package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/callresolve"
	"slash/modules/commentignore"
	"slash/modules/comments"
	"slash/modules/explanations"
	"slash/modules/github"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/testcovers"
)

// seedWorktree creates a throwaway pair of "worktree" directories for pr under
// dataDir/worktrees, each with a marker file — good enough to prove
// removePRWorktrees actually removes them (it doesn't need a real git
// worktree to fall back to os.RemoveAll).
func seedWorktree(t *testing.T, dataDir string, pr int) {
	t.Helper()
	base, head := worktreeDirs(dataDir, pr)
	for _, dir := range []string{base, head} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func worktreesExist(dataDir string, pr int) bool {
	base, head := worktreeDirs(dataDir, pr)
	_, errBase := os.Stat(base)
	_, errHead := os.Stat(head)
	return errBase == nil || errHead == nil
}

// seedGraphDB opens a throwaway graph.db and inserts one block + a pr_ingest
// row for pr, so it shows up as a cleanup candidate and has something for
// purgePRBlocks to remove.
func seedGraphDB(t *testing.T, pr int) *sql.DB {
	t.Helper()
	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := replacePRBlocks(db, pr, []Block{
		{Name: "foo", File: "app/Foo.php", Category: "OTHER", Line: 1, EndLine: 3, Status: "added", Side: "new", PR: pr},
	}); err != nil {
		t.Fatal(err)
	}
	if err := saveIngestSHAs(db, pr, "base-sha", "head-sha"); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestResolveCleanupTargets(t *testing.T) {
	dataDir := t.TempDir()
	db := seedGraphDB(t, 1)
	// A second, third, fourth candidate PR, discoverable purely via the
	// worktree dirs (no blocks row needed) — proves cleanupCandidatePRs's
	// union really works, not just the blocks-table path.
	seedWorktree(t, dataDir, 2)
	seedWorktree(t, dataDir, 3)
	seedWorktree(t, dataDir, 4)

	gh := &github.Fake{}
	now := time.Date(2024, 1, 20, 0, 0, 0, 0, time.UTC)
	cutoff := now.Add(-cleanupMergedAge)

	// PR 1: merged well before the cutoff -> eligible.
	gh.SetPRMetaFor(1, github.Meta{MergedAt: cutoff.Add(-48 * time.Hour).Format(time.RFC3339)})
	// PR 2: merged, but only just, after the cutoff -> not eligible yet.
	gh.SetPRMetaFor(2, github.Meta{MergedAt: cutoff.Add(1 * time.Hour).Format(time.RFC3339)})
	// PR 3: open (never merged) -> never eligible, regardless of age.
	gh.SetPRMetaFor(3, github.Meta{MergedAt: ""})
	// PR 4: unparsable mergedAt (defensive) -> skipped, not eligible.
	gh.SetPRMetaFor(4, github.Meta{MergedAt: "not-a-date"})

	targets, err := resolveCleanupTargets(context.Background(), gh, db, dataDir, CleanupInput{Cutoff: cutoff})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets.Targets) != 1 || targets.Targets[0].PR != 1 {
		t.Fatalf("targets = %+v, want exactly pr 1", targets.Targets)
	}
}

// ForcePRs bypasses the GitHub-merged/age gate entirely for the named PRs —
// needed for a PR that can never pass it at all (no real GitHub PR to look
// up, e.g. a synthetic/test PR number), while ordinary candidates still go
// through the normal gate, and a PR that's both a forced target AND an
// ordinary candidate is never added twice.
func TestResolveCleanupTargetsForcePRs(t *testing.T) {
	dataDir := t.TempDir()
	db := seedGraphDB(t, 1)
	gh := &github.Fake{}
	now := time.Date(2024, 1, 20, 0, 0, 0, 0, time.UTC)
	cutoff := now.Add(-cleanupMergedAge)
	// PR 1: merged well before the cutoff -> would be eligible via the
	// ordinary gate too, and is also force-named — must still only appear
	// once. PR 970099: no real GitHub PR at all (the Fake reports the
	// zero-value Meta{}, i.e. "never merged" — mirroring a real gh lookup
	// that would simply fail), so it can never pass the ordinary gate.
	gh.SetPRMetaFor(1, github.Meta{MergedAt: cutoff.Add(-48 * time.Hour).Format(time.RFC3339)})

	targets, err := resolveCleanupTargets(context.Background(), gh, db, dataDir, CleanupInput{
		Cutoff: cutoff, ForcePRs: []int{1, 970099},
	})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int]int{}
	for _, target := range targets.Targets {
		seen[target.PR]++
	}
	if seen[1] != 1 {
		t.Fatalf("pr 1 appears %d times, want exactly 1 (forced + ordinary candidate must not double up)", seen[1])
	}
	if seen[970099] != 1 {
		t.Fatalf("pr 970099 appears %d times, want exactly 1 (forced despite failing the ordinary gate)", seen[970099])
	}
	if len(targets.Targets) != 2 {
		t.Fatalf("targets = %+v, want exactly 2", targets.Targets)
	}
}

// cleanupTestManager builds a TaskManager with every module the cleanup
// workflow touches wired up (all backed by throwaway on-disk SQLite files, so
// Purge's real DELETE statements run against a real schema).
type cleanupTestManager struct {
	mgr         *TaskManager
	gh          *github.Fake
	store       *tembed.MemoryStore
	dataDir     string
	graphDB     *sql.DB
	comments    *comments.Module
	approvals   *approvals.Module
	relations   *relations.Module
	callresolve *callresolve.Module
	testcovers  *testcovers.Module
	prmeta      *prmeta.Module
	explain     *explanations.Module

	commentignore *commentignore.Module
}

func newCleanupTestManager(t *testing.T) *cleanupTestManager {
	t.Helper()
	dataDir := t.TempDir()

	graphDB, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { graphDB.Close() })

	cs, err := comments.Open(filepath.Join(dataDir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	ap, err := approvals.Open(filepath.Join(dataDir, "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ap.Close() })
	rel, err := relations.Open(filepath.Join(dataDir, "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rel.Close() })
	cr, err := callresolve.Open(filepath.Join(dataDir, "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cr.Close() })
	tc, err := testcovers.Open(filepath.Join(dataDir, "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tc.Close() })
	pm, err := prmeta.Open(filepath.Join(dataDir, "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pm.Close() })
	ex, err := explanations.Open(filepath.Join(dataDir, "explanations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ex.Close() })

	ci, err := commentignore.Open(filepath.Join(dataDir, "commentignore.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ci.Close() })

	gh := &github.Fake{}
	store := tembed.NewMemoryStore()
	engine := tembed.New(store)
	mgr := NewTaskManager(engine, gh, cs, testInbox(t), rel, pm, cr, tc, ap, ex, nil, nil, nil, graphDB, dataDir, "test/repo")

	return &cleanupTestManager{
		mgr: mgr, gh: gh, store: store, dataDir: dataDir, graphDB: graphDB,
		comments: cs, approvals: ap, relations: rel, callresolve: cr, testcovers: tc, prmeta: pm, explain: ex,
		commentignore: ci,
	}
}

// seedAllPRData populates one row in every read-model with a pr column for
// pr, plus a worktree pair and one per-PR + one per-repo workflow run.
func (ctm *cleanupTestManager) seedAllPRData(t *testing.T, pr int) {
	t.Helper()
	ctx := context.Background()

	if err := replacePRBlocks(ctm.graphDB, pr, []Block{
		{Name: "foo", File: "app/Foo.php", Category: "OTHER", Line: 1, EndLine: 3, Status: "added", Side: "new", PR: pr},
	}); err != nil {
		t.Fatal(err)
	}
	if err := saveIngestSHAs(ctm.graphDB, pr, "base-sha", "head-sha"); err != nil {
		t.Fatal(err)
	}
	seedWorktree(t, ctm.dataDir, pr)

	blockID := (&Block{File: "app/Foo.php", Name: "foo", PR: pr}).ID()

	if err := ctm.comments.Save(ctx, comments.Comment{
		ID: "c1", RunID: "c1", PR: pr, File: "app/Foo.php", Line: 1, Body: "hi", CreatedAt: time.Now().Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	if err := ctm.approvals.Replace(ctx, pr, blockID, []int{0}, nil); err != nil {
		t.Fatal(err)
	}
	if err := ctm.relations.Replace(ctx, pr, []relations.Relation{
		{PR: pr, ParentID: blockID, ChildID: blockID, Kind: "event_listener", Line: 1},
	}); err != nil {
		t.Fatal(err)
	}
	if err := ctm.callresolve.Save(ctx, callresolve.Entry{
		PR: pr, CallerID: blockID, CallKey: "bar", Status: "resolved", ChildFile: "app/Bar.php",
	}); err != nil {
		t.Fatal(err)
	}
	if err := ctm.testcovers.Save(ctx, testcovers.Entry{
		PR: pr, TestID: blockID, TargetKey: "method:Foo::bar", Status: "resolved", CoveredFile: "app/Foo.php",
	}); err != nil {
		t.Fatal(err)
	}
	if err := ctm.prmeta.SaveBasics(ctx, prmeta.Meta{PR: pr, Title: "PR " + blockID}); err != nil {
		t.Fatal(err)
	}
	if err := ctm.explain.Save(ctx, explanations.Entry{
		PR: pr, BlockID: blockID, UnitKey: "line-1", Status: "done", Text: "explains it",
	}); err != nil {
		t.Fatal(err)
	}
	if err := ctm.commentignore.Set(ctx, pr, "comment-1", true); err != nil {
		t.Fatal(err)
	}

	// One workflow run that belongs to this PR (approve tracker) ...
	if _, err := ctm.mgr.engine.StartWorkflow(WorkflowApprove, struct {
		PR int `json:"pr"`
	}{PR: pr}); err != nil {
		t.Fatal(err)
	}
}

func TestPurgePRRemovesEverything(t *testing.T) {
	ctm := newCleanupTestManager(t)
	const pr = 42
	ctm.seedAllPRData(t, pr)

	// ... plus one per-repo tracker (no "pr" field) that must survive.
	repoRunID, err := ctm.mgr.engine.StartWorkflow(WorkflowPRInbox, struct {
		Repo string `json:"repo"`
	}{Repo: "test/repo"})
	if err != nil {
		t.Fatal(err)
	}

	if !worktreesExist(ctm.dataDir, pr) {
		t.Fatal("expected worktrees to exist before purge")
	}

	deps := purgeDeps{
		engine: ctm.mgr.engine, db: ctm.graphDB, dataDir: ctm.dataDir,
		comments: ctm.comments, approvals: ctm.approvals, relations: ctm.relations,
		callresolve: ctm.callresolve, testcovers: ctm.testcovers, prmeta: ctm.prmeta, explain: ctm.explain,
		commentignore: ctm.commentignore,
	}
	res, err := purgePR(context.Background(), deps, pr)
	if err != nil {
		t.Fatal(err)
	}
	if res.WorktreesRemoved != 2 {
		t.Fatalf("WorktreesRemoved = %d, want 2", res.WorktreesRemoved)
	}
	if worktreesExist(ctm.dataDir, pr) {
		t.Fatal("worktrees still on disk after purge")
	}
	if res.WorkflowRunsDeleted != 1 {
		t.Fatalf("WorkflowRunsDeleted = %d, want 1", res.WorkflowRunsDeleted)
	}
	for _, table := range []string{"blocks", "comments", "approvals", "relations", "callresolve", "testcovers", "prmeta", "explanations", "commentignore"} {
		if n := res.RowsDeleted[table]; n < 1 {
			t.Fatalf("RowsDeleted[%q] = %d, want >= 1", table, n)
		}
	}

	// Read-models are actually empty now.
	blocks, err := blocksByPR(ctm.graphDB, pr)
	if err != nil || len(blocks) != 0 {
		t.Fatalf("blocksByPR after purge = %+v, %v", blocks, err)
	}
	if cs, _ := ctm.comments.List(context.Background(), pr); len(cs) != 0 {
		t.Fatalf("comments after purge = %+v", cs)
	}
	if as, _ := ctm.approvals.List(context.Background(), pr); len(as) != 0 {
		t.Fatalf("approvals after purge = %+v", as)
	}
	if rs, _ := ctm.relations.List(context.Background(), pr); len(rs) != 0 {
		t.Fatalf("relations after purge = %+v", rs)
	}
	if crs, _ := ctm.callresolve.List(context.Background(), pr); len(crs) != 0 {
		t.Fatalf("callresolve after purge = %+v", crs)
	}
	if tcs, _ := ctm.testcovers.List(context.Background(), pr); len(tcs) != 0 {
		t.Fatalf("testcovers after purge = %+v", tcs)
	}
	if _, ok, _ := ctm.prmeta.Get(context.Background(), pr); ok {
		t.Fatal("prmeta row still present after purge")
	}
	if exs, _ := ctm.explain.List(context.Background(), pr); len(exs) != 0 {
		t.Fatalf("explanations after purge = %+v", exs)
	}
	if cis, _ := ctm.commentignore.List(context.Background(), pr); len(cis) != 0 {
		t.Fatalf("commentignore after purge = %+v", cis)
	}

	// The PR-scoped run is gone ...
	runs, err := ctm.mgr.engine.Runs()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range runs {
		in, _ := ctm.mgr.engine.Input(r.ID)
		var input struct {
			PR int `json:"pr"`
		}
		if json.Unmarshal(in, &input) == nil && input.PR == pr {
			t.Fatalf("run %s for pr %d still present after purge", r.ID, pr)
		}
	}
	// ... but the per-repo tracker (no "pr" field) must survive untouched.
	if _, err := ctm.mgr.engine.Status(repoRunID); err != nil {
		t.Fatalf("per-repo tracker run was removed by purgePR: %v", err)
	}
}

func TestCleanupSkipsRecentMerge(t *testing.T) {
	ctm := newCleanupTestManager(t)
	const pr = 7
	ctm.seedAllPRData(t, pr)

	now := time.Now()
	ctm.gh.SetPRMetaFor(pr, github.Meta{MergedAt: now.Add(-2 * 24 * time.Hour).Format(time.RFC3339)})

	res, err := ctm.mgr.StartCleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Purged) != 0 {
		t.Fatalf("Purged = %+v, want empty (merged too recently)", res.Purged)
	}
	if !worktreesExist(ctm.dataDir, pr) {
		t.Fatal("worktrees were removed for a recently-merged PR")
	}
	if blocks, _ := blocksByPR(ctm.graphDB, pr); len(blocks) == 0 {
		t.Fatal("blocks were removed for a recently-merged PR")
	}
}

func TestCleanupNeverTouchesOpenPR(t *testing.T) {
	ctm := newCleanupTestManager(t)
	const pr = 9
	ctm.seedAllPRData(t, pr)
	ctm.gh.SetPRMetaFor(pr, github.Meta{MergedAt: ""}) // open

	res, err := ctm.mgr.StartCleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Purged) != 0 {
		t.Fatalf("Purged = %+v, want empty (pr is open)", res.Purged)
	}
	if !worktreesExist(ctm.dataDir, pr) {
		t.Fatal("worktrees were removed for an open PR")
	}
}

func TestCleanupIdempotent(t *testing.T) {
	ctm := newCleanupTestManager(t)
	const pr = 11
	ctm.seedAllPRData(t, pr)

	old := time.Now().Add(-30 * 24 * time.Hour).Format(time.RFC3339)
	ctm.gh.SetPRMetaFor(pr, github.Meta{MergedAt: old})

	res1, err := ctm.mgr.StartCleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(res1.Purged) != 1 || res1.Purged[0].PR != pr {
		t.Fatalf("first run Purged = %+v, want exactly pr %d", res1.Purged, pr)
	}

	// Second run on the same day: the PR no longer has any data, so it's not
	// a candidate anymore — nothing to purge, no error.
	res2, err := ctm.mgr.StartCleanup(context.Background())
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if len(res2.Purged) != 0 {
		t.Fatalf("second run Purged = %+v, want empty (already purged)", res2.Purged)
	}
}

// TestCleanupPurgesRetiredWorkflowRuns proves the cleanup workflow also
// removes an orphaned run of a retired Workflow Type (the real-world case
// that motivated this: a leftover per-repo "ignore" tracker from before that
// feature was replaced by task_snooze) — unconditionally, not scoped to any
// PR target — while leaving a run of a still-current per-repo tracker alone.
func TestCleanupPurgesRetiredWorkflowRuns(t *testing.T) {
	ctm := newCleanupTestManager(t)

	// Simulate the real orphan: a run of a workflow type that is no longer
	// registered in the real app (retiredWorkflowTypes only names it, the
	// registering code itself is gone) but was once a normal, waiting
	// per-repo tracker. Registering it here only long enough to start it
	// mirrors that shape without needing the removed modules/ignore code.
	ctm.mgr.engine.RegisterWorkflow("ignore", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		var out struct{}
		w.WaitSignal("ignore", &out) // blocks forever, like the real tracker did
		return nil, nil
	})
	retiredID, err := ctm.mgr.engine.StartWorkflow("ignore", struct {
		Repo string `json:"repo"`
	}{Repo: "test/repo"})
	if err != nil {
		t.Fatal(err)
	}
	if status, err := ctm.mgr.engine.Status(retiredID); err != nil || status != tembed.StatusWaiting {
		t.Fatalf("retired run status = %q, %v, want waiting", status, err)
	}

	// A current, still-registered per-repo tracker must survive the same pass.
	currentID, err := ctm.mgr.engine.StartWorkflow(WorkflowPRInbox, struct {
		Repo string `json:"repo"`
	}{Repo: "test/repo"})
	if err != nil {
		t.Fatal(err)
	}

	res, err := ctm.mgr.StartCleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.RetiredRunsDeleted != 1 {
		t.Fatalf("RetiredRunsDeleted = %d, want 1", res.RetiredRunsDeleted)
	}
	if _, err := ctm.mgr.engine.Status(retiredID); err == nil {
		t.Fatal("retired run still present after cleanup")
	}
	if _, err := ctm.mgr.engine.Status(currentID); err != nil {
		t.Fatalf("current per-repo tracker was removed by cleanup: %v", err)
	}

	// A second pass is a no-op — nothing left to delete.
	res2, err := ctm.mgr.StartCleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res2.RetiredRunsDeleted != 0 {
		t.Fatalf("second pass RetiredRunsDeleted = %d, want 0", res2.RetiredRunsDeleted)
	}
}

// startOrphanCandidate starts a real, local (never posted to GitHub, so no
// poll() goroutine spins up — see StartCodeComment's rootID guard)
// task_code_comment run and returns its run ID. Local:true keeps this
// offline, mirroring the existing StartCodeComment tests in workflows_test.go.
func startOrphanCandidate(t *testing.T, ctm *cleanupTestManager, pr int) string {
	t.Helper()
	runID, err := ctm.mgr.StartCodeComment(context.Background(), CodeCommentInput{
		PR: pr, File: "src/Order.php", Line: 1, Author: "AI check",
		Body: "test", Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runID
}

// TestCleanupPurgesOrphanCommentRuns proves the cleanup workflow also removes
// a task_code_comment run whose own comment has vanished from comments.db —
// the real-world case that motivated this: 272 of 553 waiting runs pointed at
// a comment that no longer existed, so they polled GitHub forever with no
// comment left for a reviewer to ever act on. A `waiting` orphan is removed
// regardless of age; a `running` orphan only once it's stale
// (> orphanRunningAge) — a fresh `running` orphan is left alone, to avoid
// racing a run that's genuinely still mid-Activity. A run whose comment is
// still present, in either status, must never be touched.
func TestCleanupPurgesOrphanCommentRuns(t *testing.T) {
	ctm := newCleanupTestManager(t)
	ctx := context.Background()

	waitOrphan := startOrphanCandidate(t, ctm, 1)
	if status, err := ctm.mgr.engine.Status(waitOrphan); err != nil || status != tembed.StatusWaiting {
		t.Fatalf("waitOrphan status = %q, %v, want waiting", status, err)
	}
	if err := ctm.comments.Delete(ctx, waitOrphan); err != nil {
		t.Fatal(err)
	}

	waitKept := startOrphanCandidate(t, ctm, 1) // comment row deliberately left in place

	runOrphanStale := startOrphanCandidate(t, ctm, 1)
	if err := ctm.comments.Delete(ctx, runOrphanStale); err != nil {
		t.Fatal(err)
	}
	if err := ctm.store.SetStatus(runOrphanStale, tembed.StatusRunning, time.Now().Add(-orphanRunningAge-time.Hour)); err != nil {
		t.Fatal(err)
	}

	runOrphanFresh := startOrphanCandidate(t, ctm, 1)
	if err := ctm.comments.Delete(ctx, runOrphanFresh); err != nil {
		t.Fatal(err)
	}
	if err := ctm.store.SetStatus(runOrphanFresh, tembed.StatusRunning, time.Now()); err != nil {
		t.Fatal(err)
	}

	res, err := ctm.mgr.StartCleanup(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.OrphanCommentRunsDeleted != 2 {
		t.Fatalf("OrphanCommentRunsDeleted = %d, want 2 (waitOrphan + runOrphanStale)", res.OrphanCommentRunsDeleted)
	}

	if _, err := ctm.mgr.engine.Status(waitOrphan); err == nil {
		t.Fatal("waiting orphan still present after cleanup")
	}
	if _, err := ctm.mgr.engine.Status(runOrphanStale); err == nil {
		t.Fatal("stale running orphan still present after cleanup")
	}
	if _, err := ctm.mgr.engine.Status(waitKept); err != nil {
		t.Fatalf("waiting run with a live comment was removed: %v", err)
	}
	if _, err := ctm.mgr.engine.Status(runOrphanFresh); err != nil {
		t.Fatalf("fresh running orphan (not yet stale) was removed: %v", err)
	}

	// A second pass finds nothing new to purge (idempotent) — the surviving
	// runs above still hold, since runOrphanFresh isn't old enough yet either.
	res2, err := ctm.mgr.StartCleanup(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res2.OrphanCommentRunsDeleted != 0 {
		t.Fatalf("second pass OrphanCommentRunsDeleted = %d, want 0", res2.OrphanCommentRunsDeleted)
	}
}
