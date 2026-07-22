package main

import (
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
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
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	runID, err := m.StartSubmitReview(SubmitReviewInput{PR: 42, Event: "APPROVE"})
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

	runID2, err := m.StartSubmitReview(SubmitReviewInput{PR: 42, Event: "REQUEST_CHANGES", Body: "please fix X"})
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
