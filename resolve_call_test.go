package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/callresolve"
	"slash/modules/claude"
	"slash/modules/github"
)

// resolveCallManager wires a TaskManager with a callresolve module + a claude
// Fake over the writeCallFixtureRepo worktree, for driving resolve_call.
func resolveCallManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *callresolve.Module) {
	t.Helper()
	cr, err := callresolve.Open(filepath.Join(dataDir, "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cr.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), cr, nil, nil, nil, fake, nil, nil, dataDir, "test/repo")
	return m, cr
}

func callInput(pr int, calls ...string) ResolveCallInput {
	return ResolveCallInput{
		PR: pr, CallerID: "x", CallerFile: "app/Services/OrderService.php",
		CallerClass: "OrderService", CallerName: "build", Calls: calls,
	}
}

// Haiku is confident → found, using only Haiku.
func TestResolveCallHaikuConfident(t *testing.T) {
	dataDir := t.TempDir()
	pr := 21
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Models/Order.php","class":"Order","method":"scopeJoinAddress","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "joinAddress")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusFound || e.Model != callresolve.ModelHaiku {
		t.Fatalf("entry = %+v, want found by haiku", e)
	}
	if e.ChildCode == "" {
		t.Fatalf("found entry has empty child code")
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1", n)
	}
}

// Haiku is not confident → the workflow never escalates to Sonnet: it uses
// ONLY Haiku, so an unconfident Haiku answer stays notfound even though a
// programmed Sonnet output would have found it.
func TestResolveCallNeverEscalatesToSonnet(t *testing.T) {
	dataDir := t.TempDir()
	pr := 22
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":false,"confidence":"low"}`)
	fake.SetOutput(claude.ModelSonnet, `{"found":true,"file":"app/Repos/RepoA.php","class":"RepoA","method":"fetch","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "fetch")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (no Sonnet escalation)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (Haiku only, no Sonnet call at all)", n)
	}
}

// A call with zero static candidates (nothing in the fixture worktree defines
// "someUnknownHelper") behaves the same as any other unconfident Haiku answer
// now that there is no escalation path at all.
func TestResolveCallNoEscalationWithoutCandidates(t *testing.T) {
	dataDir := t.TempDir()
	pr := 25
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":false,"confidence":"low"}`)
	fake.SetOutput(claude.ModelSonnet, `{"found":true,"file":"app/Repos/RepoA.php","class":"RepoA","method":"fetch","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "someUnknownHelper")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (no escalation without candidates)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (Haiku only, no Sonnet escalation)", n)
	}
}

// A denylisted vendor/framework builtin (assertStatus) with zero static
// candidates never even reaches Haiku: the whole point of the denylist is to
// skip the LLM call entirely for a name that can never resolve.
func TestResolveCallVendorBuiltinSkipsLLM(t *testing.T) {
	dataDir := t.TempDir()
	pr := 27
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	// Programmed outputs would make this call "resolve" if the LLM were
	// invoked at all — proving the skip, not just an absence of output.
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Repos/RepoA.php","class":"RepoA","method":"fetch","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "assertStatus")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (vendor builtin never resolves)", e)
	}
	if n := fake.CallCount(); n != 0 {
		t.Fatalf("claude called %d times, want 0 (vendor builtin skips the LLM entirely)", n)
	}
}

// The same denylisted name ("table") resolves normally once the app
// worktree actually defines it — the denylist gate only ever fires on
// len(candidates)==0, so it must never suppress a genuine app-defined match
// that merely happens to share a name with a Schema Blueprint builtin.
func TestResolveCallVendorBuiltinDoesNotSuppressRealCandidate(t *testing.T) {
	dataDir := t.TempDir()
	pr := 28
	writeCallFixtureRepo(t, dataDir, pr)
	_, headDir := worktreeDirs(dataDir, pr)
	// Add an app class that defines its own "table" method — same name as
	// the denylisted Schema Blueprint builtin, but a real app candidate.
	tableFile := filepath.Join(headDir, "app/Reports/ReportBuilder.php")
	if err := os.MkdirAll(filepath.Dir(tableFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tableFile, []byte(`<?php
namespace App\Reports;
class ReportBuilder {
    public function table() {}
}
`), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Reports/ReportBuilder.php","class":"ReportBuilder","method":"table","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "table")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusFound || e.Model != callresolve.ModelHaiku {
		t.Fatalf("entry = %+v, want found by haiku (real app candidate must not be suppressed)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (denylist must not skip a call with a real candidate)", n)
	}
}

// Neither model finds it (offline/empty Fake output) → notfound.
func TestResolveCallNotFound(t *testing.T) {
	dataDir := t.TempDir()
	pr := 23
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake() // no programmed output → "" → parse fails → notfound
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "fetch")); err != nil {
		t.Fatal(err)
	}

	e := onlyEntry(t, cr, pr)
	if e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound", e)
	}
}

// A model claiming a definition that does not exist in the worktree is rejected
// by verification → notfound (guards against a hallucinated file/method).
func TestResolveCallVerificationRejectsBogus(t *testing.T) {
	dataDir := t.TempDir()
	pr := 24
	writeCallFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"file":"app/Models/Ghost.php","class":"Ghost","method":"boo","confidence":"high"}`)
	m, cr := resolveCallManager(t, dataDir, fake)

	if _, err := m.StartResolveCall(callInput(pr, "joinAddress")); err != nil {
		t.Fatal(err)
	}
	if e := onlyEntry(t, cr, pr); e.Status != callresolve.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (bogus claim rejected)", e)
	}
}

func onlyEntry(t *testing.T, cr *callresolve.Module, pr int) callresolve.Entry {
	t.Helper()
	list, err := cr.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("callresolve has %d rows, want 1: %+v", len(list), list)
	}
	return list[0]
}
