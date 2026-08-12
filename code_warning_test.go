package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/autowarn"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
	"slash/modules/prmeta"
	"slash/modules/relations"
	"slash/modules/warndismiss"
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

// warningFixtureBaseBody is the BASE worktree's copy of the same file: lines
// 2, 5, 6 and 7 differ from the head version above, so those are exactly the
// lines this fixture PR "changed". That matters since the changed-lines guard
// (changedLineSets/allows, code_warning.go) drops any finding anchored on a
// line the PR left alone — line 8 (the closing brace) is deliberately left
// identical, so the fixture also covers an untouched line inside a changed
// block.
const warningFixtureBaseBody = `<?php
namespace App;
class OrderService {
    public function build() {
        $this->boot();
        $total = $this->amount;
        return 0;
    }
    public function prepare() {}
}
`

// writeWarningFixtureRepo lays out both worktrees with the fixture file: the
// head version, and the base version it genuinely differs from (see
// warningFixtureBaseBody — a base identical to head would mean "this PR
// changed nothing", which the changed-lines guard rightly answers with zero
// findings).
func writeWarningFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	for _, w := range []struct{ dir, body string }{{baseDir, warningFixtureBaseBody}, {headDir, warningFixtureBody}} {
		p := filepath.Join(w.dir, "app/Services/OrderService.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(w.body), 0o644); err != nil {
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
// The claude client is taken as the interface, not *claude.Fake: the
// orphan-retry tests below need a DIFFERENT answer per Run call (the Fake
// programs one fixed output per model), which scriptedClaude provides.
func warningManager(t *testing.T, dataDir string, fake claude.Client) (*TaskManager, *comments.Module, *github.Fake) {
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
	// The dismissed-findings store, wired like production (post-construction,
	// see newTasks): without it a resolved/deleted finding would come straight
	// back on the next run.
	wd, err := warndismiss.Open(filepath.Join(dataDir, "warndismiss.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { wd.Close() })
	m.warndismiss = wd
	return m, cs, gh
}

// warningManagerWithApprovals is warningManager plus a real approvals module,
// for asserting that a risk-check finding leaves the reviewer's approval of
// the row it anchors to untouched.
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
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	gh := &github.Fake{}
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, ap, nil, nil, fake, nil, db, dataDir, "test/repo")
	return m, cs, ap
}

// A Sonnet finding on a line inside the block's range anchors to it: a
// normal, block-scoped warning comment (Kind ""), Source "ai", Local true
// (so it never posts to GitHub even though a github.Fake is wired in).
func TestCodeWarningAnchorsToBlock(t *testing.T) {
	dataDir := t.TempDir()
	pr := 31
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
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

	list, err := cs.List(context.Background(), "", pr)
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
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	// Its own worktrees rather than writeWarningFixtureRepo's: this needs the
	// change to sit on exactly one line (1.21), so the block has a single
	// "first changed row" to fall back onto.
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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	// Line 2 (the namespace declaration) falls outside the build block (4-8).
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":2,"text":"Onduidelijke namespace-structuur."}]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}

	list, err := cs.List(context.Background(), "", pr)
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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Elsewhere/NotInScope.php","line":3,"text":"Should never surface."}]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(context.Background(), "", pr)
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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"First pass finding."}]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	first, _ := cs.List(context.Background(), "", pr)
	if len(first) != 1 || first[0].Body != "First pass finding." {
		t.Fatalf("after first run: comments = %+v", first)
	}

	// Second run, different finding text — the stale first-run comment must
	// be gone, not merely joined by a second one.
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"Second pass finding."}]`)
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	second, err := cs.List(context.Background(), "", pr)
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

// A finding the reviewer RESOLVED never comes back: supersedeFileWarnings
// records its fingerprint before wiping it, and the next run drops the same
// remark instead of raising it again as a fresh open comment (reported: "ik
// kan ai waarschuwing niet resolven of verwijderen"). See modules/warndismiss.
func TestCodeWarningSkipsResolvedFinding(t *testing.T) {
	dataDir := t.TempDir()
	pr := 43
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	finding := `[{"file":"app/Services/OrderService.php","line":6,"text":"Hardcoded 1.21 VAT rate."}]`
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, finding)
	m, cs, _ := warningManager(t, dataDir, fake)
	ctx := context.Background()

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(ctx, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("after first run: comments = %d, want 1: %+v", len(list), list)
	}

	// The reviewer resolves it — the same "/resolve" reply Signal the UI sends.
	if err := m.Signal(list[0].RunID, ReactionSignal{
		ID: "ui-1", Source: "ui", Author: "reviewer", Body: resolveSentinel, Done: true,
	}); err != nil {
		t.Fatal(err)
	}

	// Same model output on the next run: the finding must not reappear.
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	after, err := cs.List(ctx, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 0 {
		t.Fatalf("after the second run: comments = %d, want 0 (resolved finding stays dismissed): %+v", len(after), after)
	}
}

// Same for a finding the reviewer DELETED: the delete branch of
// taskCodeCommentWorkflow records the dismissal, so the next run skips it.
// A delete coming from supersedeFileWarnings itself (Source "ai") is NOT a
// dismissal — the second half of this test proves an untouched finding still
// comes back, which is exactly what makes the first half meaningful.
func TestCodeWarningSkipsDeletedFinding(t *testing.T) {
	dataDir := t.TempDir()
	pr := 44
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[
		{"file":"app/Services/OrderService.php","line":5,"text":"Weggegooide bevinding."},
		{"file":"app/Services/OrderService.php","line":6,"text":"Blijvende bevinding."}
	]`)
	m, cs, _ := warningManager(t, dataDir, fake)
	ctx := context.Background()

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(ctx, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("after first run: comments = %d, want 2: %+v", len(list), list)
	}
	var deleted string
	for _, c := range list {
		if c.Body == "Weggegooide bevinding." {
			deleted = c.RunID
		}
	}
	if deleted == "" {
		t.Fatalf("could not find the finding to delete: %+v", list)
	}
	// The reviewer deletes one — the UI's own delete Signal (no Source "ai").
	if err := m.Signal(deleted, ReactionSignal{ID: "ui-1", Author: "reviewer", Action: "delete"}); err != nil {
		t.Fatal(err)
	}

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	after, err := cs.List(ctx, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 {
		t.Fatalf("after the second run: comments = %d, want only the untouched finding: %+v", len(after), after)
	}
	if after[0].Body != "Blijvende bevinding." {
		t.Fatalf("surviving finding = %q, want the one the reviewer never dismissed", after[0].Body)
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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
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
	list, err := cs.List(context.Background(), "", pr)
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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
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

// The PR's own stated intent — title, description, the linked Jira ticket's
// description — plus the open conversation on it (a PR-wide comment and a
// thread reply, not just line comments) travel into the prompt, so the model
// can skip a "risk" the author already explained or the team already
// discussed. See warningScope/warningPrompt and code_warning.md.
func TestCodeWarningPromptsPRIntentAndConversation(t *testing.T) {
	dataDir := t.TempDir()
	pr := 42
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[]`)
	m, cs, _ := warningManager(t, dataDir, fake)
	ctx := context.Background()

	if err := m.prmeta.SaveBasics(ctx, prmeta.Meta{
		PR: pr, Title: "Bump the VAT rate", Body: "Hardcoded on purpose until PAYM-99 lands.",
		JiraKey: "PAYM-813", JiraDesc: "Het tarief gaat per 1 januari omhoog.",
	}); err != nil {
		t.Fatal(err)
	}
	if err := cs.Save(ctx, comments.Comment{
		ID: "c-wide", RunID: "r-wide", PR: pr, Kind: "issue",
		Author: "reindert", Body: "Waarom staat dit tarief hardcoded?",
	}); err != nil {
		t.Fatal(err)
	}
	if err := cs.AddReaction(ctx, comments.Reaction{
		ID: "x-1", CommentID: "c-wide", Source: "ui", Author: "dennis",
		Body: "Bewust, zie de omschrijving.",
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
	for _, want := range []string{
		"Bump the VAT rate",
		"Hardcoded on purpose until PAYM-99 lands.",
		"Het tarief gaat per 1 januari omhoog.",
		"Waarom staat dit tarief hardcoded?",
		"dennis: Bewust, zie de omschrijving.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt is missing %q:\n%s", want, prompt)
		}
	}
}

// A finding must anchor on a line this PR actually changed: the model may
// read anything, but a remark about untouched code is dropped outright (never
// demoted to a PR-wide finding). The prompt also names the changed lines per
// file, so the model can aim rather than spend findings the guard discards.
// See changedLineSets/describeChangedLines in code_warning.go.
func TestCodeWarningDropsFindingOnUnchangedLine(t *testing.T) {
	dataDir := t.TempDir()
	pr := 41
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	// Line 8 is the closing brace, identical in both worktrees (see
	// warningFixtureBaseBody); line 6 is genuinely changed.
	fake.SetOutput(claude.ModelOpus, `[
		{"file":"app/Services/OrderService.php","line":8,"text":"Over ongewijzigde code."},
		{"file":"app/Services/OrderService.php","line":6,"text":"Over de gewijzigde regel."}
	]`)
	m, cs, _ := warningManager(t, dataDir, fake)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("comments = %d, want 1 (the unchanged-line finding dropped): %+v", len(list), list)
	}
	if list[0].Body != "Over de gewijzigde regel." {
		t.Fatalf("kept finding = %q, want the one on the changed line", list[0].Body)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("claude calls = %d, want 1", len(fake.Calls))
	}
	if prompt := fake.Calls[0].Prompt; !strings.Contains(prompt, "changed lines: 2, 5-7") {
		t.Fatalf("prompt does not name the changed lines: %s", prompt)
	}
}

// A finding that anchors to a row the reviewer already approved leaves that
// approval alone: an AI risk check is a hint to look again, never a verdict
// that the row was never reviewed (see .claude/docs/approval.md — the same
// decision as "placing a comment keeps the approval"). The warning comment
// itself is still created.
func TestCodeWarningKeepsApproval(t *testing.T) {
	dataDir := t.TempDir()
	pr := 36
	writeWarningFixtureRepo(t, dataDir, pr)
	block := warningFixtureBlock(pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{block}); err != nil {
		t.Fatal(err)
	}

	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	row, ok := rowForLine(baseDir, headDir, block, 6, "RIGHT")
	if !ok {
		t.Fatal("rowForLine: could not resolve line 6 to a row")
	}
	blockID := block.ID()

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelOpus, `[{"file":"app/Services/OrderService.php","line":6,"text":"Hardcoded 1.21 VAT rate."}]`)
	m, cs, ap := warningManagerWithApprovals(t, dataDir, fake)
	ctx := context.Background()

	// The reviewer approved this row before the risk check ever ran.
	if err := ap.Replace(ctx, "", pr, blockID, []int{row}, nil, nil); err != nil {
		t.Fatal(err)
	}

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	list, err := cs.List(ctx, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("comments = %d, want 1: %+v", len(list), list)
	}
	after, err := ap.List(ctx, "", pr)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range after {
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
			t.Fatalf("row %d was retracted by the risk check, want it to survive: %+v", row, a)
		}
	}
	if !found {
		t.Fatalf("no approval row for block %q at all: %+v", blockID, after)
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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())

	m.EnsureRelations(context.Background(), "", pr)

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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())
	if err := m.autowarn.SetEnabled(context.Background(), m.repo, false); err != nil {
		t.Fatal(err)
	}

	m.EnsureRelations(context.Background(), "", pr)

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
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	m, _ := autoWarnTriggerManager(t, dataDir, claude.NewFake())
	ctx := context.Background()

	m.EnsureRelations(ctx, "", pr) // initial build — auto-starts one code_warning run
	if !codeWarningRunExists(t, m, pr) {
		t.Fatal("setup: initial build_relations should have auto-started a code_warning run")
	}
	runsBefore, err := m.engine.Runs()
	if err != nil {
		t.Fatal(err)
	}
	countBefore := countCodeWarningRuns(runsBefore, m, pr)

	m.EnsureRelations(ctx, "", pr) // already running — this signals SignalRebuild instead
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

// scriptedClaude is a claude.Client that answers each AGENTIC REVIEW call with
// the NEXT programmed output (the last one repeating once the script runs out),
// which claude.Fake cannot do: it programs one fixed output per model id, while
// the orphan-retry branch runs two agentic passes inside a SINGLE, synchronous
// code_warning Execution, so the test cannot reprogram anything in between.
//
// The script — and the call count the tests assert on — is scoped to
// claude.ModelOpus, the review pass itself: creating the findings' comment
// threads sets other, unrelated Haiku calls in motion, which say nothing about
// how often the review ran.
type scriptedClaude struct {
	mu    sync.Mutex
	outs  []string
	calls int
}

func (s *scriptedClaude) Run(ctx context.Context, req claude.RunRequest) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Model != claude.ModelOpus {
		return "", nil
	}
	i := s.calls
	s.calls++
	if i >= len(s.outs) {
		i = len(s.outs) - 1
	}
	if i < 0 {
		return "", nil
	}
	return s.outs[i], nil
}

func (s *scriptedClaude) RunChat(ctx context.Context, req claude.RunRequest) (claude.ChatResult, error) {
	return claude.ChatResult{}, nil
}

func (s *scriptedClaude) CallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// orphanFixtureBody is a head worktree file built for the orphan-retry tests:
// six changed lines (2-7) that sit OUTSIDE every block, so a finding on any of
// them can only become an unanchored "ai_warning", plus three methods — one
// with a changed line of its own (line 10) that a finding CAN anchor to. Three
// blocks also lift the finding cap to 3 * warningsPerBlock = 6, enough for a
// batch that trips maxOrphanWarnings.
const orphanFixtureBody = `<?php
namespace App\Services;
use App\Support\Alpha;
use App\Support\Beta;
use App\Support\Gamma;
use App\Support\Delta;
class OrphanService {
    public function build() {
        return 1;
    }
    public function ship() {
        return 2;
    }
    public function pack() {
        return 3;
    }
}
`

// orphanFixtureBaseBody differs from the head copy on lines 2-6 and 9 exactly,
// so those are the lines this fixture PR "changed".
const orphanFixtureBaseBody = `<?php
namespace App;
use App\Old\Alpha;
use App\Old\Beta;
use App\Old\Gamma;
use App\Old\Delta;
class OrphanService {
    public function build() {
        return 0;
    }
    public function ship() {
        return 2;
    }
    public function pack() {
        return 3;
    }
}
`

const orphanFixtureFile = "app/Services/OrphanService.php"

func writeOrphanFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	for _, w := range []struct{ dir, body string }{{baseDir, orphanFixtureBaseBody}, {headDir, orphanFixtureBody}} {
		p := filepath.Join(w.dir, orphanFixtureFile)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(w.body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func orphanFixtureBlocks(pr int) []Block {
	mk := func(name string, start, end int) Block {
		return Block{
			PR: pr, File: orphanFixtureFile, Class: "OrphanService", Name: name,
			Category: "SERVICE", Line: start, EndLine: end, Status: StatusModified, Side: SideNew,
		}
	}
	return []Block{mk("build", 8, 10), mk("ship", 11, 13), mk("pack", 14, 16)}
}

// orphanFindingsJSON is a model answer with n findings on the fixture's
// changed-but-unanchorable lines (2-6, reused cyclically when n exceeds them),
// each with its own text so a test can tell the two passes apart.
func orphanFindingsJSON(tag string, n int) string {
	var b strings.Builder
	b.WriteString("[")
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		line := 2 + i%5
		b.WriteString(fmt.Sprintf(`{"file":%q,"line":%d,"text":"%s %d"}`, orphanFixtureFile, line, tag, i))
	}
	b.WriteString("]")
	return b.String()
}

// More than maxOrphanWarnings findings that anchor to no block at all means the
// model's line numbers were off across the board: that whole batch is thrown
// away without creating a single comment and the review runs once more, whose
// result is what the reviewer gets.
func TestCodeWarningRetriesOnTooManyOrphans(t *testing.T) {
	dataDir := t.TempDir()
	pr := 71
	writeOrphanFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, orphanFixtureBlocks(pr)); err != nil {
		t.Fatal(err)
	}

	cl := &scriptedClaude{outs: []string{
		orphanFindingsJSON("orphan", maxOrphanWarnings+1),
		// Line 9 is a changed line inside the build block (8-10), so this one
		// anchors properly.
		fmt.Sprintf(`[{"file":%q,"line":9,"text":"Retry finding."}]`, orphanFixtureFile),
	}}
	m, cs, _ := warningManager(t, dataDir, cl)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	if cl.CallCount() != 2 {
		t.Fatalf("agentic review calls = %d, want 2 (the bad batch plus exactly one retry)", cl.CallCount())
	}
	list, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("comments = %d, want 1 (only the retry's finding): %+v", len(list), list)
	}
	if list[0].Body != "Retry finding." {
		t.Errorf("body = %q, want the retry's finding — the discarded batch must create nothing", list[0].Body)
	}
	if list[0].Kind != "" {
		t.Errorf("kind = %q, want \"\" (anchored to the build block)", list[0].Kind)
	}
}

// Exactly ONE retry: a second batch that is just as orphan-heavy is created
// anyway. A bad batch is still worth showing, and looping on the outcome of an
// LLM call would be unbounded and expensive.
func TestCodeWarningKeepsOrphansAfterOneRetry(t *testing.T) {
	dataDir := t.TempDir()
	pr := 72
	writeOrphanFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, orphanFixtureBlocks(pr)); err != nil {
		t.Fatal(err)
	}

	want := maxOrphanWarnings + 1
	cl := &scriptedClaude{outs: []string{
		orphanFindingsJSON("first", want),
		orphanFindingsJSON("second", want),
	}}
	m, cs, _ := warningManager(t, dataDir, cl)

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	if cl.CallCount() != 2 {
		t.Fatalf("agentic review calls = %d, want 2 (no second retry)", cl.CallCount())
	}
	list, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != want {
		t.Fatalf("comments = %d, want %d (the retry's orphans are shown anyway): %+v", len(list), want, list)
	}
	for _, c := range list {
		if c.Kind != "ai_warning" {
			t.Errorf("kind = %q, want ai_warning", c.Kind)
		}
		if !strings.HasPrefix(c.Body, "second ") {
			t.Errorf("body = %q, want a finding from the second pass", c.Body)
		}
	}
}
