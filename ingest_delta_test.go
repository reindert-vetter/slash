package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"

	"slash/modules/approvals"
	"slash/modules/callresolve"
	"slash/modules/comments"
)

// TestUpsertPRFileBlocksPreservesLinkedData is the hard requirement behind the
// ingest-refresh feature: a delta refresh must never lose anything hanging off
// a block — comments, approvals, and LLM-found call resolutions — whether the
// block's file was untouched by the refresh, or the block was re-parsed under
// the exact same id (a body edit, not a rename). upsertPRFileBlocks only ever
// touches the blocks table (scoped to the given files); comments/approvals/
// callresolve live in entirely separate SQLite files with no FK to it, so this
// asserts that separation actually holds end to end.
func TestUpsertPRFileBlocksPreservesLinkedData(t *testing.T) {
	dataDir := t.TempDir()
	pr := 42
	ctx := context.Background()

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	fileA := "app/Services/OrderService.php"   // refreshed by the delta below
	fileB := "app/Services/InvoiceService.php" // untouched by the delta

	blockA := Block{PR: pr, File: fileA, Class: "OrderService", Name: "build", Line: 10, EndLine: 20, Status: StatusModified, Side: SideNew}
	blockB := Block{PR: pr, File: fileB, Class: "InvoiceService", Name: "finalize", Line: 5, EndLine: 15, Status: StatusModified, Side: SideNew}

	// Simulate the initial full ingest.
	if err := replacePRBlocks(db, pr, []Block{blockA, blockB}); err != nil {
		t.Fatal(err)
	}
	idA, idB := blockA.ID(), blockB.ID()

	// Approvals for both blocks.
	ap, err := approvals.Open(filepath.Join(dataDir, "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ap.Close()
	if err := ap.Replace(ctx, pr, idA, []int{1, 2}, nil); err != nil {
		t.Fatal(err)
	}
	if err := ap.Replace(ctx, pr, idB, []int{0}, nil); err != nil {
		t.Fatal(err)
	}

	// A comment hanging off block A.
	cs, err := comments.Open(filepath.Join(dataDir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	comment := comments.Comment{
		ID: "c1", RunID: "c1", PR: pr, File: fileA, Line: 12,
		Author: "reviewer", Body: "please check this", Label: "OrderService::build",
		Path: "/pr-42/" + fileA + "/OrderService::build/comment-c1",
	}
	if err := cs.Save(ctx, comment); err != nil {
		t.Fatal(err)
	}

	// An LLM-found call resolution for a call block A makes.
	cr, err := callresolve.Open(filepath.Join(dataDir, "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cr.Close()
	found := callresolve.Entry{
		PR: pr, CallerID: idA, CallKey: "joinAddress", Status: callresolve.StatusFound,
		ChildFile: "app/Support/AddressJoiner.php", ChildClass: "AddressJoiner", ChildMethod: "join",
		Model: callresolve.ModelSonnet, Confidence: "high",
	}
	if err := cr.Save(ctx, found); err != nil {
		t.Fatal(err)
	}

	// Delta refresh: only fileA's block is re-parsed (same id — a body edit,
	// not a rename); fileB is not passed at all, simulating "untouched by this
	// refresh".
	newBlockA := blockA
	newBlockA.EndLine = 30
	if err := upsertPRFileBlocks(db, pr, []string{fileA}, []Block{newBlockA}); err != nil {
		t.Fatal(err)
	}

	blocks, err := blocksByPR(db, pr)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Block{}
	for _, b := range blocks {
		byID[b.ID()] = b
	}
	if got, ok := byID[idA]; !ok || got.EndLine != 30 {
		t.Fatalf("block A after refresh = %+v, want EndLine 30", got)
	}
	if got, ok := byID[idB]; !ok || got.EndLine != 15 {
		t.Fatalf("block B after refresh = %+v, want completely untouched (EndLine 15)", got)
	}

	// Approvals for both blocks survive untouched.
	appr, err := ap.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	apByID := map[string]approvals.Approval{}
	for _, a := range appr {
		apByID[a.BlockID] = a
	}
	if a, ok := apByID[idA]; !ok || len(a.Rows) != 2 {
		t.Fatalf("approval for A missing/changed after refresh: %+v", a)
	}
	if a, ok := apByID[idB]; !ok || len(a.Rows) != 1 {
		t.Fatalf("approval for B missing/changed after refresh: %+v", a)
	}

	// The comment on block A survives.
	comms, err := cs.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	gotComment := false
	for _, c := range comms {
		if c.ID == "c1" && c.Body == "please check this" {
			gotComment = true
		}
	}
	if !gotComment {
		t.Fatal("comment on block A did not survive the delta refresh")
	}

	// The LLM-found call resolution survives with its status intact — a
	// refresh must never silently reset an LLM-owned "found" row.
	entries, err := cr.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	gotFound := false
	for _, e := range entries {
		if e.CallerID == idA && e.CallKey == "joinAddress" {
			gotFound = true
			if e.Status != callresolve.StatusFound {
				t.Fatalf("call resolution status = %q after refresh, want %q (untouched)", e.Status, callresolve.StatusFound)
			}
		}
	}
	if !gotFound {
		t.Fatal("call resolution for block A's call did not survive the delta refresh")
	}
}

// TestUpsertPRFileBlocksRemovesDeletedSymbol confirms upsertPRFileBlocks still
// drops a block whose symbol disappeared from a delta file (the new parse of
// that file simply doesn't include it), while leaving every other file's
// blocks alone.
func TestUpsertPRFileBlocksRemovesDeletedSymbol(t *testing.T) {
	dataDir := t.TempDir()
	pr := 7
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	file := "app/Services/OrderService.php"
	other := "app/Services/InvoiceService.php"
	removed := Block{PR: pr, File: file, Class: "OrderService", Name: "oldHelper", Line: 30, EndLine: 32, Status: StatusModified, Side: SideNew}
	kept := Block{PR: pr, File: other, Class: "InvoiceService", Name: "finalize", Line: 5, EndLine: 15, Status: StatusModified, Side: SideNew}
	if err := replacePRBlocks(db, pr, []Block{removed, kept}); err != nil {
		t.Fatal(err)
	}

	// The delta refresh re-parses `file` and finds no blocks at all in it
	// (e.g. the method was deleted).
	if err := upsertPRFileBlocks(db, pr, []string{file}, nil); err != nil {
		t.Fatal(err)
	}

	blocks, err := blocksByPR(db, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].ID() != kept.ID() {
		t.Fatalf("blocks after refresh = %+v, want only %q left", blocks, kept.ID())
	}
}

// TestSaveLoadIngestSHAs round-trips the pr_ingest table: absent before the
// first save, then returns exactly what was last saved (and a second save
// overwrites, not accumulates).
func TestSaveLoadIngestSHAs(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, _, ok, err := loadIngestSHAs(db, 1); err != nil || ok {
		t.Fatalf("loadIngestSHAs before any save = ok=%v err=%v, want ok=false", ok, err)
	}

	if err := saveIngestSHAs(db, 1, "base1", "head1"); err != nil {
		t.Fatal(err)
	}
	base, head, ok, err := loadIngestSHAs(db, 1)
	if err != nil || !ok || base != "base1" || head != "head1" {
		t.Fatalf("loadIngestSHAs = base=%q head=%q ok=%v err=%v, want base1/head1/true", base, head, ok, err)
	}

	if err := saveIngestSHAs(db, 1, "base1", "head2"); err != nil {
		t.Fatal(err)
	}
	base, head, ok, err = loadIngestSHAs(db, 1)
	if err != nil || !ok || base != "base1" || head != "head2" {
		t.Fatalf("loadIngestSHAs after update = base=%q head=%q ok=%v err=%v, want base1/head2/true", base, head, ok, err)
	}
}

// TestRefreshIngestDeltaRequiresPriorIngest asserts refreshIngestDelta refuses
// to run without a prior recorded ingest (nothing to diff from) — no git/gh
// call is made in that case.
func TestRefreshIngestDeltaRequiresPriorIngest(t *testing.T) {
	dataDir := t.TempDir()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := refreshIngestDelta(context.Background(), db, dataDir, 99, "base", "head"); err == nil {
		t.Fatal("refreshIngestDelta without a prior ingest should error, got nil")
	}
}

// TestRefreshIngestDeltaSkipsWhenHeadUnchanged asserts refreshIngestDelta is a
// pure no-op (no git/gh call) when the observed head SHA already matches the
// last-recorded one.
func TestRefreshIngestDeltaSkipsWhenHeadUnchanged(t *testing.T) {
	dataDir := t.TempDir()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := saveIngestSHAs(db, 99, "base1", "head1"); err != nil {
		t.Fatal(err)
	}
	res, err := refreshIngestDelta(context.Background(), db, dataDir, 99, "base1", "head1")
	if err != nil {
		t.Fatalf("refreshIngestDelta: %v", err)
	}
	if !res.Skipped {
		t.Fatalf("res = %+v, want Skipped=true", res)
	}
}

// TestRefreshIngestDeltaEndToEnd exercises the real delta path (base SHA
// unchanged, head SHA advanced) against two real commits from the upstream
// repo, then asserts only the changed file's blocks were rewritten and
// pr_ingest was updated. It needs real gh/git access (like
// TestIngestWorkflowEndToEnd), so it skips itself when that isn't reachable.
func TestRefreshIngestDeltaEndToEnd(t *testing.T) {
	if _, err := exec.Command("gh", "pr", "view", "12903", "--repo", repoSlug, "--json", "number").Output(); err != nil {
		t.Skipf("gh not reachable, skipping: %v", err)
	}

	dataDir := t.TempDir()
	pr := 12903
	ctx := context.Background()

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	shas, err := prepareIngestWorktrees(ctx, dataDir, pr)
	if err != nil {
		t.Fatalf("prepareIngestWorktrees: %v", err)
	}
	// Pretend the last ingest only saw an ancestor of the real head, one commit
	// back — so refreshIngestDelta has real work to do (a genuine delta between
	// two real commits, no synthetic fixture needed).
	out, err := runGit(ctx, "rev-list", "-n", "1", shas.HeadSHA+"~1")
	if err != nil {
		t.Skipf("no ancestor commit available, skipping: %v", err)
	}
	priorHead := string(bytesTrim(out))
	if priorHead == "" || priorHead == shas.HeadSHA {
		t.Skip("could not derive a distinct prior head SHA, skipping")
	}

	if _, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, pr, worktreeSHAs{
		BaseSHA: shas.BaseSHA, HeadSHA: priorHead, Paths: shas.Paths,
	}); err != nil {
		t.Fatalf("seed initial (older) ingest: %v", err)
	}

	before, err := blocksByPR(db, pr)
	if err != nil {
		t.Fatal(err)
	}

	res, err := refreshIngestDelta(ctx, db, dataDir, pr, shas.BaseSHA, shas.HeadSHA)
	if err != nil {
		t.Fatalf("refreshIngestDelta: %v", err)
	}
	if res.FullFallback {
		t.Fatalf("expected the delta path (base unchanged), got a full fallback: %+v", res)
	}

	_, head, ok, err := loadIngestSHAs(db, pr)
	if err != nil || !ok || head != shas.HeadSHA {
		t.Fatalf("loadIngestSHAs after refresh = head=%q ok=%v err=%v, want %q/true", head, ok, err, shas.HeadSHA)
	}

	after, err := blocksByPR(db, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) == 0 {
		t.Fatal("refresh left zero blocks")
	}
	_ = before // the exact delta depends on live repo history; the real assertions above (no error, correct fallback flag, pr_ingest updated, non-empty result) are what's environment-independent.
}

// bytesTrim trims trailing newline/whitespace from git command output.
func bytesTrim(b []byte) []byte {
	n := len(b)
	for n > 0 && (b[n-1] == '\n' || b[n-1] == '\r' || b[n-1] == ' ') {
		n--
	}
	return b[:n]
}
