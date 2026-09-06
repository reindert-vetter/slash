package jira

import "testing"

// TestParseSearchReadsKeyStatusAndType pins the shape of
// `acli jira workitem search --json`: a bare array of issue objects whose
// fields envelope nests status/issuetype as objects with a "name".
func TestParseSearchReadsKeyStatusAndType(t *testing.T) {
	out := []byte(`[
	  {"key":"PROD-254","fields":{"summary":"Statistieken","status":{"name":"To Do"},"issuetype":{"name":"Sub-task"}}},
	  {"key":"BUG-5405","fields":{"summary":"Fout","status":{"name":"In Review"},"issuetype":{"name":"Bug"}}},
	  {"fields":{"summary":"no key, dropped"}}
	]`)
	got, err := parseSearch(out)
	if err != nil {
		t.Fatalf("parseSearch: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (a keyless row is dropped): %+v", len(got), got)
	}
	if got[0].Key != "PROD-254" || got[0].Title != "Statistieken" || got[0].Status != "To Do" || got[0].Type != "Sub-task" {
		t.Fatalf("first issue = %+v", got[0])
	}
	if got[0].URL != baseURL+"PROD-254" {
		t.Fatalf("url = %q", got[0].URL)
	}
	if got[1].Status != "In Review" {
		t.Fatalf("second status = %q", got[1].Status)
	}
}

// TestParseSearchEmptyIsNotAnError — no matching issues is an ordinary,
// empty answer, never an error the overview would have to render.
func TestParseSearchEmptyIsNotAnError(t *testing.T) {
	for _, in := range []string{"", "   \n", "[]"} {
		got, err := parseSearch([]byte(in))
		if err != nil {
			t.Fatalf("parseSearch(%q): %v", in, err)
		}
		if len(got) != 0 {
			t.Fatalf("parseSearch(%q) = %+v, want empty", in, got)
		}
	}
}
