package jira

import (
	"bytes"
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
// "my notifications" endpoint either.
//
// HISTORY, kept because it explains why this looks the way it does. This used
// to call an undocumented REST gateway:
//
//	GET https://<site>/gateway/api/notification-log/api/3/notifications?category=direct
//
// That gateway route was found WITHDRAWN (investigated live, 2026-09-05): a
// real, valid token got a clean 200 from `/rest/api/2/myself`, while EVERY
// path tried under `/gateway/api/notification-log/...` (several plausible
// API-version/sub-path variants) returned the exact same generic gateway 404
// as a deliberately made-up path (`/gateway/api/totally-bogus-xyz123`) — a
// dead route at the edge, not a broken sub-path of a live service.
//
// The reviewer asked to keep looking instead of only reporting the
// breakage, so the next stop was `/gateway/api/graphql`: alive (confirmed via
// a `{__typename}` query), and with introspection ENABLED — `__schema`/
// `__type` queries worked, which is how every field/type name below was
// found, not guessed. The bell feed lives at
// `Query.notifications.notificationFeed(first, filter)`, an
// `InfluentsNotificationFeedConnection` whose `nodes` are
// `InfluentsNotificationHeadItem` (one per notification GROUP — `groupId` +
// `groupSize` + a `headNotification`, so a burst of activity on one thread
// collapses to its most recent item, matching what the bell UI itself shows).
// `headNotification.content` carries the flat, already-rendered pieces this
// module needs: `message` (String, no ADF to flatten), `url`, and
// `actor{displayName, avatarURL}`. Same auth as before — HTTP Basic with the
// ordinary Atlassian API token — confirmed live: a `notificationFeed` query
// against the real site returned a clean, well-formed (if empty for this
// account at the time) result via `POST`.
//
// Both are still **not documented/supported APIs** — a deliberate, explicit
// choice by Reindert ("ik wil de echte bell-feed" / "zoek het zelf uit"),
// recorded here so nobody later mistakes either for a public endpoint.
// Consequences, accepted:
//
//   - Atlassian can change or withdraw this GraphQL shape too, exactly like it
//     did the REST one. parseGraphQLNotifications degrades to "no
//     notifications" (or a reported error — see below) rather than a panic,
//     but there is no lenient/tolerant field-walking here anymore: introspection
//     gave an exact, typed schema, so the mapping is a plain, direct struct
//     decode. A future shape change is expected to surface as a GraphQL
//     `errors` entry (still handled) or as an empty `nodes` list, not as
//     garbled data.
//   - If Atlassian ever stops honouring an API token here (only a browser
//     session works), the request fails and the caller degrades the same way
//     as any other feed failure — see ErrNotConfigured/checkJiraToken
//     (auth_status.go), which treats "credentials verified fine but the feed
//     itself errors" as a distinct, non-alarming state.
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

// notifyTimeout bounds one notification-feed call. Same reasoning as
// cliTimeout above: an Activity runs inline inside a workflow run, so an
// unbounded hang would block that run (and every later signal on it) forever.
var notifyTimeout = 15 * time.Second

// DefaultSite is the workspace this project talks to; overridable with
// SLASH_JIRA_SITE for another Atlassian site. Exported so auth_status.go can
// prefill the settings page's site field with the value that is actually used
// at runtime, instead of only showing it as an HTML placeholder hint.
const DefaultSite = "plugandpaybv.atlassian.net"

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

// notifyFeedQuery is the GraphQL query behind the bell feed, run against
// `/gateway/api/graphql` — see the big comment above for how every field/type
// name here was confirmed (schema introspection against the real site, not
// guessed).
const notifyFeedQuery = `query ReviewTreeNotifications($first: Int!, $category: InfluentsNotificationCategory!) {
  notifications {
    notificationFeed(first: $first, filter: {categoryFilter: $category}) {
      nodes {
        groupId
        headNotification {
          notificationId
          timestamp
          readState
          content {
            message
            url
            actor { displayName avatarURL }
          }
        }
      }
    }
  }
}`

// graphQLRequest is the standard POST body shape the gateway expects.
type graphQLRequest struct {
	OperationName string         `json:"operationName"`
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables"`
}

// notifyFeedResponse mirrors notifyFeedQuery's exact result shape — a plain,
// typed decode rather than the old lenient field-walker, because introspection
// gave an exact schema instead of a guess (see the file header).
type notifyFeedResponse struct {
	Data struct {
		Notifications struct {
			NotificationFeed struct {
				Nodes []notifyFeedNode `json:"nodes"`
			} `json:"notificationFeed"`
		} `json:"notifications"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// notifyFeedNode is one InfluentsNotificationHeadItem — one notification
// GROUP (groupId/groupSize), collapsed to its most recent item
// (headNotification), matching what the bell UI itself shows for a burst of
// activity on one thread.
type notifyFeedNode struct {
	GroupID          string `json:"groupId"`
	HeadNotification struct {
		NotificationID string `json:"notificationId"`
		Timestamp      string `json:"timestamp"`
		ReadState      string `json:"readState"`
		Content        struct {
			Message string `json:"message"`
			URL     string `json:"url"`
			Actor   struct {
				DisplayName string `json:"displayName"`
				AvatarURL   string `json:"avatarURL"`
			} `json:"actor"`
		} `json:"content"`
	} `json:"headNotification"`
}

// Notifications fetches the newest limit entries of the "direct" feed via the
// GraphQL gateway (see the file header for why not the old REST endpoint).
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

	reqBody, err := json.Marshal(graphQLRequest{
		OperationName: "ReviewTreeNotifications",
		Query:         notifyFeedQuery,
		Variables:     map[string]any{"first": limit, "category": "direct"},
	})
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("https://%s/gateway/api/graphql", site)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
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
	return parseGraphQLNotifications(body, site)
}

// VerifyCredentials confirms the configured email/token are still accepted by
// Jira, via the documented, stable `/rest/api/2/myself` endpoint — deliberately
// NOT the notification feed itself, so checkJiraToken (auth_status.go) can
// tell "your token is rejected" apart from "the feed itself errors, but your
// token is still fine" instead of blaming the token for both.
func (m *Module) VerifyCredentials(ctx context.Context) error {
	email, token, site := notifyConfig()
	if email == "" || token == "" {
		return ErrNotConfigured
	}
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()

	url := fmt.Sprintf("https://%s/rest/api/2/myself", site)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(email+":"+token)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("jira: verify credentials: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<20))
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return fmt.Errorf("jira: verify credentials: http %d — e-mailadres of token is niet (meer) geldig", resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("jira: verify credentials: http %d", resp.StatusCode)
	}
	return nil
}

// notifyConfig reads the credentials from the environment on every call (not
// cached), so editing .env and restarting is all it takes — and so a test can
// point the module at its own fake site.
func notifyConfig() (email, token, site string) {
	site = strings.TrimSpace(os.Getenv("SLASH_JIRA_SITE"))
	if site == "" {
		site = DefaultSite
	}
	return strings.TrimSpace(os.Getenv("SLASH_JIRA_EMAIL")), strings.TrimSpace(os.Getenv("SLASH_JIRA_TOKEN")), site
}

// reIssueKey finds a Jira issue key inside a URL (…/browse/KEY,
// ?selectedIssue=KEY, …/issues/KEY).
var reIssueKey = regexp.MustCompile(`[A-Z][A-Z0-9]+-\d+`)

// parseGraphQLNotifications maps notifyFeedQuery's response onto
// Notifications. A GraphQL-level error (a real query/schema problem, distinct
// from an empty result) is surfaced as an error rather than silently degraded
// to "no notifications" — that distinction is exactly what lets
// checkJiraToken tell a live-but-empty feed apart from one that broke again.
func parseGraphQLNotifications(body []byte, site string) ([]Notification, error) {
	var resp notifyFeedResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("jira: notification feed: parse: %w", err)
	}
	if len(resp.Errors) > 0 {
		return nil, fmt.Errorf("jira: notification feed: %s", resp.Errors[0].Message)
	}
	nodes := resp.Data.Notifications.NotificationFeed.Nodes
	out := make([]Notification, 0, len(nodes))
	for _, node := range nodes {
		hn := node.HeadNotification
		url := resolveNotificationURL(hn.Content.URL, site)
		if url == "" {
			continue // no link → nothing to open
		}
		id := hn.NotificationID
		if id == "" {
			id = node.GroupID
		}
		if id == "" {
			continue
		}
		n := Notification{
			ID:        id,
			At:        hn.Timestamp,
			Title:     strings.TrimSpace(hn.Content.Message),
			Actor:     hn.Content.Actor.DisplayName,
			AvatarURL: hn.Content.Actor.AvatarURL,
			URL:       url,
			Unread:    !strings.EqualFold(hn.ReadState, "read"),
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
		out = append(out, n)
	}
	return out, nil
}

// resolveNotificationURL turns content.url into an absolute link, or "" when
// it cannot: an already-absolute URL is kept verbatim (including any
// query/fragment the feed put on it, e.g. ?focusedCommentId=… — that is what
// makes a row land on the exact comment instead of the issue's top), a
// relative path is resolved against site, and anything else (empty, or some
// other unexpected shape) yields no link — that notification is skipped by
// the caller, same as before.
func resolveNotificationURL(raw, site string) string {
	raw = strings.TrimSpace(raw)
	switch {
	case raw == "":
		return ""
	case strings.HasPrefix(raw, "http://"), strings.HasPrefix(raw, "https://"):
		return raw
	case strings.HasPrefix(raw, "/"):
		return "https://" + site + raw
	default:
		return ""
	}
}
