package jira

import (
	"context"
	"encoding/json"
	"reflect"
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
