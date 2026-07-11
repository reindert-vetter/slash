package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
)

// fakeGitHub is an in-memory GitHubReviewer. The test enqueues replies and the
// poller picks them up, exactly like the real gh polling would.
type fakeGitHub struct {
	mu       sync.Mutex
	nextID   int64
	posted   []string      // bodies posted (root + replies), in order
	rootLine string        // the initial line comment body
	replies  []ReviewReply // what FetchReplies returns
}

func (f *fakeGitHub) PostLineComment(_ context.Context, pr int, file string, line int, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.rootLine = body
	f.posted = append(f.posted, body)
	return f.nextID, nil
}

func (f *fakeGitHub) Reply(_ context.Context, pr int, inReplyTo int64, body string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.posted = append(f.posted, body)
	return f.nextID, nil
}

func (f *fakeGitHub) FetchReplies(_ context.Context, pr int, rootID int64) ([]ReviewReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]ReviewReply, len(f.replies))
	copy(out, f.replies)
	return out, nil
}

func (f *fakeGitHub) enqueueReply(r ReviewReply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies = append(f.replies, r)
}

func (f *fakeGitHub) postedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.posted)
}

// waitFor polls cond until it is true or the deadline passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestReviewTaskConversation(t *testing.T) {
	gh := &fakeGitHub{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewReviewManager(engine, gh, 3*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartReview(ctx, ReviewCommentInput{
		PR:   123,
		File: "src/Order.php",
		Line: 42,
		Body: "This branch looks unreachable — can you confirm?",
	})
	if err != nil {
		t.Fatal(err)
	}

	// The initial comment is posted synchronously and the workflow now waits.
	if gh.rootLine == "" {
		t.Fatal("initial comment was not posted")
	}
	if s, _ := engine.Status(runID); s != tembed.StatusWaiting {
		t.Fatalf("status = %s, want waiting", s)
	}

	// First reply (a question) → the workflow should post one extra comment.
	gh.enqueueReply(ReviewReply{ID: 1, Author: "reviewer", Body: "why unreachable?"})
	waitFor(t, func() bool { return gh.postedCount() == 2 })

	// Second reply resolves the thread → the workflow completes.
	gh.enqueueReply(ReviewReply{ID: 2, Author: "reviewer", Body: "ok, agreed /resolve", Done: true})
	waitFor(t, func() bool {
		s, _ := engine.Status(runID)
		return s == tembed.StatusCompleted
	})

	var sum reviewSummary
	if err := engine.Result(runID, &sum); err != nil {
		t.Fatal(err)
	}
	if sum.Replies != 2 {
		t.Fatalf("summary.Replies = %d, want 2", sum.Replies)
	}
	// posted = [root comment, one follow-up reply]; the resolving reply gets no
	// follow-up.
	if gh.postedCount() != 2 {
		t.Fatalf("posted %d comments, want 2", gh.postedCount())
	}
}

// TestReviewTaskSurvivesRestart proves durability: a second engine over the same
// store resumes the waiting conversation without re-posting the root comment.
func TestReviewTaskSurvivesRestart(t *testing.T) {
	store := tembed.NewMemoryStore()
	gh := &fakeGitHub{}

	// First engine: start the review, let it post + block.
	e1 := tembed.New(store)
	NewReviewManager(e1, gh, time.Hour) // long interval: no polling in this phase
	runID, err := e1.StartWorkflow(reviewWorkflow, ReviewCommentInput{PR: 1, File: "a.php", Line: 1, Body: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if gh.postedCount() != 1 {
		t.Fatalf("posted %d, want 1", gh.postedCount())
	}

	// Second engine over the same store (simulated restart).
	e2 := tembed.New(store)
	NewReviewManager(e2, gh, time.Hour)
	if err := e2.Recover(); err != nil {
		t.Fatal(err)
	}
	// The root comment must NOT have been posted again.
	if gh.postedCount() != 1 {
		t.Fatalf("after restart posted %d, want 1 (no re-post)", gh.postedCount())
	}

	// A resolving reply delivered to the recovered engine completes the run.
	if err := e2.SignalWorkflow(runID, replySignal, ReviewReply{ID: 9, Done: true}); err != nil {
		t.Fatal(err)
	}
	if s, _ := e2.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %s, want completed", s)
	}
}
