package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/comments"
	"slash/modules/github"
)

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

func newTestManager(t *testing.T) (*TaskManager, *github.Fake, *comments.Module) {
	t.Helper()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs)
	m.interval = 3 * time.Millisecond // fast poll for the test
	return m, gh, cs
}

func TestTaskCodeCommentFlow(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "This branch looks unreachable.",
	})
	if err != nil {
		t.Fatal(err)
	}

	// The comment was posted to GitHub and stored by the comments module.
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	list, _ := cs.List(ctx, 42)
	if len(list) != 1 || list[0].ID != runID || list[0].Status != "open" {
		t.Fatalf("comments = %+v", list)
	}

	// A UI reaction hooks onto the comment (stored + mirrored to GitHub).
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "please clarify"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 2 }) // mirrored reply
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, 42)
		return len(l) == 1 && l[0].ReactionCount == 1
	})

	// A GitHub reaction arrives via the poller.
	gh.EnqueueReply(github.Reply{ID: 1, Author: "colleague", Body: "agreed"})
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, 42)
		return len(l) == 1 && l[0].ReactionCount == 2
	})

	// A resolving reaction (Done, no "/resolve" text) closes the thread and
	// completes the execution — the Done flag alone must resolve the comment.
	gh.EnqueueReply(github.Reply{ID: 2, Author: "colleague", Body: "looks fine now", Done: true})
	waitFor(t, func() bool {
		s, _ := m.engine.Status(runID)
		return s == tembed.StatusCompleted
	})

	l, _ := cs.List(ctx, 42)
	if l[0].Status != "resolved" {
		t.Fatalf("status = %q, want resolved", l[0].Status)
	}
	if l[0].ReactionCount != 3 {
		t.Fatalf("reactionCount = %d, want 3", l[0].ReactionCount)
	}
	if len(l[0].Reactions) != 3 {
		t.Fatalf("reactions = %d, want 3", len(l[0].Reactions))
	}
}

func TestTaskSurvivesRestart(t *testing.T) {
	store := tembed.NewMemoryStore()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	gh := &github.Fake{}

	e1 := tembed.New(store)
	NewTaskManager(e1, gh, cs)
	runID, err := e1.StartWorkflow(WorkflowTaskCodeComment, CodeCommentInput{PR: 1, File: "a.php", Line: 1, Body: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("posted %d, want 1", gh.PostedCount())
	}

	// Restart: a new engine over the same store must not re-post the comment.
	e2 := tembed.New(store)
	NewTaskManager(e2, gh, cs)
	if err := e2.Recover(); err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("after restart posted %d, want 1 (no re-post)", gh.PostedCount())
	}

	if err := e2.SignalWorkflow(runID, SignalReply, ReactionSignal{ID: "gh-9", Source: "github", Body: "done /resolve", Done: true}); err != nil {
		t.Fatal(err)
	}
	if s, _ := e2.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %s, want completed", s)
	}
}
