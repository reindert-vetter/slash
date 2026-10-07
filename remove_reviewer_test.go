package main

import (
	"context"
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
	pm := testPRMeta(t)
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.StartRemoveReviewer(RemoveReviewerInput{PR: 12888}); err != nil {
		t.Fatal(err)
	}

	// The PR is also marked locally as "not my review", so the inbox's
	// reviewed-by:@me COMMENTED catch skips it (GitHub keeps listing me).
	marks, err := pm.ReviewerLeftMarks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(marks) != 1 || marks[0].PR != 12888 || marks[0].Repo != "" || marks[0].At == "" {
		t.Fatalf("reviewer-left marks = %+v, want one stamped mark on 12888", marks)
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
	pm := testPRMeta(t)
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.StartRemoveReviewer(RemoveReviewerInput{PR: 12888}); err == nil {
		t.Fatal("want an error when the authenticated user is unknown")
	}
	if marks, _ := pm.ReviewerLeftMarks(context.Background()); len(marks) != 0 {
		t.Fatalf("a failed removal must not leave a mark, got %+v", marks)
	}
	if _, _, ok := gh.LastRemovedReviewer(); ok {
		t.Fatal("RemoveReviewer must not be called without a known login")
	}
}
