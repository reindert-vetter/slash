package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/inbox"
	"slash/modules/jira"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/testcovers"
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

// testRelations opens a throwaway relations read-model for the manager.
func testRelations(t *testing.T) *relations.Module {
	t.Helper()
	rel, err := relations.Open(filepath.Join(t.TempDir(), "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rel.Close() })
	return rel
}

// testPRMeta opens a throwaway prmeta read-model for the manager.
func testPRMeta(t *testing.T) *prmeta.Module {
	t.Helper()
	pm, err := prmeta.Open(filepath.Join(t.TempDir(), "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pm.Close() })
	return pm
}

// testTestCovers opens a throwaway testcovers read-model for the manager.
func testTestCovers(t *testing.T) *testcovers.Module {
	t.Helper()
	tc, err := testcovers.Open(filepath.Join(t.TempDir(), "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tc.Close() })
	return tc
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
	// fetchPRStatuses (pr_status stage 3) shells to gh directly (statusesFor,
	// not the injected github.Client fake) — keep every test built on this
	// helper offline.
	t.Setenv("SLASH_GITHUB", "off")
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, "", "test/repo")
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

// A group comment posts as a multi-line range on the RIGHT side.
func TestTaskCodeCommentGroupRange(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 14, Author: "reindert",
		Body: "Looks off.", Gran: "group", StartLine: 10, EndLine: 14, Side: "RIGHT",
	}); err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	if gh.LastStartLine() != 10 || gh.LastEndLine() != 14 || gh.LastSide() != "RIGHT" {
		t.Fatalf("range = %d..%d side=%s, want 10..14 RIGHT", gh.LastStartLine(), gh.LastEndLine(), gh.LastSide())
	}
}

// A call comment's GitHub-posted body is prefixed with the segment as a code
// span, but the stored (thread) body stays raw.
func TestTaskCodeCommentCallSegmentPrefix(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 7, Author: "reindert",
		Body: "Check the null case.", Gran: "call", StartLine: 7, EndLine: 7, Side: "RIGHT",
		Segment: "->billingAddress()",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("github posted %d, want 1", gh.PostedCount())
	}
	body := gh.LastPostedBody()
	want := "`->billingAddress()`\n\nCheck the null case."
	if body != want {
		t.Fatalf("posted body = %q, want %q", body, want)
	}
	list, _ := cs.List(ctx, 42)
	if len(list) != 1 || list[0].ID != runID || list[0].Body != "Check the null case." {
		t.Fatalf("stored comment body = %+v, want raw body untouched", list)
	}
}

// A removed line posts with side LEFT.
func TestTaskCodeCommentRemovedLineSide(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 5, Author: "reindert",
		Body: "This was removed.", Gran: "line", StartLine: 5, EndLine: 5, Side: "LEFT",
	}); err != nil {
		t.Fatal(err)
	}
	if gh.LastSide() != "LEFT" {
		t.Fatalf("side = %q, want LEFT", gh.LastSide())
	}
	if gh.LastStartLine() != 5 || gh.LastEndLine() != 5 {
		t.Fatalf("range = %d..%d, want 5..5", gh.LastStartLine(), gh.LastEndLine())
	}
}

// Backward compat: an input with only Line set (no StartLine/EndLine/Side)
// still posts single-line RIGHT on that line.
func TestTaskCodeCommentLineOnlyBackwardCompat(t *testing.T) {
	m, gh, _ := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "Old-style input.",
	}); err != nil {
		t.Fatal(err)
	}
	if gh.LastStartLine() != 10 || gh.LastEndLine() != 10 || gh.LastSide() != "RIGHT" {
		t.Fatalf("range = %d..%d side=%s, want 10..10 RIGHT", gh.LastStartLine(), gh.LastEndLine(), gh.LastSide())
	}
}

// A local ("alleen voor mijzelf") note is stored as a comment but never posted
// to GitHub: the workflow skips postGithubComment, so posted.RootID stays 0 and
// deleting it also makes no GitHub call.
func TestTaskCodeCommentLocalSkipsGitHub(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert",
		Body: "note to self", Local: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Stored in the read-model, but nothing posted to GitHub.
	if gh.PostedCount() != 0 {
		t.Fatalf("github posted %d, want 0 for a local note", gh.PostedCount())
	}
	list, _ := cs.List(ctx, 42)
	if len(list) != 1 || list[0].ID != runID || list[0].Status != "open" {
		t.Fatalf("comments = %+v", list)
	}

	// Deleting a local note removes it from the store without a GitHub delete
	// (RootID 0 → deleteGithubComment no-ops).
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Action: "delete"}); err != nil {
		t.Fatal(err)
	}
	if s, _ := m.engine.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %q, want completed", s)
	}
	if l, _ := cs.List(ctx, 42); len(l) != 0 {
		t.Fatalf("comments = %+v, want none after delete", l)
	}
	if gh.DeletedCount() != 0 {
		t.Fatalf("github deleted %d, want 0 for a local note", gh.DeletedCount())
	}
}

// Deleting a comment flips its status to "deleting" first (markCommentDeleting),
// then removes it from GitHub (best-effort) and from our own store, and
// completes the execution.
func TestTaskCodeCommentDelete(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: "src/Order.php", Line: 10, Author: "reindert", Body: "please look at this",
	})
	if err != nil {
		t.Fatal(err)
	}

	// A reaction first, so the delete also has to cascade a real reaction row.
	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "ack"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cs.List(ctx, 42)
		return len(l) == 1 && l[0].ReactionCount == 1
	})

	if err := m.Signal(runID, ReactionSignal{ID: "ui-2", Source: "ui", Author: "reindert", Action: "delete"}); err != nil {
		t.Fatal(err)
	}

	// The execution completes as part of the delete flow (SignalWorkflow drives
	// the workflow synchronously to its next block point).
	if s, _ := m.engine.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %q, want completed", s)
	}
	// The comment (and its cascaded reaction) is gone from the read-model.
	list, err := cs.List(ctx, 42)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("comments = %+v, want none after delete", list)
	}
	// GitHub's copy was removed too (best-effort call still happened).
	if gh.DeletedCount() != 1 {
		t.Fatalf("github deleted %d, want 1", gh.DeletedCount())
	}

	// The status must have flipped to "deleting" before the row itself was
	// removed — assert the two activities ran in that order in the history.
	hist, err := m.engine.History(runID)
	if err != nil {
		t.Fatal(err)
	}
	var markIdx, deleteIdx = -1, -1
	for i, ev := range hist {
		if ev.Type != tembed.EventActivityCompleted {
			continue
		}
		switch ev.Name {
		case "markCommentDeleting":
			markIdx = i
		case "deleteComment":
			deleteIdx = i
		}
	}
	if markIdx == -1 || deleteIdx == -1 || markIdx >= deleteIdx {
		t.Fatalf("expected markCommentDeleting (idx %d) before deleteComment (idx %d)", markIdx, deleteIdx)
	}
}

// A comment can be deleted before it ever receives a reaction.
func TestTaskCodeCommentDeleteWithoutReactions(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 43, File: "src/Order.php", Line: 3, Author: "reindert", Body: "typo",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Action: "delete"}); err != nil {
		t.Fatal(err)
	}

	if s, _ := m.engine.Status(runID); s != tembed.StatusCompleted {
		t.Fatalf("status = %q, want completed", s)
	}
	list, _ := cs.List(ctx, 43)
	if len(list) != 0 {
		t.Fatalf("comments = %+v, want none after delete", list)
	}
	if gh.DeletedCount() != 1 {
		t.Fatalf("github deleted %d, want 1", gh.DeletedCount())
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
	m := NewTaskManager(engine, &github.Fake{}, nil, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, db, "", repoSlug)

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
	NewTaskManager(e1, gh, cs, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, "", "test/repo")
	runID, err := e1.StartWorkflow(WorkflowTaskCodeComment, CodeCommentInput{PR: 1, File: "a.php", Line: 1, Body: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 1 {
		t.Fatalf("posted %d, want 1", gh.PostedCount())
	}

	// Restart: a new engine over the same store must not re-post the comment.
	e2 := tembed.New(store)
	NewTaskManager(e2, gh, cs, ib, testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, "", "test/repo")
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

// TestPRStatusFetchesMeta asserts the pr_status tracker fetches the PR's
// metadata (title + URL) into the prmeta read-model at start (synchronously,
// inside EnsurePRStatus → StartWorkflow), which is what feeds the `/` menu.
func TestPRStatusFetchesMeta(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off") // fetchPRStatuses shells to gh directly (statusesFor); keep this test offline
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{Title: "PS-123 fix the thing", URL: "https://github.com/x/y/pull/7"})
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.EnsurePRStatus(7); err != nil {
		t.Fatal(err)
	}
	meta, ok, err := pm.Get(context.Background(), 7)
	if err != nil || !ok {
		t.Fatalf("meta not stored (ok=%v err=%v)", ok, err)
	}
	if meta.Title != "PS-123 fix the thing" {
		t.Fatalf("title = %q, want %q", meta.Title, "PS-123 fix the thing")
	}
	if meta.URL == "" {
		t.Fatalf("url empty, want stored")
	}
}

// TestPRStatusThreeStages asserts the pr_status tracker fills the prmeta
// read-model in its three stages — basics (incl. the linked Jira issue),
// Claude summary, review/CI statuses — all at start, before the tracker parks
// on its first state Signal.
func TestPRStatusThreeStages(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off") // fetchPRStatuses shells to gh directly (statusesFor); keep this test offline
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })

	gh := &github.Fake{}
	gh.SetPRMeta(github.Meta{
		Title: "INTEG-562 fix the thing", URL: "https://github.com/x/y/pull/7",
		Body: "does a thing", Author: "alice", Additions: 10, Deletions: 2, ChangedFiles: 1, HeadRef: "feature/x",
	})
	jr := &jira.Fake{}
	jr.SetIssue("INTEG-562", jira.Issue{
		Key: "INTEG-562", Title: "Jira title", Description: "Jira description",
		URL: "https://plugandpaybv.atlassian.net/browse/INTEG-562",
	})
	cl := claude.NewFake()
	cl.SetOutput(claude.ModelHaiku, "This PR fixes the thing.")

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, cl, jr, nil, "", "test/repo")

	if _, err := m.EnsurePRStatus(7); err != nil {
		t.Fatal(err)
	}

	meta, ok, err := pm.Get(context.Background(), 7)
	if err != nil || !ok {
		t.Fatalf("meta not stored (ok=%v err=%v)", ok, err)
	}
	// Stage 1: basics + Jira.
	if meta.Title != "INTEG-562 fix the thing" || meta.Body != "does a thing" || meta.Author != "alice" {
		t.Fatalf("basics = %+v", meta)
	}
	if meta.JiraKey != "INTEG-562" || meta.JiraTitle != "Jira title" || meta.JiraDesc != "Jira description" {
		t.Fatalf("jira fields = %+v", meta)
	}
	// Stage 2: Claude summary.
	if meta.Summary != "This PR fixes the thing." {
		t.Fatalf("summary = %q", meta.Summary)
	}
	// Stage 3: statuses. The Fake github/statusesFor path (no real gh) yields no
	// heavy status — assert it didn't error the tracker and stays zero.
	if meta.ChecksTotal != 0 || meta.ReviewDecision != "" {
		t.Fatalf("statuses = %+v, want zero (no gh in test)", meta)
	}
}

func TestCommentPath(t *testing.T) {
	cases := []struct {
		name string
		in   CodeCommentInput
		id   string
		want string
	}{
		{
			name: "call unit with segment",
			in:   CodeCommentInput{PR: 123, File: "app/Actions/Foo.php", Label: "Foo::bar", Gran: "call", RowStart: 7, RowEnd: 7, Seg: "r12-18"},
			id:   "abc",
			want: "/pr-123/app/Actions/Foo.php/Foo::bar/call-7-r12-18/comment-abc",
		},
		{
			name: "group unit",
			in:   CodeCommentInput{PR: 123, File: "app/Foo.php", Label: "Foo::bar", Gran: "group", RowStart: 5, RowEnd: 9},
			id:   "x",
			want: "/pr-123/app/Foo.php/Foo::bar/group-5-9/comment-x",
		},
		{
			name: "line unit",
			in:   CodeCommentInput{PR: 7, File: "a.php", Label: "A::b", Gran: "line", RowStart: 3, RowEnd: 3},
			id:   "y",
			want: "/pr-7/a.php/A::b/line-3/comment-y",
		},
		{
			name: "unknown anchor falls back to gran",
			in:   CodeCommentInput{PR: 9, File: "a.php", Label: "A::b", Gran: "group", RowStart: -1, RowEnd: -1},
			id:   "z",
			want: "/pr-9/a.php/A::b/group/comment-z",
		},
		{
			name: "spaces in label are sanitised, slash cannot be injected",
			in:   CodeCommentInput{PR: 1, File: "a.php", Label: "A::b c/d", Gran: "line", RowStart: 0, RowEnd: 0},
			id:   "w",
			want: "/pr-1/a.php/A::b-c-d/line-0/comment-w",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := commentPath(tc.in, tc.id); got != tc.want {
				t.Errorf("commentPath = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestRunsForPR asserts RunsForPR filters workflow runs by their input's PR
// number and excludes runs without one (pr_inbox), so the read-only "Taken"
// endpoint only ever shows runs that belong to the requested PR.
func TestRunsForPR(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	pm := testPRMeta(t)
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, "", "test/repo")

	if _, err := m.EnsurePRStatus(101); err != nil {
		t.Fatal(err)
	}
	if _, err := m.EnsurePRStatus(202); err != nil {
		t.Fatal(err)
	}
	m.EnsureInbox(context.Background()) // per-repo, no "pr" field — must not leak into either PR's list

	runs := m.RunsForPR(101)
	if len(runs) != 1 {
		t.Fatalf("RunsForPR(101) = %d runs, want 1 (%+v)", len(runs), runs)
	}
	if runs[0].Workflow != WorkflowPRStatus {
		t.Fatalf("workflow = %q, want %q", runs[0].Workflow, WorkflowPRStatus)
	}
	if runs[0].Status != tembed.StatusWaiting && runs[0].Status != tembed.StatusRunning {
		t.Fatalf("status = %q, want waiting/running", runs[0].Status)
	}

	runs202 := m.RunsForPR(202)
	if len(runs202) != 1 {
		t.Fatalf("RunsForPR(202) = %d runs, want 1", len(runs202))
	}

	if runs := m.RunsForPR(999); len(runs) != 0 {
		t.Fatalf("RunsForPR(999) = %d runs, want 0", len(runs))
	}
}
