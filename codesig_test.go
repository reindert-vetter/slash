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
