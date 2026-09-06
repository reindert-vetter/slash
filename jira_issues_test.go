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
