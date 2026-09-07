package jira

import (
	"encoding/json"
	"testing"
)

// decodeADF unpacks what BuildCommentADF produced into a walkable shape.
func decodeADF(t *testing.T, raw json.RawMessage) adfDoc {
	t.Helper()
	var doc adfDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal adf: %v (%s)", err, raw)
	}
	if doc.Type != "doc" || doc.Version != 1 {
		t.Fatalf("adf envelope = %q/%d, want doc/1", doc.Type, doc.Version)
	}
	return doc
}

func TestBuildCommentADFPlainBody(t *testing.T) {
	doc := decodeADF(t, BuildCommentADF("Klopt dit?", nil))
	if len(doc.Content) != 1 || len(doc.Content[0].Content) != 1 {
		t.Fatalf("content = %+v, want one paragraph with one leaf", doc.Content)
	}
	leaf := doc.Content[0].Content[0]
	if leaf.Type != "text" || leaf.Text != "Klopt dit?" {
		t.Fatalf("leaf = %+v", leaf)
	}
}

func TestBuildCommentADFLinesBecomeParagraphs(t *testing.T) {
	doc := decodeADF(t, BuildCommentADF("een\n\ntwee\r\n", nil))
	if len(doc.Content) != 2 {
		t.Fatalf("paragraphs = %d, want 2 (the empty line is dropped)", len(doc.Content))
	}
	if doc.Content[0].Content[0].Text != "een" || doc.Content[1].Content[0].Text != "twee" {
		t.Fatalf("paragraphs = %+v", doc.Content)
	}
}

func TestBuildCommentADFMentionNodes(t *testing.T) {
	body := "@Dennis Sloove en @Dennis, kijk hier: @Dennis Sloove"
	raw := BuildCommentADF(body, []Mention{
		{AccountID: "111", Text: "@Dennis Sloove"},
		{AccountID: "222", Text: "@Dennis"},
	})
	doc := decodeADF(t, raw)
	if len(doc.Content) != 1 {
		t.Fatalf("paragraphs = %d, want 1", len(doc.Content))
	}
	var ids []string
	for _, leaf := range doc.Content[0].Content {
		if leaf.Type == "mention" {
			ids = append(ids, leaf.Attrs.ID)
			if leaf.Attrs.Text == "" {
				t.Fatalf("mention without text: %+v", leaf)
			}
		}
	}
	// The longest text wins, so the two "@Dennis Sloove" occurrences become
	// 111 and the bare "@Dennis" becomes 222 — never three times 222.
	want := []string{"111", "222", "111"}
	if len(ids) != len(want) {
		t.Fatalf("mention ids = %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("mention ids = %v, want %v", ids, want)
		}
	}
}

func TestBuildCommentADFDropsUnusableMentions(t *testing.T) {
	// An unsafe accountId, an empty one and a text that does not occur in the
	// body all contribute nothing; the body stays exactly as typed.
	raw := BuildCommentADF("hoi @Niemand", []Mention{
		{AccountID: "a b/c", Text: "@Niemand"},
		{AccountID: "", Text: "@Niemand"},
		{AccountID: "333", Text: "@Weg"},
	})
	doc := decodeADF(t, raw)
	for _, leaf := range doc.Content[0].Content {
		if leaf.Type == "mention" {
			t.Fatalf("unexpected mention node: %+v", leaf)
		}
	}
	if doc.Content[0].Content[0].Text != "hoi @Niemand" {
		t.Fatalf("body = %q", doc.Content[0].Content[0].Text)
	}
}

func TestParseUserSearchKeepsRealPeopleOnly(t *testing.T) {
	body := []byte(`[
	  {"accountId":"638f","accountType":"atlassian","displayName":"Reindert","emailAddress":"r@x.nl","active":true,"avatarUrls":{"24x24":"https://x/24"}},
	  {"accountId":"aaa","accountType":"app","displayName":"Bot","active":true},
	  {"accountId":"bbb","accountType":"atlassian","displayName":"Oud","active":false},
	  {"accountId":"ccc","accountType":"atlassian","displayName":"","active":true}
	]`)
	users := parseUserSearch(body)
	if len(users) != 1 {
		t.Fatalf("users = %+v, want only the active atlassian account", users)
	}
	u := users[0]
	if u.AccountID != "638f" || u.DisplayName != "Reindert" || u.Email != "r@x.nl" || u.AvatarURL != "https://x/24" {
		t.Fatalf("user = %+v", u)
	}
}

func TestParseAddCommentResponse(t *testing.T) {
	if got := parseAddCommentResponse([]byte(`{"id":"10142","self":"…"}`)); got != "10142" {
		t.Fatalf("id = %q", got)
	}
	// A body we cannot read is not an error: the comment is posted either way.
	if got := parseAddCommentResponse([]byte(`not json`)); got != "" {
		t.Fatalf("id = %q, want empty", got)
	}
}
