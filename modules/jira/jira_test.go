package jira

import (
	"context"
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
	if empty != (Issue{}) {
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

// TestFakeAssignedToMeRoundTrip asserts the Fake's AssignedToMe returns
// exactly what was programmed (empty by default), so the task-inbox "jira"
// task source can be tested without acli/network.
func TestFakeAssignedToMeRoundTrip(t *testing.T) {
	f := &Fake{}
	got, err := f.AssignedToMe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("default AssignedToMe = %+v, want empty", got)
	}

	want := []Issue{
		{Key: "INTEG-1", Title: "A", Status: "To Do", URL: "https://x/INTEG-1"},
		{Key: "INTEG-2", Title: "B", Status: "In Progress", URL: "https://x/INTEG-2"},
	}
	f.SetAssigned(want)
	got, err = f.AssignedToMe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Key != "INTEG-1" || got[1].Status != "In Progress" {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
