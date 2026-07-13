package callresolve

import (
	"context"
	"path/filepath"
	"testing"
)

func TestUpsertGoPreservesLLMRows(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	caller := "1:a.php:A::build"

	// Go run: one resolved, one unresolved.
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, CallerID: caller, CallKey: "prepare", Status: StatusResolved, ChildFile: "a.php", ChildClass: "A", ChildMethod: "prepare"},
		{PR: 1, CallerID: caller, CallKey: "fetch", Status: StatusUnresolved},
	}); err != nil {
		t.Fatal(err)
	}

	// LLM finds "fetch".
	if err := m.Save(ctx, Entry{
		PR: 1, CallerID: caller, CallKey: "fetch", Status: StatusFound,
		ChildFile: "b.php", ChildClass: "RepoA", ChildMethod: "fetch",
		Model: ModelSonnet, Confidence: "high",
	}); err != nil {
		t.Fatal(err)
	}

	// A later Go rebuild re-asserts "fetch" as unresolved — it must NOT clobber the
	// LLM's found row.
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, CallerID: caller, CallKey: "prepare", Status: StatusResolved, ChildFile: "a.php", ChildClass: "A", ChildMethod: "prepare"},
		{PR: 1, CallerID: caller, CallKey: "fetch", Status: StatusUnresolved},
	}); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]Entry{}
	for _, e := range list {
		byKey[e.CallKey] = e
	}
	if e := byKey["fetch"]; e.Status != StatusFound || e.Model != ModelSonnet {
		t.Fatalf("fetch = %+v, want preserved LLM found/sonnet row", e)
	}
	if e := byKey["prepare"]; e.Status != StatusResolved {
		t.Fatalf("prepare = %+v, want resolved", e)
	}
}

func TestNormalizeCallKey(t *testing.T) {
	cases := map[string]string{
		"->joinAddress":   "joinAddress",
		"joinAddress(":    "joinAddress",
		"::compute()":     "compute",
		"  ->fetch('x') ": "fetch",
		"plain":           "plain",
	}
	for in, want := range cases {
		if got := NormalizeCallKey(in); got != want {
			t.Errorf("NormalizeCallKey(%q) = %q, want %q", in, got, want)
		}
	}
}
