package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/testcovers"
)

// writeTestCoversFixtureRepo lays out a head worktree with a production Order
// model plus two PHPUnit test files exercising every annotation form:
// #[CoversMethod] and "@covers Class::method" (method-level, resolved),
// "@coversDefaultClass" + "@covers ::method" (combined, resolved),
// #[CoversClass] and a bare "@covers Class" docblock (class-level-only,
// unresolved — LLM territory), an unverifiable #[CoversMethod] claim (falls
// back to unannotated), a plain test with no annotation at all (unannotated),
// and a bare "@covers Class" sitting only on the class docblock — exercised
// by both the first test method (whose zone directly reaches the class
// docblock) and a later one (which only gets there via the classZone
// fallback).
func writeTestCoversFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Models/Order.php": `<?php
namespace App\Models;
class Order {
    public function billingAddress() {}
    public function shippingAddress() {}
    public function taxAddress() {}
}
`,
		"tests/Feature/OrderCoverageTest.php": `<?php
namespace Tests\Feature;

use App\Models\Order;
use PHPUnit\Framework\TestCase;

/**
 * @coversDefaultClass \App\Models\Order
 */
class OrderCoverageTest extends TestCase
{
    #[CoversMethod(Order::class, 'billingAddress')]
    public function testBillingAddressAttribute(): void
    {
        $this->assertTrue(true);
    }

    /**
     * @covers Order::shippingAddress
     */
    public function testShippingAddressDocblock(): void
    {
        $this->assertTrue(true);
    }

    /**
     * @covers ::taxAddress
     */
    public function testTaxAddressDefaultClass(): void
    {
        $this->assertTrue(true);
    }

    #[CoversClass(Order::class)]
    public function testCoversClassOnly(): void
    {
        $this->assertTrue(true);
    }

    #[CoversMethod(Order::class, 'doesNotExist')]
    public function testTypoMethod(): void
    {
        $this->assertTrue(true);
    }

    public function testNoAnnotationAtAll(): void
    {
        $this->assertTrue(true);
    }
}
`,
		"tests/Feature/BareCoversTest.php": `<?php
namespace Tests\Feature;

use PHPUnit\Framework\TestCase;

/**
 * @covers \App\Models\Invoice
 */
class BareCoversTest extends TestCase
{
    public function testFirstBareCovers(): void
    {
        $this->assertTrue(true);
    }

    public function testSecondBareCovers(): void
    {
        $this->assertTrue(true);
    }
}
`,
	}
	for rel, body := range files {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// testCoversBlocks re-parses a fixture test file with the real scanner (so
// line numbers exactly match the source, which the zone-slicing logic
// depends on) and returns its methods as changed TEST-category PR blocks.
func testCoversBlocks(t *testing.T, dataDir string, pr int, relFile string) []Block {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	src, err := os.ReadFile(filepath.Join(headDir, relFile))
	if err != nil {
		t.Fatal(err)
	}
	var out []Block
	for _, b := range ScanBlocks(src, relFile) {
		b.PR = pr
		b.Category = "TEST"
		b.Side = SideNew
		b.Status = StatusAdded
		out = append(out, b)
	}
	return out
}

func findCoverEntry(entries []testcovers.Entry, testID, targetKey string) (testcovers.Entry, bool) {
	for _, e := range entries {
		if e.TestID == testID && e.TargetKey == targetKey {
			return e, true
		}
	}
	return testcovers.Entry{}, false
}

func TestScanTestCoversAnnotationForms(t *testing.T) {
	dataDir := t.TempDir()
	pr := 9
	writeTestCoversFixtureRepo(t, dataDir, pr)

	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/OrderCoverageTest.php")
	entries := scanTestCovers(dataDir, pr, blocks)

	testID := func(method string) string {
		for _, b := range blocks {
			if b.Name == method {
				return b.ID()
			}
		}
		t.Fatalf("no block named %s", method)
		return ""
	}

	// 1. #[CoversMethod] resolves statically.
	e, ok := findCoverEntry(entries, testID("testBillingAddressAttribute"), "method:Order::billingAddress")
	if !ok || e.Status != testcovers.StatusResolved || e.Annotation != "CoversMethod" || e.CoveredCode == "" {
		t.Fatalf("CoversMethod entry = %+v, ok=%v", e, ok)
	}

	// 2. "@covers Class::method" docblock resolves statically.
	e, ok = findCoverEntry(entries, testID("testShippingAddressDocblock"), "method:Order::shippingAddress")
	if !ok || e.Status != testcovers.StatusResolved || e.Annotation != "@covers" {
		t.Fatalf("@covers Class::method entry = %+v, ok=%v", e, ok)
	}

	// 3. "@coversDefaultClass" + "@covers ::method" combine to resolve.
	e, ok = findCoverEntry(entries, testID("testTaxAddressDefaultClass"), "method:Order::taxAddress")
	if !ok || e.Status != testcovers.StatusResolved {
		t.Fatalf("@coversDefaultClass combo entry = %+v, ok=%v", e, ok)
	}

	// 4. #[CoversClass] (method-level placement) is class-level-only → unresolved.
	e, ok = findCoverEntry(entries, testID("testCoversClassOnly"), "class:Order")
	if !ok || e.Status != testcovers.StatusUnresolved || e.Annotation != "CoversClass" || e.CoveredClass != "Order" {
		t.Fatalf("CoversClass entry = %+v, ok=%v", e, ok)
	}

	// 5. An unverifiable #[CoversMethod] claim (method doesn't exist on the
	// class) is dropped — falls through to unannotated, exactly like no
	// annotation at all.
	e, ok = findCoverEntry(entries, testID("testTypoMethod"), "none")
	if !ok || e.Status != testcovers.StatusUnannotated {
		t.Fatalf("unverifiable claim entry = %+v, ok=%v", e, ok)
	}

	// 6. No annotation at all → unannotated.
	e, ok = findCoverEntry(entries, testID("testNoAnnotationAtAll"), "none")
	if !ok || e.Status != testcovers.StatusUnannotated {
		t.Fatalf("no-annotation entry = %+v, ok=%v", e, ok)
	}
}

func TestScanTestCoversBareClassFallback(t *testing.T) {
	dataDir := t.TempDir()
	pr := 10
	writeTestCoversFixtureRepo(t, dataDir, pr)

	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/BareCoversTest.php")
	entries := scanTestCovers(dataDir, pr, blocks)

	testID := func(method string) string {
		for _, b := range blocks {
			if b.Name == method {
				return b.ID()
			}
		}
		t.Fatalf("no block named %s", method)
		return ""
	}

	// The first test method's own zone reaches all the way back to the class
	// docblock, so it finds the bare "@covers Invoice" directly.
	e, ok := findCoverEntry(entries, testID("testFirstBareCovers"), "class:Invoice")
	if !ok || e.Status != testcovers.StatusUnresolved || e.Annotation != "@covers-class" {
		t.Fatalf("first bare-covers entry = %+v, ok=%v", e, ok)
	}

	// The second test method's own zone does NOT reach the class docblock — it
	// only gets the bare class-wide annotation via the classZone fallback.
	e, ok = findCoverEntry(entries, testID("testSecondBareCovers"), "class:Invoice")
	if !ok || e.Status != testcovers.StatusUnresolved || e.Annotation != "@covers-class" {
		t.Fatalf("second bare-covers (fallback) entry = %+v, ok=%v", e, ok)
	}
}

// A non-TEST-category block, and the old (removed) side of a changed test
// block, never produce a test-coverage entry.
func TestScanTestCoversSkipsNonTestBlocks(t *testing.T) {
	dataDir := t.TempDir()
	pr := 11
	writeTestCoversFixtureRepo(t, dataDir, pr)

	blocks := []Block{
		{PR: pr, File: "app/Models/Order.php", Class: "Order", Name: "billingAddress", Category: "MODEL", Side: SideNew, Status: StatusModified},
	}
	entries := scanTestCovers(dataDir, pr, blocks)
	if len(entries) != 0 {
		t.Fatalf("expected no entries for a non-TEST block, got %+v", entries)
	}
}

// The build_relations workflow also writes the testcovers read-model:
// EnsureRelations starts it, the buildRelations Activity runs synchronously
// and — alongside the relations/callresolve rows — scans the PR's test blocks
// for coverage annotations.
func TestBuildRelationsWorkflowFillsTestCovers(t *testing.T) {
	dataDir := t.TempDir()
	pr := 35
	writeTestCoversFixtureRepo(t, dataDir, pr)
	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/OrderCoverageTest.php")

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := replacePRBlocks(db, pr, blocks); err != nil {
		t.Fatal(err)
	}

	tc, err := testcovers.Open(filepath.Join(dataDir, "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tc.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, tc, nil, nil, nil, db, dataDir, "test/repo")

	ctx := context.Background()
	m.EnsureRelations(ctx, pr) // initial build runs inside StartWorkflow

	got, err := tc.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatalf("testcovers read-model is empty after build_relations")
	}
	found := false
	for _, e := range got {
		if e.TargetKey == "method:Order::billingAddress" && e.Status == testcovers.StatusResolved {
			found = true
		}
	}
	if !found {
		t.Fatalf("testcovers rows = %+v, want a resolved method:Order::billingAddress row", got)
	}
}
