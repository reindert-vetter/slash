package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/github"
	"slash/modules/testcovers"
)

// resolveTestCoversManager wires a TaskManager with a testcovers module + a
// claude Fake over the writeTestCoversFixtureRepo worktree, for driving
// resolve_test_covers.
func resolveTestCoversManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *testcovers.Module) {
	t.Helper()
	tc, err := testcovers.Open(filepath.Join(dataDir, "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tc.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, tc, nil, nil, fake, nil, nil, dataDir, "test/repo")
	return m, tc
}

func testCoverInput(pr int, classes ...string) ResolveTestCoversInput {
	return ResolveTestCoversInput{
		PR: pr, TestID: "x", TestFile: "tests/Feature/OrderCoverageTest.php",
		TestClass: "OrderCoverageTest", TestName: "testCoversClassOnly", Classes: classes,
	}
}

// Haiku is confident → found, using only Haiku.
func TestResolveTestCoversHaikuConfident(t *testing.T) {
	dataDir := t.TempDir()
	pr := 31
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"method":"billingAddress","confidence":"high"}`)
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	if _, err := m.StartResolveTestCovers(testCoverInput(pr, "Order")); err != nil {
		t.Fatal(err)
	}

	e := onlyTestCoverEntry(t, tc, pr)
	if e.Status != testcovers.StatusFound || e.Model != testcovers.ModelHaiku {
		t.Fatalf("entry = %+v, want found by haiku", e)
	}
	if e.CoveredCode == "" {
		t.Fatalf("found entry has empty covered code")
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1", n)
	}
}

// Haiku is not confident → the workflow never escalates to Sonnet: it uses
// ONLY Haiku, so an unconfident Haiku answer stays notfound even though a
// programmed Sonnet output would have found it.
func TestResolveTestCoversNeverEscalatesToSonnet(t *testing.T) {
	dataDir := t.TempDir()
	pr := 32
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":false,"confidence":"low"}`)
	fake.SetOutput(claude.ModelSonnet, `{"found":true,"method":"shippingAddress","confidence":"high"}`)
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	if _, err := m.StartResolveTestCovers(testCoverInput(pr, "Order")); err != nil {
		t.Fatal(err)
	}

	e := onlyTestCoverEntry(t, tc, pr)
	if e.Status != testcovers.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (no Sonnet escalation)", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (Haiku only, no Sonnet call at all)", n)
	}
}

// Neither model finds it (offline/empty Fake output) → notfound.
func TestResolveTestCoversNotFound(t *testing.T) {
	dataDir := t.TempDir()
	pr := 33
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake() // no programmed output → "" → parse fails → notfound
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	if _, err := m.StartResolveTestCovers(testCoverInput(pr, "Order")); err != nil {
		t.Fatal(err)
	}

	e := onlyTestCoverEntry(t, tc, pr)
	if e.Status != testcovers.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound", e)
	}
}

// A model claiming a method that does not exist on the named class is
// rejected by verification → notfound (guards against a hallucinated method).
func TestResolveTestCoversVerificationRejectsBogus(t *testing.T) {
	dataDir := t.TempDir()
	pr := 34
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"method":"ghostMethod","confidence":"high"}`)
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	if _, err := m.StartResolveTestCovers(testCoverInput(pr, "Order")); err != nil {
		t.Fatal(err)
	}
	if e := onlyTestCoverEntry(t, tc, pr); e.Status != testcovers.StatusNotfound {
		t.Fatalf("entry = %+v, want notfound (bogus claim rejected)", e)
	}
}

func onlyTestCoverEntry(t *testing.T, tc *testcovers.Module, pr int) testcovers.Entry {
	t.Helper()
	list, err := tc.List(context.Background(), pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("testcovers has %d rows, want 1: %+v", len(list), list)
	}
	return list[0]
}
