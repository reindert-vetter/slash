package main

import "testing"

// symbols returns the block symbols (Class::method or name) for easy asserts.
func symbols(bs []Block) []string {
	out := make([]string, len(bs))
	for i, b := range bs {
		out[i] = b.symbol()
	}
	return out
}

func hasSymbol(bs []Block, sym string) bool {
	for _, b := range bs {
		if b.symbol() == sym {
			return true
		}
	}
	return false
}

func TestScanSimpleClassMethods(t *testing.T) {
	src := `<?php
class Foo {
    public function bar() {
        return 1;
    }
    private function baz(int $x): string {
        return (string) $x;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Foo.php")
	if !hasSymbol(got, "Foo::bar") || !hasSymbol(got, "Foo::baz") {
		t.Fatalf("expected Foo::bar and Foo::baz, got %v", symbols(got))
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 blocks, got %d: %v", len(got), symbols(got))
	}
}

func TestClosureInsideMethodIsNotABlock(t *testing.T) {
	src := `<?php
class Svc {
    public function run() {
        $f = function () use ($x) { return $x + 1; };
        $g = fn ($y) => $y * 2;
        return $f(1);
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/Svc.php")
	if len(got) != 1 || got[0].symbol() != "Svc::run" {
		t.Fatalf("closures/arrow-fn must not spawn blocks; got %v", symbols(got))
	}
	// The method body must span past the closure's closing brace.
	if got[0].EndLine <= got[0].Line {
		t.Fatalf("body span looks wrong: line=%d end=%d", got[0].Line, got[0].EndLine)
	}
}

func TestAnonymousMigrationClass(t *testing.T) {
	src := `<?php
use Illuminate\Database\Migrations\Migration;
return new class extends Migration {
    public function up(): void {
        Schema::table('addresses', function ($t) { $t->string('type'); });
    }
    public function down(): void {
        //
    }
};
`
	got := ScanBlocks([]byte(src), "database/migrations/2026_add_type.php")
	// up/down should be recognized as methods (empty class => bare names).
	if !hasSymbol(got, "up") || !hasSymbol(got, "down") {
		t.Fatalf("expected up and down methods, got %v", symbols(got))
	}
}

func TestHeredocWithBracesIgnored(t *testing.T) {
	src := "<?php\nclass H {\n    public function tpl() {\n        $s = <<<SQL\n        SELECT * FROM t WHERE j = '{\"a\":1}' -- } not a brace\n        SQL;\n        return $s;\n    }\n}\n"
	got := ScanBlocks([]byte(src), "app/H.php")
	if len(got) != 1 || got[0].symbol() != "H::tpl" {
		t.Fatalf("heredoc braces must be ignored; got %v", symbols(got))
	}
}

func TestAttributeVsComment(t *testing.T) {
	src := `<?php
class C {
    #[Route('/x')]
    public function handle() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Http/Controllers/C.php")
	if !hasSymbol(got, "C::handle") {
		t.Fatalf("#[...] attribute must not swallow the method; got %v", symbols(got))
	}
}

// blockByName returns the block whose symbol matches sym, for Line/EndLine
// assertions (hasSymbol only checks presence).
func blockByName(bs []Block, sym string) (Block, bool) {
	for _, b := range bs {
		if b.symbol() == sym {
			return b, true
		}
	}
	return Block{}, false
}

// TestLeadingAttributeIncludedInBlock: a method's leading #[...] attribute is
// part of its block — Block.Line starts at the attribute line, not the
// `function` keyword's own line (see .claude/docs/blocks-and-ingest.md,
// "Leidende attributen").
func TestLeadingAttributeIncludedInBlock(t *testing.T) {
	src := `<?php
class C {
    #[Route('/x')]
    public function handle() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Http/Controllers/C.php")
	b, ok := blockByName(got, "C::handle")
	if !ok {
		t.Fatalf("expected C::handle, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the attribute line), got %d", b.Line)
	}
}

// TestMultilineLeadingAttributeIncludedInBlock: an attribute whose arguments
// span several lines (e.g. #[DataProvider('name')] wrapped) still pulls the
// block's Line back to its OPENING line, and the body span is unaffected.
func TestMultilineLeadingAttributeIncludedInBlock(t *testing.T) {
	src := `<?php
class PermissionTest {
    #[DataProvider(
        'permissionAccessDataProvider'
    )]
    public function testPermissionAccess($perm) {
        return true;
    }

    public function permissionAccessDataProvider(): array {
        return [];
    }
}
`
	got := ScanBlocks([]byte(src), "tests/Feature/PermissionTest.php")
	b, ok := blockByName(got, "PermissionTest::testPermissionAccess")
	if !ok {
		t.Fatalf("expected testPermissionAccess, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the attribute's opening line), got %d", b.Line)
	}
	if b.EndLine <= b.Line {
		t.Fatalf("body span looks wrong: line=%d end=%d", b.Line, b.EndLine)
	}
	if !hasSymbol(got, "PermissionTest::permissionAccessDataProvider") {
		t.Fatalf("expected the provider method as its own block too, got %v", symbols(got))
	}
}

// TestStackedAttributesUseFirstLine: several attributes stacked above one
// method (a common PHPUnit combination, #[Test] + #[DataProvider(...)]) pull
// the block's Line back to the FIRST attribute, not the last.
func TestStackedAttributesUseFirstLine(t *testing.T) {
	src := `<?php
class PermissionTest {
    #[Test]
    #[DataProvider('permissionAccessDataProvider')]
    public function testPermissionAccess($perm) {
        return true;
    }
}
`
	got := ScanBlocks([]byte(src), "tests/Feature/PermissionTest.php")
	b, ok := blockByName(got, "PermissionTest::testPermissionAccess")
	if !ok {
		t.Fatalf("expected testPermissionAccess, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the FIRST attribute's line), got %d", b.Line)
	}
}

// TestPropertyAttributeNotLeakedToNextMethod: an attribute on a preceding
// property must not leak into the following, unrelated method's Line — the
// property's own type-hint/variable tokens between the attribute and the `;`
// reset the pending-attribute tracking (see scanPHP's pendingAttrLine).
func TestPropertyAttributeNotLeakedToNextMethod(t *testing.T) {
	src := `<?php
class Svc {
    #[Deprecated]
    private string $legacy;

    public function run() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/Svc.php")
	b, ok := blockByName(got, "Svc::run")
	if !ok {
		t.Fatalf("expected Svc::run, got %v", symbols(got))
	}
	if b.Line != 6 {
		t.Fatalf("expected Block.Line=6 (own declaration, not the property's attribute), got %d", b.Line)
	}
}

// TestPHPDocPullsBlockLineLikeAttribute: a PHPDoc directly above a method —
// even one with no extractable free-text description, just @param/@return
// tags — pulls Block.Line back to its own opening line, mirroring how a
// leading #[...] attribute already does (see TestLeadingAttributeIncludedInBlock).
func TestPHPDocPullsBlockLineLikeAttribute(t *testing.T) {
	src := `<?php
class OrderService {
    /**
     * @param string $customerId
     * @return Order
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
	if b.Description != "" {
		t.Fatalf("expected no description (only @tag lines), got %q", b.Description)
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the PHPDoc's opening line), got %d", b.Line)
	}
}

// TestPHPDocAndAttributeBothPullBlockLine: when a PHPDoc AND a leading
// attribute both sit above a method, Block.Line adopts whichever of the two
// starts EARLIEST — regardless of which order they appear in (PHPDoc above
// the attribute here; TestPHPDocDescriptionSurvivesLeadingAttribute covers
// the same order with a real description, this one covers attribute-above-
// doc too).
func TestPHPDocAndAttributeBothPullBlockLine(t *testing.T) {
	docAboveAttr := `<?php
class PermissionTest {
    /**
     * @return void
     */
    #[Test]
    public function testDenied() {
        return true;
    }
}
`
	got := ScanBlocks([]byte(docAboveAttr), "tests/Feature/PermissionTest.php")
	b, ok := blockByName(got, "PermissionTest::testDenied")
	if !ok {
		t.Fatalf("expected testDenied, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("doc-above-attribute: expected Block.Line=3 (the doc's line), got %d", b.Line)
	}

	attrAboveDoc := `<?php
class PermissionTest {
    #[Test]
    /**
     * @return void
     */
    public function testDenied() {
        return true;
    }
}
`
	got = ScanBlocks([]byte(attrAboveDoc), "tests/Feature/PermissionTest.php")
	b, ok = blockByName(got, "PermissionTest::testDenied")
	if !ok {
		t.Fatalf("expected testDenied, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("attribute-above-doc: expected Block.Line=3 (the attribute's line), got %d", b.Line)
	}
}

func TestAbstractAndInterfaceMethods(t *testing.T) {
	src := `<?php
interface Repo {
    public function find(int $id): ?Model;
    public function all(): array;
}
`
	got := ScanBlocks([]byte(src), "app/Repository/Repo.php")
	if !hasSymbol(got, "Repo::find") || !hasSymbol(got, "Repo::all") {
		t.Fatalf("interface methods should be blocks; got %v", symbols(got))
	}
}

// TestInterfaceMethodWithLeadingDocSpansFullSignature: a body-less (`;`
// terminated) interface method whose Block.Line was pulled back to a leading
// PHPDoc must still get an EndLine that spans all the way to the actual
// signature line (where the `;` sits) — NOT collapse to the PHPDoc's own
// opening line. Regression test for the bug where such a block rendered as
// literally just "/**" (see .claude/docs/blocks-and-ingest.md, "PHPDoc
// description as block description").
func TestInterfaceMethodWithLeadingDocSpansFullSignature(t *testing.T) {
	src := `<?php
interface WebhookResourceDriverInterface {
    /**
     * Map raw include strings to this driver's own include enum cases.
     *
     * @param array $includes
     * @return array
     */
    public function toIncludes(array $includes): array;
}
`
	got := ScanBlocks([]byte(src), "packages/plugandpay/Contracts/WebhookResourceDriverInterface.php")
	b, ok := blockByName(got, "WebhookResourceDriverInterface::toIncludes")
	if !ok {
		t.Fatalf("expected toIncludes, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the PHPDoc's opening line), got %d", b.Line)
	}
	const sigLine = 9 // "    public function toIncludes(array $includes): array;"
	if b.EndLine != sigLine {
		t.Fatalf("expected Block.EndLine=%d (the signature/';' line), got %d — the block must not collapse to just the PHPDoc's opening line", sigLine, b.EndLine)
	}
	if b.EndLine <= b.Line {
		t.Fatalf("body span looks wrong: line=%d end=%d", b.Line, b.EndLine)
	}
}

// TestInterfaceMethodMultilineSignatureEndLine: even WITHOUT a leading
// PHPDoc/attribute, a body-less method whose own signature spans multiple
// lines (a wrapped parameter list) must get an EndLine on the line the `;`
// itself sits on — not on declLine (the `function` keyword's own line). This
// is the same underlying scanFunction fix, isolated from the PHPDoc case.
func TestInterfaceMethodMultilineSignatureEndLine(t *testing.T) {
	src := `<?php
interface Repo {
    public function find(
        int $id,
        array $options
    ): ?Model;
}
`
	got := ScanBlocks([]byte(src), "app/Repository/Repo.php")
	b, ok := blockByName(got, "Repo::find")
	if !ok {
		t.Fatalf("expected Repo::find, got %v", symbols(got))
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the function keyword's line), got %d", b.Line)
	}
	const sigLine = 6 // "    ): ?Model;"
	if b.EndLine != sigLine {
		t.Fatalf("expected Block.EndLine=%d (the line the ';' sits on), got %d", sigLine, b.EndLine)
	}
}

func TestFreeFunction(t *testing.T) {
	src := `<?php
function helper($a) {
    return $a;
}
`
	got := ScanBlocks([]byte(src), "app/helpers.php")
	if !hasSymbol(got, "helper") {
		t.Fatalf("free function expected; got %v", symbols(got))
	}
	if got[0].Class != "" {
		t.Fatalf("free function should have empty class, got %q", got[0].Class)
	}
}

func TestNonPHPWholeFileFallback(t *testing.T) {
	src := "openapi: 3.0.0\npaths:\n  /x: {}\n"
	got := ScanBlocks([]byte(src), "docs/api.yaml")
	if len(got) != 1 || got[0].Name != "api.yaml" {
		t.Fatalf("yaml should be one whole-file block, got %v", symbols(got))
	}
}

func TestImbalanceFallsBack(t *testing.T) {
	// Unterminated string → scanner reports imbalance → whole-file fallback.
	src := "<?php\nclass Broken {\n    public function x() {\n        $s = 'never closed\n    }\n}\n"
	got := ScanBlocks([]byte(src), "app/Broken.php")
	if len(got) != 1 || got[0].Name != "Broken.php" {
		t.Fatalf("expected whole-file fallback on imbalance, got %v", symbols(got))
	}
}

func TestClassHeaderBlockWithMethod(t *testing.T) {
	src := `<?php
final class ProductGroup extends Model
{
    use HasFactory;

    protected $fillable = [
        'name',
    ];

    public function __construct()
    {
        parent::__construct();
    }

    public function items()
    {
        return $this->hasMany(Item::class);
    }
}
`
	got := ScanBlocks([]byte(src), "app/Models/ProductGroup.php")
	if !hasSymbol(got, "ProductGroup::<class-header>") {
		t.Fatalf("expected a class-header block, got %v", symbols(got))
	}
	if !hasSymbol(got, "ProductGroup::__construct") || !hasSymbol(got, "ProductGroup::items") {
		t.Fatalf("expected the methods to still be their own blocks, got %v", symbols(got))
	}
	// 4, not 3: $fillable is a block of its own (splitClassHeaderMembers), and
	// the header keeps only what sits above it — the `use HasFactory;` line.
	if len(got) != 4 {
		t.Fatalf("expected exactly 4 blocks, got %d: %v", len(got), symbols(got))
	}
	header := blockBySymbol(t, got, "ProductGroup::<class-header>")
	fillable := blockBySymbol(t, got, "ProductGroup::$fillable")
	// Body opens on line 3 ("{"); header content starts line 4
	// ("use HasFactory;") and now ends just before $fillable's own block.
	if header.Line != 4 || header.EndLine != fillable.Line-1 {
		t.Fatalf("expected header Line=4 EndLine=%d, got Line=%d EndLine=%d", fillable.Line-1, header.Line, header.EndLine)
	}
	// $fillable spans its declaration up to and including the `];` line, and
	// stops well before the constructor.
	ctor := blockBySymbol(t, got, "ProductGroup::__construct")
	if fillable.Line != 6 || fillable.EndLine != 8 {
		t.Fatalf("expected $fillable Line=6 EndLine=8, got Line=%d EndLine=%d", fillable.Line, fillable.EndLine)
	}
	if fillable.EndLine >= ctor.Line {
		t.Fatalf("$fillable (EndLine=%d) must end before the ctor (Line=%d)", fillable.EndLine, ctor.Line)
	}
}

// blockBySymbol returns the one block with that symbol, failing the test when
// it is absent.
func blockBySymbol(t *testing.T, blocks []Block, symbol string) Block {
	t.Helper()
	for _, b := range blocks {
		if b.symbol() == symbol {
			return b
		}
	}
	t.Fatalf("no %s block, got %v", symbol, symbols(blocks))
	return Block{}
}

func TestClassHeaderBlockWithoutAnyMethod(t *testing.T) {
	src := `<?php
class Config
{
    use SomeTrait;

    const VERSION = 1;
}
`
	got := ScanBlocks([]byte(src), "app/Models/Config.php")
	// The class never gets a method, so the header region is the whole body —
	// but VERSION is split out of it into its own block, leaving the header
	// with just the `use SomeTrait;` line above it.
	if len(got) != 2 {
		t.Fatalf("expected the header plus the VERSION block, got %v", symbols(got))
	}
	header := blockBySymbol(t, got, "Config::<class-header>")
	version := blockBySymbol(t, got, "Config::VERSION")
	// Body opens line 3; the last content line is line 6 (the closing brace is
	// line 7). VERSION owns line 6, the header the `use` on line 4.
	if header.Line != 4 || header.EndLine != 5 {
		t.Fatalf("expected header Line=4 EndLine=5, got Line=%d EndLine=%d", header.Line, header.EndLine)
	}
	if version.Line != 6 || version.EndLine != 6 {
		t.Fatalf("expected VERSION Line=6 EndLine=6, got Line=%d EndLine=%d", version.Line, version.EndLine)
	}
}

// TestClassHeaderMembersSplitOut pins splitClassHeaderMembers on the shape the
// feature exists for: a class whose header holds NOTHING but constants — no
// residual header block at all — with a leading PHPDoc becoming the member
// block's Description and a leading attribute run pulled into its code.
func TestClassHeaderMembersSplitOut(t *testing.T) {
	src := `<?php
final class ActivityV2WriteTest extends TestCase
{
    /**
     * The tenant every row in this test belongs to.
     */
    #[Deprecated]
    private const int TENANT_ID = 42;

    private const string SESSION_ID = 'session-abc';

    public function it_writes(): void
    {
    }
}
`
	got := ScanBlocks([]byte(src), "modules/Statistics/Tests/ActivityV2WriteTest.php")
	if hasSymbol(got, "ActivityV2WriteTest::<class-header>") {
		t.Fatalf("a header of nothing but members must leave no header block, got %v", symbols(got))
	}
	tenant := blockBySymbol(t, got, "ActivityV2WriteTest::TENANT_ID")
	session := blockBySymbol(t, got, "ActivityV2WriteTest::SESSION_ID")
	blockBySymbol(t, got, "ActivityV2WriteTest::it_writes")

	// TENANT_ID's block starts at its PHPDoc (line 4), not at the `const` on
	// line 8, so both the doc and the #[Deprecated] attribute show as code in
	// its own diff.
	if tenant.Line != 4 || tenant.EndLine != 8 {
		t.Fatalf("expected TENANT_ID Line=4 EndLine=8, got Line=%d EndLine=%d", tenant.Line, tenant.EndLine)
	}
	if tenant.Description != "The tenant every row in this test belongs to." {
		t.Fatalf("expected the PHPDoc as the block description, got %q", tenant.Description)
	}
	// The second constant has neither, so it starts at its own declaration and
	// inherits nothing from its predecessor.
	if session.Line != 10 || session.EndLine != 10 {
		t.Fatalf("expected SESSION_ID Line=10 EndLine=10, got Line=%d EndLine=%d", session.Line, session.EndLine)
	}
	if session.Description != "" {
		t.Fatalf("expected no description on SESSION_ID, got %q", session.Description)
	}
	// No overlap: nothing is counted, or approved, twice.
	if tenant.EndLine >= session.Line {
		t.Fatalf("member blocks overlap: TENANT_ID ends %d, SESSION_ID starts %d", tenant.EndLine, session.Line)
	}
}

func TestClassHeaderBlockPerClassInSameFile(t *testing.T) {
	src := `<?php
class A
{
    use TraitA;

    public function foo()
    {
        return 1;
    }
}

class B
{
    use TraitB;

    public function bar()
    {
        return 2;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Multi.php")
	if !hasSymbol(got, "A::<class-header>") || !hasSymbol(got, "B::<class-header>") {
		t.Fatalf("expected a class-header block per class, got %v", symbols(got))
	}
	if !hasSymbol(got, "A::foo") || !hasSymbol(got, "B::bar") {
		t.Fatalf("expected both methods, got %v", symbols(got))
	}
}

func TestNoClassHeaderBlockWhenBodyEmptyOrNoRoom(t *testing.T) {
	// The constructor is the very first thing after the opening brace — there
	// is no header content, so no class-header block should be emitted.
	src := `<?php
class Bare
{
    public function __construct()
    {
    }
}
`
	got := ScanBlocks([]byte(src), "app/Bare.php")
	if hasSymbol(got, "Bare::<class-header>") {
		t.Fatalf("did not expect a class-header block, got %v", symbols(got))
	}
	if !hasSymbol(got, "Bare::__construct") {
		t.Fatalf("expected the constructor block, got %v", symbols(got))
	}
}

func TestInterfaceHasNoClassHeaderBlock(t *testing.T) {
	src := `<?php
interface Repo {
    public function find(int $id): ?Model;
    public function all(): array;
}
`
	got := ScanBlocks([]byte(src), "app/Repository/Repo.php")
	if hasSymbol(got, "Repo::<class-header>") {
		t.Fatalf("interfaces must not get a class-header block, got %v", symbols(got))
	}
}

func TestAnonymousClassHasNoClassHeaderBlock(t *testing.T) {
	src := `<?php
use Illuminate\Database\Migrations\Migration;
return new class extends Migration {
    protected $x = 1;
    public function up(): void {
        Schema::table('addresses', function ($t) { $t->string('type'); });
    }
    public function down(): void {
        //
    }
};
`
	got := ScanBlocks([]byte(src), "database/migrations/2026_add_type.php")
	for _, b := range got {
		if b.Name == classHeaderSentinel {
			t.Fatalf("anonymous class must not get a class-header block, got %v", symbols(got))
		}
	}
}

func TestStringWithBracesAndKeywords(t *testing.T) {
	src := `<?php
class S {
    public function f() {
        $a = "function nope() { this is a string }";
        $b = '} also fake';
        return $a . $b;
    }
}
`
	got := ScanBlocks([]byte(src), "app/S.php")
	if len(got) != 1 || got[0].symbol() != "S::f" {
		t.Fatalf("keywords/braces inside strings must be ignored; got %v", symbols(got))
	}
}

// TestPHPDocDescriptionCapturedForMethod: a PHPDoc directly above a method is
// extracted as Block.Description, with @tag lines stripped and the prose
// lines joined into one paragraph.
func TestPHPDocDescriptionCapturedForMethod(t *testing.T) {
	src := `<?php
class OrderService {
    /**
     * Creates an order for the given customer.
     *
     * @param string $customerId
     * @return Order
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
	want := "Creates an order for the given customer."
	if b.Description != want {
		t.Fatalf("Description = %q, want %q", b.Description, want)
	}
}

// TestPHPDocDescriptionSurvivesLeadingAttribute: a PHPDoc above a leading
// #[...] attribute run must still be adopted by the function — the doc's own
// line wins as Block.Line (it sits above the attribute here, and both are now
// folded into the block's own span — see TestPHPDocPullsBlockLineLikeAttribute)
// and the attribute must not swallow or reset the doc's pending description.
func TestPHPDocDescriptionSurvivesLeadingAttribute(t *testing.T) {
	src := `<?php
class PermissionTest {
    /**
     * Verifies a user without the permission is rejected.
     */
    #[Test]
    public function testPermissionDenied() {
        return true;
    }
}
`
	got := ScanBlocks([]byte(src), "tests/Feature/PermissionTest.php")
	b, ok := blockByName(got, "PermissionTest::testPermissionDenied")
	if !ok {
		t.Fatalf("expected testPermissionDenied, got %v", symbols(got))
	}
	want := "Verifies a user without the permission is rejected."
	if b.Description != want {
		t.Fatalf("Description = %q, want %q", b.Description, want)
	}
	if b.Line != 3 {
		t.Fatalf("expected Block.Line=3 (the PHPDoc's own opening line, now pulled in like a leading attribute), got %d", b.Line)
	}
}

// TestPHPDocDescriptionNotLeakedAcrossProperty: a PHPDoc above a property
// declaration (terminated by `;`) must not leak into a later, unrelated
// method's description.
func TestPHPDocDescriptionNotLeakedAcrossProperty(t *testing.T) {
	src := `<?php
class Svc {
    /**
     * The legacy client, kept for backwards compatibility.
     */
    private $legacy;

    public function run() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/Svc.php")
	b, ok := blockByName(got, "Svc::run")
	if !ok {
		t.Fatalf("expected Svc::run, got %v", symbols(got))
	}
	if b.Description != "" {
		t.Fatalf("expected no description (property's doc must not leak), got %q", b.Description)
	}
}

// TestPlainBlockCommentIsNotADescription: a plain /* ... */ comment (a single
// asterisk at open, not PHPDoc's `/**`) must never be used as a description.
func TestPlainBlockCommentIsNotADescription(t *testing.T) {
	src := `<?php
class Svc {
    /* just a regular comment, not a doc block */
    public function run() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/Svc.php")
	b, ok := blockByName(got, "Svc::run")
	if !ok {
		t.Fatalf("expected Svc::run, got %v", symbols(got))
	}
	if b.Description != "" {
		t.Fatalf("expected no description from a plain block comment, got %q", b.Description)
	}
}

// TestNoPHPDocMeansNoDescription: a method with no preceding comment at all
// gets an empty Description.
func TestNoPHPDocMeansNoDescription(t *testing.T) {
	src := `<?php
class Svc {
    public function run() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/Svc.php")
	b, ok := blockByName(got, "Svc::run")
	if !ok {
		t.Fatalf("expected Svc::run, got %v", symbols(got))
	}
	if b.Description != "" {
		t.Fatalf("expected empty description, got %q", b.Description)
	}
}

// TestPHPDocDescriptionStopsAtFirstTag: a MULTI-LINE tag must not leak into
// the description. Only the `@param` line itself starts with `@`; the
// array-shape continuation lines and the `-` bullets documenting them do not,
// so the original "skip lines starting with @" rule glued the entire raw type
// declaration onto the prose — observed on ImportSubscriptionStatsFlow::run
// (PR 13255), which showed a wall of `tenant_ids?: list<int>|null, ... } $input
// - ...` on its block card. The scan therefore breaks at the first tag line.
func TestPHPDocDescriptionStopsAtFirstTag(t *testing.T) {
	src := `<?php
class ImportSubscriptionStatsFlow {
    /**
     * Walks every tenant and rebuilds the statistics views.
     *
     * @param array{
     *     tenant_ids?: list<int>|null,
     *     from_tenant_id?: int|null,
     *     imported_total?: int,
     * } $input
     *   - ` + "`tenant_ids`" + `: an explicit, hand-picked set. Leave it out to walk every tenant.
     *   - ` + "`imported_total`" + `: internal running tally; do not set it yourself.
     * @return Generator<mixed, mixed, mixed, array{tenants_imported: int}>
     */
    public function run(array $input) {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Workflows/ImportSubscriptionStatsFlow.php")
	b, ok := blockByName(got, "ImportSubscriptionStatsFlow::run")
	if !ok {
		t.Fatalf("expected ImportSubscriptionStatsFlow::run, got %v", symbols(got))
	}
	want := "Walks every tenant and rebuilds the statistics views."
	if b.Description != want {
		t.Fatalf("Description = %q, want %q", b.Description, want)
	}
}

// TestPHPDocTagsOnlyMeansNoDescription: a docblock that opens straight into
// its tags has no free text at all, so the description stays empty rather
// than picking up the tag block's own continuation lines.
func TestPHPDocTagsOnlyMeansNoDescription(t *testing.T) {
	src := `<?php
class Svc {
    /**
     * @param array{a?: int,
     *     b?: string,
     * } $input
     * @return void
     */
    public function run(array $input) {
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/Svc.php")
	b, ok := blockByName(got, "Svc::run")
	if !ok {
		t.Fatalf("expected Svc::run, got %v", symbols(got))
	}
	if b.Description != "" {
		t.Fatalf("expected empty description, got %q", b.Description)
	}
}

// TestPHPDocDescriptionKeepsParagraphs: a blank doc line is a real paragraph
// break and survives as "\n\n" (the frontend renders the description as
// Markdown). Lines WITHIN a paragraph still join with a space — a docblock
// hard-wraps its prose, so a lone newline there is not a line break.
func TestPHPDocDescriptionKeepsParagraphs(t *testing.T) {
	src := `<?php
class Flow {
    /**
     * Imports the nightly statistics for every tenant that has
     * contracts, in ascending id order.
     *
     * It only ever works inside a nightly window and stops before
     * the billing chain starts.
     */
    public function run() {
    }
}
`
	got := ScanBlocks([]byte(src), "app/Workflows/Flow.php")
	b, ok := blockByName(got, "Flow::run")
	if !ok {
		t.Fatalf("expected Flow::run, got %v", symbols(got))
	}
	want := "Imports the nightly statistics for every tenant that has contracts, in ascending id order." +
		"\n\n" +
		"It only ever works inside a nightly window and stops before the billing chain starts."
	if b.Description != want {
		t.Fatalf("Description = %q, want %q", b.Description, want)
	}
}

// TestPHPDocDescriptionUnwrapsInlineRefs: `{@see X}`/`{@link X}` are docblock
// framing, not prose — the reviewer wants the reference, not the braces. Any
// OTHER inline tag is deliberately left verbatim rather than guessed at.
func TestPHPDocDescriptionUnwrapsInlineRefs(t *testing.T) {
	src := `<?php
class Flow {
    /**
     * Stops before the chain in {@see \App\Console\Kernel} starts, see
     * {@link https://example.test/docs} and {@inheritDoc}.
     */
    public function run() {
    }
}
`
	got := ScanBlocks([]byte(src), "app/Workflows/Flow.php")
	b, ok := blockByName(got, "Flow::run")
	if !ok {
		t.Fatalf("expected Flow::run, got %v", symbols(got))
	}
	want := `Stops before the chain in \App\Console\Kernel starts, see https://example.test/docs and {@inheritDoc}.`
	if b.Description != want {
		t.Fatalf("Description = %q, want %q", b.Description, want)
	}
}

// TestInterfaceMethodIsFlaggedIsInterface: a method declared directly inside
// an `interface` body gets Block.IsInterface=true, so classify.go can
// override its category to "INTERFACE" regardless of the file's path — see
// .claude/docs/blocks-and-ingest.md.
func TestInterfaceMethodIsFlaggedIsInterface(t *testing.T) {
	src := `<?php
interface Repo {
    public function find(int $id): ?Model;
}
`
	got := ScanBlocks([]byte(src), "app/Services/Repo.php")
	b, ok := blockByName(got, "Repo::find")
	if !ok {
		t.Fatalf("expected Repo::find, got %v", symbols(got))
	}
	if !b.IsInterface {
		t.Fatalf("expected Repo::find to be flagged IsInterface")
	}
}

// TestClassMethodIsNotFlaggedIsInterface: an ordinary class method (as
// opposed to an interface method) must never get IsInterface set.
func TestClassMethodIsNotFlaggedIsInterface(t *testing.T) {
	src := `<?php
class Foo {
    public function bar() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Foo.php")
	b, ok := blockByName(got, "Foo::bar")
	if !ok {
		t.Fatalf("expected Foo::bar, got %v", symbols(got))
	}
	if b.IsInterface {
		t.Fatalf("expected Foo::bar NOT to be flagged IsInterface")
	}
}

// TestTraitMethodIsNotFlaggedIsInterface: a trait method must also stay
// unflagged — only a real `interface` body sets IsInterface.
func TestTraitMethodIsNotFlaggedIsInterface(t *testing.T) {
	src := `<?php
trait Helper {
    public function assist() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Helper.php")
	b, ok := blockByName(got, "Helper::assist")
	if !ok {
		t.Fatalf("expected Helper::assist, got %v", symbols(got))
	}
	if b.IsInterface {
		t.Fatalf("expected Helper::assist NOT to be flagged IsInterface")
	}
}

// TestTraitMethodIsFlaggedIsTrait: a method declared directly inside a
// `trait` body gets Block.IsTrait=true, so classify.go can override its
// category to "TRAIT" regardless of the file's path — mirrors
// TestInterfaceMethodIsFlaggedIsInterface. See
// .claude/docs/blocks-and-ingest.md.
func TestTraitMethodIsFlaggedIsTrait(t *testing.T) {
	src := `<?php
trait Helper {
    public function assist() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Helper.php")
	b, ok := blockByName(got, "Helper::assist")
	if !ok {
		t.Fatalf("expected Helper::assist, got %v", symbols(got))
	}
	if !b.IsTrait {
		t.Fatalf("expected Helper::assist to be flagged IsTrait")
	}
}

// TestClassMethodIsNotFlaggedIsTrait: an ordinary class method must never get
// IsTrait set.
func TestClassMethodIsNotFlaggedIsTrait(t *testing.T) {
	src := `<?php
class Foo {
    public function bar() {
        return 1;
    }
}
`
	got := ScanBlocks([]byte(src), "app/Foo.php")
	b, ok := blockByName(got, "Foo::bar")
	if !ok {
		t.Fatalf("expected Foo::bar, got %v", symbols(got))
	}
	if b.IsTrait {
		t.Fatalf("expected Foo::bar NOT to be flagged IsTrait")
	}
}

// TestInterfaceMethodIsNotFlaggedIsTrait: an interface method must also stay
// unflagged — only a real `trait` body sets IsTrait.
func TestInterfaceMethodIsNotFlaggedIsTrait(t *testing.T) {
	src := `<?php
interface Repo {
    public function find(int $id): ?Model;
}
`
	got := ScanBlocks([]byte(src), "app/Services/Repo.php")
	b, ok := blockByName(got, "Repo::find")
	if !ok {
		t.Fatalf("expected Repo::find, got %v", symbols(got))
	}
	if b.IsTrait {
		t.Fatalf("expected Repo::find NOT to be flagged IsTrait")
	}
}

// TestBladeTemplateIsOneWholeFileBlock: a Laravel Blade template gets the
// whole-file treatment even though its extension ends in `.php` and even though
// the brace lexer CAN find "functions" in it — those are the JavaScript
// declarations of an inline <script>, and trusting them drops every changed
// line outside their spans from the review tree. Real case: PR 13263's
// resources/views/partials/scripts/fb.blade.php, where all 25 changed lines
// sat outside the two decoy blocks and the whole file vanished.
func TestBladeTemplateIsOneWholeFileBlock(t *testing.T) {
	src := `<div>
    @php
        $key = 'orders.purchase.' . $order->id;
    @endphp
    <script>
        function getFBCookie(name) {
            return name;
        }
    </script>
</div>
`
	file := "resources/views/partials/scripts/fb.blade.php"

	// Guard the premise: the lexer really does report the JS function, so the
	// existing "zero blocks" fallback would NOT have fired here.
	if decoys, ok := scanPHP(src, file); !ok || len(decoys) == 0 {
		t.Fatalf("premise broken: expected scanPHP to find decoy blocks, got ok=%v n=%d", ok, len(decoys))
	}

	got := ScanBlocks([]byte(src), file)
	if len(got) != 1 {
		t.Fatalf("expected exactly one whole-file block, got %d: %v", len(got), symbols(got))
	}
	if got[0].Name != "fb.blade.php" || got[0].Line != 1 || got[0].EndLine != 11 {
		t.Fatalf("expected whole-file block fb.blade.php 1-11, got %s %d-%d",
			got[0].Name, got[0].Line, got[0].EndLine)
	}
}

// TestPlainPhpFileStillScansIntoBlocks: the Blade carve-out keys on the
// `.blade.php` suffix only — an ordinary .php file (including one that merely
// has "blade" somewhere in its path) keeps its per-method blocks.
func TestPlainPhpFileStillScansIntoBlocks(t *testing.T) {
	src := `<?php
class BladeCompiler {
    public function compile(): string {
        return '';
    }
}
`
	got := ScanBlocks([]byte(src), "app/Services/blade/BladeCompiler.php")
	if _, ok := blockByName(got, "BladeCompiler::compile"); !ok {
		t.Fatalf("expected BladeCompiler::compile, got %v", symbols(got))
	}
}
