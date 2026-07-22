package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// TestResolveTestCoversHaikuFoundFoldsLeadingPHPDoc: an LLM-found covered
// method whose definition carries a leading PHPDoc gets the same
// @return/@param signature fold applied to its embedded CoveredCode (via
// resolveTestCoversWithModel -> enrichedCodeSide) that an active (changed)
// block's diff gets via /api/code — see codesig.go and
// .claude/rules/blocks-and-ingest.md ("PHPDoc-types in de signatuur vouwen").
// CoveredLine must shift by the same removed-line count.
func TestResolveTestCoversHaikuFoundFoldsLeadingPHPDoc(t *testing.T) {
	dataDir := t.TempDir()
	pr := 38
	_, headDir := worktreeDirs(dataDir, pr)
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
	list, err := tc.List(context.Background(), pr)
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
	list, err := tc.List(context.Background(), pr)
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
