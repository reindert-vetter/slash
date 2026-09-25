package main

import "testing"

func findTSBlock(blocks []Block, name string) (Block, bool) {
	for _, b := range blocks {
		if b.Name == name {
			return b, true
		}
	}
	return Block{}, false
}

// TestScanTSFunctionDeclaration covers the plain `function name(...) { ... }`
// shape, including export/async modifiers.
func TestScanTSFunctionDeclaration(t *testing.T) {
	src := `export async function loadOrder(id: number): Promise<void> {
  await fetchOrder(id);
}

function helper() {
  return 1;
}
`
	blocks := scanTS([]byte(src), "example.ts")
	b, ok := findTSBlock(blocks, "loadOrder")
	if !ok {
		t.Fatalf("loadOrder not found, got %+v", blocks)
	}
	if b.Line != 1 || b.EndLine != 3 {
		t.Fatalf("loadOrder: line=%d endLine=%d, want 1/3", b.Line, b.EndLine)
	}
	if b.Class != "" {
		t.Fatalf("loadOrder: class = %q, want empty", b.Class)
	}
	if _, ok := findTSBlock(blocks, "helper"); !ok {
		t.Fatalf("helper not found, got %+v", blocks)
	}
}

// TestScanTSArrowBlockBody covers the `const name = (...) => { ... }` shape —
// the concrete PR 13538 case (firePurchaseEvent/trackEvents).
func TestScanTSArrowBlockBody(t *testing.T) {
	src := `export const firePurchaseEvent = (orderData: number): void => {
  console.log(orderData);
};

export const trackEvents = async (options: number): Promise<void> => {
  if (options) {
    firePurchaseEvent(options);
  }
};
`
	blocks := scanTS([]byte(src), "v2.ts")
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d: %+v", len(blocks), blocks)
	}
	fp, ok := findTSBlock(blocks, "firePurchaseEvent")
	if !ok {
		t.Fatalf("firePurchaseEvent not found, got %+v", blocks)
	}
	if fp.Line != 1 || fp.EndLine != 3 {
		t.Fatalf("firePurchaseEvent: line=%d endLine=%d, want 1/3", fp.Line, fp.EndLine)
	}
	te, ok := findTSBlock(blocks, "trackEvents")
	if !ok {
		t.Fatalf("trackEvents not found, got %+v", blocks)
	}
	if te.Line != 5 || te.EndLine != 9 {
		t.Fatalf("trackEvents: line=%d endLine=%d, want 5/9", te.Line, te.EndLine)
	}
}

// TestScanTSExpressionBodyArrowSkipped is the explicit v1 boundary: an arrow
// function whose body is an expression (no `{ ... }`) is not turned into a
// block at all.
func TestScanTSExpressionBodyArrowSkipped(t *testing.T) {
	src := `const isPaid = (x: number): boolean =>
  x > 0 || x < -1;

export const buildEvent = (x: number) => ({
  event: 'x',
  value: x,
});
`
	blocks := scanTS([]byte(src), "example.ts")
	// scanTSFunctions itself finds nothing (both are expression-bodied), so
	// scanTS falls back to one whole-file block — same "nothing matched"
	// fallback ScanBlocks' PHP path takes, see
	// TestScanTSNoMatchesFallsBackToWholeFile.
	if len(blocks) != 1 || blocks[0].Name != "example.ts" {
		t.Fatalf("expected the whole-file fallback (no block-bodied function found), got %+v", blocks)
	}
	if len(scanTSFunctions(src, "example.ts")) != 0 {
		t.Fatalf("expected scanTSFunctions itself to find zero block-bodied functions")
	}
}

// TestScanTSNestedFunctionNotTopLevel: a function declared INSIDE another
// function's body must not be emitted as its own top-level block — it's part
// of its parent's own diff/approval unit, exactly like a PHP closure never
// gets its own block.
func TestScanTSNestedFunctionNotTopLevel(t *testing.T) {
	src := `export const outer = (): void => {
  const inner = (): void => {
    console.log('inner');
  };
  inner();
};
`
	blocks := scanTS([]byte(src), "example.ts")
	if len(blocks) != 1 {
		t.Fatalf("expected exactly 1 top-level block, got %d: %+v", len(blocks), blocks)
	}
	if blocks[0].Name != "outer" {
		t.Fatalf("expected the sole block to be 'outer', got %q", blocks[0].Name)
	}
}

// TestScanTSSkipsTopLevelBracesLikeDeclareGlobal proves the depth-scan
// correctly walks through an unrelated top-level `{ ... }` region (a
// `declare global { interface Window { ... } }` block, straight from the
// real PR 13538 file) without losing track of "are we still at depth 0" for
// the function declared after it.
func TestScanTSSkipsTopLevelBracesLikeDeclareGlobal(t *testing.T) {
	src := `declare global {
  interface Window {
    dataLayer: any[];
    gtag: (...args: any[]) => void;
  }
}

export const afterDeclare = (): void => {
  console.log('after');
};
`
	blocks := scanTS([]byte(src), "example.ts")
	if len(blocks) != 1 {
		t.Fatalf("expected exactly 1 block, got %d: %+v", len(blocks), blocks)
	}
	if blocks[0].Name != "afterDeclare" {
		t.Fatalf("expected 'afterDeclare', got %q", blocks[0].Name)
	}
}

// TestScanTSStringsAndCommentsDoNotConfuseBraceCounting: a brace character
// inside a string/template literal/comment must never be counted toward
// depth tracking.
func TestScanTSStringsAndCommentsDoNotConfuseBraceCounting(t *testing.T) {
	src := `// a comment with a fake brace {
export const withBraceInString = (): void => {
  const s = "not a real } brace";
  const t = ` + "`template ${1 + 1} with a fake } brace`" + `;
  /* block comment with a { fake brace */
  console.log(s, t);
};
`
	blocks := scanTS([]byte(src), "example.ts")
	if len(blocks) != 1 {
		t.Fatalf("expected exactly 1 block, got %d: %+v", len(blocks), blocks)
	}
	if blocks[0].Name != "withBraceInString" {
		t.Fatalf("expected 'withBraceInString', got %q", blocks[0].Name)
	}
}

// TestScanTSNoMatchesFallsBackToWholeFile mirrors ScanBlocks' own PHP
// fallback: a .ts file with nothing tsscan.go can find still gets exactly
// one whole-file block, never an empty result (which would drop the file
// from the review tree entirely).
func TestScanTSNoMatchesFallsBackToWholeFile(t *testing.T) {
	src := "export interface Foo {\n  bar: string;\n}\n"
	blocks := scanTS([]byte(src), "example.ts")
	if len(blocks) != 1 {
		t.Fatalf("expected exactly 1 whole-file fallback block, got %d: %+v", len(blocks), blocks)
	}
	if blocks[0].Name != "example.ts" {
		t.Fatalf("expected the whole-file fallback name, got %q", blocks[0].Name)
	}
}

// TestScanTSClassSplitsIntoMethodsAndHeader is the concrete PR 13885 case
// (analytics.ts's PlugAndPayAnalytics class): a getter, a constructor, a
// plain method and a private `#method` each become their own Block with
// Class set, and the leading field declarations become one residual
// "<class-header>" block.
func TestScanTSClassSplitsIntoMethodsAndHeader(t *testing.T) {
	src := `class PlugAndPayAnalytics {
    #endpoint: string = "x";
    #debug: boolean = false;

    get isInitialized() {
        return this.#debug;
    }

    constructor() {
        this.init();
    }

    init() {
        this.#adoptHandedOverIds();
    }

    #adoptHandedOverIds() {
        console.log('adopt');
    }
}
`
	blocks := scanTS([]byte(src), "analytics.ts")
	header, ok := findTSBlock(blocks, classHeaderSentinel)
	if !ok {
		t.Fatalf("expected a <class-header> block, got %+v", blocks)
	}
	if header.Class != "PlugAndPayAnalytics" || header.Line != 2 || header.EndLine != 4 {
		t.Fatalf("header: class=%q line=%d-%d, want PlugAndPayAnalytics/2-4", header.Class, header.Line, header.EndLine)
	}
	for _, name := range []string{"isInitialized", "constructor", "init", "#adoptHandedOverIds"} {
		b, ok := findTSBlock(blocks, name)
		if !ok {
			t.Fatalf("%s not found, got %+v", name, blocks)
		}
		if b.Class != "PlugAndPayAnalytics" {
			t.Fatalf("%s: class = %q, want PlugAndPayAnalytics", name, b.Class)
		}
	}
	adopt, _ := findTSBlock(blocks, "#adoptHandedOverIds")
	if adopt.Line != 16 || adopt.EndLine != 19 {
		t.Fatalf("#adoptHandedOverIds: line=%d-%d, want 16-19", adopt.Line, adopt.EndLine)
	}
}

// TestScanTSClassGeneratorAndComputedMethod covers a generator method and a
// computed method name — both newly in scope.
func TestScanTSClassGeneratorAndComputedMethod(t *testing.T) {
	src := `class Foo {
    *entries() {
        yield 1;
    }

    [Symbol.iterator]() {
        return this.entries();
    }
}
`
	blocks := scanTS([]byte(src), "foo.ts")
	if _, ok := findTSBlock(blocks, "entries"); !ok {
		t.Fatalf("generator method 'entries' not found, got %+v", blocks)
	}
	computed, ok := findTSBlock(blocks, "[Symbol.iterator]")
	if !ok {
		t.Fatalf("computed method '[Symbol.iterator]' not found, got %+v", blocks)
	}
	if computed.Class != "Foo" {
		t.Fatalf("computed method: class = %q, want Foo", computed.Class)
	}
}

// TestScanTSClassArrowFieldMethod covers a class field assigned an arrow
// function — `handler = (x) => { ... }` — which is split into its own block
// like an ordinary method (reviewer decision: WEL splitsen, unlike the
// top-level const-arrow v1 boundary).
func TestScanTSClassArrowFieldMethod(t *testing.T) {
	src := `class Foo {
    handler = (x: number): void => {
        console.log(x);
    };

    private onClick = () => {
        this.handler(1);
    };
}
`
	blocks := scanTS([]byte(src), "foo.ts")
	h, ok := findTSBlock(blocks, "handler")
	if !ok {
		t.Fatalf("arrow field 'handler' not found, got %+v", blocks)
	}
	if h.Class != "Foo" {
		t.Fatalf("handler: class = %q, want Foo", h.Class)
	}
	if _, ok := findTSBlock(blocks, "onClick"); !ok {
		t.Fatalf("arrow field 'onClick' (with a modifier) not found, got %+v", blocks)
	}
}

// TestScanTSClassWithNoMethodsEmitsNothing: a class with only fields (no
// method-shaped member at all) contributes nothing — as if the class hadn't
// been detected — same "silently nothing" precedent as an expression-bodied
// top-level arrow. The file still falls back to one whole-file block.
func TestScanTSClassWithNoMethodsEmitsNothing(t *testing.T) {
	src := `class Config {
    debug = false;
    name = "x";
}
`
	blocks := scanTS([]byte(src), "config.ts")
	if len(blocks) != 1 || blocks[0].Name != "config.ts" {
		t.Fatalf("expected the whole-file fallback, got %+v", blocks)
	}
}

// TestScanBlocksDispatchesTSExtension is the ScanBlocks-level integration
// check: a .ts file must reach scanTS, not the PHP path or the generic
// whole-file default.
func TestScanBlocksDispatchesTSExtension(t *testing.T) {
	src := `export const foo = (): void => {
  console.log('foo');
};
`
	blocks := ScanBlocks([]byte(src), "modules/example.ts")
	if len(blocks) != 1 || blocks[0].Name != "foo" {
		t.Fatalf("expected ScanBlocks to dispatch .ts to scanTS, got %+v", blocks)
	}
}
