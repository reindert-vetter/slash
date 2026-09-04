package jira

import "testing"

// A representative notification-log payload: one unread comment notification
// carrying a relative link WITH a focusedCommentId (the deep link the overview
// row opens in a new window), and one already-read entry.
const feedJSON = `{
  "notificationGroups": [
    {
      "notificationIds": ["ari:cloud:notifications::notification/abc-123"],
      "timestamp": "2026-09-03T10:15:00.000Z",
      "readState": "unread",
      "content": {
        "message": {"content": [{"text": "commented on "}, {"text": "PAYM-813"}]},
        "actors": [{"displayName": "Dennis Sloove", "avatarUrl": "https://avatar.example/d.png"}],
        "entity": {"url": "/browse/PAYM-813?focusedCommentId=98765"}
      }
    },
    {
      "id": "abc-456",
      "timestamp": "2026-09-02T08:00:00.000Z",
      "readState": "read",
      "content": {
        "message": "assigned an issue to you",
        "entity": {"url": "https://plugandpaybv.atlassian.net/browse/PAYM-99"}
      }
    },
    {
      "id": "no-link",
      "timestamp": "2026-09-01T08:00:00.000Z",
      "content": {"message": "something without a link"}
    }
  ]
}`

func TestParseNotifications(t *testing.T) {
	got := parseNotifications([]byte(feedJSON), "plugandpaybv.atlassian.net")
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

	second := got[1]
	if second.Unread {
		t.Error(`an entry with readState "read" must not be unread`)
	}
	if second.URL != "https://plugandpaybv.atlassian.net/browse/PAYM-99" {
		t.Errorf("absolute url: got %q", second.URL)
	}
}

// A shape change in this undocumented feed must degrade to "no notifications",
// never to a panic or an error wall.
func TestParseNotificationsTolerantOfJunk(t *testing.T) {
	for _, body := range []string{`{}`, `[]`, `null`, `{"notificationGroups": [{"nothing": true}]}`, `not json at all`} {
		if got := parseNotifications([]byte(body), "example.atlassian.net"); len(got) != 0 {
			t.Errorf("body %q: want no notifications, got %+v", body, got)
		}
	}
}

// An entry whose read state the feed does not report at all counts as unread:
// showing it once too often beats swallowing it.
func TestUnknownReadStateIsUnread(t *testing.T) {
	got := parseNotifications([]byte(`{"notifications":[{"id":"x","content":{"entity":{"url":"/browse/AB-1"}}}]}`), "s.atlassian.net")
	if len(got) != 1 || !got[0].Unread {
		t.Fatalf("want one unread notification, got %+v", got)
	}
}
