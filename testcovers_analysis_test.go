package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	entries := scanTestCovers(dataDir, pr, blocks, nil)

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

// TestScanTestCoversCapturesLine verifies that a resolved (method-level) and
// an unresolved (class-level-only) annotation each carry the absolute source
// line, within the TEST's own file, where the annotation itself sits — see
// coverTarget.line / methodZone's `from`. The frontend's group-scoping/
// reordering of the "Onderliggende code" panel (detail-layout.md) depends on
// this. Line numbers are the fixture's own (see writeTestCoversFixtureRepo):
// #[CoversMethod(Order::class, 'billingAddress')] sits on line 12, and
// #[CoversClass(Order::class)] on line 34.
func TestScanTestCoversCapturesLine(t *testing.T) {
	dataDir := t.TempDir()
	pr := 12
	writeTestCoversFixtureRepo(t, dataDir, pr)

	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/OrderCoverageTest.php")
	entries := scanTestCovers(dataDir, pr, blocks, nil)

	testID := func(method string) string {
		for _, b := range blocks {
			if b.Name == method {
				return b.ID()
			}
		}
		t.Fatalf("no block named %s", method)
		return ""
	}

	e, ok := findCoverEntry(entries, testID("testBillingAddressAttribute"), "method:Order::billingAddress")
	if !ok {
		t.Fatalf("CoversMethod entry not found")
	}
	if e.Line != 12 {
		t.Errorf("CoversMethod Line = %d, want 12", e.Line)
	}

	e, ok = findCoverEntry(entries, testID("testCoversClassOnly"), "class:Order")
	if !ok {
		t.Fatalf("CoversClass entry not found")
	}
	if e.Line != 34 {
		t.Errorf("CoversClass Line = %d, want 34", e.Line)
	}
}

func TestScanTestCoversBareClassFallback(t *testing.T) {
	dataDir := t.TempDir()
	pr := 10
	writeTestCoversFixtureRepo(t, dataDir, pr)

	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/BareCoversTest.php")
	entries := scanTestCovers(dataDir, pr, blocks, nil)

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

// TestScanTestCoversClassLevelCoversMethod proves that #[CoversMethod(...)]
// placed directly above the CLASS declaration (not above one test method)
// resolves statically too, and applies to EVERY test method of that class —
// reproduces the real-world PR-13148 case (ProductGroupUpdateTest.php),
// where one #[CoversMethod(ProductGroupController::class, 'update')] sits
// above the class and every test method only carries a bare #[Test].
func TestScanTestCoversClassLevelCoversMethod(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Http/Controllers/Api/ProductGroupController.php": `<?php
namespace App\Http\Controllers\Api;
class ProductGroupController {
    public function update() {}
}
`,
		"tests/Http/ProductGroups/ProductGroupUpdateTest.php": `<?php
namespace Tests\Http\ProductGroups;

use App\Http\Controllers\Api\ProductGroupController;
use PHPUnit\Framework\Attributes\CoversMethod;
use PHPUnit\Framework\Attributes\Test;
use Tests\Http\HttpTestCase;

#[CoversMethod(ProductGroupController::class, 'update')]
final class ProductGroupUpdateTest extends HttpTestCase
{
    #[Test]
    public function it_should_update_the_product_group_when_valid(): void
    {
        $this->assertTrue(true);
    }

    #[Test]
    public function it_should_move_a_product_from_another_group_when_it_is_coupled(): void
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

	blocks := testCoversBlocks(t, dataDir, pr, "tests/Http/ProductGroups/ProductGroupUpdateTest.php")
	entries := scanTestCovers(dataDir, pr, blocks, nil)

	testID := func(method string) string {
		for _, b := range blocks {
			if b.Name == method {
				return b.ID()
			}
		}
		t.Fatalf("no block named %s", method)
		return ""
	}

	for _, method := range []string{
		"it_should_update_the_product_group_when_valid",
		"it_should_move_a_product_from_another_group_when_it_is_coupled",
	} {
		e, ok := findCoverEntry(entries, testID(method), "method:ProductGroupController::update")
		if !ok || e.Status != testcovers.StatusResolved || e.Annotation != "CoversMethod" {
			t.Fatalf("%s: class-level CoversMethod entry = %+v, ok=%v", method, e, ok)
		}
		// Line must stay 0 — the annotation sits above the class, shared
		// verbatim by every test method, so it is never "this test's own
		// line": home.mjs's groupTierForLine would otherwise wrongly score
		// this child as out of scope for every group/line of every test in
		// the class, and newLineToRowOf could coincidentally miscount it onto
		// an unrelated row of THIS method (reported as "a 0/8 approve badge
		// with no matching card in the Onderliggende-code panel").
		if e.Line != 0 {
			t.Errorf("%s: class-level CoversMethod Line = %d, want 0", method, e.Line)
		}
	}
}

// TestScanTestCoversSingleStartpointShortcut reproduces the screenshot case:
// a PR with exactly one non-TEST start block (Cart::fill) and a test class
// with no coverage annotation at all — every otherwise-"unannotated" test
// method is linked to that one block instead. An explicitly (but only
// partially) annotated test method keeps going through the ordinary
// "unresolved" path, untouched by the shortcut.
func TestScanTestCoversSingleStartpointShortcut(t *testing.T) {
	dataDir := t.TempDir()
	pr := 20
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Models/Cart.php": `<?php
namespace App\Models;
class Cart {
    public function fill() {}
}
`,
		"tests/Feature/CartShippingTest.php": `<?php
namespace Tests\Feature;

use PHPUnit\Framework\TestCase;

class CartShippingTest extends TestCase
{
    public function testShippingIsCalculated(): void
    {
        $this->assertTrue(true);
    }

    #[CoversClass(\App\Models\Cart::class)]
    public function testWithClassLevelAnnotation(): void
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

	testBlocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/CartShippingTest.php")
	blocks := append([]Block{
		{PR: pr, File: "app/Models/Cart.php", Class: "Cart", Name: "fill", Category: "OTHER", Line: 4, EndLine: 4, Side: SideNew, Status: StatusModified},
	}, testBlocks...)

	testID := func(method string) string {
		for _, b := range testBlocks {
			if b.Name == method {
				return b.ID()
			}
		}
		t.Fatalf("no block named %s", method)
		return ""
	}

	// No relations at all (rels=nil): Cart::fill is the PR's only non-TEST
	// block and isn't a relation child of anything, so it's the one start
	// block.
	entries := scanTestCovers(dataDir, pr, blocks, nil)

	e, ok := findCoverEntry(entries, testID("testShippingIsCalculated"), "method:Cart::fill")
	if !ok || e.Status != testcovers.StatusResolved || e.Annotation != annotationSingleStartpoint || e.CoveredCode == "" {
		t.Fatalf("unannotated test entry = %+v, ok=%v", e, ok)
	}

	// An explicit (if incomplete) annotation still wins — the shortcut never
	// touches an "unresolved" row.
	e, ok = findCoverEntry(entries, testID("testWithClassLevelAnnotation"), "class:Cart")
	if !ok || e.Status != testcovers.StatusUnresolved {
		t.Fatalf("class-level-annotated test entry = %+v, ok=%v", e, ok)
	}
}

// TestScanTestCoversSingleStartpointShortcutNeedsExactlyOne proves the
// shortcut stays inert with zero or several non-TEST start blocks: an
// unannotated test falls back to the ordinary "unannotated" status.
func TestScanTestCoversSingleStartpointShortcutNeedsExactlyOne(t *testing.T) {
	dataDir := t.TempDir()
	pr := 21
	writeTestCoversFixtureRepo(t, dataDir, pr)
	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/OrderCoverageTest.php")

	testID := func(method string) string {
		for _, b := range blocks {
			if b.Name == method {
				return b.ID()
			}
		}
		t.Fatalf("no block named %s", method)
		return ""
	}

	// Zero non-TEST blocks in the PR at all.
	entries := scanTestCovers(dataDir, pr, blocks, nil)
	e, ok := findCoverEntry(entries, testID("testNoAnnotationAtAll"), "none")
	if !ok || e.Status != testcovers.StatusUnannotated {
		t.Fatalf("zero-candidate entry = %+v, ok=%v", e, ok)
	}

	// Two non-TEST blocks — too ambiguous to guess.
	withTwo := append([]Block{
		{PR: pr, File: "app/Models/Order.php", Class: "Order", Name: "billingAddress", Category: "OTHER", Side: SideNew, Status: StatusModified},
		{PR: pr, File: "app/Models/Order.php", Class: "Order", Name: "shippingAddress", Category: "OTHER", Side: SideNew, Status: StatusModified},
	}, blocks...)
	entries = scanTestCovers(dataDir, pr, withTwo, nil)
	e, ok = findCoverEntry(entries, testID("testNoAnnotationAtAll"), "none")
	if !ok || e.Status != testcovers.StatusUnannotated {
		t.Fatalf("two-candidate entry = %+v, ok=%v", e, ok)
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
	entries := scanTestCovers(dataDir, pr, blocks, nil)
	if len(entries) != 0 {
		t.Fatalf("expected no entries for a non-TEST block, got %+v", entries)
	}
}

// TestFuncDeclLineIgnoresFunctionWordInDocProse proves that funcDeclLine
// still finds the REAL `function` keyword line even when the method's own
// PHPDoc — now folded into its Block.Line/EndLine span, see
// .claude/docs/blocks-and-ingest.md — contains the bare word "function" in
// its prose. A naive `\bfunction\b` search (the pre-hardening regex) would
// false-match the docblock line instead of the actual declaration below it.
func TestFuncDeclLineIgnoresFunctionWordInDocProse(t *testing.T) {
	src := `<?php
class OrderService {
    /**
     * This function creates an order for the given customer.
     */
    public function create($customerId) {
        return new Order();
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/OrderService.php")
	b, ok := blockByName(got, "OrderService::create")
	if !ok {
		t.Fatalf("expected OrderService::create, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the PHPDoc's opening line), got %d", b.Line)
	}
	lines := strings.Split(src, "\n")
	if got := funcDeclLine(lines, b); got != 6 {
		t.Fatalf("expected funcDeclLine=6 (the real `function` line), got %d — the doc prose's \"function\" mention was false-matched", got)
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
	if err := replacePRBlocks(db, "", pr, blocks); err != nil {
		t.Fatal(err)
	}

	tc, err := testcovers.Open(filepath.Join(dataDir, "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer tc.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, tc, nil, nil, nil, nil, db, dataDir, "test/repo")

	ctx := context.Background()
	m.EnsureRelations(ctx, "", pr) // initial build runs inside StartWorkflow

	got, err := tc.List(ctx, "", pr)
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

// TestScanTestCoversFoldsLeadingPHPDocInCoveredCode: a resolved covers-child
// (the tested method) whose definition carries a leading PHPDoc gets the same
// @return/@param signature fold applied to its embedded CoveredCode that an
// active (changed) block's diff gets via /api/code — see
// codesig.go/enrichedCodeSide and .claude/docs/blocks-and-ingest.md
// ("PHPDoc-types in de signatuur vouwen"). CoveredLine must shift by the same
// removed-line count as the doc.
func TestScanTestCoversFoldsLeadingPHPDocInCoveredCode(t *testing.T) {
	dataDir := t.TempDir()
	pr := 15
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Models/Order.php": "<?php\n" +
			"namespace App\\Models;\n" +
			"class Order {\n" +
			"    /**\n" +
			"     * @param string $type\n" +
			"     * @return array\n" +
			"     */\n" +
			"    public function billingAddress($type)\n" +
			"    {\n" +
			"        return [];\n" +
			"    }\n" +
			"}\n",
		"tests/Feature/OrderCoverageTest.php": `<?php
namespace Tests\Feature;

use App\Models\Order;
use PHPUnit\Framework\TestCase;

class OrderCoverageTest extends TestCase
{
    #[CoversMethod(Order::class, 'billingAddress')]
    public function testBillingAddress(): void
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

	blocks := testCoversBlocks(t, dataDir, pr, "tests/Feature/OrderCoverageTest.php")
	entries := scanTestCovers(dataDir, pr, blocks, nil)

	testID := blocks[0].ID()
	e, ok := findCoverEntry(entries, testID, "method:Order::billingAddress")
	if !ok || e.Status != testcovers.StatusResolved {
		t.Fatalf("CoversMethod entry = %+v, ok=%v", e, ok)
	}
	if strings.Contains(e.CoveredCode, "/**") || strings.Contains(e.CoveredCode, "@param") {
		t.Errorf("CoveredCode still carries the PHPDoc, got %q", e.CoveredCode)
	}
	if !strings.Contains(e.CoveredCode, "function billingAddress(string $type): array") {
		t.Errorf("CoveredCode signature not folded, got %q", e.CoveredCode)
	}
	if e.CoveredLine != 8 {
		t.Errorf("CoveredLine = %d, want 8 (the doc's 4 removed lines shift the def from line 4 to line 8)", e.CoveredLine)
	}
}
