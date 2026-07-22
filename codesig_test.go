package main

import "testing"

func TestEnrichSignatureReturnTypeOnly(t *testing.T) {
	in := "/**\n" +
		" * Immutable, point-in-time resource snapshot.\n" +
		" *\n" +
		" * @return array<string, mixed>|null\n" +
		" */\n" +
		"private function getResource(): ?array\n" +
		"{\n" +
		"    return $this->resource;\n" +
		"}"
	want := "private function getResource(): array<string, mixed>|null\n" +
		"{\n" +
		"    return $this->resource;\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 5 {
		t.Fatalf("removed = %d, want 5", removed)
	}
}

func TestEnrichSignatureReturnAndParamSingleLine(t *testing.T) {
	in := "/**\n" +
		" * @param OrderInclude[] $includes\n" +
		" * @return array<string, mixed>\n" +
		" */\n" +
		"public function getOrderResource(int $id, array $includes): array\n" +
		"{\n" +
		"    return [];\n" +
		"}"
	want := "public function getOrderResource(int $id, OrderInclude[] $includes): array<string, mixed>\n" +
		"{\n" +
		"    return [];\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 4 {
		t.Fatalf("removed = %d, want 4", removed)
	}
}

func TestEnrichSignatureMultiLineParamList(t *testing.T) {
	in := "/**\n" +
		" * @param OrderInclude[] $includes\n" +
		" * @param int $id\n" +
		" * @return array<string, mixed>\n" +
		" */\n" +
		"public function getOrderResource(\n" +
		"    int $id,\n" +
		"    array $includes\n" +
		"): array {\n" +
		"    return [];\n" +
		"}"
	want := "public function getOrderResource(\n" +
		"    int $id,\n" +
		"    OrderInclude[] $includes\n" +
		"): array<string, mixed> {\n" +
		"    return [];\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 5 {
		t.Fatalf("removed = %d, want 5", removed)
	}
}

func TestEnrichSignatureConstructorPropertyPromotion(t *testing.T) {
	in := "/**\n" +
		" * @param OrderInclude[] $includes\n" +
		" */\n" +
		"public function __construct(\n" +
		"    private readonly int $id,\n" +
		"    private array $includes,\n" +
		") {\n" +
		"}"
	want := "public function __construct(\n" +
		"    private readonly int $id,\n" +
		"    private OrderInclude[] $includes,\n" +
		") {\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
}

func TestEnrichSignatureInsertsMissingNativeReturnType(t *testing.T) {
	in := "/**\n" +
		" * @return array<string, mixed>|null\n" +
		" */\n" +
		"private function getResource()\n" +
		"{\n" +
		"    return null;\n" +
		"}"
	want := "private function getResource(): array<string, mixed>|null\n" +
		"{\n" +
		"    return null;\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
}

func TestEnrichSignatureFreeTextOnlyDocLeftUntouched(t *testing.T) {
	in := "/**\n" +
		" * Just a plain description, no tags at all.\n" +
		" */\n" +
		"private function getResource(): ?array\n" +
		"{\n" +
		"    return null;\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != in || removed != 0 {
		t.Fatalf("expected the doc-only-text block untouched, got out=%q removed=%d", out, removed)
	}
}

func TestEnrichSignatureNoLeadingDocLeftUntouched(t *testing.T) {
	in := "private function getResource(): ?array\n{\n    return null;\n}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != in || removed != 0 {
		t.Fatalf("expected no-doc block untouched, got out=%q removed=%d", out, removed)
	}
}

func TestEnrichSignatureAttributeBeforeDocNotSupported(t *testing.T) {
	// An attribute run BEFORE the PHPDoc is an accepted v1 limitation — the
	// text must start with "/**" itself to be touched at all.
	in := "#[Deprecated]\n" +
		"/**\n" +
		" * @return array<string, mixed>|null\n" +
		" */\n" +
		"private function getResource(): ?array\n" +
		"{\n" +
		"    return null;\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != in || removed != 0 {
		t.Fatalf("expected attribute-before-doc block untouched, got out=%q removed=%d", out, removed)
	}
}

func TestEnrichSignatureAttributeAfterDocPreserved(t *testing.T) {
	in := "/**\n" +
		" * @return array<string, mixed>|null\n" +
		" */\n" +
		"#[Override]\n" +
		"private function getResource(): ?array\n" +
		"{\n" +
		"    return null;\n" +
		"}"
	want := "#[Override]\n" +
		"private function getResource(): array<string, mixed>|null\n" +
		"{\n" +
		"    return null;\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
}

func TestEnrichSignatureParamNameNotFoundLeavesThatParamAlone(t *testing.T) {
	// @param names a variable that doesn't exist on the signature (stale doc) —
	// the real (matching) param still gets folded, the stray tag is ignored.
	in := "/**\n" +
		" * @param OrderInclude[] $includes\n" +
		" * @param string $typo\n" +
		" */\n" +
		"public function f(array $includes): void\n" +
		"{\n" +
		"}"
	want := "public function f(OrderInclude[] $includes): void\n" +
		"{\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 4 {
		t.Fatalf("removed = %d, want 4", removed)
	}
}

func TestEnrichSignatureByRefAndVariadicMarkersPreserved(t *testing.T) {
	in := "/**\n" +
		" * @param int $ids\n" +
		" */\n" +
		"public function f(int &...$ids): void\n" +
		"{\n" +
		"}"
	want := "public function f(int &...$ids): void\n" +
		"{\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
}

func TestEnrichSignatureIntersectionTypeAmpersandNotMistakenForByRef(t *testing.T) {
	in := "/**\n" +
		" * @param OrderInclude[] $x\n" +
		" */\n" +
		"public function f(Foo&Bar $x): void\n" +
		"{\n" +
		"}"
	want := "public function f(OrderInclude[] $x): void\n" +
		"{\n" +
		"}"
	out, removed := enrichSignatureWithDocTypes(in)
	if out != want {
		t.Fatalf("out =\n%s\nwant\n%s", out, want)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
}

// TestBlockChangedRowCountParityAfterDocFold pins the approve-teller
// (blockstats.go) to the exact same, now-shorter row count the reviewer would
// see in the diff once the PHPDoc is folded into the signature — a change
// that ADDS such a doc (with a real type change) should count only the one
// rewritten signature line, not the whole multi-line doc block.
func TestChangedRowCountAfterDocFold(t *testing.T) {
	old := "private function getResource(): ?array\n{\n    return $this->resource;\n}"
	newT := "/**\n" +
		" * Immutable, point-in-time resource snapshot.\n" +
		" *\n" +
		" * @return array<string, mixed>|null\n" +
		" */\n" +
		"private function getResource(): ?array\n" +
		"{\n" +
		"    return $this->resource;\n" +
		"}"
	oldEnriched, _ := enrichSignatureWithDocTypes(old)
	newEnriched, _ := enrichSignatureWithDocTypes(newT)
	got := changedRowCount(oldEnriched, newEnriched)
	// Only the return-type token itself differs (?array -> array<string, mixed>|null)
	// once the doc is folded away — everything else (body) is identical.
	if got != 1 {
		t.Fatalf("changedRowCount after doc fold = %d, want 1", got)
	}
	// Without the fold, the same pair counts the whole added doc block too.
	rawGot := changedRowCount(old, newT)
	if rawGot <= got {
		t.Fatalf("expected the raw (unfolded) count %d to exceed the folded count %d", rawGot, got)
	}
}

func TestTrimTrailingBlankLineDropsBlankLastLine(t *testing.T) {
	in := "    case A = 'a';\n    case B = 'b';\n"
	out, removed := trimTrailingBlankLine(in)
	want := "    case A = 'a';\n    case B = 'b';"
	if out != want {
		t.Fatalf("out = %q, want %q", out, want)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
}

func TestTrimTrailingBlankLineDropsWhitespaceOnlyLastLine(t *testing.T) {
	in := "    case A = 'a';\n    "
	out, removed := trimTrailingBlankLine(in)
	want := "    case A = 'a';"
	if out != want {
		t.Fatalf("out = %q, want %q", out, want)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
}

func TestTrimTrailingBlankLineNoopOnRealContent(t *testing.T) {
	in := "    case A = 'a';\n    case B = 'b';"
	out, removed := trimTrailingBlankLine(in)
	if out != in {
		t.Fatalf("out = %q, want unchanged %q", out, in)
	}
	if removed != 0 {
		t.Fatalf("removed = %d, want 0", removed)
	}
}

func TestTrimTrailingBlankLineNoopOnSingleLine(t *testing.T) {
	in := "    case A = 'a';"
	out, removed := trimTrailingBlankLine(in)
	if out != in || removed != 0 {
		t.Fatalf("out = %q, removed = %d, want unchanged/0", out, removed)
	}
}

func TestTrimTrailingBlankLineNoopOnEmpty(t *testing.T) {
	out, removed := trimTrailingBlankLine("")
	if out != "" || removed != 0 {
		t.Fatalf("out = %q, removed = %d, want empty/0", out, removed)
	}
}

func TestTrimTrailingBlankLineOnlyDropsOne(t *testing.T) {
	// Two consecutive trailing blank lines: only the very last one is
	// dropped — deliberately a single trim, not a loop (see the doc
	// comment on trimTrailingBlankLine).
	in := "    case A = 'a';\n\n"
	out, removed := trimTrailingBlankLine(in)
	want := "    case A = 'a';\n"
	if out != want {
		t.Fatalf("out = %q, want %q", out, want)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
}

func TestEnrichedCodeSideTrimsTrailingBlankLineOnly(t *testing.T) {
	// Mirrors the class-header-sentinel case: no leading PHPDoc, so
	// enrichSignatureWithDocTypes is a no-op, but the text's last line is
	// blank — End should shrink by 1, Start untouched.
	cs := codeSide{Start: 11, End: 36, Text: "    case A = 'a';\n    case B = 'b';\n"}
	got := enrichedCodeSide(cs)
	want := codeSide{Start: 11, End: 35, Text: "    case A = 'a';\n    case B = 'b';"}
	if got != want {
		t.Fatalf("enrichedCodeSide = %+v, want %+v", got, want)
	}
}

func TestEnrichedCodeSideNoopWithoutDocOrTrailingBlank(t *testing.T) {
	cs := codeSide{Start: 11, End: 35, Text: "    case A = 'a';\n    case B = 'b';"}
	got := enrichedCodeSide(cs)
	if got != cs {
		t.Fatalf("enrichedCodeSide = %+v, want unchanged %+v", got, cs)
	}
}

func TestEnrichedCodeSideCombinesLeadingFoldAndTrailingTrim(t *testing.T) {
	// A leading PHPDoc fold (bumps Start) combined with a blank trailing
	// line (shrinks End) — the two corrections must apply independently
	// and correctly in the same call.
	cs := codeSide{
		Start: 10,
		End:   17,
		Text: "/**\n" +
			" * @return array<string, mixed>|null\n" +
			" */\n" +
			"private function getResource(): ?array\n" +
			"{\n" +
			"    return $this->resource;\n" +
			"}\n" +
			"\n",
	}
	got := enrichedCodeSide(cs)
	wantText := "private function getResource(): array<string, mixed>|null\n" +
		"{\n" +
		"    return $this->resource;\n" +
		"}\n"
	if got.Text != wantText {
		t.Fatalf("Text =\n%q\nwant\n%q", got.Text, wantText)
	}
	// 3 lines removed from the front (doc), 1 blank line removed from the tail.
	if got.Start != 13 {
		t.Fatalf("Start = %d, want 13", got.Start)
	}
	if got.End != 16 {
		t.Fatalf("End = %d, want 16", got.End)
	}
}
