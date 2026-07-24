package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
)

// warningFixtureBody is the fixture PHP file both worktrees carry: a single
// changed method (build, lines 4-8) whose body has a magic number a review
// might flag (line 6), plus a line outside any block (line 2) that a finding
// can't be pinned to.
const warningFixtureBody = `<?php
namespace App\Services;
class OrderService {
    public function build() {
        $this->prepare();
        $total = $this->amount * 1.21;
        return $total;
    }
    public function prepare() {}
}
`

// writeWarningFixtureRepo lays out both worktrees with the same fixture file —
// only the RIGHT (head) side's row math is exercised here, so base/head being
// identical is enough.
func writeWarningFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	baseDir, headDir := worktreeDirs(dataDir, pr)
	for _, dir := range []string{baseDir, headDir} {
		p := filepath.Join(dir, "app/Services/OrderService.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(warningFixtureBody), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func warningFixtureBlock(pr int) Block {
	return Block{
		PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: "build",
		Category: "SERVICE", Line: 4, EndLine: 8, Status: StatusModified, Side: SideNew,
	}
}

// warningManager wires a TaskManager with a real DB (blocksByPR reads) + a
// comments module (saveComment/List/delete) + a claude Fake, over the
// writeWarningFixtureRepo worktree, for driving code_warning.
func warningManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *comments.Module, *github.Fake) {
	t.Helper()
	cs, err := comments.Open(filepath.Join(dataDir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, nil, db, dataDir, "test/repo")
	return m, cs, gh
}

// A Sonnet finding on a line inside the block's range anchors to it: a
// normal, block-scoped warning comment (Kind ""), Source "ai", Local true
// (so it never posts to GitHub even though a github.Fake is wired in).
func TestCodeWarningAnchorsToBlock(t *testing.T) {
	dataDir := t.TempDir()
	pr := 31
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelSonnet, `[{"file":"app/Services/OrderService.php","line":6,"text":"Hardcoded 1.21 VAT rate — extract as a named constant."}]`)
	m, cs, gh := warningManager(t, dataDir, fake)

	runID, err := m.StartCodeWarning(CodeWarningInput{PR: pr})
	if err != nil {
		t.Fatal(err)
	}
	if status, _ := m.engine.Status(runID); status != tembed.StatusCompleted {
		t.Fatalf("run status = %q, want completed", status)
	}

	list, err := cs.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("comments = %d, want 1: %+v", len(list), list)
	}
	c := list[0]
	if c.Source != "ai" {
		t.Errorf("source = %q, want ai", c.Source)
	}
	if c.Kind != "" {
		t.Errorf("kind = %q, want \"\" (anchored)", c.Kind)
	}
	if c.Label != "OrderService::build" {
		t.Errorf("label = %q, want OrderService::build", c.Label)
	}
	if c.RowStart < 0 {
		t.Errorf("rowStart = %d, want a pinned row (>= 0)", c.RowStart)
	}
	if c.Author != warningAuthor {
		t.Errorf("author = %q, want %q", c.Author, warningAuthor)
	}
	if gh.PostedCount() != 0 {
		t.Errorf("github posted %d comments, want 0 (Local)", gh.PostedCount())
	}
}

// A Sonnet finding on a line outside any block becomes a PR-wide warning
// (Kind "ai_warning") instead of being dropped.
func TestCodeWarningFallsBackToPRWide(t *testing.T) {
	dataDir := t.TempDir()
	pr := 32
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	// Line 2 (the namespace declaration) falls outside the build block (4-8).
	fake.SetOutput(claude.ModelSonnet, `[{"file":"app/Services/OrderService.php","line":2,"text":"Onduidelijke namespace-structuur."}]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}

	list, err := cs.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("comments = %d, want 1: %+v", len(list), list)
	}
	c := list[0]
	if c.Kind != "ai_warning" {
		t.Errorf("kind = %q, want ai_warning", c.Kind)
	}
	if c.Source != "ai" {
		t.Errorf("source = %q, want ai", c.Source)
	}
	if c.File != "app/Services/OrderService.php" {
		t.Errorf("file = %q, want the scoped file kept as a hint", c.File)
	}
}

// A finding whose "file" is NOT one of the scoped changed files is a
// hallucination guard and is silently dropped, never shown PR-wide either.
func TestCodeWarningDropsOutOfScopeFile(t *testing.T) {
	dataDir := t.TempDir()
	pr := 33
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelSonnet, `[{"file":"app/Elsewhere/NotInScope.php","line":3,"text":"Should never surface."}]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("comments = %d, want 0 (out-of-scope file dropped): %+v", len(list), list)
	}
}

// Running code_warning a second time supersedes (deletes) the previous run's
// AI warnings for the files back in scope, instead of accumulating them.
func TestCodeWarningSupersedesPreviousRun(t *testing.T) {
	dataDir := t.TempDir()
	pr := 34
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelSonnet, `[{"file":"app/Services/OrderService.php","line":6,"text":"First pass finding."}]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	first, _ := cs.List(context.Background(), pr)
	if len(first) != 1 || first[0].Body != "First pass finding." {
		t.Fatalf("after first run: comments = %+v", first)
	}

	// Second run, different finding text — the stale first-run comment must
	// be gone, not merely joined by a second one.
	fake.SetOutput(claude.ModelSonnet, `[{"file":"app/Services/OrderService.php","line":6,"text":"Second pass finding."}]`)
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	second, err := cs.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 {
		t.Fatalf("after second run: comments = %d, want 1 (superseded): %+v", len(second), second)
	}
	if second[0].Body != "Second pass finding." {
		t.Fatalf("after second run: body = %q, want the fresh finding", second[0].Body)
	}
}

// The cap of ~2 findings per block in scope is enforced in Go, not left to
// the model's instruction-following: with one block in scope (cap 2), a
// four-finding Sonnet answer is trimmed to 2, keeping the lowest file/line
// (the sort order runCodeWarningReview applies before trimming).
func TestCodeWarningCapsFindingsPerBlock(t *testing.T) {
	dataDir := t.TempDir()
	pr := 35
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelSonnet, `[
		{"file":"app/Services/OrderService.php","line":8,"text":"d"},
		{"file":"app/Services/OrderService.php","line":7,"text":"c"},
		{"file":"app/Services/OrderService.php","line":6,"text":"b"},
		{"file":"app/Services/OrderService.php","line":5,"text":"a"}
	]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != warningsPerBlock {
		t.Fatalf("comments = %d, want the %d-per-block cap: %+v", len(list), warningsPerBlock, list)
	}
	got := map[string]bool{}
	for _, c := range list {
		got[c.Body] = true
	}
	if !got["a"] || !got["b"] {
		t.Fatalf("kept findings = %+v, want the two lowest-line findings (a, b)", list)
	}
}

// mustOpenGraphDB opens (or re-opens) the graph DB under dataDir — a thin
// helper so each test can seed blocks before wiring the TaskManager, which
// opens its own handle to the same file.
func mustOpenGraphDB(t *testing.T, dataDir string) *sql.DB {
	t.Helper()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}
