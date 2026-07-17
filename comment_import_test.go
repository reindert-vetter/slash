package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"

	"slash/modules/comments"
	"slash/modules/github"
)

// writeWorktreeFile writes rel into the pr's base+head worktrees under dataDir
// (both sides get the same content unless the test overwrites one).
func writeWorktreeFile(t *testing.T, dataDir string, pr int, rel, base, head string) {
	t.Helper()
	baseDir, headDir := worktreeDirs(dataDir, pr)
	for dir, content := range map[string]string{baseDir: base, headDir: head} {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

const orderPHP = `<?php
class Order {
    public function total() {
        $x = 1;
        return $x;
    }
}
`

// A RIGHT-side review comment on a line inside a block maps to that block plus
// the aligned-row index of the line (identical base/head → row = line - start).
func TestMapReviewCommentAnchorsToBlockRow(t *testing.T) {
	dir := t.TempDir()
	pr := 91
	writeWorktreeFile(t, dir, pr, "Order.php", orderPHP, orderPHP)

	// The method declaration `public function total() {` is on line 3.
	b := Block{PR: pr, File: "Order.php", Class: "Order", Name: "total",
		Line: 3, EndLine: 6, Label: "Order::total", Status: "modified", Side: "new"}

	gc := github.ReviewComment{ID: 555, Author: "colleague", Body: "why 1?",
		Path: "Order.php", Line: 4, Side: "RIGHT"}
	in := mapReviewComment(dir, pr, []Block{b}, gc)

	if in.Source != "github" || in.ImportedRootID != 555 || in.Kind != "" {
		t.Fatalf("import meta = source=%q root=%d kind=%q", in.Source, in.ImportedRootID, in.Kind)
	}
	if in.File != "Order.php" || in.Label != "Order::total" || in.Side != "RIGHT" || in.Gran != "line" {
		t.Fatalf("anchor = file=%q label=%q side=%q gran=%q", in.File, in.Label, in.Side, in.Gran)
	}
	// Identical base/head → the aligned-row index of a new-side line is
	// line - blockStart. The block declaration (line 3) is row 0, so line 4 → row 1.
	if want := gc.Line - b.Line; in.RowStart != want || in.RowEnd != want {
		t.Fatalf("rowStart=%d rowEnd=%d, want %d", in.RowStart, in.RowEnd, want)
	}
}

// A review comment whose anchor falls in no block degrades to a PR-wide comment.
func TestMapReviewCommentNoBlockIsPRWide(t *testing.T) {
	dir := t.TempDir()
	pr := 91
	gc := github.ReviewComment{ID: 7, Body: "general note", Path: "Untracked.php", Line: 99, Side: "RIGHT"}
	in := mapReviewComment(dir, pr, nil, gc)
	if in.Kind != "review" || in.Label != "" || in.RowStart != -1 {
		t.Fatalf("PR-wide = kind=%q label=%q rowStart=%d", in.Kind, in.Label, in.RowStart)
	}
	if in.File != "Untracked.php" || in.ImportedRootID != 7 {
		t.Fatalf("file=%q root=%d", in.File, in.ImportedRootID)
	}
}

// mapGeneralComment carries kind + import meta and no anchor.
func TestMapGeneralComment(t *testing.T) {
	in := mapGeneralComment(91, github.GeneralComment{ID: 12, Author: "a", Body: "overall LGTM", Kind: "review_summary"})
	if in.Kind != "review_summary" || in.Source != "github" || in.ImportedRootID != 12 || in.RowStart != -1 || in.File != "" {
		t.Fatalf("general = %+v", in)
	}
}

// importPRComments imports existing GitHub review + PR-wide comments into the
// read-model as github-sourced comments, never re-posts them to GitHub, and is
// idempotent across repeated imports (the deterministic gh-<id> Run ID makes the
// second start a no-op).
func TestImportPRCommentsIntoReadModel(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42

	gh.SetReviewComments([]github.ReviewComment{
		{ID: 100, Author: "colleague", Body: "review note", Path: "src/Order.php", Line: 10, Side: "RIGHT"},
	})
	gh.SetGeneralComments([]github.GeneralComment{
		{ID: 200, Author: "boss", Body: "please add a test", Kind: "issue"},
		{ID: 300, Author: "boss", Body: "approving with nits", Kind: "review_summary"},
	})

	m.importPRComments(ctx, pr)

	list, _ := cs.List(ctx, pr)
	if len(list) != 3 {
		t.Fatalf("imported %d comments, want 3: %+v", len(list), list)
	}
	byID := map[string]int{}
	for i, c := range list {
		byID[c.ID] = i
		if c.Source != "github" {
			t.Fatalf("comment %s source=%q, want github", c.ID, c.Source)
		}
	}
	for _, want := range []string{"gh-100", "gh-200", "gh-300"} {
		if _, ok := byID[want]; !ok {
			t.Fatalf("missing imported comment %s: got %+v", want, list)
		}
	}
	if k := list[byID["gh-200"]].Kind; k != "issue" {
		t.Fatalf("gh-200 kind=%q, want issue", k)
	}
	// Imported comments already live on GitHub: they must never be re-posted.
	if gh.PostedCount() != 0 {
		t.Fatalf("github posted %d, want 0 (imports must not re-post)", gh.PostedCount())
	}

	// A second import is a no-op reuse: still exactly three comments, still no posts.
	m.importPRComments(ctx, pr)
	list2, _ := cs.List(ctx, pr)
	if len(list2) != 3 {
		t.Fatalf("after re-import %d comments, want 3 (idempotent)", len(list2))
	}
	if gh.PostedCount() != 0 {
		t.Fatalf("re-import posted %d, want 0", gh.PostedCount())
	}
}

// An imported review-diff thread is a live thread: the workflow records the known
// GitHub root without re-posting, mirrors a UI reply to GitHub, and does NOT echo
// a GitHub-sourced reply back.
func TestImportedThreadMirrorsWithoutEcho(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42

	in := CodeCommentInput{
		PR: pr, File: "src/Order.php", Line: 10, Label: "Order::total", Gran: "line",
		Author: "colleague", Body: "imported root", Side: "RIGHT",
		RowStart: 1, RowEnd: 1, Source: "github", ImportedRootID: 900,
	}
	runID, err := m.engine.StartWorkflowID(importedRunID(900), WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	if runID != "gh-900" {
		t.Fatalf("runID = %q, want gh-900", runID)
	}
	// Stored, github-sourced, and NOT re-posted (it already exists on GitHub).
	list, _ := cs.List(ctx, pr)
	if len(list) != 1 || list[0].Source != "github" {
		t.Fatalf("comments = %+v", list)
	}
	if gh.PostedCount() != 0 {
		t.Fatalf("imported root posted %d to github, want 0", gh.PostedCount())
	}

	// A UI reply mirrors to the real GitHub thread.
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "me", Body: "thanks"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.PostedCount() == 1 })

	// A GitHub-sourced reply is stored but not echoed back to GitHub.
	if err := m.Signal(runID, ReactionSignal{ID: "gh-1", Source: "github", Author: "colleague", Body: "ok"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, pr)
		return len(l) == 1 && l[0].ReactionCount == 2
	})
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d after github reply, want 1 (no echo)", gh.PostedCount())
	}
}

// A restart resumes an imported thread's reply poller using the root ID from its
// input (there is no postGithubComment history event to read it from).
func TestResumePollingImportedThread(t *testing.T) {
	store := tembed.NewMemoryStore()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	gh := &github.Fake{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	e1 := tembed.New(store)
	NewTaskManager(e1, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, "", "test/repo")
	in := CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "colleague", Body: "root",
		Side: "RIGHT", RowStart: 1, RowEnd: 1, Source: "github", ImportedRootID: 901,
	}
	runID, err := e1.StartWorkflowID(importedRunID(901), WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 0 {
		t.Fatalf("imported root re-posted %d times, want 0", gh.PostedCount())
	}

	// A fresh manager over the same store (a restart) must resume the poller for
	// this imported, still-waiting thread — proving the root ID is recovered from
	// the input, not from a postGithubComment history event (there is none).
	e2 := tembed.New(store)
	m2 := NewTaskManager(e2, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, "", "test/repo")
	m2.interval = 3 * time.Millisecond // fast poll for the test
	m2.idle = 3 * time.Millisecond
	if err := e2.Recover(); err != nil {
		t.Fatal(err)
	}
	m2.ResumePolling(ctx)
	gh.EnqueueReply(github.Reply{ID: 1, Author: "x", Body: "late reply"})
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, 42)
		return len(l) == 1 && l[0].ID == runID && l[0].ReactionCount == 1
	})
}
