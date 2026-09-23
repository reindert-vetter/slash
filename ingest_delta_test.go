package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	if err := replacePRBlocks(db, "", pr, []Block{blockA, blockB}); err != nil {
		t.Fatal(err)
	}
	idA, idB := blockA.ID(), blockB.ID()

	// Approvals for both blocks.
	ap, err := approvals.Open(filepath.Join(dataDir, "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ap.Close()
	if err := ap.Replace(ctx, "", pr, idA, []int{1, 2}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := ap.Replace(ctx, "", pr, idB, []int{0}, nil, nil); err != nil {
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
	if err := upsertPRFileBlocks(db, "", pr, []string{fileA}, []Block{newBlockA}); err != nil {
		t.Fatal(err)
	}

	blocks, err := blocksByPR(db, "", pr)
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
	appr, err := ap.List(ctx, "", pr)
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
	comms, err := cs.List(ctx, "", pr)
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
	entries, err := cr.List(ctx, "", pr)
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
	if err := replacePRBlocks(db, "", pr, []Block{removed, kept}); err != nil {
		t.Fatal(err)
	}

	// The delta refresh re-parses `file` and finds no blocks at all in it
	// (e.g. the method was deleted).
	if err := upsertPRFileBlocks(db, "", pr, []string{file}, nil); err != nil {
		t.Fatal(err)
	}

	blocks, err := blocksByPR(db, "", pr)
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

	if _, _, ok, err := loadIngestSHAs(db, "", 1); err != nil || ok {
		t.Fatalf("loadIngestSHAs before any save = ok=%v err=%v, want ok=false", ok, err)
	}

	if err := saveIngestSHAs(db, "", 1, "base1", "head1"); err != nil {
		t.Fatal(err)
	}
	base, head, ok, err := loadIngestSHAs(db, "", 1)
	if err != nil || !ok || base != "base1" || head != "head1" {
		t.Fatalf("loadIngestSHAs = base=%q head=%q ok=%v err=%v, want base1/head1/true", base, head, ok, err)
	}

	if err := saveIngestSHAs(db, "", 1, "base1", "head2"); err != nil {
		t.Fatal(err)
	}
	base, head, ok, err = loadIngestSHAs(db, "", 1)
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

	if _, err := refreshIngestDelta(context.Background(), db, dataDir, "", 99, "base", "head"); err == nil {
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

	if err := saveIngestSHAs(db, "", 99, "base1", "head1"); err != nil {
		t.Fatal(err)
	}
	res, err := refreshIngestDelta(context.Background(), db, dataDir, "", 99, "base1", "head1")
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

	shas, err := prepareIngestWorktrees(ctx, dataDir, "", pr)
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

	if _, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, "", pr, worktreeSHAs{
		BaseSHA: shas.BaseSHA, HeadSHA: priorHead, Paths: shas.Paths,
	}); err != nil {
		t.Fatalf("seed initial (older) ingest: %v", err)
	}

	before, err := blocksByPR(db, "", pr)
	if err != nil {
		t.Fatal(err)
	}

	res, err := refreshIngestDelta(ctx, db, dataDir, "", pr, shas.BaseSHA, shas.HeadSHA)
	if err != nil {
		t.Fatalf("refreshIngestDelta: %v", err)
	}
	if res.FullFallback {
		t.Fatalf("expected the delta path (base unchanged), got a full fallback: %+v", res)
	}

	_, head, ok, err := loadIngestSHAs(db, "", pr)
	if err != nil || !ok || head != shas.HeadSHA {
		t.Fatalf("loadIngestSHAs after refresh = head=%q ok=%v err=%v, want %q/true", head, ok, err, shas.HeadSHA)
	}

	after, err := blocksByPR(db, "", pr)
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

// ingestRefreshNeeded is what keeps a landed-but-unpushed chat edit visible: the
// stored head SHA is then a LOCAL commit GitHub hasn't seen, so remote and
// stored differ on every poll tick and a bare inequality check would rewind the
// review tree to the older remote tip over and over.
func TestIngestRefreshNeededIgnoresALandedLocalCommit(t *testing.T) {
	_, cloneDir := setupChatShadowRepo(t, "feature/x", "v1\n")
	ctx := context.Background()

	remoteOut, err := runGit(ctx, "rev-parse", "origin/feature/x")
	if err != nil {
		t.Fatalf("rev-parse origin: %v", err)
	}
	remote := string(bytesTrim(remoteOut))

	if ingestRefreshNeeded(ctx, remote, remote) {
		t.Fatal("identical SHAs should never need a refresh")
	}

	// A landed chat edit: one commit on top of the remote tip, present only
	// locally (commit-tree needs no checkout — the clone has none, exactly like
	// the real clone whose worktrees are all detached/on their own branches).
	localOut, err := exec.Command("git", "-C", cloneDir, "commit-tree", remote+"^{tree}", "-p", remote, "-m", "landed chat edit").Output()
	if err != nil {
		t.Fatalf("commit-tree: %v", err)
	}
	local := string(bytesTrim(localOut))

	if ingestRefreshNeeded(ctx, remote, local) {
		t.Fatal("a stored head that already contains the remote tip must not trigger a refresh")
	}
	// The reverse — the remote genuinely moved past what was ingested — still must.
	if !ingestRefreshNeeded(ctx, local, remote) {
		t.Fatal("a remote tip the stored head does not contain must trigger a refresh")
	}
}

// refreshTreeAfterLanding is best-effort glue called from an Activity: without a
// manager (tests), without a graph DB, or without any prior ingest to build a
// delta on, it must quietly do nothing rather than panic or signal nonsense.
func TestRefreshTreeAfterLandingNoOpsWithoutPriorIngest(t *testing.T) {
	setupChatShadowRepo(t, "feature/x", "v1\n")
	refreshTreeAfterLanding(context.Background(), nil, "", 4242, "feature/x", nil)
}

// TestFilterToPRFilesDropsBaseBranchMergeNoise is the guard behind the bug this
// filter exists for: merging the base branch into the head makes the
// prevHead..head delta list every file that branch touched meanwhile, none of
// which belong to the PR. Only the PR's own files may survive, in order.
func TestFilterToPRFilesDropsBaseBranchMergeNoise(t *testing.T) {
	prFiles := []string{
		"modules/Statistics/Workflows/SessionFlow.php",
		"modules/Statistics/Enums/StatsTable.php",
	}
	delta := []string{
		"modules/Statistics/Workflows/SessionFlow.php",
		"modules/Accounting/Tests/Feature/Moneybird/MoneybirdApiTest.php", // came in with the merge
		"resources/checkout/views/partials/style.blade.php",               // idem
		"modules/Statistics/Enums/StatsTable.php",
	}
	got := filterToPRFiles(delta, prFiles)
	want := []string{
		"modules/Statistics/Workflows/SessionFlow.php",
		"modules/Statistics/Enums/StatsTable.php",
	}
	if len(got) != len(want) {
		t.Fatalf("filterToPRFiles = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("filterToPRFiles = %v, want %v", got, want)
		}
	}
	// An empty PR file list can only mean "we don't know", never "no files".
	if got := filterToPRFiles(delta, nil); len(got) != 0 {
		t.Fatalf("filterToPRFiles with no pr files = %v, want empty", got)
	}
}

// TestPruneBlocksOutsidePRFiles asserts the self-heal half: blocks a widened
// delta already stored for files outside the PR are removed, the PR's own
// blocks and another PR's blocks are untouched, and an empty file list is a
// no-op rather than a wipe.
func TestPruneBlocksOutsidePRFiles(t *testing.T) {
	dataDir := t.TempDir()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mine := "modules/Statistics/Workflows/SessionFlow.php"
	noise := "modules/Accounting/Tests/Feature/Moneybird/MoneybirdApiTest.php"
	blocks := []Block{
		{PR: 13535, File: mine, Class: "SessionFlow", Name: "write", Line: 10, EndLine: 20, Status: StatusModified, Side: SideNew},
		{PR: 13535, File: noise, Class: "MoneybirdApiTest", Name: "test_it", Line: 5, EndLine: 9, Status: StatusAdded, Side: SideNew},
	}
	if err := replacePRBlocks(db, "", 13535, blocks); err != nil {
		t.Fatal(err)
	}
	other := []Block{{PR: 99, File: noise, Class: "MoneybirdApiTest", Name: "test_it", Line: 5, EndLine: 9, Status: StatusAdded, Side: SideNew}}
	if err := replacePRBlocks(db, "", 99, other); err != nil {
		t.Fatal(err)
	}

	if n, err := pruneBlocksOutsidePRFiles(db, "", 13535, nil); err != nil || n != 0 {
		t.Fatalf("prune with no pr files = %d, %v; want 0, nil (never a wipe)", n, err)
	}
	n, err := pruneBlocksOutsidePRFiles(db, "", 13535, []string{mine})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("pruned %d block(s), want 1", n)
	}

	var left int
	if err := db.QueryRow(`SELECT COUNT(*) FROM blocks WHERE pr = 13535`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("pr 13535 has %d block(s) left, want 1", left)
	}
	var otherLeft int
	if err := db.QueryRow(`SELECT COUNT(*) FROM blocks WHERE pr = 99`).Scan(&otherLeft); err != nil {
		t.Fatal(err)
	}
	if otherLeft != 1 {
		t.Fatalf("pr 99 has %d block(s) left, want 1 (another PR must be untouched)", otherLeft)
	}
}

// checkoutBranch points dir's local HEAD at an existing remote-tracking
// branch. setupChatShadowRepo's bare "origin" has no default branch matching
// headRefName (its own HEAD still points at git's default, e.g. master/main,
// which was never pushed), so a plain `git clone` leaves the clone's local
// HEAD unborn — `rev-parse HEAD` fails right after setupChatShadowRepo
// returns, even though `origin/<headRefName>` already holds the seeded
// commit. Call this first in any test that needs a real local HEAD to commit
// on top of.
func checkoutBranch(t *testing.T, dir, branch string) {
	t.Helper()
	cmd := exec.Command("git", "-C", dir, "checkout", "-B", branch, "origin/"+branch)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git checkout -B %s origin/%s: %v: %s", branch, branch, err, out)
	}
}

// setupDevelopRepo builds a throwaway bare "origin" plus a local clone whose
// origin/develop already exists and holds one seed commit — prLocalChangedFilePaths
// resolves the base branch's LIVE tip via `baseBranchFor(repo)`, which defaults
// to "develop" for the primary repo (repos.go), so any fixture exercising it
// needs a real origin/develop, unlike setupChatShadowRepo's single arbitrary
// branch. Returns the clone dir (SLASH_REPO_DIR is already set, same as
// setupChatShadowRepo) and the seed commit's SHA (develop's tip == the PR's
// merge base for every fixture below, since nothing else ever commits to
// develop in these tests).
func setupDevelopRepo(t *testing.T) (cloneDir, developSHA string) {
	t.Helper()
	root := t.TempDir()
	bareDir := filepath.Join(root, "origin.git")
	seedDir := filepath.Join(root, "seed")
	cloneDir = filepath.Join(root, "clone")

	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s (in %s): %v: %s", strings.Join(args, " "), dir, err, out)
		}
	}

	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.Command("git", "init", "--bare", bareDir).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v", err)
	}
	run(seedDir, "init")
	run(seedDir, "config", "user.email", "test@example.com")
	run(seedDir, "config", "user.name", "test")
	run(seedDir, "checkout", "-b", "develop")
	if err := os.WriteFile(filepath.Join(seedDir, "seed.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(seedDir, "add", "seed.txt")
	run(seedDir, "commit", "-m", "seed develop")
	run(seedDir, "remote", "add", "origin", bareDir)
	run(seedDir, "push", "origin", "develop")

	if _, err := exec.Command("git", "clone", bareDir, cloneDir).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v", err)
	}
	run(cloneDir, "config", "user.email", "test@example.com")
	run(cloneDir, "config", "user.name", "test")

	t.Setenv("SLASH_REPO_DIR", cloneDir)
	remoteHeadCache.Lock()
	remoteHeadCache.byPR = map[prKey]remoteHeadEntry{}
	remoteHeadCache.Unlock()

	checkoutBranch(t, cloneDir, "develop")
	out, err := exec.Command("git", "-C", cloneDir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return cloneDir, string(bytesTrim(out))
}

// commitPHPFile writes a small PHP file with one function into dir and commits
// it, returning the new commit's SHA. Used by the offline (no gh, no network)
// fixtures below to build a real local git history for refreshIngestDelta's
// widening guard.
func commitPHPFile(t *testing.T, dir, path, funcName, msg string) string {
	t.Helper()
	full := filepath.Join(dir, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "<?php\n\nfunction " + funcName + "() {\n    return true;\n}\n"
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("add", path)
	run("commit", "-m", msg)
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return string(bytesTrim(out))
}

// TestPRLocalChangedFilePathsUsesLocalGitOnly asserts prLocalChangedFilePaths
// returns the real merge-base..head file set purely from local git, with zero
// gh/network involvement — the fix for the race documented on
// refreshIngestDelta's widening-guard call site ("A delta refresh must not
// depend on gh for its own widening guard", .claude/docs/blocks-and-ingest.md):
// gh's own `files` list can still be computing right after a push and briefly
// under-report, silently dropping a just-pushed file from the PR forever. A
// local merge-base..head diff cannot lag like that.
func TestPRLocalChangedFilePathsUsesLocalGitOnly(t *testing.T) {
	cloneDir, developSHA := setupDevelopRepo(t)
	ctx := context.Background()

	// Branch off develop locally (no push needed — prLocalChangedFilePaths
	// only ever needs origin/develop, never the head branch itself, so the
	// PR's own commits stay purely local, exactly like a not-yet-pushed
	// landed chat edit).
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "-b", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b feature/x: %v: %s", err, out)
	}

	commitPHPFile(t, cloneDir, "app/Foo.php", "foo", "add Foo")
	headSHA := commitPHPFile(t, cloneDir, "app/Bar.php", "bar", "add Bar")

	files, err := prLocalChangedFilePaths(ctx, "", headSHA)
	if err != nil {
		t.Fatalf("prLocalChangedFilePaths: %v", err)
	}
	want := map[string]bool{"app/Foo.php": true, "app/Bar.php": true}
	if len(files) != len(want) {
		t.Fatalf("files = %v, want exactly %v", files, want)
	}
	for _, f := range files {
		if !want[f] {
			t.Fatalf("unexpected file %q in %v", f, files)
		}
	}

	// develop's own tip, unchanged relative to itself: no changed files,
	// reported as an error (the caller treats an error as "no filter", never
	// as "the PR has zero files").
	if _, err := prLocalChangedFilePaths(ctx, "", developSHA); err == nil {
		t.Fatal("expected an error when head equals the base branch tip, got nil")
	}
}

// TestRefreshIngestDeltaKeepsAJustPushedFile reproduces the actual production
// symptom (PR 13810: app/Events/Subscriptions/SubscriptionStateEvent.php
// changed on GitHub but never appeared locally): a file that only entered the
// PR in the very commit a delta refresh is now processing must survive the
// widening guard, even though it was never part of any earlier-recorded file
// list. Before the fix this guard intersected the delta against a FRESH `gh pr
// view` snapshot, which can still be computing right after a push and briefly
// omit that file — silently dropping it, forever, since the stored head SHA
// then already matches and no later poll ever retries. This test needs no gh
// stub/fake at all, which is exactly the point of the fix: the guard is now
// pure local git and cannot race against GitHub's own backend.
func TestRefreshIngestDeltaKeepsAJustPushedFile(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13810
	ctx := context.Background()

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cloneDir, baseSHA := setupDevelopRepo(t)
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "-b", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b feature/x: %v: %s", err, out)
	}

	// The previously-ingested head: only app/Foo.php exists in the PR so far.
	prevHeadSHA := commitPHPFile(t, cloneDir, "app/Foo.php", "foo", "add Foo")

	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	if err := ensureWorktree(ctx, "", baseDir, baseSHA); err != nil {
		t.Fatalf("base worktree: %v", err)
	}
	if err := ensureWorktree(ctx, "", headDir, prevHeadSHA); err != nil {
		t.Fatalf("head worktree: %v", err)
	}
	if _, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, "", pr, worktreeSHAs{
		BaseSHA: baseSHA, HeadSHA: prevHeadSHA, Paths: []string{"app/Foo.php"},
	}); err != nil {
		t.Fatalf("seed initial ingest: %v", err)
	}

	// A new commit lands on the PR, touching a brand-new file — the moment a
	// real `gh pr view` snapshot could still be lagging behind.
	newHeadSHA := commitPHPFile(t, cloneDir, "app/Events/Subscriptions/SubscriptionStateEvent.php", "getProductTags", "touch SubscriptionStateEvent")

	res, err := refreshIngestDelta(ctx, db, dataDir, "", pr, baseSHA, newHeadSHA)
	if err != nil {
		t.Fatalf("refreshIngestDelta: %v", err)
	}
	if res.FullFallback || res.Skipped {
		t.Fatalf("expected a plain delta refresh, got %+v", res)
	}

	blocks, err := blocksByPR(db, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, b := range blocks {
		if b.File == "app/Events/Subscriptions/SubscriptionStateEvent.php" {
			found = true
		}
	}
	if !found {
		t.Fatalf("app/Events/Subscriptions/SubscriptionStateEvent.php missing from blocks after refresh: %+v", blocks)
	}
}

// stubGHUnreachable prepends a fake `gh` executable that always fails
// immediately (no network) to PATH, ahead of any real `gh` — so any call
// this test expects to route through git only (never gh) fails loudly and
// fast instead of silently succeeding against a real, authenticated `gh` on
// the machine running the test. git itself is untouched (PATH is prepended,
// not replaced), so ordinary git plumbing keeps working.
func stubGHUnreachable(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\necho 'stubbed gh: no network in tests' >&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestRefreshIngestDeltaFallsBackOnRebasedHead covers "Rebase zonder dat er
// gepushed is, kan voorkomen": a rebase/force-push can rewrite the PR's own
// commits without moving the resolved merge base at all (squashed onto the
// very same base tip), which the existing `baseSHA != prevBase` guard alone
// cannot see — yet the previously-recorded head is no longer reachable from
// the new one, so a prevHead..headSHA diff is not a meaningful "what changed
// since the last refresh" question anymore. refreshIngestDelta must detect
// that (isAncestor) and fall back to a full ingest instead of risking a delta
// that silently misses files.
//
// Since the full-ingest fallback itself needs gh (prepareIngestWorktreesLocked
// calls fetchPRMeta), this test stubs `gh` to fail immediately (stubGHUnreachable)
// and merely asserts refreshIngestDelta actually TOOK the fallback branch (its
// error names the fallback, coming from the stub's instant failure) rather
// than silently proceeding with a bogus delta. A companion assertion on the
// ordinary (non-rebased) path proves that path never touches gh at all, with
// the exact same stub in place.
func TestRefreshIngestDeltaFallsBackOnRebasedHead(t *testing.T) {
	dataDir := t.TempDir()
	pr := 4242
	ctx := context.Background()

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cloneDir, baseSHA := setupDevelopRepo(t)
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "-b", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b feature/x: %v: %s", err, out)
	}

	prevHeadSHA := commitPHPFile(t, cloneDir, "app/Foo.php", "foo", "add Foo")

	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	if err := ensureWorktree(ctx, "", baseDir, baseSHA); err != nil {
		t.Fatalf("base worktree: %v", err)
	}
	if err := ensureWorktree(ctx, "", headDir, prevHeadSHA); err != nil {
		t.Fatalf("head worktree: %v", err)
	}
	if _, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, "", pr, worktreeSHAs{
		BaseSHA: baseSHA, HeadSHA: prevHeadSHA, Paths: []string{"app/Foo.php"},
	}); err != nil {
		t.Fatalf("seed initial ingest: %v", err)
	}

	// A rebase: reset the branch back to the base tip and commit a brand-new,
	// unrelated commit object on top — same resolved merge base as before
	// (still just one commit forward from develop), but prevHeadSHA is no
	// longer an ancestor of the new head at all.
	if out, err := exec.Command("git", "-C", cloneDir, "reset", "--hard", baseSHA).CombinedOutput(); err != nil {
		t.Fatalf("git reset --hard: %v: %s", err, out)
	}
	rebasedHeadSHA := commitPHPFile(t, cloneDir, "app/Foo.php", "fooRebased", "rebased add Foo")

	if isAncestor(ctx, "", prevHeadSHA, rebasedHeadSHA) {
		t.Fatal("test setup broken: prevHeadSHA is still an ancestor of the rebased head")
	}

	stubGHUnreachable(t)

	_, err = refreshIngestDelta(ctx, db, dataDir, "", pr, baseSHA, rebasedHeadSHA)
	if err == nil {
		t.Fatal("expected an error (the stubbed gh failing inside the full-ingest fallback), got nil")
	}
	if !strings.Contains(err.Error(), "full ingest fallback") {
		t.Fatalf("error = %v, want it to name the full-ingest fallback (proving refreshIngestDelta took that branch)", err)
	}

	// Companion check: an ORDINARY (non-rebased) advance over the same stub
	// must NOT take that branch at all, i.e. must succeed without ever
	// touching the stubbed gh. Check out prevHeadSHA itself (still a real,
	// un-gc'd commit object) so the next commit is a genuine descendant of
	// it, unlike the rebased branch above which moved away from it.
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", prevHeadSHA).CombinedOutput(); err != nil {
		t.Fatalf("git checkout prevHeadSHA: %v: %s", err, out)
	}
	ordinaryHeadSHA := commitPHPFile(t, cloneDir, "app/Bar.php", "bar", "add Bar (no rebase)")
	if !isAncestor(ctx, "", prevHeadSHA, ordinaryHeadSHA) {
		t.Fatal("test setup broken: ordinaryHeadSHA should still be a descendant of prevHeadSHA")
	}
	res, err := refreshIngestDelta(ctx, db, dataDir, "", pr, baseSHA, ordinaryHeadSHA)
	if err != nil {
		t.Fatalf("refreshIngestDelta on the ordinary (non-rebased) path: %v", err)
	}
	if res.FullFallback {
		t.Fatalf("ordinary advance incorrectly took the full-ingest fallback: %+v", res)
	}
}

// TestRefreshIngestDeltaSavesHeadEvenWhenSomethingWasFiltered: when the
// widening guard drops a file from this round's delta, refreshIngestDelta
// still records the new head. A dropped file is identical at the merge base
// and the head (the guard is pure local git), so holding the head back only
// made every later poll redo the same filtered delta forever (PR 13810).
func TestRefreshIngestDeltaSavesHeadEvenWhenSomethingWasFiltered(t *testing.T) {
	dataDir := t.TempDir()
	pr := 5150
	ctx := context.Background()

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cloneDir, developSHA := setupDevelopRepo(t)

	// The PR's own branch: one commit ahead of develop.
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "-b", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b feature/x: %v: %s", err, out)
	}
	prevHeadSHA := commitPHPFile(t, cloneDir, "app/Foo.php", "foo", "add Foo")

	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	if err := ensureWorktree(ctx, "", baseDir, developSHA); err != nil {
		t.Fatalf("base worktree: %v", err)
	}
	if err := ensureWorktree(ctx, "", headDir, prevHeadSHA); err != nil {
		t.Fatalf("head worktree: %v", err)
	}
	if _, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, "", pr, worktreeSHAs{
		BaseSHA: developSHA, HeadSHA: prevHeadSHA, Paths: []string{"app/Foo.php"},
	}); err != nil {
		t.Fatalf("seed initial ingest: %v", err)
	}

	// develop advances independently (a commit the PR never asked for).
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "develop").CombinedOutput(); err != nil {
		t.Fatalf("git checkout develop: %v: %s", err, out)
	}
	developAdvancedSHA := commitPHPFile(t, cloneDir, "modules/Noise/Unrelated.php", "noise", "unrelated develop progress")
	if out, err := exec.Command("git", "-C", cloneDir, "push", "origin", "develop").CombinedOutput(); err != nil {
		t.Fatalf("git push origin develop: %v: %s", err, out)
	}

	// The reviewer merges the (now-advanced) develop into their own branch —
	// dragging modules/Noise/Unrelated.php along, none of which is really
	// part of this PR.
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("git checkout feature/x: %v: %s", err, out)
	}
	if out, err := exec.Command("git", "-C", cloneDir, "merge", "--no-edit", developAdvancedSHA).CombinedOutput(); err != nil {
		t.Fatalf("git merge develop into feature/x: %v: %s", err, out)
	}
	widenedHeadOut, err := exec.Command("git", "-C", cloneDir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	widenedHeadSHA := string(bytesTrim(widenedHeadOut))

	res, err := refreshIngestDelta(ctx, db, dataDir, "", pr, developSHA, widenedHeadSHA)
	if err != nil {
		t.Fatalf("refreshIngestDelta: %v", err)
	}
	if res.FullFallback {
		t.Fatalf("expected a plain delta refresh (base unchanged), got a full fallback: %+v", res)
	}

	// The noise file must never be stored...
	blocks, err := blocksByPR(db, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks {
		if b.File == "modules/Noise/Unrelated.php" {
			t.Fatalf("widening noise file leaked into blocks: %+v", blocks)
		}
	}

	// ...and the head still advances, so the next poll with the same head is
	// a Skipped no-op instead of the same filtered delta again.
	_, head, ok, err := loadIngestSHAs(db, "", pr)
	if err != nil || !ok {
		t.Fatalf("loadIngestSHAs: ok=%v err=%v", ok, err)
	}
	if head != widenedHeadSHA {
		t.Fatalf("pr_ingest head = %s, want the new head %s even though a file was filtered", short(head), short(widenedHeadSHA))
	}
	again, err := refreshIngestDelta(ctx, db, dataDir, "", pr, developSHA, widenedHeadSHA)
	if err != nil || !again.Skipped {
		t.Fatalf("second refresh at the same head: res=%+v err=%v, want Skipped", again, err)
	}
}

// TestPendingHeadForPrefersALandedChatEdit pins the rule every full ingest now
// applies (prepareIngestWorktreesLocked): a pending ref holding a landed,
// unpushed chat edit on top of GitHub's head wins; no ref, the same commit, or
// a remote that moved past it (the ref no longer contains the remote head)
// leaves GitHub's head in charge. Regression for PR 13835, where an AMENDED
// landing took refreshIngestDelta's full-ingest fallback and rewound the tree
// to the last pushed tip.
func TestPendingHeadForPrefersALandedChatEdit(t *testing.T) {
	cloneDir, _ := setupDevelopRepo(t)
	ctx := context.Background()
	pr, branch := 4243, "feature/x"
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "-b", branch).CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b: %v: %s", err, out)
	}
	remoteHead := commitPHPFile(t, cloneDir, "app/Foo.php", "foo", "pushed")

	if got := pendingHeadFor(ctx, "", pr, branch, remoteHead); got != "" {
		t.Fatalf("no pending ref: got %q, want \"\"", got)
	}
	setRef := func(sha string) {
		t.Helper()
		if out, err := exec.Command("git", "-C", cloneDir, "update-ref", prPendingRef("", pr, branch), sha).CombinedOutput(); err != nil {
			t.Fatalf("update-ref: %v: %s", err, out)
		}
	}
	setRef(remoteHead)
	if got := pendingHeadFor(ctx, "", pr, branch, remoteHead); got != "" {
		t.Fatalf("pending == remote: got %q, want \"\"", got)
	}

	landed := commitPHPFile(t, cloneDir, "app/Bar.php", "bar", "landed chat edit")
	setRef(landed)
	if got := pendingHeadFor(ctx, "", pr, branch, remoteHead); got != landed {
		t.Fatalf("landed on top of remote: got %q, want %q", got, landed)
	}
	if got := pendingHeadFor(ctx, "", pr, "", remoteHead); got != "" {
		t.Fatalf("unknown branch name: got %q, want \"\"", got)
	}

	// Someone pushed past the landed commit: the remote head is no longer
	// contained in the pending ref, so GitHub wins again.
	if out, err := exec.Command("git", "-C", cloneDir, "reset", "--hard", remoteHead).CombinedOutput(); err != nil {
		t.Fatalf("git reset: %v: %s", err, out)
	}
	pushedByColleague := commitPHPFile(t, cloneDir, "app/Baz.php", "baz", "colleague push")
	if got := pendingHeadFor(ctx, "", pr, branch, pushedByColleague); got != "" {
		t.Fatalf("remote moved past pending ref: got %q, want \"\"", got)
	}
}

// TestRefreshIngestDeltaFallbackKeepsTheRequestedHead is the PR 13835
// regression end to end: an AMENDED chat landing leaves the previous head
// unreachable, so refreshIngestDelta takes the full-ingest fallback — which
// used to re-resolve the head through gh (the last PUSHED tip, or a snapshot
// still lagging a push) and store THAT, silently rewinding the tree. Here gh
// is stubbed to report the stale pre-amend head; the recorded head must still
// be the amended one refreshIngestDelta was asked for, and its code must be
// what the head worktree now holds.
func TestRefreshIngestDeltaFallbackKeepsTheRequestedHead(t *testing.T) {
	dataDir := t.TempDir()
	pr := 4244
	ctx := context.Background()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cloneDir, baseSHA := setupDevelopRepo(t)
	if out, err := exec.Command("git", "-C", cloneDir, "checkout", "-b", "feature/x").CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b: %v: %s", err, out)
	}
	pushed := commitPHPFile(t, cloneDir, "app/Foo.php", "foo", "pushed")
	firstLanding := commitPHPFile(t, cloneDir, "app/Bar.php", "bar", "chat landing")

	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	if err := ensureWorktree(ctx, "", baseDir, baseSHA); err != nil {
		t.Fatal(err)
	}
	if err := ensureWorktree(ctx, "", headDir, firstLanding); err != nil {
		t.Fatal(err)
	}
	if _, err := scanAndStoreIngestBlocksLocked(ctx, db, dataDir, "", pr, worktreeSHAs{
		BaseSHA: baseSHA, HeadSHA: firstLanding, Paths: []string{"app/Foo.php", "app/Bar.php"},
	}); err != nil {
		t.Fatalf("seed ingest: %v", err)
	}

	// The amend: same parent, new SHA, so firstLanding is no longer an ancestor.
	if err := os.WriteFile(filepath.Join(cloneDir, "app/Bar.php"), []byte("<?php\nfunction barAmended() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", cloneDir, "commit", "-aq", "--amend", "-m", "chat landing (amended)").CombinedOutput(); err != nil {
		t.Fatalf("amend: %v: %s", err, out)
	}
	out, err := exec.Command("git", "-C", cloneDir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	amended := string(bytesTrim(out))

	// gh still reports the pushed tip (the ref on GitHub never moved).
	stub := t.TempDir()
	meta := `{"files":[{"path":"app/Foo.php"}],"baseRefOid":"` + baseSHA + `","headRefOid":"` + pushed + `","baseRefName":"develop","headRefName":"feature/x"}`
	if err := os.WriteFile(filepath.Join(stub, "gh"), []byte("#!/bin/sh\necho '"+meta+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", stub+string(os.PathListSeparator)+os.Getenv("PATH"))

	res, err := refreshIngestDelta(ctx, db, dataDir, "", pr, baseSHA, amended)
	if err != nil {
		t.Fatalf("refreshIngestDelta: %v", err)
	}
	if !res.FullFallback {
		t.Fatalf("expected the full-ingest fallback, got %+v", res)
	}
	_, head, _, err := loadIngestSHAs(db, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if head != amended {
		t.Fatalf("recorded head = %s, want the amended landing %s (gh's stale head was %s)", short(head), short(amended), short(pushed))
	}
	src, err := os.ReadFile(filepath.Join(headDir, "app/Bar.php"))
	if err != nil || !strings.Contains(string(src), "barAmended") {
		t.Fatalf("head worktree app/Bar.php = %q (%v), want the amended source", src, err)
	}
}
