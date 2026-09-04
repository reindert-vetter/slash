package jira

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// This file adds the reviewer's own Jira NOTIFICATION FEED — the bell menu in
// the Jira UI ("Notifications", tabs Direct/Watching, toggle "Only show
// unread") — to this module. It is the one thing `acli` cannot do: it has no
// notifications command at all, and the Jira Cloud platform REST API has no
// "my notifications" endpoint either. The feed comes from Atlassian's own
// notification-log gateway:
//
//	GET https://<site>/gateway/api/notification-log/api/3/notifications?category=direct
//
// which is **not a documented/supported API** — a deliberate, explicit choice
// by Reindert ("ik wil de echte bell-feed"), recorded here so nobody later
// mistakes it for a public endpoint. Consequences, accepted:
//
//   - Atlassian can change or withdraw the shape at any time. That is why
//     parsing below is deliberately LENIENT (see extractNotification): every
//     field is optional, an entry that yields no link is skipped, and a shape
//     change degrades to "no notifications" instead of an error wall.
//   - It authenticates with an ordinary Atlassian API token over HTTP basic
//     auth (email:token), like every documented Jira REST call. If Atlassian
//     only honours a browser session there, this returns 401 and the UI simply
//     shows nothing — see ErrNotConfigured/the handler.
//
// Credentials come from the environment (loaded from the gitignored .env, see
// env.go / .env.example): SLASH_JIRA_EMAIL + SLASH_JIRA_TOKEN, optionally
// SLASH_JIRA_SITE. Deliberately NOT data/settings.json — that file is served
// verbatim to the browser by GET /api/settings, so a token in it would leak to
// every page.

// ErrNotConfigured is returned when no Jira API token is configured. The
// caller treats it as "the feature is off", never as a failure worth logging
// on every poll.
var ErrNotConfigured = errors.New("jira: no API token configured (SLASH_JIRA_EMAIL/SLASH_JIRA_TOKEN)")

// notifyTimeout bounds one notification-log call. Same reasoning as cliTimeout
// above: an Activity runs inline inside a workflow run, so an unbounded hang
// would block that run (and every later signal on it) forever.
var notifyTimeout = 15 * time.Second

// defaultSite is the workspace this project talks to; overridable with
// SLASH_JIRA_SITE for another Atlassian site.
const defaultSite = "plugandpaybv.atlassian.net"

// Notification is one entry of the bell feed, flattened to exactly what the
// overview row renders and links to.
type Notification struct {
	ID        string `json:"id"`
	At        string `json:"at"`    // RFC3339, when it happened
	Title     string `json:"title"` // one line: who did what
	IssueKey  string `json:"issueKey"`
	Actor     string `json:"actor"`
	AvatarURL string `json:"avatarUrl"`
	URL       string `json:"url"`    // deep link, opened in a new window
	Unread    bool   `json:"unread"` // as Jira itself reports it
}

// Notifications fetches the newest limit entries of the "direct" feed.
func (m *Module) Notifications(ctx context.Context, limit int) ([]Notification, error) {
	email, token, site := notifyConfig()
	if email == "" || token == "" {
		return nil, ErrNotConfigured
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()

	url := fmt.Sprintf("https://%s/gateway/api/notification-log/api/3/notifications?category=direct&limit=%d", site, limit)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(email+":"+token)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jira: notification feed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("jira: notification feed: read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jira: notification feed: http %d", resp.StatusCode)
	}
	return parseNotifications(body, site), nil
}

// notifyConfig reads the credentials from the environment on every call (not
// cached), so editing .env and restarting is all it takes — and so a test can
// point the module at its own fake site.
func notifyConfig() (email, token, site string) {
	site = strings.TrimSpace(os.Getenv("SLASH_JIRA_SITE"))
	if site == "" {
		site = defaultSite
	}
	return strings.TrimSpace(os.Getenv("SLASH_JIRA_EMAIL")), strings.TrimSpace(os.Getenv("SLASH_JIRA_TOKEN")), site
}

// notifyEnvelope is the only structure this parser insists on: a list of
// entries under one of the names the feed has used. Everything INSIDE an entry
// is walked generically (extractNotification), because that part is the
// undocumented half most likely to change.
type notifyEnvelope struct {
	NotificationGroups []json.RawMessage `json:"notificationGroups"`
	Notifications      []json.RawMessage `json:"notifications"`
}

// parseNotifications maps a feed response onto Notifications, skipping every
// entry it cannot make a usable row out of (no link → nothing to open).
func parseNotifications(body []byte, site string) []Notification {
	var env notifyEnvelope
	entries := []json.RawMessage(nil)
	if err := json.Unmarshal(body, &env); err == nil {
		entries = env.NotificationGroups
		if len(entries) == 0 {
			entries = env.Notifications
		}
	}
	if len(entries) == 0 {
		// A bare array is the other shape seen in the wild.
		var arr []json.RawMessage
		if err := json.Unmarshal(body, &arr); err == nil {
			entries = arr
		}
	}
	out := make([]Notification, 0, len(entries))
	for _, raw := range entries {
		var node map[string]any
		if err := json.Unmarshal(raw, &node); err != nil {
			continue
		}
		if n, ok := extractNotification(node, site); ok {
			out = append(out, n)
		}
	}
	return out
}

// reIssueKey finds a Jira issue key inside a URL (…/browse/KEY,
// ?selectedIssue=KEY, …/issues/KEY).
var reIssueKey = regexp.MustCompile(`[A-Z][A-Z0-9]+-\d+`)

// extractNotification flattens one feed entry. It never assumes a fixed nesting
// depth: it walks the whole entry and picks the first value it finds per field,
// preferring the shallowest one (breadth-first), which in every observed shape
// is the entry's own value rather than one belonging to a nested actor/object.
func extractNotification(node map[string]any, site string) (Notification, bool) {
	var n Notification
	n.ID = firstString(node, "id", "notificationId")
	if n.ID == "" {
		if ids := firstStrings(node, "notificationIds"); len(ids) > 0 {
			n.ID = ids[0]
		}
	}
	n.At = firstString(node, "timestamp", "time", "created", "createdAt", "updated")
	n.Unread = isUnread(node)
	n.Title = strings.TrimSpace(collapseSpace(firstString(node, "message", "title", "text", "body")))
	n.Actor = firstString(node, "displayName", "name", "actorName")
	n.AvatarURL = firstString(node, "avatarUrl", "avatarURL", "avatar")
	n.URL = firstURL(node, site)
	if n.ID == "" || n.URL == "" {
		return Notification{}, false
	}
	if key := reIssueKey.FindString(n.URL); key != "" {
		n.IssueKey = key
	}
	if n.Title == "" {
		n.Title = n.IssueKey
	}
	if n.At == "" {
		n.At = time.Now().UTC().Format(time.RFC3339)
	}
	return n, true
}

// isUnread reads the entry's read state under any of the spellings seen, and
// defaults to UNREAD: a notification we cannot classify is better shown once
// too often than silently swallowed.
func isUnread(node map[string]any) bool {
	if s := firstString(node, "readState", "state"); s != "" {
		return !strings.EqualFold(s, "read") && !strings.EqualFold(s, "seen")
	}
	if v, ok := firstBool(node, "read", "isRead"); ok {
		return !v
	}
	if v, ok := firstBool(node, "unread", "isUnread"); ok {
		return v
	}
	return true
}

// walk visits every map in the entry breadth-first, so a shallower match always
// wins over a deeper one. fn returns true to stop the walk.
func walk(node map[string]any, fn func(m map[string]any) bool) {
	queue := []map[string]any{node}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if fn(cur) {
			return
		}
		for _, k := range sortedKeys(cur) {
			switch v := cur[k].(type) {
			case map[string]any:
				queue = append(queue, v)
			case []any:
				for _, item := range v {
					if m, ok := item.(map[string]any); ok {
						queue = append(queue, m)
					}
				}
			}
		}
	}
}

// sortedKeys keeps the walk order stable (a map iteration order would make the
// extracted values vary between two runs over the same payload).
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// firstString returns the first non-empty string value stored under any of
// names, anywhere in the entry (shallowest first). A nested {"text": "…"} /
// ADF-ish object under such a name is flattened to its text.
func firstString(node map[string]any, names ...string) string {
	found := ""
	walk(node, func(m map[string]any) bool {
		for _, name := range names {
			v, ok := m[name]
			if !ok {
				continue
			}
			switch t := v.(type) {
			case string:
				if strings.TrimSpace(t) != "" {
					found = strings.TrimSpace(t)
					return true
				}
			case map[string]any, []any:
				if s := strings.TrimSpace(flattenText(v)); s != "" {
					found = s
					return true
				}
			}
		}
		return false
	})
	return found
}

// firstStrings returns the first non-empty []string under any of names.
func firstStrings(node map[string]any, names ...string) []string {
	var found []string
	walk(node, func(m map[string]any) bool {
		for _, name := range names {
			arr, ok := m[name].([]any)
			if !ok {
				continue
			}
			for _, item := range arr {
				if s, ok := item.(string); ok && s != "" {
					found = append(found, s)
				}
			}
			if len(found) > 0 {
				return true
			}
		}
		return false
	})
	return found
}

// firstBool returns the first boolean under any of names.
func firstBool(node map[string]any, names ...string) (bool, bool) {
	var val, ok bool
	walk(node, func(m map[string]any) bool {
		for _, name := range names {
			if b, is := m[name].(bool); is {
				val, ok = b, true
				return true
			}
		}
		return false
	})
	return val, ok
}

// firstURL returns the first absolute link into this Jira site — the thing the
// row opens in a new window. A relative path (the feed's own shape for an issue
// link) is resolved against the site. Any query/fragment the feed put on it
// (notably ?focusedCommentId=…) is kept verbatim: that is exactly what makes
// the row land on the comment instead of the issue's top.
func firstURL(node map[string]any, site string) string {
	found := ""
	walk(node, func(m map[string]any) bool {
		for _, name := range []string{"url", "href", "link", "path"} {
			s, ok := m[name].(string)
			if !ok || strings.TrimSpace(s) == "" {
				continue
			}
			s = strings.TrimSpace(s)
			switch {
			case strings.HasPrefix(s, "https://"+site):
				found = s
				return true
			case strings.HasPrefix(s, "/"):
				found = "https://" + site + s
				return true
			}
		}
		return false
	})
	return found
}

// flattenText concatenates every string leaf of a nested value, so a message
// stored as an ADF-ish {"content":[{"text":"…"}]} still yields a readable line.
func flattenText(v any) string {
	var b strings.Builder
	var rec func(any)
	rec = func(x any) {
		switch t := x.(type) {
		case string:
			b.WriteString(t)
		case []any:
			for _, item := range t {
				rec(item)
			}
		case map[string]any:
			for _, k := range sortedKeys(t) {
				if k == "type" || k == "url" || k == "href" {
					continue
				}
				rec(t[k])
			}
		}
	}
	rec(v)
	return b.String()
}

// collapseSpace squashes runs of whitespace/newlines into single spaces — a
// feed message can carry hard line breaks that would wreck the one-line row.
func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }
