package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/autowarn"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/relations"
	"slash/modules/warnrevoke"
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
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, fake, nil, db, dataDir, "test/repo")
	return m, cs, gh
}

// warningManagerWithApprovals is warningManager plus a real approvals module
// (constructor param) and a real warnrevoke module (post-construction, like
// production wiring) — for exercising code_warning's approval-revoke path.
func warningManagerWithApprovals(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *comments.Module, *approvals.Module) {
	t.Helper()
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
	wr, err := warnrevoke.Open(filepath.Join(dataDir, "warnrevoke.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { wr.Close() })
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, ap, nil, nil, fake, nil, db, dataDir, "test/repo")
	m.warnrevoke = wr
	return m, cs, ap
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
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"Hardcoded 1.21 VAT rate — extract as a named constant."}]`)
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

// A finding whose line falls inside a block's declared range but isn't a row
// rowForLine can actually find (e.g. a docblock line enrichedCodeSide drops,
// or — as reproduced here — a line beyond the block's real extracted source
// despite still being <= its EndLine) anchors on the block's own first
// changed row instead of being left unpinned. Unpinned (RowStart -1) used to
// mean "shown anywhere within this block" for EVERY selection inside it, not
// just the block-wide one it's actually about (see commentUnder,
// RelatedPanel.mjs) — reported bug. BlockWide=true tells the frontend to
// badge it as being about the whole block, not specifically that first row.
// Exercises anchoredWarning directly (no need to drive the whole workflow).
func TestAnchoredWarningFallsBackToBlockWideFirstRow(t *testing.T) {
	dataDir := t.TempDir()
	pr := 34
	baseDir, headDir := worktreeDirs(dataDir, pr)
	// Unlike writeWarningFixtureRepo (base == head, no real diff — fine for
	// the row-math-only tests above), this needs a GENUINE change so a "first
	// changed row" actually exists to fall back onto.
	baseBody := strings.Replace(warningFixtureBody, "1.21", "1.19", 1)
	for _, dir := range []struct{ path, body string }{{baseDir, baseBody}, {headDir, warningFixtureBody}} {
		p := filepath.Join(dir.path, "app/Services/OrderService.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(dir.body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b := warningFixtureBlock(pr)
	b.EndLine = 12 // past the fixture file's actual last line (10)

	f := warningFinding{File: b.File, Line: 11, Text: "Dit raakt de hele methode, niet één regel."}
	in, blockID := anchoredWarning(dataDir, pr, []Block{b}, f)

	if in.Kind != "" {
		t.Errorf("kind = %q, want \"\" (still block-scoped, not PR-wide)", in.Kind)
	}
	if blockID != b.ID() {
		t.Errorf("blockID = %q, want %q", blockID, b.ID())
	}
	if in.RowStart < 0 || in.RowEnd < 0 {
		t.Errorf("rowStart/rowEnd = %d/%d, want a pinned row (>= 0) — the block's first changed row", in.RowStart, in.RowEnd)
	}
	if in.RowStart != in.RowEnd {
		t.Errorf("rowStart=%d rowEnd=%d, want a single row", in.RowStart, in.RowEnd)
	}
	if !in.BlockWide {
		t.Errorf("blockWide = false, want true")
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
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":2,"text":"Onduidelijke namespace-structuur."}]`)
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
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Elsewhere/NotInScope.php","line":3,"text":"Should never surface."}]`)
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
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"First pass finding."}]`)
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
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"Second pass finding."}]`)
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
	fake.SetOutput(claude.ModelOpus, `[
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

// An existing open, human-authored comment on a file in scope is handed to
// the model as context in the prompt, so it can decide whether a finding on
// that line would just repeat what's already been said (see
// existingLineCommentsInScope, code_warning.md).
func TestCodeWarningPromptsExistingComments(t *testing.T) {
	dataDir := t.TempDir()
	pr := 40
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if err := cs.Save(context.Background(), comments.Comment{
		ID: "c-existing", RunID: "r-existing", PR: pr,
		File: "app/Services/OrderService.php", Line: 6,
		Author: "reindert", Body: "This VAT rate should be a named constant.",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("claude calls = %d, want 1", len(fake.Calls))
	}
	prompt := fake.Calls[0].Prompt
	if !strings.Contains(prompt, "app/Services/OrderService.php:6") ||
		!strings.Contains(prompt, "reindert") ||
		!strings.Contains(prompt, "This VAT rate should be a named constant.") {
		t.Fatalf("prompt does not mention the existing comment: %s", prompt)
	}
}

// A code_warning finding retracts the reviewer's approval of the row it
// anchors to — but only the FIRST time that (pr, block, row) triggers a
// warning. A re-run whose finding lands on the SAME row again (e.g. a trivial
// re-ingest that doesn't change the underlying issue) must not undo an
// approval the reviewer gave again after already seeing the warning once.
func TestCodeWarningRevokesApprovalOnlyOnce(t *testing.T) {
	dataDir := t.TempDir()
	pr := 36
	writeWarningFixtureRepo(t, dataDir, pr)
	block := warningFixtureBlock(pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{block}); err != nil {
		t.Fatal(err)
	}

	baseDir, headDir := worktreeDirs(dataDir, pr)
	row, ok := rowForLine(baseDir, headDir, block, 6, "RIGHT")
	if !ok {
		t.Fatal("rowForLine: could not resolve line 6 to a row")
	}
	blockID := block.ID()

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"Hardcoded 1.21 VAT rate."}]`)
	m, cs, ap := warningManagerWithApprovals(t, dataDir, fake)
	ctx := context.Background()

	// The reviewer had already approved this row before the risk check ever ran.
	if err := ap.Replace(ctx, pr, blockID, []int{row}, nil); err != nil {
		t.Fatal(err)
	}

	// Run 1: the finding anchors to the already-approved row — this is the
	// FIRST time this (pr, block, row) triggers a warning, so the approval is
	// retracted.
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("after run 1: comments = %d, want 1: %+v", len(list), list)
	}
	approvals1, err := ap.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(approvals1) != 0 && (len(approvals1) != 1 || len(approvals1[0].Rows) != 0) {
		t.Fatalf("after run 1: approvals = %+v, want the row retracted", approvals1)
	}

	// The reviewer looks at the (still open) warning, decides the code is fine
	// after all, and approves the row again.
	if err := ap.Replace(ctx, pr, blockID, []int{row}, nil); err != nil {
		t.Fatal(err)
	}

	// Run 2: the SAME finding recurs on the SAME row (e.g. a trivial re-ingest)
	// — this (pr, block, row) already triggered a warning once, so the
	// reviewer's fresh approval must survive.
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	approvals2, err := ap.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range approvals2 {
		if a.BlockID != blockID {
			continue
		}
		found = true
		hasRow := false
		for _, r := range a.Rows {
			if r == row {
				hasRow = true
			}
		}
		if !hasRow {
			t.Fatalf("after run 2: row %d was retracted again, want it to survive: %+v", row, a)
		}
	}
	if !found {
		t.Fatalf("after run 2: no approval row for block %q at all: %+v", blockID, approvals2)
	}
}

// autoWarnTriggerManager wires a TaskManager for exercising the AUTOMATIC
// code_warning trigger (autoStartCodeWarning, fired from build_relations —
// see workflows.go): a real relations module (buildRelations writes to it), a
// real comments module (supersedeFileWarnings/createWarningComment read/write
// it), and a real autowarn module (post-construction, mirrors production
// wiring) so the on/off toggle can be flipped from the test.
func autoWarnTriggerManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *relations.Module) {
	t.Helper()
	cs, err := comments.Open(filepath.Join(dataDir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	rel, err := relations.Open(filepath.Join(dataDir, "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rel.Close() })
	aw, err := autowarn.Open(filepath.Join(dataDir, "autowarn.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { aw.Close() })
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), rel, testPRMeta(t), nil, nil, nil, nil, nil, fake, nil, db, dataDir, "test/repo")
	m.autowarn = aw
	return m, rel
}

// codeWarningRunExists polls (the trigger fires from a goroutine, so it isn't
// necessarily recorded the instant EnsureRelations returns) for up to 2s for a
// code_warning run whose input names pr.
func codeWarningRunExists(t *testing.T, m *TaskManager, pr int) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		runs, err := m.engine.Runs()
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range runs {
			if r.Workflow != WorkflowCodeWarning {
				continue
			}
			in, err := m.engine.Input(r.ID)
			if err != nil {
				continue
			}
			var pin CodeWarningInput
			if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The very first build_relations run for a PR (a fresh ingest) automatically
// starts a code_warning run — no menu click needed.
func TestBuildRelationsAutoStartsCodeWarning(t *testing.T) {
	dataDir := t.TempDir()
	pr := 40
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())

	m.EnsureRelations(context.Background(), pr)

	if !codeWarningRunExists(t, m, pr) {
		t.Fatal("no code_warning run was auto-started after the first build_relations")
	}
}

// The reviewer's own on/off toggle (next to the theme button) gates the
// AUTOMATIC trigger: switched off, a fresh ingest starts no code_warning run.
func TestBuildRelationsSkipsAutoWarnWhenDisabled(t *testing.T) {
	dataDir := t.TempDir()
	pr := 41
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())
	if err := m.autowarn.SetEnabled(context.Background(), m.repo, false); err != nil {
		t.Fatal(err)
	}

	m.EnsureRelations(context.Background(), pr)

	if codeWarningRunExists(t, m, pr) {
		t.Fatal("a code_warning run was auto-started while the toggle is off")
	}
}

// A plain "rebuild" (re-ingest without new commits, e.g. a manual
// "Regenereren") must NOT auto-start a second code_warning run — only the
// very first build and a genuine delta-refresh (prStatusWorkflow) do.
func TestRebuildSignalDoesNotAutoStartCodeWarning(t *testing.T) {
	dataDir := t.TempDir()
	pr := 42
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())
	ctx := context.Background()

	m.EnsureRelations(ctx, pr) // initial build — auto-starts one code_warning run
	if !codeWarningRunExists(t, m, pr) {
		t.Fatal("setup: initial build_relations should have auto-started a code_warning run")
	}
	runsBefore, err := m.engine.Runs()
	if err != nil {
		t.Fatal(err)
	}
	countBefore := countCodeWarningRuns(runsBefore, m, pr)

	m.EnsureRelations(ctx, pr) // already running — this signals SignalRebuild instead
	// Give any (wrongly fired) goroutine a moment, then compare counts.
	time.Sleep(200 * time.Millisecond)
	runsAfter, err := m.engine.Runs()
	if err != nil {
		t.Fatal(err)
	}
	countAfter := countCodeWarningRuns(runsAfter, m, pr)
	if countAfter != countBefore {
		t.Fatalf("code_warning runs for pr %d: before=%d after a rebuild signal=%d, want unchanged", pr, countBefore, countAfter)
	}
}

func countCodeWarningRuns(runs []tembed.RunRecord, m *TaskManager, pr int) int {
	n := 0
	for _, r := range runs {
		if r.Workflow != WorkflowCodeWarning {
			continue
		}
		in, err := m.engine.Input(r.ID)
		if err != nil {
			continue
		}
		var pin CodeWarningInput
		if json.Unmarshal(in, &pin) == nil && pin.PR == pr {
			n++
		}
	}
	return n
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
