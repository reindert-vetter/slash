package jira

import "testing"

// A representative notifyFeedQuery response: one unread comment notification
// carrying a relative link WITH a focusedCommentId (the deep link the overview
// row opens in a new window), and one already-read entry, plus one entry with
// no usable link. This shape was CONFIRMED live via schema introspection
// against the real Atlassian site (see the big comment at the top of
// notifications.go) — it is the actual `notifications.notificationFeed`
// GraphQL query result, not a guess.
const feedJSON = `{
  "data": {
    "notifications": {
      "notificationFeed": {
        "nodes": [
          {
            "groupId": "ari:cloud:notifications::group/abc-123",
            "groupSize": 3,
            "additionalActors": [{"displayName": "Alex", "avatarURL": "https://avatar.example/a.png"}],
            "headNotification": {
              "notificationId": "ari:cloud:notifications::notification/abc-123",
              "timestamp": "2026-09-03T10:15:00.000Z",
              "readState": "unread",
              "content": {
                "message": "commented on PAYM-813",
                "url": "/browse/PAYM-813?focusedCommentId=98765",
                "actor": {"displayName": "Dennis Sloove", "avatarURL": "https://avatar.example/d.png"},
                "entity": {"title": "Fix the checkout flow", "status": "To Do", "iconUrl": "https://avatar.example/bug.png"},
                "bodyItems": [{"type": "comment", "document": {"data": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Helemaal top!\"}]}]}", "format": "adf"}}]
              }
            }
          },
          {
            "groupId": "ari:cloud:notifications::group/abc-456",
            "headNotification": {
              "notificationId": "abc-456",
              "timestamp": "2026-09-02T08:00:00.000Z",
              "readState": "read",
              "content": {
                "message": "assigned an issue to you",
                "url": "https://plugandpaybv.atlassian.net/browse/PAYM-99",
                "actor": {"displayName": ""}
              }
            }
          },
          {
            "groupId": "no-link",
            "headNotification": {
              "notificationId": "no-link",
              "timestamp": "2026-09-01T08:00:00.000Z",
              "readState": "unread",
              "content": {"message": "something without a link", "url": ""}
            }
          }
        ]
      }
    }
  }
}`

func TestParseGraphQLNotifications(t *testing.T) {
	got, err := parseGraphQLNotifications([]byte(feedJSON), "plugandpaybv.atlassian.net")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 usable notifications (the third has no link), got %d: %+v", len(got), got)
	}

	first := got[0]
	if first.ID != "ari:cloud:notifications::notification/abc-123" {
		t.Errorf("id: got %q", first.ID)
	}
	// The relative link must resolve against the site AND keep the
	// focusedCommentId — that is what makes the row land on the comment.
	want := "https://plugandpaybv.atlassian.net/browse/PAYM-813?focusedCommentId=98765"
	if first.URL != want {
		t.Errorf("url: got %q, want %q", first.URL, want)
	}
	if first.IssueKey != "PAYM-813" {
		t.Errorf("issue key: got %q", first.IssueKey)
	}
	if first.Actor != "Dennis Sloove" {
		t.Errorf("actor: got %q", first.Actor)
	}
	if first.AvatarURL != "https://avatar.example/d.png" {
		t.Errorf("avatar: got %q", first.AvatarURL)
	}
	if first.Title != "commented on PAYM-813" {
		t.Errorf("title: got %q", first.Title)
	}
	if !first.Unread {
		t.Error("first entry should be unread")
	}
	if first.IssueTitle != "Fix the checkout flow" {
		t.Errorf("issue title: got %q", first.IssueTitle)
	}
	if first.IssueStatus != "To Do" {
		t.Errorf("issue status: got %q", first.IssueStatus)
	}
	if first.IssueIconURL != "https://avatar.example/bug.png" {
		t.Errorf("issue icon: got %q", first.IssueIconURL)
	}
	if first.GroupSize != 3 {
		t.Errorf("group size: got %d", first.GroupSize)
	}
	if first.OtherActor != "Alex" {
		t.Errorf("other actor: got %q", first.OtherActor)
	}
	if first.CommentPreview != "Helemaal top!" {
		t.Errorf("comment preview: got %q", first.CommentPreview)
	}

	second := got[1]
	if second.Unread {
		t.Error(`an entry with readState "read" must not be unread`)
	}
	if second.URL != "https://plugandpaybv.atlassian.net/browse/PAYM-99" {
		t.Errorf("absolute url: got %q", second.URL)
	}
	// No "groupSize" field at all in the fixture — must default to 1
	// (ungrouped), never 0, and carry no "+N updates from X" note.
	if second.GroupSize != 1 {
		t.Errorf("group size: got %d, want 1 (ungrouped default)", second.GroupSize)
	}
	if second.OtherActor != "" {
		t.Errorf("other actor: got %q, want empty (ungrouped)", second.OtherActor)
	}
}

// A shape change in this still-undocumented feed must degrade to "no
// notifications", never to a panic.
func TestParseGraphQLNotificationsTolerantOfJunk(t *testing.T) {
	for _, body := range []string{`{}`, `{"data":{}}`, `{"data":{"notifications":{}}}`, `null`} {
		got, err := parseGraphQLNotifications([]byte(body), "example.atlassian.net")
		if err != nil {
			t.Errorf("body %q: unexpected error: %v", body, err)
		}
		if len(got) != 0 {
			t.Errorf("body %q: want no notifications, got %+v", body, got)
		}
	}
}

// Invalid JSON is a real parse failure and must be reported, not silently
// swallowed into an empty list — that distinction is what lets checkJiraToken
// tell a genuinely empty feed apart from one that broke.
func TestParseGraphQLNotificationsInvalidJSON(t *testing.T) {
	if _, err := parseGraphQLNotifications([]byte("not json at all"), "example.atlassian.net"); err == nil {
		t.Fatal("want an error for invalid JSON, got nil")
	}
}

// A GraphQL-level error (a real query/schema problem) must be reported as an
// error, never silently degraded to "no notifications" — that would hide a
// broken feed behind an innocent-looking empty bell.
func TestParseGraphQLNotificationsSurfacesGraphQLErrors(t *testing.T) {
	body := `{"errors":[{"message":"Validation error: unknown field notificationFeed"}]}`
	if _, err := parseGraphQLNotifications([]byte(body), "example.atlassian.net"); err == nil {
		t.Fatal("want an error when the response carries a GraphQL error, got nil")
	}
}

// An entry whose read state is anything other than exactly "read" counts as
// unread: showing it once too often beats swallowing it.
func TestUnknownReadStateIsUnread(t *testing.T) {
	body := `{"data":{"notifications":{"notificationFeed":{"nodes":[
		{"groupId":"g1","headNotification":{"notificationId":"x","content":{"url":"/browse/AB-1"}}}
	]}}}}`
	got, err := parseGraphQLNotifications([]byte(body), "s.atlassian.net")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || !got[0].Unread {
		t.Fatalf("want one unread notification, got %+v", got)
	}
}

// TestJiraSiteARI pins the exact format notificationFeed's
// collabContextRoutingAri argument needs — confirmed live against the real
// Atlassian site (see the file header's "PITFALL THAT COST A ROUND-TRIP").
func TestJiraSiteARI(t *testing.T) {
	got := jiraSiteARI("d1788971-83f3-466c-ab39-27a0b4b24228")
	want := "ari:cloud:jira::site/d1788971-83f3-466c-ab39-27a0b4b24228"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestParseTenantInfo covers the tiny, undocumented `_edge/tenant_info`
// response shape resolveCloudID depends on.
func TestParseTenantInfo(t *testing.T) {
	id, err := parseTenantInfo([]byte(`{"cloudId":"abc-123"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "abc-123" {
		t.Errorf("cloudId: got %q", id)
	}
}

// TestParseTenantInfoRejectsEmpty guards against silently building an ARI out
// of an empty cloudId (which would just resolve to an empty-context feed
// again — the exact bug this whole mechanism exists to avoid).
func TestParseTenantInfoRejectsEmpty(t *testing.T) {
	for _, body := range []string{`{}`, `{"cloudId":""}`, `not json`} {
		if _, err := parseTenantInfo([]byte(body)); err == nil {
			t.Errorf("body %q: want an error, got nil", body)
		}
	}
}

// TestFirstCommentPreview covers both document shapes this must handle: real
// ADF (Jira's normal comment storage format) and a document whose Data isn't
// valid ADF JSON at all, which must still surface as-is rather than being
// dropped (this feed is undocumented — see the "degrade, never drop" rule at
// the top of the file).
func TestFirstCommentPreview(t *testing.T) {
	adf := `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Great work"}]}]}`
	got := firstCommentPreview([]notifyFeedBodyItem{{Document: notifyFeedDocument{Data: adf, Format: "adf"}}})
	if got != "Great work" {
		t.Errorf("ADF preview: got %q", got)
	}

	got = firstCommentPreview([]notifyFeedBodyItem{{Document: notifyFeedDocument{Data: "plain text body", Format: "plain_text"}}})
	if got != "plain text body" {
		t.Errorf("plain-text fallback: got %q", got)
	}

	if got := firstCommentPreview(nil); got != "" {
		t.Errorf("nil body items: got %q, want empty", got)
	}
	if got := firstCommentPreview([]notifyFeedBodyItem{{Document: notifyFeedDocument{Data: ""}}}); got != "" {
		t.Errorf("empty document data: got %q, want empty", got)
	}
}
