package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// TestResolveTestCoversHaikuFoundFoldsLeadingPHPDoc: an LLM-found covered
// method whose definition carries a leading PHPDoc gets the same
// @return/@param signature fold applied to its embedded CoveredCode (via
// resolveTestCoversWithModel -> enrichedCodeSide) that an active (changed)
// block's diff gets via /api/code — see codesig.go and
// .claude/docs/blocks-and-ingest.md ("PHPDoc-types in de signatuur vouwen").
// CoveredLine must shift by the same removed-line count.
func TestResolveTestCoversHaikuFoundFoldsLeadingPHPDoc(t *testing.T) {
	dataDir := t.TempDir()
	pr := 38
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
    #[CoversClass(Order::class)]
    public function testCoversClassOnly(): void
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
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"method":"billingAddress","confidence":"high"}`)
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	if _, err := m.StartResolveTestCovers(testCoverInput(pr, "Order")); err != nil {
		t.Fatal(err)
	}

	e := onlyTestCoverEntry(t, tc, pr)
	if e.Status != testcovers.StatusFound {
		t.Fatalf("entry = %+v, want found", e)
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
	list, err := tc.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("testcovers has %d rows, want 1: %+v", len(list), list)
	}
	return list[0]
}

// testBlockID builds a block-id-shaped test_id ("<pr>:<file>:<class>::<name>")
// — the same "<pr>:<file>:" prefix reuseSiblingCovers scopes reuse to.
func testBlockID(pr int, file, class, name string) string {
	return fmt.Sprintf("%d:%s:%s::%s", pr, file, class, name)
}

// findTestCoverEntry returns the single testcovers row for testID, failing if
// it's missing (unlike onlyTestCoverEntry, which requires the whole PR to
// have exactly one row — these sibling-reuse tests deliberately seed more
// than one).
func findTestCoverEntry(t *testing.T, tc *testcovers.Module, pr int, testID string) testcovers.Entry {
	t.Helper()
	list, err := tc.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range list {
		if e.TestID == testID {
			return e
		}
	}
	t.Fatalf("no testcovers row for test_id %q in %+v", testID, list)
	return testcovers.Entry{}
}

// (a) A sibling test in the SAME file that already resolved a class-level-
// only annotation (status found, from an earlier LLM run) is reused verbatim
// for another test naming the same class — no Haiku call at all.
func TestResolveTestCoversReusesFoundSibling(t *testing.T) {
	dataDir := t.TempDir()
	pr := 35
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake() // no programmed output — a call would degrade to notfound
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	file := "tests/Feature/OrderCoverageTest.php"
	siblingID := testBlockID(pr, file, "OrderCoverageTest", "testSibling")
	if err := tc.Save(context.Background(), testcovers.Entry{
		PR: pr, TestID: siblingID, TargetKey: "class:Order",
		Status: testcovers.StatusFound, Annotation: "CoversClass",
		CoveredClass: "Order", CoveredMethod: "billingAddress", CoveredFile: "app/Models/Order.php",
		CoveredCode: "public function billingAddress() {}",
		Model:       testcovers.ModelHaiku, Confidence: "high",
	}); err != nil {
		t.Fatal(err)
	}

	in := testCoverInput(pr, "Order")
	in.TestFile = file
	in.TestID = testBlockID(pr, file, "OrderCoverageTest", "testCoversClassOnly")
	if _, err := m.StartResolveTestCovers(in); err != nil {
		t.Fatal(err)
	}

	e := findTestCoverEntry(t, tc, pr, in.TestID)
	if e.Status != testcovers.StatusFound || e.CoveredMethod != "billingAddress" || e.Model != testcovers.ModelHaiku {
		t.Fatalf("entry = %+v, want reused found sibling", e)
	}
	if n := fake.CallCount(); n != 0 {
		t.Fatalf("claude called %d times, want 0 (reused sibling)", n)
	}
}

// (b) A sibling with the same status/class but in a DIFFERENT test file must
// NOT be reused — Haiku still runs and its own answer wins.
func TestResolveTestCoversNoReuseAcrossFiles(t *testing.T) {
	dataDir := t.TempDir()
	pr := 36
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake()
	fake.SetOutput(claude.ModelHaiku, `{"found":true,"method":"billingAddress","confidence":"high"}`)
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	otherFile := "tests/Feature/OtherCoverageTest.php"
	siblingID := testBlockID(pr, otherFile, "OtherCoverageTest", "testSibling")
	if err := tc.Save(context.Background(), testcovers.Entry{
		PR: pr, TestID: siblingID, TargetKey: "class:Order",
		Status: testcovers.StatusFound, Annotation: "CoversClass",
		CoveredClass: "Order", CoveredMethod: "shippingAddress",
		Model: testcovers.ModelHaiku, Confidence: "high",
	}); err != nil {
		t.Fatal(err)
	}

	in := testCoverInput(pr, "Order")
	in.TestID = testBlockID(pr, in.TestFile, in.TestClass, "testCoversClassOnly")
	if _, err := m.StartResolveTestCovers(in); err != nil {
		t.Fatal(err)
	}

	e := findTestCoverEntry(t, tc, pr, in.TestID)
	if e.Status != testcovers.StatusFound || e.CoveredMethod != "billingAddress" {
		t.Fatalf("entry = %+v, want haiku's own answer (billingAddress), not the other-file sibling", e)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (a sibling in a different file must not be reused)", n)
	}
}

// (c) A sibling with status "resolved" (a method-level annotation, verified
// statically — no LLM involved) is reused just like a "found" sibling.
func TestResolveTestCoversReusesResolvedSibling(t *testing.T) {
	dataDir := t.TempDir()
	pr := 37
	writeTestCoversFixtureRepo(t, dataDir, pr)
	fake := claude.NewFake() // no programmed output — a call would degrade to notfound
	m, tc := resolveTestCoversManager(t, dataDir, fake)

	file := "tests/Feature/OrderCoverageTest.php"
	siblingID := testBlockID(pr, file, "OrderCoverageTest", "testExplicitCovers")
	if err := tc.Save(context.Background(), testcovers.Entry{
		PR: pr, TestID: siblingID, TargetKey: "method:Order::billingAddress",
		Status: testcovers.StatusResolved, Annotation: "@covers",
		CoveredClass: "Order", CoveredMethod: "billingAddress", CoveredFile: "app/Models/Order.php",
		CoveredCode: "public function billingAddress() {}",
	}); err != nil {
		t.Fatal(err)
	}

	in := testCoverInput(pr, "Order")
	in.TestFile = file
	in.TestID = testBlockID(pr, file, "OrderCoverageTest", "testCoversClassOnly")
	if _, err := m.StartResolveTestCovers(in); err != nil {
		t.Fatal(err)
	}

	e := findTestCoverEntry(t, tc, pr, in.TestID)
	if e.Status != testcovers.StatusResolved || e.CoveredMethod != "billingAddress" {
		t.Fatalf("entry = %+v, want reused resolved sibling", e)
	}
	if n := fake.CallCount(); n != 0 {
		t.Fatalf("claude called %d times, want 0 (reused resolved sibling)", n)
	}
}

// --- groupUnresolvedTestCovers (pure, no engine/goroutine) ---

// One start per test: a resolved/unannotated entry is excluded (not
// Unresolved), a test whose block isn't in blocks is skipped, and a class
// already submitted to a resolve_test_covers Execution before (via attempted
// — a durable, ever-tried set, see resolveTestCoversAttempted) is skipped too
// — a rebuild must never resubmit a class the LLM already attempted. Mirrors
// TestGroupUnresolvedCalls.
func TestGroupUnresolvedTestCovers(t *testing.T) {
	testA := Block{PR: 1, File: "tests/Feature/ATest.php", Class: "ATest", Name: "testA"}
	testB := Block{PR: 1, File: "tests/Feature/BTest.php", Class: "BTest", Name: "testB"}
	blocks := []Block{testA, testB}

	covers := []testcovers.Entry{
		{PR: 1, TestID: testA.ID(), TargetKey: "class:Y", CoveredClass: "Y", Status: testcovers.StatusUnresolved},
		{PR: 1, TestID: testA.ID(), TargetKey: "class:X", CoveredClass: "X", Status: testcovers.StatusUnresolved},
		{PR: 1, TestID: testA.ID(), TargetKey: "method:Z::m", CoveredClass: "Z", Status: testcovers.StatusResolved}, // resolved: excluded
		{PR: 1, TestID: testB.ID(), TargetKey: "class:W", CoveredClass: "W", Status: testcovers.StatusUnresolved},
		// No block for this test id — must be skipped defensively.
		{PR: 1, TestID: "1:tests/Ghost.php:GhostTest::boo", TargetKey: "class:V", CoveredClass: "V", Status: testcovers.StatusUnresolved},
	}
	attempted := map[string]bool{
		testB.ID() + "\x1f" + "W": true, // already tried before — skip
	}

	got := groupUnresolvedTestCovers(1, covers, attempted, blocks)
	if len(got) != 1 {
		t.Fatalf("groupUnresolvedTestCovers returned %d group(s), want 1: %+v", len(got), got)
	}
	g := got[0]
	if g.TestID != testA.ID() || g.TestFile != testA.File || g.TestClass != testA.Class || g.TestName != testA.Name {
		t.Fatalf("group test fields = %+v, want test A's fields", g)
	}
	if len(g.Classes) != 2 || g.Classes[0] != "X" || g.Classes[1] != "Y" {
		t.Fatalf("group.Classes = %v, want sorted [X Y]", g.Classes)
	}
}

// A class that was never attempted before (absent from attempted) stays
// eligible, even if it's the only one for its test.
func TestGroupUnresolvedTestCoversKeepsNeverAttemptedClass(t *testing.T) {
	test := Block{PR: 1, File: "tests/Feature/ATest.php", Class: "ATest", Name: "testA"}
	covers := []testcovers.Entry{
		{PR: 1, TestID: test.ID(), TargetKey: "class:X", CoveredClass: "X", Status: testcovers.StatusUnresolved},
	}

	got := groupUnresolvedTestCovers(1, covers, map[string]bool{}, []Block{test})
	if len(got) != 1 || len(got[0].Classes) != 1 || got[0].Classes[0] != "X" {
		t.Fatalf("groupUnresolvedTestCovers = %+v, want one group with class X", got)
	}
}

// resolveTestCoversRunID: sorting Classes makes the ID independent of build
// order, while a genuinely different Classes set yields a fresh ID.
func TestResolveTestCoversRunIDStableAndSensitive(t *testing.T) {
	a := ResolveTestCoversInput{PR: 1, TestID: "t", Classes: []string{"A", "B"}}
	b := ResolveTestCoversInput{PR: 1, TestID: "t", Classes: []string{"B", "A"}}
	if resolveTestCoversRunID(a) != resolveTestCoversRunID(b) {
		t.Fatalf("resolveTestCoversRunID depends on Classes order: %s != %s", resolveTestCoversRunID(a), resolveTestCoversRunID(b))
	}
	c := ResolveTestCoversInput{PR: 1, TestID: "t", Classes: []string{"A", "B", "New"}}
	if resolveTestCoversRunID(a) == resolveTestCoversRunID(c) {
		t.Fatal("resolveTestCoversRunID does not change for a different Classes set")
	}
}

// --- The automatic server-side trigger, end to end via buildRelations ---

// autoResolveTestCoversManager wires a TaskManager with a real DB (so
// blocksByPR works inside the buildRelations Activity), a testcovers module,
// and a claude Fake — everything the automatic resolve_test_covers trigger
// needs. Mirrors autoResolveCallManager.
func autoResolveTestCoversManager(t *testing.T, dataDir string, fake *claude.Fake) (*TaskManager, *sql.DB, *testcovers.Module) {
	t.Helper()
	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	tc, err := testcovers.Open(filepath.Join(dataDir, "testcovers.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tc.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, tc, nil, nil, fake, nil, db, dataDir, "test/repo")
	return m, db, tc
}

// (a) EnsureRelations (the buildRelations Activity) starts a search for a
// Go-unresolved class-level-only coverage annotation automatically, without
// the frontend ever calling POST /api/workflows/resolve_test_covers. (b) A
// rebuild with nothing changed never re-spends an LLM call — even though the
// search ended in "notfound" and UpsertGo resets a notfound row back to
// "unresolved" on that very rebuild; resolveTestCoversAttempted's durable,
// history-based set (not the testcovers read-model's own fluctuating status)
// is what prevents the resubmit. Mirrors TestAutoStartResolveCallOnBuildRelations.
//
// writeTestCoversFixtureRepo's OrderCoverageTest::testCoversClassOnly is the
// only method with a class-level-only annotation (#[CoversClass(Order::class)],
// no method named). Only THIS block is stored as a PR block (unlike the other
// tests above, which store the whole file) — the other methods in that fixture
// carry an already-RESOLVED annotation for the very same class ("Order"), and
// reuseSiblingCovers (see resolve_test_covers.go) would otherwise reuse one of
// those instead of ever asking the LLM, making the auto-search trigger itself
// unobservable here. So exactly one resolve_test_covers Execution, for exactly
// one class, is expected.
func TestAutoStartResolveTestCoversOnBuildRelations(t *testing.T) {
	dataDir := t.TempDir()
	pr := 211
	writeTestCoversFixtureRepo(t, dataDir, pr)
	var testBlock Block
	for _, b := range testCoversBlocks(t, dataDir, pr, "tests/Feature/OrderCoverageTest.php") {
		if b.Name == "testCoversClassOnly" {
			testBlock = b
		}
	}
	if testBlock.Name == "" {
		t.Fatal("no testCoversClassOnly block found, fixture is stale")
	}
	blocks := []Block{testBlock}

	fake := claude.NewFake() // no programmed output → every search ends in "notfound"
	m, db, tc := autoResolveTestCoversManager(t, dataDir, fake)
	if err := replacePRBlocks(db, "", pr, blocks); err != nil {
		t.Fatal(err)
	}
	testID := testBlock.ID()

	ctx := context.Background()
	m.EnsureRelations(ctx, "", pr) // must return without waiting for the auto-search

	waitFor(t, func() bool {
		e, ok := findCoverEntry(mustTestCoversList(t, tc, pr), testID, "class:Order")
		return ok && e.Status == testcovers.StatusNotfound
	})
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d time(s) after the first build, want 1 (Order)", n)
	}

	// Rebuild with nothing changed: the Go rescan still emits the same
	// unresolved class-level-only target and UpsertGo resets the notfound row
	// back to unresolved — but the auto-trigger must not search it again.
	m.EnsureRelations(ctx, "", pr)
	// Nothing SHOULD happen here (already attempted), so there is no positive
	// condition to poll for — give any (wrongly re-triggered) background
	// search a moment to run before asserting the count didn't grow.
	time.Sleep(50 * time.Millisecond)
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d time(s) after a no-op rebuild, want still 1 (no duplicate search)", n)
	}
}

// mustTestCoversList mirrors mustCallresolveList.
func mustTestCoversList(t *testing.T, tc *testcovers.Module, pr int) []testcovers.Entry {
	t.Helper()
	list, err := tc.List(context.Background(), "", pr)
	if err != nil {
		t.Fatal(err)
	}
	return list
}
