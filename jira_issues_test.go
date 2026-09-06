package main

import (
	"context"
	"testing"

	"slash/modules/jira"
)

// TestFetchJiraIssuesDedupesSprintIssues pins the one non-obvious rule of the
// two issue sections: an issue that is BOTH still "To Do" and in the active
// sprint matches both JQL queries, and must be shown once — in Planning, the
// section furthest along the pipeline.
func TestFetchJiraIssuesDedupesSprintIssues(t *testing.T) {
	t.Setenv("SLASH_JIRA", "")
	f := &jira.Fake{}
	f.SetSearch(planningJQL, []jira.Issue{{Key: "PROD-1", Status: "To Do"}, {Key: "PROD-2", Status: "In Progress"}})
	f.SetSearch(todoJQL, []jira.Issue{{Key: "PROD-1", Status: "To Do"}, {Key: "PROD-9", Status: "To Do"}})

	got := fetchJiraIssues(context.Background(), f)
	if got.Error != "" {
		t.Fatalf("error = %q", got.Error)
	}
	if len(got.Planning) != 2 {
		t.Fatalf("planning = %+v, want both sprint issues", got.Planning)
	}
	if len(got.Todo) != 1 || got.Todo[0].Key != "PROD-9" {
		t.Fatalf("todo = %+v, want only the issue not already in the sprint", got.Todo)
	}
}

// TestFetchJiraIssuesOffIsEmptyNotAnError — with Jira switched off (offline,
// tests) the sections are simply absent; the endpoint still answers ok.
func TestFetchJiraIssuesOffIsEmptyNotAnError(t *testing.T) {
	t.Setenv("SLASH_JIRA", "off")
	got := fetchJiraIssues(context.Background(), &jira.Fake{})
	if !got.OK || got.Error == "" {
		t.Fatalf("got %+v, want ok with a reason", got)
	}
	if len(got.Planning) != 0 || len(got.Todo) != 0 {
		t.Fatalf("lists = %+v/%+v, want empty", got.Planning, got.Todo)
	}
}

// TestGroupPlanningNestsSubtasksUnderTheirParent pins the three halves of the
// grouping rule: a Sub-task whose parent is in the list moves under it (the
// group taking the earliest member's position), a Sub-task whose parent is NOT
// in the list gets that parent pulled in as an unclickable context row above
// it, and a Sub-task that does not know its parent yet learns it through a
// per-issue read (the search cannot return one, see modules/jira/search.go).
func TestGroupPlanningNestsSubtasksUnderTheirParent(t *testing.T) {
	f := &jira.Fake{}
	f.SetIssue("PROD-254", jira.Issue{Key: "PROD-254", ParentKey: "STAT-900", ParentTitle: "Search parent"})
	f.SetIssue("STAT-900", jira.Issue{Key: "STAT-900", Title: "Fetched parent", Type: "Story"})
	list := []jira.Issue{
		{Key: "PROD-254", Type: "Sub-task"},
		{Key: "BUG-5405", Type: "Bug"},
		{Key: "INTEG-445", Type: "Story"},
		{Key: "INTEG-404", Type: "Sub-task", ParentKey: "INTEG-445"},
	}

	got := groupPlanning(context.Background(), f, list)
	var keys []string
	for _, r := range got {
		keys = append(keys, r.Key)
	}
	want := []string{"STAT-900", "PROD-254", "BUG-5405", "INTEG-445", "INTEG-404"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
	if !got[0].Context || got[0].Title != "Fetched parent" {
		t.Fatalf("missing parent = %+v, want a context row read via Issue()", got[0])
	}
	for _, r := range got[1:] {
		if r.Context {
			t.Fatalf("row %s is marked context, but it is in the list itself", r.Key)
		}
	}
}

// TestGroupPlanningKeepsAnUnreadableParentOut — the enrichment is best-effort:
// a parent that cannot be read (offline, no permission) yields no context row,
// and its Sub-task simply stays an ordinary top-level row.
func TestGroupPlanningKeepsAnUnreadableParentOut(t *testing.T) {
	got := groupPlanning(context.Background(), &jira.Fake{}, []jira.Issue{
		{Key: "PROD-254", Type: "Sub-task", ParentKey: "STAT-900", ParentTitle: "Search parent"},
	})
	if len(got) != 1 || got[0].Key != "PROD-254" || got[0].Context {
		t.Fatalf("got %+v, want just the Sub-task itself", got)
	}
}
