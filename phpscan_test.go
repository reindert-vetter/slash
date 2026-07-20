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
// `function` keyword's own line (see .claude/rules/blocks-and-ingest.md,
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
	if len(got) != 3 {
		t.Fatalf("expected exactly 3 blocks, got %d: %v", len(got), symbols(got))
	}
	var header Block
	for _, b := range got {
		if b.symbol() == "ProductGroup::<class-header>" {
			header = b
		}
	}
	// Body opens on line 3 ("{"); header content starts line 4 ("use HasFactory;")
	// and must end just before the constructor's declaration line.
	if header.Line != 4 {
		t.Fatalf("expected header Line=4, got %d", header.Line)
	}
	var ctor Block
	for _, b := range got {
		if b.symbol() == "ProductGroup::__construct" {
			ctor = b
		}
	}
	if header.EndLine != ctor.Line-1 {
		t.Fatalf("expected header EndLine=%d (ctor.Line-1), got %d", ctor.Line-1, header.EndLine)
	}
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
	if len(got) != 1 || got[0].symbol() != "Config::<class-header>" {
		t.Fatalf("expected the whole body to be one class-header block, got %v", symbols(got))
	}
	// Body opens line 3; the last content line is line 6 (the closing brace is
	// line 7).
	if got[0].Line != 4 || got[0].EndLine != 6 {
		t.Fatalf("expected Line=4 EndLine=6, got Line=%d EndLine=%d", got[0].Line, got[0].EndLine)
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
