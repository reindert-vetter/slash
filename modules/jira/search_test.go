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

// TestParseSearchReadsAssignee pins the assignee half of the same payload: a
// real person becomes name + 24x24 avatar, and an UNASSIGNED issue comes back
// as a literal `null` (verified live) which must read as "nobody" rather than
// as a person with an empty name — the UI turns that into a question-mark
// circle (see .claude/docs/pr-overview.md).
func TestParseSearchReadsAssignee(t *testing.T) {
	out := []byte(`[
	  {"key":"CLUS-591","fields":{"summary":"Api calls","assignee":{"displayName":"Reindert Vetter","avatarUrls":{"24x24":"https://avatar/24"}}}},
	  {"key":"CLUS-592","fields":{"summary":"Notify tenants","assignee":null}}
	]`)
	got, err := parseSearch(out)
	if err != nil {
		t.Fatalf("parseSearch: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Assignee != "Reindert Vetter" || got[0].AssigneeAvatarURL != "https://avatar/24" {
		t.Fatalf("assigned issue = %+v", got[0])
	}
	if got[1].Assignee != "" || got[1].AssigneeAvatarURL != "" {
		t.Fatalf("unassigned issue = %+v, want no assignee at all", got[1])
	}
}

// TestIssuesByKeySkipsAnythingThatIsNotAKey — the one non-constant JQL in this
// module builds its `key in (…)` list itself, so every key must pass the same
// keyPattern gate Issue() uses before it can reach the argv entry. Nothing
// usable left means no call at all, not an empty-set query.
func TestIssuesByKeyRejectsUnusableKeys(t *testing.T) {
	m := New()
	got, err := m.IssuesByKey(nil, []string{"", "  ", "not a key", "PROJ-1) OR (1=1"})
	if err != nil {
		t.Fatalf("IssuesByKey: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %+v, want nothing (and no acli call)", got)
	}
}
