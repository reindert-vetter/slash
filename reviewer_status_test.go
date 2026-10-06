package main

import (
	"context"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
)

// TestReviewerStatus proves which GitHub facts count as "already a reviewer"
// (so no question before an inline comment): the author, a personal or team
// request (both folded into Requested by the module), or any submitted
// review — and that an unknown login yields "unknown" rather than a guess.
func TestReviewerStatus(t *testing.T) {
	ctx := context.Background()
	newManager := func(gh *github.Fake) *TaskManager {
		engine := tembed.New(tembed.NewMemoryStore())
		return NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	}

	if known, _ := newManager(&github.Fake{}).ReviewerStatus(ctx, "", 1); known {
		t.Fatal("without a known login the status must be unknown")
	}

	gh := &github.Fake{}
	m := newManager(gh)
	gh.SetCurrentUser(github.Collaborator{Login: "reindert-vetter"})
	gh.SetReviewerFacts(1, github.ReviewerFacts{Author: "someone"})
	gh.SetReviewerFacts(2, github.ReviewerFacts{Author: "Reindert-Vetter"})
	gh.SetReviewerFacts(3, github.ReviewerFacts{Author: "someone", Requested: true})
	gh.SetReviewerFacts(4, github.ReviewerFacts{Author: "someone", Reviewed: true})
	for pr, want := range map[int]bool{1: false, 2: true, 3: true, 4: true} {
		known, reviewer := m.ReviewerStatus(ctx, "", pr)
		if !known || reviewer != want {
			t.Errorf("pr %d: known=%v reviewer=%v, want known=true reviewer=%v", pr, known, reviewer, want)
		}
	}
}
