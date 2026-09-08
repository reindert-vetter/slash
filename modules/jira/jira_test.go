package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// TestFakeRoundTrip asserts the Fake returns what was programmed and records
// the requested key, so workflow tests can inject it without touching acli.
func TestFakeRoundTrip(t *testing.T) {
	f := &Fake{}
	f.SetIssue("INTEG-562", Issue{
		Key: "INTEG-562", Title: "Some title", Description: "Some description",
		URL: "https://plugandpaybv.atlassian.net/browse/INTEG-562",
	})

	got, err := f.Issue(context.Background(), "INTEG-562")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Some title" || got.Description != "Some description" {
		t.Fatalf("got %+v", got)
	}
	if len(f.Calls) != 1 || f.Calls[0] != "INTEG-562" {
		t.Fatalf("Calls = %v", f.Calls)
	}

	// An unprogrammed key returns a zero Issue, not an error.
	empty, err := f.Issue(context.Background(), "OTHER-1")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(empty, Issue{}) {
		t.Fatalf("empty = %+v, want zero value", empty)
	}
}

// TestAdfTextExtractsPlainText feeds a realistic ADF description (the shape
// `acli jira workitem view --json` actually returns) through adfText and
// asserts it flattens to the paragraph's plain text.
func TestAdfTextExtractsPlainText(t *testing.T) {
	raw := []byte(`{
		"type": "doc",
		"version": 1,
		"content": [
			{
				"type": "paragraph",
				"content": [
					{"type": "text", "text": "Als er een rule failed kun je het opnieuw uitvoeren. "}
				]
			},
			{
				"type": "paragraph",
				"content": [
					{"type": "text", "text": "Tweede paragraaf."}
				]
			}
		]
	}`)
	got := adfText(raw)
	want := "Als er een rule failed kun je het opnieuw uitvoeren. \nTweede paragraaf."
	if got != want {
		t.Fatalf("adfText = %q, want %q", got, want)
	}
}

// TestAdfTextEmpty asserts a missing/empty description doesn't panic and
// returns an empty string.
func TestAdfTextEmpty(t *testing.T) {
	if got := adfText(nil); got != "" {
		t.Fatalf("adfText(nil) = %q, want empty", got)
	}
	if got := adfText([]byte("null")); got != "" {
		t.Fatalf(`adfText("null") = %q, want empty`, got)
	}
}

// TestModuleRejectsInvalidKey asserts Issue validates the key before ever
// shelling out (input validation before exec, per project rule).
func TestModuleRejectsInvalidKey(t *testing.T) {
	m := New()
	if _, err := m.Issue(context.Background(), "not a key; rm -rf /"); err == nil {
		t.Fatal("want error for invalid key")
	}
}

// TestIssueParsesParentAndSubtasks pins down the two link fields the plan
// page's scope question depends on, against the real `acli jira workitem view`
// shape (a nested `fields` envelope per link, `parent` absent entirely for an
// ordinary issue).
func TestIssueParsesParentAndSubtasks(t *testing.T) {
	subtask := []byte(`{"key":"INTL-145","fields":{"summary":"Payment link vertalingen",
		"parent":{"key":"INTL-139","id":"101780","fields":{"summary":"Spaans toevoegen",
			"status":{"name":"To Do"},"issuetype":{"name":"Story"}}},
		"subtasks":[]}}`)
	var parsed acliIssue
	if err := json.Unmarshal(subtask, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := issueFromACLI("INTL-145", parsed)
	if got.ParentKey != "INTL-139" || got.ParentTitle != "Spaans toevoegen" {
		t.Fatalf("parent = %q/%q", got.ParentKey, got.ParentTitle)
	}
	if len(got.Subtasks) != 0 {
		t.Fatalf("subtasks = %v, want none", got.Subtasks)
	}

	parent := []byte(`{"key":"INTL-139","fields":{"summary":"Spaans toevoegen",
		"subtasks":[
			{"key":"INTL-140","fields":{"summary":"ES toevoegen aan locales",
				"status":{"name":"In Progress"},"issuetype":{"name":"Sub-task"}}},
			{"key":"","fields":{"summary":"kapotte link"}}]}}`)
	parsed = acliIssue{}
	if err := json.Unmarshal(parent, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got = issueFromACLI("INTL-139", parsed)
	if got.ParentKey != "" {
		t.Fatalf("parent = %q, want none", got.ParentKey)
	}
	if len(got.Subtasks) != 1 {
		t.Fatalf("subtasks = %v, want the one with a key", got.Subtasks)
	}
	if got.Subtasks[0].Key != "INTL-140" || got.Subtasks[0].Title != "ES toevoegen aan locales" ||
		got.Subtasks[0].Status != "In Progress" || got.Subtasks[0].Type != "Sub-task" {
		t.Fatalf("subtask = %+v", got.Subtasks[0])
	}
}

// TestIssueReadsIssueType pins the field the plan page's hotfix gate keys off:
// Issue() now asks for `issuetype` too, so a bug is recognisable without a
// second Search() call.
func TestIssueReadsIssueType(t *testing.T) {
	var parsed acliIssue
	if err := json.Unmarshal([]byte(`{"key":"PAYM-813","fields":{"summary":"Refund faalt","issuetype":{"name":"Bug"}}}`), &parsed); err != nil {
		t.Fatal(err)
	}
	got := issueFromACLI("PAYM-813", parsed)
	if got.Type != "Bug" {
		t.Fatalf("type = %q, want Bug", got.Type)
	}
	// An issue whose payload carries no issuetype simply has none.
	var bare acliIssue
	if err := json.Unmarshal([]byte(`{"key":"PAYM-1","fields":{"summary":"x"}}`), &bare); err != nil {
		t.Fatal(err)
	}
	if issueFromACLI("PAYM-1", bare).Type != "" {
		t.Fatalf("a payload without issuetype must yield an empty type")
	}
}

// TestIssueReadsComments pins the field the plan page plans WITH: a comment
// that walks the description back (reviewer request: "kijken naar de comments
// die zijn gegeven in de jira tickets, hoofd en sub"). It also covers the two
// ADF nodes a comment carries that a description usually does not — a mention
// (whose text lives in attrs, not in a text leaf) and a hardBreak.
func TestIssueReadsComments(t *testing.T) {
	raw := []byte(`{"key":"PROD-254","fields":{"summary":"Statistieken","comment":{"comments":[
		{"id":"10142","author":{"displayName":"Reindert Vetter","accountId":"638f","avatarUrls":{"48x48":"https://x/48"}},"created":"2026-09-04T13:56:44.191+0200",
		 "body":{"type":"doc","content":[{"type":"paragraph","content":[
			{"type":"mention","attrs":{"text":"@Dennis Sloove"}},
			{"type":"text","text":" waarom een nieuwe kolom?"},
			{"type":"hardBreak"},
			{"type":"text","text":"-- hoeft dus niet."}]}]}},
		{"author":{"displayName":"Leeg"},"body":{"type":"doc","content":[]}}]}}}`)
	var parsed acliIssue
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := issueFromACLI("PROD-254", parsed)
	if len(got.Comments) != 1 {
		t.Fatalf("comments = %+v, want only the non-empty one", got.Comments)
	}
	c := got.Comments[0]
	if c.Author != "Reindert Vetter" || c.Created == "" {
		t.Fatalf("comment meta = %+v", c)
	}
	// The plan page's comment panel keys its rows on the id and mentions the
	// author back by accountId (see .claude/docs/plan-page.md).
	if c.ID != "10142" || c.AccountID != "638f" || c.AvatarURL != "https://x/48" {
		t.Fatalf("comment identity = %+v", c)
	}
	for _, want := range []string{"@Dennis Sloove", "waarom een nieuwe kolom?", "-- hoeft dus niet."} {
		if !strings.Contains(c.Body, want) {
			t.Fatalf("comment body %q misses %q", c.Body, want)
		}
	}
}

// TestIssueCapsComments keeps ONE long ticket from flooding the plan prompt:
// the newest maxIssueComments survive, in chronological order.
func TestIssueCapsComments(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"key":"PROD-1","fields":{"comment":{"comments":[`)
	for i := 0; i < maxIssueComments+5; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"author":{"displayName":"A"},"body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"c%d"}]}]}}`, i)
	}
	b.WriteString(`]}}}`)
	var parsed acliIssue
	if err := json.Unmarshal([]byte(b.String()), &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := issueFromACLI("PROD-1", parsed)
	if len(got.Comments) != maxIssueComments {
		t.Fatalf("comments = %d, want %d", len(got.Comments), maxIssueComments)
	}
	if got.Comments[0].Body != "c5" || got.Comments[len(got.Comments)-1].Body != fmt.Sprintf("c%d", maxIssueComments+4) {
		t.Fatalf("kept the wrong window: %q…%q", got.Comments[0].Body, got.Comments[len(got.Comments)-1].Body)
	}
}

// TestIssueParsesIssueLinks pins the official-link parsing the plan page's
// "referenced tickets" feature depends on: an outwardIssue entry is phrased
// with the TYPE's outward word, an inwardIssue entry with the inward word, and
// a malformed entry (neither side present) is dropped rather than producing a
// blank link.
func TestIssueParsesIssueLinks(t *testing.T) {
	raw := []byte(`{"key":"PROD-254","fields":{"summary":"Statistieken",
		"issuelinks":[
			{"type":{"inward":"is blocked by","outward":"relates to"},
			 "outwardIssue":{"key":"PROD-216","fields":{"summary":"Productgroepen","status":{"name":"In Progress"}}}},
			{"type":{"inward":"is blocked by","outward":"blocks"},
			 "inwardIssue":{"key":"PROD-300","fields":{"summary":"Migratie","status":{"name":"To Do"}}}},
			{"type":{"inward":"is blocked by","outward":"relates to"}}
		]}}`)
	var parsed acliIssue
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := issueFromACLI("PROD-254", parsed)
	if len(got.Links) != 2 {
		t.Fatalf("links = %+v, want 2 (the malformed entry dropped)", got.Links)
	}
	if got.Links[0].Key != "PROD-216" || got.Links[0].Title != "Productgroepen" || got.Links[0].Relation != "relates to" {
		t.Fatalf("outward link = %+v", got.Links[0])
	}
	if got.Links[1].Key != "PROD-300" || got.Links[1].Relation != "is blocked by" {
		t.Fatalf("inward link = %+v", got.Links[1])
	}
}
