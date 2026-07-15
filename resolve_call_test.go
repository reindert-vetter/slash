package main

import (
	"context"
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
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), cr, nil, nil, fake, nil, nil, dataDir, "test/repo")
	return m, cr
}

func callInput(pr int, calls ...string) ResolveCallInput {
	return ResolveCallInput{
		PR: pr, CallerID: "x", CallerFile: "app/Services/OrderService.php",
		CallerClass: "OrderService", CallerName: "build", Calls: calls,
	}
}

// Haiku is confident → found on the first model, no Sonnet escalation.
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
		t.Fatalf("claude called %d times, want 1 (no Sonnet escalation)", n)
	}
}

// Haiku is not confident → automatic escalation to Sonnet, which finds it.
func TestResolveCallEscalatesToSonnet(t *testing.T) {
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
	if e.Status != callresolve.StatusFound || e.Model != callresolve.ModelSonnet {
		t.Fatalf("entry = %+v, want found by sonnet", e)
	}
	if n := fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d times, want 2 (haiku then sonnet)", n)
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
	fake.SetOutput(claude.ModelSonnet, `{"found":true,"file":"app/Models/Ghost.php","class":"Ghost","method":"boo","confidence":"high"}`)
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
