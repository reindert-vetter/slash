package main

import (
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
)

// TestRemoveReviewerWorkflow proves the workflow removes the AUTHENTICATED user
// (never a login taken from the request, which carries only the PR number) from
// the PR's requested reviewers — via the Fake, so no network is touched.
func TestRemoveReviewerWorkflow(t *testing.T) {
	gh := &github.Fake{}
	gh.SetCurrentUser(github.Collaborator{Login: "reindert-vetter"})

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.StartRemoveReviewer(RemoveReviewerInput{PR: 12888}); err != nil {
		t.Fatal(err)
	}

	pr, login, ok := gh.LastRemovedReviewer()
	if !ok {
		t.Fatal("RemoveReviewer was never called")
	}
	if pr != 12888 || login != "reindert-vetter" {
		t.Fatalf("RemoveReviewer(%d, %q), want (12888, \"reindert-vetter\")", pr, login)
	}
}

// TestRemoveReviewerWorkflowWithoutCurrentUser proves the workflow fails loudly
// when the local login is unknown (offline / SLASH_GITHUB=off): removing "me"
// is meaningless then, and silently dropping nobody would look like success.
func TestRemoveReviewerWorkflowWithoutCurrentUser(t *testing.T) {
	gh := &github.Fake{} // no SetCurrentUser: an empty login, like an offline run

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.StartRemoveReviewer(RemoveReviewerInput{PR: 12888}); err == nil {
		t.Fatal("want an error when the authenticated user is unknown")
	}
	if _, _, ok := gh.LastRemovedReviewer(); ok {
		t.Fatal("RemoveReviewer must not be called without a known login")
	}
}
