package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
)

// comment_autoresolve_test.go covers both layers of the auto-resolve feature:
// the pure classifier/guardrail functions (comment_autoresolve.go) in
// isolation, and the wiring into reanchorAfterRefresh end to end (a real
// comment Execution, driven through the Activity exactly like
// TestReanchorActivityIsRegistered's probe pattern).

// ── classifyRemovalRequest ──────────────────────────────────────────────────

func TestClassifyRemovalRequestHighConfidenceYes(t *testing.T) {
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":true,"confidence":"high"}`)
	if !classifyRemovalRequest(context.Background(), fake, "please remove this method", "public function foo() {}") {
		t.Error("want true for a high-confidence yes")
	}
}

func TestClassifyRemovalRequestLowConfidenceYesIsRejected(t *testing.T) {
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":true,"confidence":"low"}`)
	if classifyRemovalRequest(context.Background(), fake, "maybe remove this?", "") {
		t.Error("want false — only high confidence may trigger an auto-resolve")
	}
}

func TestClassifyRemovalRequestNo(t *testing.T) {
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":false,"confidence":"high"}`)
	if classifyRemovalRequest(context.Background(), fake, "why is this here?", "") {
		t.Error("want false for a non-removal comment")
	}
}

// Empty/unparseable output — exactly what a claude.Fake with nothing programmed
// returns (the SLASH_CLAUDE=off shape) — must never be treated as a yes.
func TestClassifyRemovalRequestEmptyOutputIsNoOp(t *testing.T) {
	fake := claude.NewFake() // no SetOutput: Run returns ("", nil)
	if classifyRemovalRequest(context.Background(), fake, "remove this", "") {
		t.Error("want false for empty/no model output")
	}
}

func TestClassifyRemovalRequestGarbageOutputIsNoOp(t *testing.T) {
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, "sure, sounds good")
	if classifyRemovalRequest(context.Background(), fake, "remove this", "") {
		t.Error("want false for unparseable output")
	}
}

func TestClassifyRemovalRequestNilClientIsNoOp(t *testing.T) {
	if classifyRemovalRequest(context.Background(), nil, "remove this", "") {
		t.Error("want false with no claude client at all")
	}
}

// ── shouldConsiderAutoResolve ────────────────────────────────────────────────

func TestShouldConsiderAutoResolve(t *testing.T) {
	cases := []struct {
		name string
		c    comments.Comment
		want bool
	}{
		{"open, block-scoped, no replies", comments.Comment{Status: "open"}, true},
		{"already resolved", comments.Comment{Status: "resolved"}, false},
		{"deleting", comments.Comment{Status: "deleting"}, false},
		{"PR-wide (Kind set)", comments.Comment{Status: "open", Kind: "issue"}, false},
		{"has a reply", comments.Comment{Status: "open", Reactions: []comments.Reaction{{ID: "r1"}}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldConsiderAutoResolve(tc.c); got != tc.want {
				t.Errorf("shouldConsiderAutoResolve(%+v) = %v, want %v", tc.c, got, tc.want)
			}
		})
	}
}

// ── End to end, through reanchorAfterRefresh ────────────────────────────────

// autoResolveManager wires a TaskManager with a real DB (blocksByPR reads), a
// comments module, and the given claude Fake — mirrors code_warning_test.go's
// warningManager.
func autoResolveManager(t *testing.T, dataDir string, fake *claude.Fake) (*tembed.Engine, *TaskManager, *comments.Module) {
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
	engine := tembed.New(tembed.NewMemoryStore())
	var cl claude.Client
	if fake != nil {
		cl = fake
	}
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t),
		nil, nil, nil, nil, cl, nil, db, dataDir, "test/repo")
	return engine, m, cs
}

// runReanchor drives the real reanchorAfterRefresh Activity by name, exactly
// like TestReanchorActivityIsRegistered's probe workflow — the two real call
// sites (ingestWorkflow, pr_status's delta refresh) invoke it the same way.
func runReanchor(t *testing.T, engine *tembed.Engine, probeName string, pr int, changedFiles []string) reanchorResult {
	t.Helper()
	engine.RegisterWorkflow(probeName, func(w *tembed.Workflow, input []byte) ([]byte, error) {
		var out reanchorResult
		if err := w.ExecuteActivity("reanchorAfterRefresh", map[string]any{
			"pr": pr, "prevBaseSHA": "", "prevHeadSHA": "", "changedFiles": changedFiles,
		}, &out); err != nil {
			return nil, err
		}
		return json.Marshal(out)
	})
	runID, err := engine.StartWorkflow(probeName, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var out reanchorResult
	if err := engine.Result(runID, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A comment whose symbol is entirely gone from the PR (AnchorOrphan) and whose
// text was unambiguously asking to remove that code gets auto-resolved: the
// Execution completes, and the ONLY trace is a new, self-explanatory reply.
func TestAutoResolveOrphanedRemovalRequestResolvesComment(t *testing.T) {
	dir, pr := t.TempDir(), 950101
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)
	// The refresh left the file with a differently-named method: Foo::total is
	// gone from the PR's own blocks, so the comment on it orphans.
	other := Block{PR: pr, File: "Foo.php", Class: "Foo", Name: "subtotal",
		Line: 3, EndLine: 6, Label: "Foo::subtotal", Status: "added", Side: "new"}
	if err := replacePRBlocks(mustOpenGraphDB(t, dir), "", pr, []Block{other}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":true,"confidence":"high"}`)
	engine, _, cs := autoResolveManager(t, dir, fake)

	in := CodeCommentInput{PR: pr, File: "Foo.php", Label: "Foo::total", Line: 4,
		Body: "haal deze method weg, die wordt nergens meer gebruikt",
		Gran: "line", Code: bodySnippet("return $x;"), RowStart: 2, RowEnd: 2, Local: true}
	runID, err := engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1
	})

	res := runReanchor(t, engine, "probe_autoresolve_yes", pr, []string{"Foo.php"})
	if res.AutoResolved != 1 {
		t.Fatalf("AutoResolved = %d, want 1: %+v", res.AutoResolved, res)
	}

	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1 && got[0].Status == "resolved"
	})

	got, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	c := got[0]
	if c.AnchorState != comments.AnchorOrphan {
		t.Errorf("anchorState = %q, want orphan", c.AnchorState)
	}
	if c.Status != "resolved" {
		t.Fatalf("status = %q, want resolved", c.Status)
	}
	if len(c.Reactions) != 1 {
		t.Fatalf("reactions = %d, want exactly 1 (the auto-resolve note)", len(c.Reactions))
	}
	r := c.Reactions[0]
	if r.Source != "ai" {
		t.Errorf("reaction source = %q, want ai", r.Source)
	}
	// Resolves itself isn't a persisted column (comments.Module.AddReaction only
	// uses it, at write time, to flip the comment's status) — c.Status ==
	// "resolved" above is the durable proof the thread actually closed.
	// The reply text is the main trace of this ever having happened, so it must
	// explain both what happened and why on its own — check both, not just a
	// generic "automatic" marker.
	lower := strings.ToLower(r.Body)
	if !strings.Contains(lower, "automatisch") {
		t.Errorf("reply body = %q, want it to say this happened automatically", r.Body)
	}
	if !strings.Contains(lower, "niet meer aanwezig") && !strings.Contains(lower, "verwijder") {
		t.Errorf("reply body = %q, want it to explain the code is gone", r.Body)
	}
	// The Execution stays alive: an auto-resolve is no longer irreversible — the
	// reviewer can unresolve the thread, which needs a signallable run.
	if status, _ := engine.Status(runID); status != tembed.StatusWaiting {
		t.Errorf("run status = %v, want waiting", status)
	}
}

// A reply from anyone at all — before the orphan transition — blocks the
// auto-resolve entirely: an active conversation must never be silently closed.
// The model is never even asked (guardrails are checked before the LLM call).
func TestAutoResolveSkipsWhenReplyExists(t *testing.T) {
	dir, pr := t.TempDir(), 950102
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)
	other := Block{PR: pr, File: "Foo.php", Class: "Foo", Name: "subtotal",
		Line: 3, EndLine: 6, Label: "Foo::subtotal", Status: "added", Side: "new"}
	if err := replacePRBlocks(mustOpenGraphDB(t, dir), "", pr, []Block{other}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":true,"confidence":"high"}`)
	engine, m, cs := autoResolveManager(t, dir, fake)

	in := CodeCommentInput{PR: pr, File: "Foo.php", Label: "Foo::total", Line: 4,
		Body: "haal deze method weg", Gran: "line", Code: bodySnippet("return $x;"),
		RowStart: 2, RowEnd: 2, Local: true}
	runID, err := engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1
	})
	if err := m.Signal(runID, ReactionSignal{ID: "r1", Source: "ui", Author: "reviewer", Body: "onderzoek ik"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1 && got[0].ReactionCount == 1
	})

	res := runReanchor(t, engine, "probe_autoresolve_reply", pr, []string{"Foo.php"})
	if res.AutoResolved != 0 {
		t.Fatalf("AutoResolved = %d, want 0 — a thread with a reply must never auto-close", res.AutoResolved)
	}
	if fake.CallCount() != 0 {
		t.Errorf("claude was called %d time(s), want 0 — the guardrail must gate before the LLM call", fake.CallCount())
	}

	got, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Status != "open" {
		t.Errorf("status = %q, want still open", got[0].Status)
	}
	if len(got[0].Reactions) != 1 {
		t.Errorf("reactions = %d, want still just the one manual reply", len(got[0].Reactions))
	}
}

// A comment already resolved (by hand) before its anchor happens to orphan is
// never reconsidered — its Execution has already completed, so re-signalling
// it would be pointless, and the LLM must not even be asked.
func TestAutoResolveSkipsAlreadyResolvedComment(t *testing.T) {
	dir, pr := t.TempDir(), 950103
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)
	other := Block{PR: pr, File: "Foo.php", Class: "Foo", Name: "subtotal",
		Line: 3, EndLine: 6, Label: "Foo::subtotal", Status: "added", Side: "new"}
	if err := replacePRBlocks(mustOpenGraphDB(t, dir), "", pr, []Block{other}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":true,"confidence":"high"}`)
	engine, m, cs := autoResolveManager(t, dir, fake)

	in := CodeCommentInput{PR: pr, File: "Foo.php", Label: "Foo::total", Line: 4,
		Body: "haal deze method weg", Gran: "line", Code: bodySnippet("return $x;"),
		RowStart: 2, RowEnd: 2, Local: true}
	runID, err := engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1
	})
	// Manually resolved already, unrelated to auto-resolve.
	if err := m.Signal(runID, ReactionSignal{ID: "r1", Source: "ui", Author: "reviewer", Body: "klaar", Done: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1 && got[0].Status == "resolved"
	})

	res := runReanchor(t, engine, "probe_autoresolve_already_resolved", pr, []string{"Foo.php"})
	if res.AutoResolved != 0 {
		t.Fatalf("AutoResolved = %d, want 0 — already resolved", res.AutoResolved)
	}
	if fake.CallCount() != 0 {
		t.Errorf("claude was called %d time(s), want 0", fake.CallCount())
	}

	got, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(got[0].Reactions) != 1 {
		t.Errorf("reactions = %d, want still just the one manual resolve", len(got[0].Reactions))
	}
}

// An AnchorUnpinned transition (the code within the block was merely edited,
// not the symbol removed) must never trigger the check at all — only a
// genuine AnchorOrphan does.
func TestAutoResolveNeverTriggersOnUnpinned(t *testing.T) {
	dir, pr := t.TempDir(), 950104
	old := fooPHP("$x = 1;", "return $x;")
	head := fooPHP("$x = 1;", "return $x * 2;") // the anchored line itself was edited
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)
	if err := replacePRBlocks(mustOpenGraphDB(t, dir), "", pr, []Block{fooBlock(pr)}); err != nil {
		t.Fatal(err)
	}

	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"removeCode":true,"confidence":"high"}`)
	engine, _, cs := autoResolveManager(t, dir, fake)

	in := CodeCommentInput{PR: pr, File: "Foo.php", Label: "Foo::total", Line: 4,
		Body: "haal deze regel weg", Gran: "line", Code: bodySnippet("return $x;"),
		RowStart: 2, RowEnd: 2, Local: true}
	if _, err := engine.StartWorkflow(WorkflowTaskCodeComment, in); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1
	})

	res := runReanchor(t, engine, "probe_autoresolve_unpinned", pr, []string{"Foo.php"})
	if res.AutoResolved != 0 {
		t.Fatalf("AutoResolved = %d, want 0 — this is an unpin, not an orphan", res.AutoResolved)
	}
	if fake.CallCount() != 0 {
		t.Errorf("claude was called %d time(s), want 0 — only AnchorOrphan may trigger the check", fake.CallCount())
	}

	got, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].AnchorState != comments.AnchorUnpinned {
		t.Fatalf("anchorState = %q, want unpinned (test setup issue)", got[0].AnchorState)
	}
	if got[0].Status != "open" {
		t.Errorf("status = %q, want still open", got[0].Status)
	}
}

// Offline / SLASH_CLAUDE=off: no claude client at all. The orphan transition
// itself still happens (that part is unrelated to the LLM), but nothing is
// ever auto-resolved.
func TestAutoResolveOfflineIsNoOp(t *testing.T) {
	dir, pr := t.TempDir(), 950105
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)
	other := Block{PR: pr, File: "Foo.php", Class: "Foo", Name: "subtotal",
		Line: 3, EndLine: 6, Label: "Foo::subtotal", Status: "added", Side: "new"}
	if err := replacePRBlocks(mustOpenGraphDB(t, dir), "", pr, []Block{other}); err != nil {
		t.Fatal(err)
	}

	// No claude Fake at all — mirrors SLASH_CLAUDE=off, where m.claude is nil.
	engine, _, cs := autoResolveManager(t, dir, nil)

	in := CodeCommentInput{PR: pr, File: "Foo.php", Label: "Foo::total", Line: 4,
		Body: "haal deze method weg", Gran: "line", Code: bodySnippet("return $x;"),
		RowStart: 2, RowEnd: 2, Local: true}
	if _, err := engine.StartWorkflow(WorkflowTaskCodeComment, in); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(context.Background(), "", pr)
		return len(got) == 1
	})

	res := runReanchor(t, engine, "probe_autoresolve_offline", pr, []string{"Foo.php"})
	if res.AutoResolved != 0 {
		t.Fatalf("AutoResolved = %d, want 0 with no claude client", res.AutoResolved)
	}

	got, err := cs.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].AnchorState != comments.AnchorOrphan {
		t.Errorf("anchorState = %q, want orphan (the anchor move itself is independent of the LLM)", got[0].AnchorState)
	}
	if got[0].Status != "open" {
		t.Errorf("status = %q, want still open", got[0].Status)
	}
}
