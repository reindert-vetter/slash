package testcovers

import (
	"context"
	"path/filepath"
	"testing"
)

func TestUpsertGoPreservesLLMRows(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	test := "1:tests/OrderTest.php:OrderTest::testBillingAddress"

	// Go run: one resolved (method-level annotation), one unresolved
	// (class-level-only annotation, awaiting the LLM).
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, TestID: test, TargetKey: "method:Order::billingAddress", Status: StatusResolved,
			CoveredClass: "Order", CoveredMethod: "billingAddress", Annotation: "CoversMethod"},
		{PR: 1, TestID: test, TargetKey: "class:Invoice", Status: StatusUnresolved, Annotation: "CoversClass", CoveredClass: "Invoice"},
	}); err != nil {
		t.Fatal(err)
	}

	// The LLM finds the method the class-level annotation named.
	if err := m.Save(ctx, Entry{
		PR: 1, TestID: test, TargetKey: "class:Invoice", Status: StatusFound,
		CoveredClass: "Invoice", CoveredMethod: "total", Model: ModelSonnet, Confidence: "high",
	}); err != nil {
		t.Fatal(err)
	}

	// A later Go rebuild re-asserts the class-level target as unresolved — it
	// must NOT clobber the LLM's found row.
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, TestID: test, TargetKey: "method:Order::billingAddress", Status: StatusResolved,
			CoveredClass: "Order", CoveredMethod: "billingAddress", Annotation: "CoversMethod"},
		{PR: 1, TestID: test, TargetKey: "class:Invoice", Status: StatusUnresolved, Annotation: "CoversClass", CoveredClass: "Invoice"},
	}); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]Entry{}
	for _, e := range list {
		byKey[e.TargetKey] = e
	}
	if e := byKey["class:Invoice"]; e.Status != StatusFound || e.Model != ModelSonnet || e.CoveredMethod != "total" {
		t.Fatalf("class:Invoice = %+v, want preserved LLM found/sonnet row", e)
	}
	if e := byKey["method:Order::billingAddress"]; e.Status != StatusResolved {
		t.Fatalf("method:Order::billingAddress = %+v, want resolved", e)
	}
}

func TestPrune(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	stay := "1:tests/OrderTest.php:OrderTest::testStay"
	gone := "1:tests/OldTest.php:OldTest::testGone"

	if err := m.UpsertGo(ctx, []Entry{
		{PR: 1, TestID: stay, TargetKey: "method:Order::billingAddress", Status: StatusResolved},
		{PR: 1, TestID: stay, TargetKey: "none", Status: StatusUnannotated},
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.Save(ctx, Entry{PR: 1, TestID: gone, TargetKey: "class:Invoice", Status: StatusFound, Model: ModelSonnet}); err != nil {
		t.Fatal(err)
	}
	// A row for another PR must be untouched by pruning PR 1.
	if err := m.UpsertGo(ctx, []Entry{
		{PR: 2, TestID: gone, TargetKey: "class:Invoice", Status: StatusUnresolved},
	}); err != nil {
		t.Fatal(err)
	}

	if err := m.Prune(ctx, 1, []Entry{{PR: 1, TestID: stay, TargetKey: "method:Order::billingAddress"}}); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].TestID != stay || list[0].TargetKey != "method:Order::billingAddress" {
		t.Fatalf("PR 1 after prune = %+v, want only %s/method:Order::billingAddress", list, stay)
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
