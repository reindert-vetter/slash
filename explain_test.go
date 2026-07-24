package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/explanations"
	"slash/modules/github"
)

// explainManager wires a TaskManager with an explanations module + a claude
// Fake, for driving explain_code.
func explainManager(t *testing.T, fake *claude.Fake) (*TaskManager, *explanations.Module) {
	t.Helper()
	ex, err := explanations.Open(filepath.Join(t.TempDir(), "explanations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ex.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, ex, nil, fake, nil, nil, "", "test/repo")
	return m, ex
}

func explainInput() ExplainCodeInput {
	return ExplainCodeInput{
		PR: 31, BlockID: "31:app/Actions/Foo.php:Foo::run", File: "app/Actions/Foo.php",
		Label: "Foo::run", Gran: "line", UnitKey: "line-2", CodeHash: "hash1",
		Code:    "if ($value > 0) {",
		Context: "public function run()\n{\n    if ($value > 0) {\n        $value = 2;\n    }\n    return $value;\n}",
	}
}

// Haiku answers → the read-model gets a done row with the Dutch text, and the
// prompt carried the unit code and asked for Dutch.
func TestExplainCodeGeneratesDescription(t *testing.T) {
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, "Deze conditie controleert of de waarde positief is; alleen dan wordt hij op 2 gezet.")
	m, ex := explainManager(t, fake)

	if _, err := m.StartExplainCode(explainInput()); err != nil {
		t.Fatal(err)
	}

	list, err := ex.List(context.Background(), 31)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("explanations has %d rows, want 1: %+v", len(list), list)
	}
	e := list[0]
	if e.Status != explanations.StatusDone || e.Model != "haiku" || !strings.Contains(e.Text, "positief") {
		t.Fatalf("entry = %+v, want done haiku row", e)
	}
	if e.UnitKey != "line-2" || e.CodeHash != "hash1" {
		t.Fatalf("entry keyed %s/%s, want line-2/hash1", e.UnitKey, e.CodeHash)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1", n)
	}
	call := fake.Calls[0]
	if !strings.Contains(call.Prompt, "if ($value > 0) {") {
		t.Fatalf("prompt misses code:\n%s", call.Prompt)
	}
	// The call-independent Dutch task framing travels separately via
	// SystemPrompt (--append-system-prompt), not inline in Prompt — see
	// modules/claude/prompts.go.
	if !strings.Contains(call.SystemPrompt, "Nederlands") {
		t.Fatalf("system prompt misses Dutch instruction:\n%s", call.SystemPrompt)
	}
	if call.SystemPrompt != claude.ExplainCodeSystemPrompt {
		t.Fatalf("system prompt = %q, want the embedded claude.ExplainCodeSystemPrompt", call.SystemPrompt)
	}
	if fake.Calls[0].WorkDir != "" || len(fake.Calls[0].Tools) != 0 {
		t.Fatalf("explain run must be context-only, got %+v", fake.Calls[0])
	}
}

// A second start for the same unit+code is an idempotent no-op reuse
// (deterministic Run ID via StartWorkflowID) — no second LLM call.
func TestExplainCodeIdempotentStart(t *testing.T) {
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, "Uitleg.")
	m, ex := explainManager(t, fake)

	id1, err := m.StartExplainCode(explainInput())
	if err != nil {
		t.Fatal(err)
	}
	id2, err := m.StartExplainCode(explainInput())
	if err != nil {
		t.Fatal(err)
	}
	if id1 != id2 {
		t.Fatalf("run ids differ: %s vs %s", id1, id2)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (idempotent reuse)", n)
	}
	// A new code hash (new commit) is a fresh Execution.
	in := explainInput()
	in.CodeHash = "hash2"
	id3, err := m.StartExplainCode(in)
	if err != nil {
		t.Fatal(err)
	}
	if id3 == id1 {
		t.Fatalf("new hash reused run id %s", id3)
	}
	if n := fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d times, want 2 (fresh run for new hash)", n)
	}
	list, err := ex.List(context.Background(), 31)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].CodeHash != "hash2" {
		t.Fatalf("read-model = %+v, want 1 row on the newest hash", list)
	}
}

// An empty Fake (SLASH_CLAUDE=off / a hiccup) yields a terminal failed row —
// the workflow completes cleanly and the footer then shows nothing.
func TestExplainCodeOfflineFails(t *testing.T) {
	fake := claude.NewFake() // no programmed output → ""
	m, ex := explainManager(t, fake)

	if _, err := m.StartExplainCode(explainInput()); err != nil {
		t.Fatal(err)
	}
	list, err := ex.List(context.Background(), 31)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Status != explanations.StatusFailed || list[0].Text != "" {
		t.Fatalf("entry = %+v, want failed row with empty text", list)
	}
}
