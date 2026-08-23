package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
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
	in := mapReviewComment(dir, "", pr, []Block{b}, gc)

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

// A review comment pinned to a real row that isn't itself a changed row (e.g.
// GitHub shows unchanged context lines around a hunk, and a reviewer can
// comment on one) falls back to the block's own first changed row, with
// BlockWide=true — mirrors TestAnchoredWarningFallsBackToBlockWideFirstRow
// (code_warning_test.go) one-for-one. Without this, the comment stays pinned
// to a context row with no navigable line-granularity unit of its own, so it
// silently never shows under any drilled cursor (reported bug, PR 13383).
func TestMapReviewCommentOnUnchangedRowFallsBackToBlockWideFirstRow(t *testing.T) {
	dir := t.TempDir()
	pr := 91
	base := orderPHP
	head := strings.Replace(orderPHP, "$x = 1;", "$x = 2;", 1)
	writeWorktreeFile(t, dir, pr, "Order.php", base, head)

	// The method declaration `public function total() {` is on line 3; `$x = 1;`
	// (the block's only changed line) is line 4; the closing brace `}` is line 6.
	b := Block{PR: pr, File: "Order.php", Class: "Order", Name: "total",
		Line: 3, EndLine: 6, Label: "Order::total", Status: "modified", Side: "new"}

	// Comment on the closing brace — a real, pinnable row, but not a changed one.
	gc := github.ReviewComment{ID: 556, Author: "colleague", Body: "hele methode",
		Path: "Order.php", Line: 6, Side: "RIGHT"}
	in := mapReviewComment(dir, "", pr, []Block{b}, gc)

	if in.Kind != "" {
		t.Fatalf("kind = %q, want \"\" (still block-scoped, not PR-wide)", in.Kind)
	}
	if in.RowStart < 0 || in.RowEnd < 0 {
		t.Fatalf("rowStart/rowEnd = %d/%d, want a pinned row (>= 0) — the block's first changed row", in.RowStart, in.RowEnd)
	}
	if in.RowStart != in.RowEnd {
		t.Fatalf("rowStart=%d rowEnd=%d, want a single row", in.RowStart, in.RowEnd)
	}
	// The block's only changed row is `$x = 1;`/`$x = 2;`, row 1 (row 0 is the
	// unchanged declaration).
	if want := 1; in.RowStart != want {
		t.Fatalf("rowStart = %d, want %d (the block's first changed row)", in.RowStart, want)
	}
	if !in.BlockWide {
		t.Fatalf("blockWide = false, want true")
	}
}

// A review comment whose anchor falls in no block degrades to a PR-wide comment.
func TestMapReviewCommentNoBlockIsPRWide(t *testing.T) {
	dir := t.TempDir()
	pr := 91
	gc := github.ReviewComment{ID: 7, Body: "general note", Path: "Untracked.php", Line: 99, Side: "RIGHT"}
	in := mapReviewComment(dir, "", pr, nil, gc)
	if in.Kind != "review" || in.Label != "" || in.RowStart != -1 {
		t.Fatalf("PR-wide = kind=%q label=%q rowStart=%d", in.Kind, in.Label, in.RowStart)
	}
	if in.File != "Untracked.php" || in.ImportedRootID != 7 {
		t.Fatalf("file=%q root=%d", in.File, in.ImportedRootID)
	}
}

// mapGeneralComment carries kind + import meta and no anchor.
func TestMapGeneralComment(t *testing.T) {
	in := mapGeneralComment("", 91, github.GeneralComment{ID: 12, Author: "a", Body: "overall LGTM", Kind: "review_summary"})
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

	m.importPRComments(ctx, "", pr)

	list, _ := cs.List(ctx, "", pr)
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
	// Each imported comment's own GitHub database id is persisted (the
	// ImportedRootID), so the frontend can build a "view on GitHub" deep link
	// without depending on the runId's "gh-<id>" shape.
	if id := list[byID["gh-100"]].GithubID; id != 100 {
		t.Fatalf("gh-100 githubId = %d, want 100", id)
	}
	if id := list[byID["gh-200"]].GithubID; id != 200 {
		t.Fatalf("gh-200 githubId = %d, want 200", id)
	}
	if id := list[byID["gh-300"]].GithubID; id != 300 {
		t.Fatalf("gh-300 githubId = %d, want 300", id)
	}

	// A second import is a no-op reuse: still exactly three comments, still no posts.
	m.importPRComments(ctx, "", pr)
	list2, _ := cs.List(ctx, "", pr)
	if len(list2) != 3 {
		t.Fatalf("after re-import %d comments, want 3 (idempotent)", len(list2))
	}
	if gh.PostedCount() != 0 {
		t.Fatalf("re-import posted %d, want 0", gh.PostedCount())
	}
}

// A kilo-review bot summary (body carries BOTH markers) is never imported — no
// Execution is started, so it stays out of the read-model — while a normal
// PR-wide comment alongside it imports as usual.
func TestImportSkipsKiloReviewComment(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42

	gh.SetGeneralComments([]github.GeneralComment{
		{ID: 200, Author: "boss", Body: "please add a test", Kind: "issue"},
		{ID: 400, Author: "kilo-code-bot[bot]", Kind: "issue",
			Body: "<!-- kilo-review -->\nCode Review Summary\nStatus: 2 Issues Found"},
	})

	m.importPRComments(ctx, "", pr)

	list, _ := cs.List(ctx, "", pr)
	if len(list) != 1 {
		t.Fatalf("imported %d comments, want 1 (kilo-review skipped): %+v", len(list), list)
	}
	if list[0].ID != "gh-200" {
		t.Fatalf("imported %q, want gh-200 (the non-kilo comment)", list[0].ID)
	}
}

// An imported review-diff thread is a live thread: the workflow records the known
// GitHub root without re-posting, mirrors a UI reply to GitHub, and does NOT echo
// a GitHub-sourced reply back.
// An imported comment carries its author's GitHub avatar URL all the way into
// the read-model — for a bot account ("…[bot]") just as much as for a human —
// and so does a reply that arrives via the poller. That's what lets the thread
// render the real profile picture instead of an initials circle.
func TestImportCarriesAuthorAvatars(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42
	m.interval = 3 * time.Millisecond // fast reply poll for the test
	m.idle = 3 * time.Millisecond
	const botAvatar = "https://avatars.githubusercontent.com/in/1234?v=4"
	const humanAvatar = "https://avatars.githubusercontent.com/u/5678?v=4"

	gh.SetReviewComments([]github.ReviewComment{
		{ID: 100, Author: "kilo-code-bot[bot]", AvatarURL: botAvatar,
			Body: "WARNING: naming", Path: "src/Order.php", Line: 10, Side: "RIGHT"},
	})
	gh.SetGeneralComments([]github.GeneralComment{
		{ID: 200, Author: "BOGSAT", AvatarURL: humanAvatar, Body: "please add a test", Kind: "issue"},
	})

	m.importPRComments(ctx, "", pr)

	list, _ := cs.List(ctx, "", pr)
	got := map[string]comments.Comment{}
	for _, c := range list {
		got[c.ID] = c
	}
	if a := got["gh-100"].AvatarURL; a != botAvatar {
		t.Fatalf("gh-100 avatarUrl = %q, want %q", a, botAvatar)
	}
	if a := got["gh-200"].AvatarURL; a != humanAvatar {
		t.Fatalf("gh-200 avatarUrl = %q, want %q", a, humanAvatar)
	}

	// A comment imported BEFORE the avatar was threaded through (empty column,
	// and its Execution never re-runs) gets its picture backfilled on the next
	// import tick, via the "avatar" Signal.
	if _, err := m.engine.StartWorkflowID(importedRunID(500), WorkflowTaskCodeComment, CodeCommentInput{
		PR: pr, Body: "older import", Author: "BOGSAT", Kind: "issue",
		ImportedRootID: 500, Source: "github", RowStart: -1, RowEnd: -1,
	}); err != nil {
		t.Fatal(err)
	}
	gh.SetGeneralComments([]github.GeneralComment{
		{ID: 500, Author: "BOGSAT", AvatarURL: humanAvatar, Body: "older import", Kind: "issue"},
	})
	m.importPRComments(ctx, "", pr)
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", pr)
		for _, c := range l {
			if c.ID == "gh-500" && c.AvatarURL == humanAvatar {
				return true
			}
		}
		return false
	})

	// A GitHub reply arriving via the per-thread reply poller keeps its own
	// avatar too. Polled on a live thread of its own (the imported roots above
	// have no worktree to anchor to here, so they degrade to PR-wide comments,
	// which have no reply thread to poll).
	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: pr, File: "src/Order.php", Line: 10, Author: "me", Body: "question",
	})
	if err != nil {
		t.Fatal(err)
	}
	gh.EnqueueReply(github.Reply{ID: 400, Author: "BOGSAT", AvatarURL: humanAvatar, Body: "fixed"})
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", pr)
		for _, c := range l {
			if c.ID != runID {
				continue
			}
			for _, r := range c.Reactions {
				if r.ID == "gh-400" && r.AvatarURL == humanAvatar {
					return true
				}
			}
		}
		return false
	})
}

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
	list, _ := cs.List(ctx, "", pr)
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

	// A GitHub-sourced reply is stored but not echoed back to GitHub. Its id
	// (501) is deliberately far above the fake's own mirror counter (1, for
	// the "ui-1" reply mirrored just above) — a real GitHub comment id is
	// globally unique, so an external reply never collides with one this
	// workflow itself just mirrored; a colliding low number here would look
	// like the workflow's own echo-of-self guard (see the reply-Signal loop
	// in workflows.go) incorrectly swallowing a genuinely external reply.
	if err := m.Signal(runID, ReactionSignal{ID: "gh-501", Source: "github", Author: "colleague", Body: "ok"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", pr)
		return len(l) == 1 && l[0].ReactionCount == 2
	})
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d after github reply, want 1 (no echo)", gh.PostedCount())
	}
}

// A reply on an imported PR-wide (issue/review-summary) thread posts a NEW issue
// comment to the flat PR conversation — NOT the review-reply endpoint — and a
// resolve is local-only (never touches GitHub).
func TestPRWideReplyPostsIssueComment(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42

	in := CodeCommentInput{
		PR: pr, Author: "boss", Body: "please add a test",
		Source: "github", Kind: "issue", ImportedRootID: 400, RowStart: -1, RowEnd: -1,
	}
	runID, err := m.engine.StartWorkflowID(importedRunID(400), WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	// A UI reply → a new issue comment on the PR conversation, never a review reply.
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "me", Body: "on it"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.IssuePostedCount() == 1 })
	if gh.PostedCount() != 0 {
		t.Fatalf("review-reply endpoint posted %d, want 0 (PR-wide reply → issue comment)", gh.PostedCount())
	}

	// A resolve (Done) is local-only: status flips to resolved, GitHub untouched.
	if err := m.Signal(runID, ReactionSignal{ID: "ui-2", Source: "ui", Author: "me", Body: "resolved", Done: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", pr)
		return len(l) == 1 && l[0].Status == "resolved"
	})
	if gh.IssuePostedCount() != 1 {
		t.Fatalf("resolve posted %d issue comments, want 1 (resolve is local-only)", gh.IssuePostedCount())
	}
}

// importPRComments never duplicates an app-created comment: a review comment the
// app itself posted (its GitHub ID recorded in history) is skipped on import,
// even though its Run ID isn't the deterministic gh-<id> an import would use.
func TestImportSkipsAppCreatedComment(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42

	// The app posts a review comment; the Fake returns GitHub ID 1.
	appRunID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: pr, File: "src/Order.php", Line: 10, Author: "me", Body: "app comment",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Import sees that same review comment (root ID 1) on GitHub — it must be
	// skipped, not re-imported as a second (gh-1) thread.
	gh.SetReviewComments([]github.ReviewComment{
		{ID: 1, Author: "me", Body: "app comment", Path: "src/Order.php", Line: 10, Side: "RIGHT"},
	})
	m.importPRComments(ctx, "", pr)

	list, _ := cs.List(ctx, "", pr)
	if len(list) != 1 {
		t.Fatalf("comments = %d, want 1 (no duplicate of the app-created comment): %+v", len(list), list)
	}
	if list[0].ID != appRunID {
		t.Fatalf("comment id = %q, want the app's run id %q (not an imported gh-1)", list[0].ID, appRunID)
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
	NewTaskManager(e1, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
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
	m2 := NewTaskManager(e2, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m2.interval = 3 * time.Millisecond // fast poll for the test
	m2.idle = 3 * time.Millisecond
	if err := e2.Recover(); err != nil {
		t.Fatal(err)
	}
	m2.ResumePolling(ctx)
	gh.EnqueueReply(github.Reply{ID: 1, Author: "x", Body: "late reply"})
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, "", 42)
		return len(l) == 1 && l[0].ID == runID && l[0].ReactionCount == 1
	})
}

// A thread whose Execution has permanently failed (e.g. a SQLITE_BUSY hit
// during an earlier saveReaction — see the cleanup section in
// .claude/docs/tembed-workflows.md) can never accept a Signal again
// (engine.SignalWorkflow's own "already failed" check). importPRComments'
// avatar-backfill glue must check the run's status BEFORE attempting the
// Signal instead of discovering that the hard way and logging the same
// deterministic error on every poll/server restart forever.
func TestImportSkipsAvatarBackfillOnFailedRun(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	store := tembed.NewMemoryStore()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	gh := &github.Fake{}
	engine := tembed.New(store)
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.interval = 3 * time.Millisecond
	m.idle = 3 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42
	const humanAvatar = "https://avatars.githubusercontent.com/u/9999?v=4"

	in := CodeCommentInput{
		PR: pr, File: "src/Order.php", Line: 10, Label: "Order::total", Gran: "line",
		Author: "colleague", Body: "imported root", Side: "RIGHT",
		RowStart: 1, RowEnd: 1, Source: "github", ImportedRootID: 700,
	}
	runID, err := m.engine.StartWorkflowID(importedRunID(700), WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	// Force the run into the same terminal state a real SQLITE_BUSY failure
	// during a later saveReaction leaves behind.
	if err := store.SetStatus(runID, tembed.StatusFailed, time.Now()); err != nil {
		t.Fatal(err)
	}

	var logs []string
	m.logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }

	// The stored comment's avatar column is still empty (never threaded
	// through at import time) and the live GitHub comment now carries one —
	// exactly the combination that used to trigger the backfill Signal.
	gh.SetGeneralComments([]github.GeneralComment{
		{ID: 700, Author: "colleague", AvatarURL: humanAvatar, Body: "imported root", Kind: "issue"},
	})
	m.importPRComments(ctx, "", pr)

	for _, l := range logs {
		if strings.Contains(l, "avatar backfill") {
			t.Fatalf("expected no avatar-backfill log noise for a terminal run, got: %q", l)
		}
	}
	list, _ := cs.List(ctx, "", pr)
	for _, c := range list {
		if c.ID == runID && c.AvatarURL == humanAvatar {
			t.Fatalf("avatar was backfilled onto a permanently-failed run, want left untouched")
		}
	}
}

// TestImportAppliesGithubResolvedState covers the other half of a comment's
// lifecycle the import used to ignore entirely: somebody hits "Resolve
// conversation" on github.com, and slash never noticed — the thread stayed
// `open` here forever (no ✓, not dimmed, still marking its diff row), because
// the only local resolve trigger was a reply body containing "/resolve".
// isResolved lives on the GraphQL reviewThread node, hence the separate
// ResolvedReviewThreads read.
func TestImportAppliesGithubResolvedState(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr := 42

	gh.SetReviewComments([]github.ReviewComment{
		{ID: 100, Author: "colleague", Body: "resolved on github", Path: "src/Order.php", Line: 10, Side: "RIGHT"},
		{ID: 101, Author: "colleague", Body: "still open", Path: "src/Order.php", Line: 12, Side: "RIGHT"},
	})
	gh.SetGeneralComments([]github.GeneralComment{
		{ID: 200, Author: "colleague", Body: "a PR-wide one", Kind: "issue"},
	})
	m.importPRComments(ctx, "", pr)

	statusOf := func() map[string]string {
		list, _ := cs.List(ctx, "", pr)
		out := map[string]string{}
		for _, c := range list {
			out[c.ID] = c.Status
		}
		return out
	}
	if got := statusOf(); got["gh-100"] != "open" || got["gh-101"] != "open" {
		t.Fatalf("statuses after the first import = %v, want both open", got)
	}

	// Now one of them is resolved on GitHub. The next import tick picks it up.
	gh.SetResolvedOnGithub(100)
	m.importPRComments(ctx, "", pr)

	got := statusOf()
	if got["gh-100"] != "resolved" {
		t.Fatalf("gh-100 status = %q, want resolved", got["gh-100"])
	}
	if got["gh-101"] != "open" {
		t.Fatalf("gh-101 status = %q, want open (its thread is not resolved on GitHub)", got["gh-101"])
	}
	// An issue comment's id is never in the review-thread set, so a genuinely
	// thread-less PR-wide comment can't be swept along.
	if got["gh-200"] != "open" {
		t.Fatalf("gh-200 status = %q, want open (an issue comment has no review thread)", got["gh-200"])
	}

	// Nothing is written BACK to GitHub — the thread is already resolved there,
	// and the mirror path only ever fires for a Source "ui" reaction.
	if n := gh.ResolvedThreadCount(); n != 0 {
		t.Fatalf("ResolveReviewThread called %d times, want 0", n)
	}

	// The resolve trace is stored once, and a further tick is a no-op (the
	// Status check keeps it quiet) rather than a growing pile of reactions.
	m.importPRComments(ctx, "", pr)
	list, _ := cs.List(ctx, "", pr)
	for _, c := range list {
		if c.ID != "gh-100" {
			continue
		}
		if c.ReactionCount != 1 {
			t.Fatalf("gh-100 reactionCount = %d, want exactly 1 (/resolve trace)", c.ReactionCount)
		}
	}
}
