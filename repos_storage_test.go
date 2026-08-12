package main

import (
	"context"
	"path/filepath"
	"testing"

	"slash/modules/approvals"
	"slash/modules/comments"
	"slash/modules/prmeta"
	"slash/modules/warndismiss"
)

// The whole point of the storage layer's repo column: two repos can each have a
// PR 12, and nothing about one may leak into the other. These tests use the same
// PR NUMBER on purpose — that is the collision the column exists to prevent.
const testOps = "plug-and-pay/plug-and-pay-ops"

// A block's id keeps its historical shape for the primary repo and gains the
// repo's key for another, so the two never collide on one row.
func TestBlockIDRepoPrefix(t *testing.T) {
	twoRepoRegistry(t)

	primary := Block{PR: 12, File: "app/Foo.php", Class: "Foo", Name: "bar"}
	other := Block{Repo: testOps, PR: 12, File: "app/Foo.php", Class: "Foo", Name: "bar"}

	if got, want := primary.ID(), "12:app/Foo.php:Foo::bar"; got != want {
		t.Fatalf("primary block id = %q, want the unchanged historical form %q", got, want)
	}
	if got, want := other.ID(), "ops#12:app/Foo.php:Foo::bar"; got != want {
		t.Fatalf("second-repo block id = %q, want %q", got, want)
	}
}

// blocks + pr_ingest are keyed by (repo, pr): storing one repo's PR 12 must not
// touch, hide or overwrite the other's.
func TestBlocksAndIngestSHAsAreRepoScoped(t *testing.T) {
	twoRepoRegistry(t)
	db := mustOpenGraphDB(t, t.TempDir())

	primary := []Block{{PR: 12, File: "app/Primary.php", Class: "P", Name: "run", Line: 1, EndLine: 2, Status: StatusAdded, Side: SideNew}}
	other := []Block{{Repo: testOps, PR: 12, File: "app/Ops.php", Class: "O", Name: "run", Line: 1, EndLine: 2, Status: StatusAdded, Side: SideNew}}

	if err := replacePRBlocks(db, "", 12, primary); err != nil {
		t.Fatal(err)
	}
	if err := replacePRBlocks(db, testOps, 12, other); err != nil {
		t.Fatal(err)
	}

	// A full swap of one repo's PR 12 leaves the other's rows alone.
	gotPrimary, err := blocksByPR(db, "", 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotPrimary) != 1 || gotPrimary[0].File != "app/Primary.php" || gotPrimary[0].Repo != "" {
		t.Fatalf("primary blocks = %+v", gotPrimary)
	}
	gotOther, err := blocksByPR(db, testOps, 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotOther) != 1 || gotOther[0].File != "app/Ops.php" || gotOther[0].Repo != testOps {
		t.Fatalf("second-repo blocks = %+v", gotOther)
	}

	// pr_ingest too — its PRIMARY KEY had to become (repo, pr) for this.
	if err := saveIngestSHAs(db, "", 12, "base-p", "head-p"); err != nil {
		t.Fatal(err)
	}
	if err := saveIngestSHAs(db, testOps, 12, "base-o", "head-o"); err != nil {
		t.Fatal(err)
	}
	base, head, ok, err := loadIngestSHAs(db, "", 12)
	if err != nil || !ok || base != "base-p" || head != "head-p" {
		t.Fatalf("primary SHAs = %q/%q ok=%v err=%v", base, head, ok, err)
	}
	base, head, ok, err = loadIngestSHAs(db, testOps, 12)
	if err != nil || !ok || base != "base-o" || head != "head-o" {
		t.Fatalf("second-repo SHAs = %q/%q ok=%v err=%v", base, head, ok, err)
	}

	// And a purge of one repo's PR 12 leaves the other's intact.
	if _, err := purgePRBlocks(db, "", 12); err != nil {
		t.Fatal(err)
	}
	if left, err := blocksByPR(db, "", 12); err != nil || len(left) != 0 {
		t.Fatalf("primary blocks after purge = %+v (err=%v)", left, err)
	}
	if left, err := blocksByPR(db, testOps, 12); err != nil || len(left) != 1 {
		t.Fatalf("purging one repo removed the other's blocks: %+v (err=%v)", left, err)
	}
	if _, _, ok, _ := loadIngestSHAs(db, testOps, 12); !ok {
		t.Fatal("purging one repo removed the other's ingest SHAs")
	}
}

// The module read-models are scoped the same way. prmeta and warndismiss are the
// two whose PRIMARY KEY had to be rebuilt (their old key could collide across
// repos), so they are the interesting ones to cover.
func TestModulesAreRepoScoped(t *testing.T) {
	twoRepoRegistry(t)
	dir := t.TempDir()
	ctx := context.Background()

	cs, err := comments.Open(filepath.Join(dir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	if err := cs.Save(ctx, comments.Comment{ID: "c-primary", PR: 12, File: "a.php", Body: "primary"}); err != nil {
		t.Fatal(err)
	}
	if err := cs.Save(ctx, comments.Comment{ID: "c-ops", Repo: testOps, PR: 12, File: "a.php", Body: "ops"}); err != nil {
		t.Fatal(err)
	}
	if list, err := cs.List(ctx, "", 12); err != nil || len(list) != 1 || list[0].ID != "c-primary" {
		t.Fatalf("primary comments = %+v (err=%v)", list, err)
	}
	if list, err := cs.List(ctx, testOps, 12); err != nil || len(list) != 1 || list[0].ID != "c-ops" {
		t.Fatalf("second-repo comments = %+v (err=%v)", list, err)
	}

	ap, err := approvals.Open(filepath.Join(dir, "approvals.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ap.Close()
	if err := ap.Replace(ctx, "", 12, "12:a.php:A::x", []int{1}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := ap.Replace(ctx, testOps, 12, "ops#12:a.php:A::x", []int{1, 2}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if list, err := ap.List(ctx, "", 12); err != nil || len(list) != 1 || len(list[0].Rows) != 1 {
		t.Fatalf("primary approvals = %+v (err=%v)", list, err)
	}
	if list, err := ap.List(ctx, testOps, 12); err != nil || len(list) != 1 || len(list[0].Rows) != 2 {
		t.Fatalf("second-repo approvals = %+v (err=%v)", list, err)
	}

	// prmeta: PRIMARY KEY (repo, pr) — with the old bare-pr key, the second
	// Save would have OVERWRITTEN the first.
	pm, err := prmeta.Open(filepath.Join(dir, "prmeta.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer pm.Close()
	if err := pm.SaveBasics(ctx, prmeta.Meta{PR: 12, Title: "primary 12"}); err != nil {
		t.Fatal(err)
	}
	if err := pm.SaveBasics(ctx, prmeta.Meta{Repo: testOps, PR: 12, Title: "ops 12"}); err != nil {
		t.Fatal(err)
	}
	if meta, ok, err := pm.Get(ctx, "", 12); err != nil || !ok || meta.Title != "primary 12" {
		t.Fatalf("primary meta = %+v ok=%v err=%v", meta, ok, err)
	}
	if meta, ok, err := pm.Get(ctx, testOps, 12); err != nil || !ok || meta.Title != "ops 12" {
		t.Fatalf("second-repo meta = %+v ok=%v err=%v", meta, ok, err)
	}

	// warndismiss: same story — its key (pr, file, fingerprint) is identical
	// across repos, so dismissing a finding in one repo used to silence the
	// other's.
	wd, err := warndismiss.Open(filepath.Join(dir, "warndismiss.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer wd.Close()
	if err := wd.Add(ctx, "", 12, "a.php", "fp-1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if fps, err := wd.Fingerprints(ctx, testOps, 12); err != nil || len(fps) != 0 {
		t.Fatalf("a dismissal in one repo must not appear in the other: %+v (err=%v)", fps, err)
	}
	if fps, err := wd.Fingerprints(ctx, "", 12); err != nil || len(fps) != 1 {
		t.Fatalf("primary dismissals = %+v (err=%v)", fps, err)
	}
}

// The worktree path and the pending-push ref keep their exact historical layout
// for the primary repo (an on-disk worktree and an unpushed ref must stay
// findable) and get the repo's key for another.
func TestWorktreeAndRefLayout(t *testing.T) {
	twoRepoRegistry(t)

	base, head := worktreeDirs("/data", "", 12)
	if filepath.Base(base) != "pr-12-base" || filepath.Base(head) != "pr-12-head" {
		t.Fatalf("primary worktrees = %q/%q, want the unchanged names", base, head)
	}
	base, head = worktreeDirs("/data", testOps, 12)
	if filepath.Base(base) != "ops-pr-12-base" || filepath.Base(head) != "ops-pr-12-head" {
		t.Fatalf("second-repo worktrees = %q/%q", base, head)
	}

	if got, want := prPendingRef("", 12, "feature/x"), "refs/slash/pending/pr-12/feature/x"; got != want {
		t.Fatalf("primary pending ref = %q, want %q", got, want)
	}
	if got, want := prPendingRef(testOps, 12, "feature/x"), "refs/slash/pending/ops/pr-12/feature/x"; got != want {
		t.Fatalf("second-repo pending ref = %q, want %q", got, want)
	}

	// A deterministic run ID must be byte-identical for the primary repo, so an
	// Execution started before multi-repo existed is still found after a restart.
	if got, want := chatMergeQueueRunID("", 13000), "chatmerge-13000"; got != want {
		t.Fatalf("primary chat_merge run id = %q, want %q", got, want)
	}
	if got, want := chatMergeQueueRunID(testOps, 12), "chatmerge-ops-12"; got != want {
		t.Fatalf("second-repo chat_merge run id = %q, want %q", got, want)
	}
}
