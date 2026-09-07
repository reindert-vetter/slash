package jira

// comments.go — the WRITE half of this module plus the user lookup behind an
// @-mention: posting a comment on an issue, and searching the people who can
// be mentioned in one.
//
// WHY REST AND NOT `acli`, unlike Issue()/Search() next door: `acli` can post
// a comment (`acli jira workitem comment create --body`), but it has no user
// command at all — there is no way to turn "@rein" into the accountId a real
// Jira mention node needs. The documented Jira Cloud REST API has both, on the
// SAME credentials this module already uses for the notification feed
// (SLASH_JIRA_EMAIL/SLASH_JIRA_TOKEN, see notifyConfig in notifications.go),
// so both live here on one auth path instead of half a feature per transport.
// These are documented, supported endpoints — unlike the GraphQL bell feed:
//
//	POST /rest/api/3/issue/{key}/comment   {"body": <ADF>}
//	GET  /rest/api/3/user/search?query=…
//
// Only AddComment writes, and only from the postJiraComment Activity of the
// jira_comment workflow (.claude/rules/workflows-write-boundary.md); Users is
// an ordinary read method the read-only /api/jira/users handler may call.
//
// See .claude/docs/plan-page.md, "Jira-opmerkingen: lezen, beantwoorden,
// @-mentions".

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// User is one person who can be @-mentioned: the accountId a mention node
// carries, plus what the picker shows.
type User struct {
	AccountID   string `json:"accountId"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
}

// Mention is one @-mention the reviewer picked while typing: the accountId to
// address, and the literal text it occupies in the typed body ("@Dennis
// Sloove"). BuildCommentADF turns every occurrence of Text into a real mention
// node; anything it cannot place stays ordinary text.
type Mention struct {
	AccountID string `json:"accountId"`
	Text      string `json:"text"`
}

// accountIDPattern bounds an accountId before it reaches a URL/JSON payload —
// Atlassian's own ids are hex/`:`-separated ARIs, never anything needing
// escaping. Same "validate before it leaves the process" rule keyPattern
// applies to an issue key.
var accountIDPattern = regexp.MustCompile(`^[A-Za-z0-9:._-]{1,128}$`)

// maxMentions bounds one comment's mention list: a body with dozens of them is
// a mistake, not a use case, and every one of them is a node we build.
const maxMentions = 20

// MaxCommentBody bounds one posted comment. Jira's own limit is far higher;
// this only keeps a runaway paste out of the API and out of the workflow's
// event history.
const MaxCommentBody = 32 << 10

// ValidMention reports whether a picked mention is safe to build a node from.
func ValidMention(m Mention) bool {
	return accountIDPattern.MatchString(m.AccountID) && strings.TrimSpace(m.Text) != ""
}

// adfDoc/adfPara/adfLeaf are the minimal ADF shapes we EMIT (adfNode in
// jira.go is the lenient shape we PARSE) — a doc of paragraphs, each holding
// text and mention leaves.
type adfDoc struct {
	Type    string    `json:"type"`
	Version int       `json:"version"`
	Content []adfPara `json:"content"`
}

type adfPara struct {
	Type    string    `json:"type"`
	Content []adfLeaf `json:"content"`
}

type adfLeaf struct {
	Type  string        `json:"type"`
	Text  string        `json:"text,omitempty"`
	Attrs *adfLeafAttrs `json:"attrs,omitempty"`
}

type adfLeafAttrs struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// BuildCommentADF turns a typed body plus the mentions picked while typing
// into an Atlassian Document Format document. Pure, so the whole mapping is
// unit-testable without a network: every line becomes a paragraph (an empty
// line is dropped rather than emitted as an invalid empty paragraph), and
// inside a line every literal occurrence of a mention's Text becomes a real
// mention node. Longest text first, so "@Dennis Sloove" wins over a second
// mention "@Dennis"; a mention whose text does not occur simply contributes
// nothing and the body stays as typed.
func BuildCommentADF(body string, mentions []Mention) json.RawMessage {
	valid := make([]Mention, 0, len(mentions))
	for _, m := range mentions {
		if len(valid) >= maxMentions {
			break
		}
		if ValidMention(m) {
			valid = append(valid, m)
		}
	}
	// Longest text first: a shorter mention that is a prefix of a longer one
	// must never consume it.
	sort.SliceStable(valid, func(i, j int) bool { return len(valid[i].Text) > len(valid[j].Text) })

	doc := adfDoc{Type: "doc", Version: 1}
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		doc.Content = append(doc.Content, adfPara{Type: "paragraph", Content: mentionLeaves(line, valid)})
	}
	if len(doc.Content) == 0 {
		doc.Content = append(doc.Content, adfPara{Type: "paragraph", Content: []adfLeaf{{Type: "text", Text: strings.TrimSpace(body)}}})
	}
	raw, err := json.Marshal(doc)
	if err != nil { // unreachable: only plain strings go in
		return nil
	}
	return raw
}

// mentionLeaves splits one line into text and mention leaves.
func mentionLeaves(line string, mentions []Mention) []adfLeaf {
	var out []adfLeaf
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			out = append(out, adfLeaf{Type: "text", Text: buf.String()})
			buf.Reset()
		}
	}
	for i := 0; i < len(line); {
		hit := -1
		for k, m := range mentions {
			if strings.HasPrefix(line[i:], m.Text) {
				hit = k
				break // mentions are sorted longest-first
			}
		}
		if hit < 0 {
			buf.WriteByte(line[i])
			i++
			continue
		}
		flush()
		m := mentions[hit]
		out = append(out, adfLeaf{Type: "mention", Attrs: &adfLeafAttrs{ID: m.AccountID, Text: m.Text}})
		i += len(m.Text)
	}
	flush()
	if len(out) == 0 {
		out = append(out, adfLeaf{Type: "text", Text: line})
	}
	return out
}

// AddComment posts one comment on key and returns the new comment's id. The
// key is validated against keyPattern before it reaches the URL, and the body
// is already an ADF document built by BuildCommentADF.
func (m *Module) AddComment(ctx context.Context, key string, adf json.RawMessage) (string, error) {
	if !keyPattern.MatchString(key) {
		return "", fmt.Errorf("jira: invalid issue key %q", key)
	}
	if len(adf) == 0 {
		return "", fmt.Errorf("jira: empty comment body")
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"body": adf})
	if err != nil {
		return "", err
	}
	body, err := restCall(ctx, http.MethodPost, "/rest/api/3/issue/"+key+"/comment", payload)
	if err != nil {
		return "", err
	}
	return parseAddCommentResponse(body), nil
}

// parseAddCommentResponse picks the new comment's id off the 201 body. A
// response we cannot read is not an error — the comment IS posted at that
// point, and the id is only used for display/dedup.
func parseAddCommentResponse(body []byte) string {
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &out)
	return strings.TrimSpace(out.ID)
}

// Users searches the people who can be @-mentioned. query is whatever the
// reviewer typed after the "@"; it is sent as an ordinary URL query value.
func (m *Module) Users(ctx context.Context, query string, limit int) ([]User, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	q := url.Values{}
	q.Set("query", query)
	q.Set("maxResults", fmt.Sprint(limit))
	body, err := restCall(ctx, http.MethodGet, "/rest/api/3/user/search?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	return parseUserSearch(body), nil
}

// parseUserSearch maps the user-search payload onto Users — pure, so the
// filtering below is testable without a network. Only real, active Atlassian
// accounts are offered: an app/customer account cannot be mentioned usefully.
func parseUserSearch(body []byte) []User {
	var raw []struct {
		AccountID   string `json:"accountId"`
		AccountType string `json:"accountType"`
		DisplayName string `json:"displayName"`
		Email       string `json:"emailAddress"`
		Active      bool   `json:"active"`
		AvatarURLs  struct {
			Small string `json:"24x24"`
		} `json:"avatarUrls"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	out := make([]User, 0, len(raw))
	for _, u := range raw {
		if !u.Active || u.AccountType != "atlassian" || !accountIDPattern.MatchString(u.AccountID) {
			continue
		}
		name := strings.TrimSpace(u.DisplayName)
		if name == "" {
			continue
		}
		out = append(out, User{AccountID: u.AccountID, DisplayName: name, Email: strings.TrimSpace(u.Email), AvatarURL: strings.TrimSpace(u.AvatarURLs.Small)})
	}
	return out
}

// restCall runs one authenticated Jira Cloud REST request against the
// configured site. Same credentials, same Basic auth and the same
// notifyTimeout bound as the notification feed (see notifications.go's header
// for why every call this module makes bounds itself).
func restCall(ctx context.Context, method, path string, payload []byte) ([]byte, error) {
	email, token, site := notifyConfig()
	if email == "" || token == "" {
		return nil, ErrNotConfigured
	}
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://"+site+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(email+":"+token)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jira: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("jira: %s %s: read: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("jira: %s %s: http %d: %s", method, path, resp.StatusCode, clipBody(body))
	}
	return body, nil
}

// clipBody keeps an error message readable: Jira answers a rejected write with
// a long JSON envelope, and only its first line ever tells the reviewer
// anything.
func clipBody(body []byte) string {
	s := strings.TrimSpace(string(body))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
