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

func TestPrune(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	stay := "1:a.php:A::build"
	gone := "1:old.php:Old::query"

	// Three PR-1 rows: a pair the scan still emits, a stale key on that same
	// caller (its call site left the changed lines), and an LLM 'found' row for a
	// caller that dropped out — Prune must remove both stale ones.
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, CallerID: stay, CallKey: "prepare", Status: StatusResolved, ChildClass: "A", ChildMethod: "prepare"},
		{PR: 1, CallerID: stay, CallKey: "join", Status: StatusResolved, ChildClass: "X", ChildMethod: "join"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.Save(ctx, Entry{PR: 1, CallerID: gone, CallKey: "join", Status: StatusFound, ChildClass: "X", ChildMethod: "join", Model: ModelSonnet}); err != nil {
		t.Fatal(err)
	}
	// A row for another PR must be untouched by pruning PR 1.
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 2, CallerID: gone, CallKey: "join", Status: StatusResolved, ChildClass: "X", ChildMethod: "join"},
	}); err != nil {
		t.Fatal(err)
	}

	if err := m.Prune(ctx, 1, []Entry{{PR: 1, CallerID: stay, CallKey: "prepare"}}); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].CallerID != stay || list[0].CallKey != "prepare" {
		t.Fatalf("PR 1 after prune = %+v, want only %s/prepare", list, stay)
	}
	if other, _ := m.List(ctx, 2); len(other) != 1 {
		t.Fatalf("PR 2 = %+v, want its row untouched", other)
	}

	// Empty keep-set clears the whole PR.
	if err := m.Prune(ctx, 1, nil); err != nil {
		t.Fatal(err)
	}
	if list, _ := m.List(ctx, 1); len(list) != 0 {
		t.Fatalf("PR 1 after empty-keep prune = %+v, want empty", list)
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
