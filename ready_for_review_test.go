package main

import (
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/reviewerusage"
)

// TestValidateReadyForReview covers the request validation: pr must be
// positive, reviewer logins are trimmed + de-duplicated, and an invalid
// GitHub username is rejected before the workflow starts.
func TestValidateReadyForReview(t *testing.T) {
	if err := validateReadyForReview(&ReadyForReviewInput{PR: 0}); err == nil {
		t.Fatal("expected error for non-positive pr")
	}
	if err := validateReadyForReview(&ReadyForReviewInput{PR: 1, Reviewers: []string{"bad login!"}}); err == nil {
		t.Fatal("expected error for an invalid reviewer login")
	}
	in := ReadyForReviewInput{PR: 1, Reviewers: []string{" alice ", "alice", "", "bob"}}
	if err := validateReadyForReview(&in); err != nil {
		t.Fatal(err)
	}
	if len(in.Reviewers) != 2 || in.Reviewers[0] != "alice" || in.Reviewers[1] != "bob" {
		t.Fatalf("reviewers = %v, want [alice bob] (trimmed + deduped)", in.Reviewers)
	}
}

// TestReadyForReviewWorkflow proves the workflow marks the PR ready, requests
// the reviewers, and bumps the local usage counts — all via the Fake (no
// network). A second run bumps alice again, so she sorts ahead of bob in the
// most-used-first Reviewers() view.
func TestReadyForReviewWorkflow(t *testing.T) {
	gh := &github.Fake{}
	gh.SetCollaborators([]github.Collaborator{{Login: "bob"}, {Login: "alice"}, {Login: "carol"}})
	ru, err := reviewerusage.Open("file:rfr_test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer ru.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.reviewerusage = ru

	if _, err := m.StartReadyForReview(ReadyForReviewInput{PR: 7, Reviewers: []string{"alice", "bob"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartReadyForReview(ReadyForReviewInput{PR: 9, Reviewers: []string{"alice"}}); err != nil {
		t.Fatal(err)
	}

	if gh.ReadyForReviewCount() != 2 {
		t.Fatalf("ReadyForReviewCount = %d, want 2", gh.ReadyForReviewCount())
	}
	if got := gh.LastRequestedReviewers(); len(got) != 1 || got[0] != "alice" {
		t.Fatalf("last requested reviewers = %v, want [alice]", got)
	}

	// Reviewers() = collaborators sorted most-used-first: alice(2), bob(1),
	// then carol(0, never assigned) alphabetically last.
	cands, err := m.Reviewers(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 3 {
		t.Fatalf("want 3 candidates, got %d: %+v", len(cands), cands)
	}
	if cands[0].Login != "alice" || cands[0].Count != 2 {
		t.Fatalf("cand 0 = %+v, want alice/2", cands[0])
	}
	if cands[1].Login != "bob" || cands[1].Count != 1 {
		t.Fatalf("cand 1 = %+v, want bob/1", cands[1])
	}
	if cands[2].Login != "carol" || cands[2].Count != 0 {
		t.Fatalf("cand 2 = %+v, want carol/0", cands[2])
	}
}

// TestReadyForReviewWorkflowNoReviewers proves the reviewer/usage Activities
// are skipped when no reviewers are given — only the mark-ready call happens.
func TestReadyForReviewWorkflowNoReviewers(t *testing.T) {
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.StartReadyForReview(ReadyForReviewInput{PR: 7}); err != nil {
		t.Fatal(err)
	}
	if gh.ReadyForReviewCount() != 1 {
		t.Fatalf("ReadyForReviewCount = %d, want 1", gh.ReadyForReviewCount())
	}
	if got := gh.LastRequestedReviewers(); got != nil {
		t.Fatalf("expected no reviewer request, got %v", got)
	}
}
