package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/inbox"
)

// testInbox opens a throwaway inbox read-model for the manager under test.
func testInbox(t *testing.T) *inbox.Module {
	t.Helper()
	ib, err := inbox.Open(filepath.Join(t.TempDir(), "inbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ib.Close() })
	return ib
}

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
	m := NewTaskManager(engine, gh, cs, testInbox(t), nil, "test/repo")
	m.interval = 3 * time.Millisecond // fast poll for the test
	m.idle = 3 * time.Millisecond     // idle cadence too, so tests never wait 10m
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

// When the PR is merged/closed, the idle poller records it on the pr_status
// tracker and stops.
func TestPollStopsWhenPRMerged(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 7, File: "a.php", Line: 1, Author: "reindert", Body: "q",
	})
	if err != nil {
		t.Fatal(err)
	}

	prRunID, err := m.ensurePRStatus(7) // returns the tracker started at StartCodeComment
	if err != nil {
		t.Fatal(err)
	}
	if s, _ := m.engine.Status(prRunID); s != tembed.StatusWaiting {
		t.Fatalf("pr_status = %q, want waiting", s)
	}

	// The PR merges — the idle poller must observe it, record it, and complete
	// the tracker.
	gh.SetPRState("merged")
	waitFor(t, func() bool {
		s, _ := m.engine.Status(prRunID)
		return s == tembed.StatusCompleted
	})

	// The code-comment execution itself is untouched (still open/waiting).
	if s, _ := m.engine.Status(runID); s != tembed.StatusWaiting {
		t.Fatalf("comment run = %q, want waiting", s)
	}
}

// An active reviewer (recent heartbeat) keeps the fast cadence and never checks
// the PR state, so a merged PR does not stop the poller.
func TestHeartbeatKeepsActive(t *testing.T) {
	m, gh, _ := newTestManager(t)
	m.interval = 20 * time.Millisecond // first tick fires after the setup below
	m.idle = time.Hour                 // if the poller ever went idle it would stall the test
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 8, File: "a.php", Line: 1, Author: "reindert", Body: "q",
	})
	if err != nil {
		t.Fatal(err)
	}
	prRunID, _ := m.ensurePRStatus(8)

	m.Heartbeat(runID) // reviewer is active → fast cadence, no PR-state check
	gh.SetPRState("merged")

	// A GitHub reply still flows (the fast poller runs)...
	gh.EnqueueReply(github.Reply{ID: 1, Author: "colleague", Body: "ok"})
	waitFor(t, func() bool {
		hist, _ := m.engine.History(runID)
		for _, ev := range hist {
			if ev.Type == tembed.EventSignalReceived && ev.Name == SignalReply {
				return true
			}
		}
		return false
	})
	// ...but the merged PR is ignored while active: the tracker stays waiting.
	if s, _ := m.engine.Status(prRunID); s != tembed.StatusWaiting {
		t.Fatalf("pr_status = %q, want waiting (active reviewer ignores PR state)", s)
	}
}

func TestPRInboxRefreshPopulatesReadModel(t *testing.T) {
	// Offline: the refreshInbox Activity reads the fixture instead of GitHub.
	t.Setenv("SLASH_GITHUB", "off")
	t.Setenv("SLASH_INBOX", "tests/fixtures/inbox.json")

	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ib := testInbox(t)
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, ib, db, repoSlug)

	runID, err := engine.StartWorkflow(WorkflowPRInbox, PRInboxInput{Repo: repoSlug})
	if err != nil {
		t.Fatal(err)
	}
	// Before any refresh, the read-model is empty (no direct GitHub read exists).
	if snap, _ := ib.Get(context.Background(), repoSlug); snap != nil {
		t.Fatalf("read-model populated before any refresh: %+v", snap)
	}
	// A refresh signal drives the fetch+save Activity synchronously.
	if err := m.RefreshInbox(runID); err != nil {
		t.Fatal(err)
	}
	snap, err := ib.Get(context.Background(), repoSlug)
	if err != nil || snap == nil {
		t.Fatalf("read-model empty after refresh (err=%v)", err)
	}
	var sections []inboxSection
	if err := json.Unmarshal(snap.Sections, &sections); err != nil {
		t.Fatalf("sections json: %v", err)
	}
	found := false
	for _, s := range sections {
		for _, p := range s.PRs {
			if p.Number == 12903 {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("expected PR 12903 in the refreshed inbox, got %+v", sections)
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

	ib := testInbox(t)
	e1 := tembed.New(store)
	NewTaskManager(e1, gh, cs, ib, nil, "test/repo")
	runID, err := e1.StartWorkflow(WorkflowTaskCodeComment, CodeCommentInput{PR: 1, File: "a.php", Line: 1, Body: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("posted %d, want 1", gh.PostedCount())
	}

	// Restart: a new engine over the same store must not re-post the comment.
	e2 := tembed.New(store)
	NewTaskManager(e2, gh, cs, ib, nil, "test/repo")
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
