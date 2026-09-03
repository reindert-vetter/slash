package main

import (
	"context"
	"errors"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/prmeta"
)

// TestValidateSubmitReview is a pure, fast table test of the request-validation
// rule enforced before the submit_review workflow ever starts: pr must be
// positive, event must be APPROVE or REQUEST_CHANGES, and a REQUEST_CHANGES
// review must carry a non-empty body (GitHub itself rejects a bodyless one) —
// an APPROVE may be bodyless.
func TestValidateSubmitReview(t *testing.T) {
	cases := []struct {
		name    string
		in      SubmitReviewInput
		wantErr bool
	}{
		{"approve without body is valid", SubmitReviewInput{PR: 1, Event: "APPROVE"}, false},
		{"request-changes with body is valid", SubmitReviewInput{PR: 1, Event: "REQUEST_CHANGES", Body: "please fix X"}, false},
		{"request-changes without body is rejected", SubmitReviewInput{PR: 1, Event: "REQUEST_CHANGES"}, true},
		{"request-changes with whitespace-only body is rejected", SubmitReviewInput{PR: 1, Event: "REQUEST_CHANGES", Body: "   "}, true},
		{"unknown event is rejected", SubmitReviewInput{PR: 1, Event: "COMMENT", Body: "x"}, true},
		{"non-positive pr is rejected", SubmitReviewInput{PR: 0, Event: "APPROVE"}, true},
		{"event is normalised (lowercase + whitespace)", SubmitReviewInput{PR: 1, Event: " approve "}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := c.in
			err := validateSubmitReview(&in)
			if (err != nil) != c.wantErr {
				t.Fatalf("validateSubmitReview(%+v) error = %v, wantErr %v", c.in, err, c.wantErr)
			}
		})
	}
}

// TestSubmitReviewWorkflowPassesEventAndBody proves the submit_review workflow
// passes the event/body through to the github module unchanged, for both
// APPROVE (bodyless) and REQUEST_CHANGES (with body) — using github.Fake, no
// real network (mirrors the SLASH_GITHUB=off test posture used elsewhere).
func TestSubmitReviewWorkflowPassesEventAndBody(t *testing.T) {
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	runID, err := m.StartSubmitReview(context.Background(), SubmitReviewInput{PR: 42, Event: "APPROVE"})
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("StartSubmitReview returned an empty run ID")
	}
	if got := gh.LastReviewEvent(); got != "APPROVE" {
		t.Fatalf("event = %q, want APPROVE", got)
	}
	if got := gh.LastReviewBody(); got != "" {
		t.Fatalf("body = %q, want empty", got)
	}

	runID2, err := m.StartSubmitReview(context.Background(), SubmitReviewInput{PR: 42, Event: "REQUEST_CHANGES", Body: "please fix X"})
	if err != nil {
		t.Fatal(err)
	}
	if runID2 == runID {
		t.Fatal("expected a distinct run for the second submission")
	}
	if got := gh.LastReviewEvent(); got != "REQUEST_CHANGES" {
		t.Fatalf("event = %q, want REQUEST_CHANGES", got)
	}
	if got := gh.LastReviewBody(); got != "please fix X" {
		t.Fatalf("body = %q, want %q", got, "please fix X")
	}
	if gh.ReviewSubmittedCount() != 2 {
		t.Fatalf("ReviewSubmittedCount = %d, want 2", gh.ReviewSubmittedCount())
	}
}

// TestStartSubmitReviewRejectsSelfReview proves a review is refused, without
// ever starting the submit_review workflow (no run is created at all), when
// the PR's stored author and the authenticated gh user are the same login —
// GitHub itself refuses this, so it fails fast with a readable message
// instead of a bare "exit status 1" reaching the failed-tasks list.
func TestStartSubmitReviewRejectsSelfReview(t *testing.T) {
	gh := &github.Fake{}
	gh.SetCurrentUser(github.Collaborator{Login: "reindert-vetter"})
	engine := tembed.New(tembed.NewMemoryStore())
	pm := testPRMeta(t)
	if err := pm.SaveBasics(t.Context(), prmeta.Meta{PR: 42, Author: "reindert-vetter"}); err != nil {
		t.Fatal(err)
	}
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	before, err := engine.Runs()
	if err != nil {
		t.Fatal(err)
	}

	_, err = m.StartSubmitReview(context.Background(), SubmitReviewInput{PR: 42, Event: "APPROVE"})
	if !errors.Is(err, errSelfReview) {
		t.Fatalf("err = %v, want errSelfReview", err)
	}
	if gh.ReviewSubmittedCount() != 0 {
		t.Fatalf("ReviewSubmittedCount = %d, want 0 — gh must never be called", gh.ReviewSubmittedCount())
	}

	after, err := engine.Runs()
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("run count changed from %d to %d — a doomed self-review must never start a workflow", len(before), len(after))
	}

	// A DIFFERENT author (or an unknown current user) must still work normally.
	if err := pm.SaveBasics(t.Context(), prmeta.Meta{PR: 43, Author: "someone-else"}); err != nil {
		t.Fatal(err)
	}
	runID, err := m.StartSubmitReview(context.Background(), SubmitReviewInput{PR: 43, Event: "APPROVE"})
	if err != nil {
		t.Fatalf("submit review for another author's PR failed: %v", err)
	}
	if runID == "" {
		t.Fatal("expected a real run ID for another author's PR")
	}
}

// TestGithubModuleRejectsUnknownReviewEvent proves the real modules/github
// Module — not the test Fake, which unconditionally records — rejects an
// event outside {APPROVE, REQUEST_CHANGES} before it would ever reach `gh`,
// per the project rule to validate input before it reaches exec.CommandContext.
// This is defense in depth behind validateSubmitReview's own rejection of the
// same input at the HTTP layer.
func TestGithubModuleRejectsUnknownReviewEvent(t *testing.T) {
	mod := github.New("test/repo")
	if err := mod.SubmitReview(t.Context(), 42, "COMMENT", "x"); err == nil {
		t.Fatal("expected an error for an unsupported review event")
	}
}
