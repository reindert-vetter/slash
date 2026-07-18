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

// TestKindRoundTrip: an Entry with no Kind set normalizes to KindMethodCall on
// write (both UpsertGo and Save), while an explicit Kind (e.g. the
// migration→model / model-usage rules) round-trips unchanged.
func TestKindRoundTrip(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	caller := "1:a.php:A::store"
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, CallerID: caller, CallKey: "prepare", Status: StatusResolved, ChildClass: "A", ChildMethod: "prepare"},
		{PR: 1, CallerID: caller, CallKey: "ProductGroup", Status: StatusResolved, Kind: KindModelUsage, ChildClass: "ProductGroup"},
		{PR: 1, CallerID: caller, CallKey: "migration_model:orders", Status: StatusResolved, Kind: KindMigrationModel, ChildClass: "Order"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.Save(ctx, Entry{PR: 1, CallerID: caller, CallKey: "fetch", Status: StatusFound, ChildClass: "RepoA", ChildMethod: "fetch", Model: ModelSonnet}); err != nil {
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
	if e := byKey["prepare"]; e.Kind != KindMethodCall {
		t.Errorf("prepare: kind=%q, want %q (normalized default)", e.Kind, KindMethodCall)
	}
	if e := byKey["fetch"]; e.Kind != KindMethodCall {
		t.Errorf("fetch (via Save): kind=%q, want %q (normalized default)", e.Kind, KindMethodCall)
	}
	if e := byKey["ProductGroup"]; e.Kind != KindModelUsage {
		t.Errorf("ProductGroup: kind=%q, want %q", e.Kind, KindModelUsage)
	}
	if e := byKey["migration_model:orders"]; e.Kind != KindMigrationModel {
		t.Errorf("migration_model:orders: kind=%q, want %q", e.Kind, KindMigrationModel)
	}
}

// TestMigrateAddsKindColumn: an existing callresolve.db created before the
// kind column existed (a bare CREATE TABLE without it) still opens and reads
// back rows with the default kind after Open runs its migrate step.
func TestMigrateAddsKindColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "callresolve.db")
	// Simulate the pre-kind schema directly (New() also always applies the
	// current `schema`, which already includes the column for a fresh table —
	// so exercise ALTER TABLE against a hand-built legacy table instead).
	legacy, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.db.Exec(`DROP TABLE call_resolutions`); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.db.Exec(`CREATE TABLE call_resolutions (
  pr INTEGER NOT NULL, caller_id TEXT NOT NULL, call_key TEXT NOT NULL, status TEXT NOT NULL,
  child_file TEXT NOT NULL DEFAULT '', child_class TEXT NOT NULL DEFAULT '', child_method TEXT NOT NULL DEFAULT '',
  child_line INTEGER NOT NULL DEFAULT 0, child_code TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (pr, caller_id, call_key))`); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.db.Exec(`INSERT INTO call_resolutions (pr, caller_id, call_key, status) VALUES (1, 'c', 'k', 'resolved')`); err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	m, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	list, err := m.List(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Kind != KindMethodCall {
		t.Fatalf("got %+v, want one row with kind=%q (migrated default)", list, KindMethodCall)
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
