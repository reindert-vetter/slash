package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// A method body with enough substance to clear moveMinLines, used as the shared
// "same code, different name" payload across the fixtures below.
const movedBody = `        return AffiliateCommission::query()
            ->withoutTenantScope()
            ->select('affiliate_commissions.*')
            ->join('affiliate_partnerships', 'affiliate_partnerships.tenant_id', '=', 'affiliate_commissions.tenant_id')
            ->leftJoin('products', 'products.id', '=', 'affiliate_commissions.product_id')
            ->where('affiliate_commissions.amount', '>', 0)
            ->orderBy('affiliate_commissions.created_at', 'desc')
            ->groupBy('affiliate_commissions.id');`

func repoClass(class string, methods ...string) string {
	return "<?php\n\nclass " + class + "\n{\n" + strings.Join(methods, "\n\n") + "\n}\n"
}

func method(name, body string) string {
	return "    public function " + name + "(): Builder\n    {\n" + body + "\n    }"
}

// findBlock returns the single block with the given class::name, or fails.
func findBlock(t *testing.T, blocks []Block, symbol string) Block {
	t.Helper()
	var hits []Block
	for _, b := range blocks {
		if b.Class+"::"+b.Name == symbol {
			hits = append(hits, b)
		}
	}
	if len(hits) != 1 {
		t.Fatalf("want exactly one block %s, got %d (%s)", symbol, len(hits), blockSymbols(blocks))
	}
	return hits[0]
}

// realBlocks drops the class-header sentinel phpscan emits for a changed class
// declaration — a fixture artefact here (emptying a class body changes its
// header), never what these tests are about.
func mustParse(t *testing.T, paths []string, baseDir, headDir string) []Block {
	t.Helper()
	blocks, errs := parseFiles(1, paths, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	return blocks
}

func realBlocks(blocks []Block) []Block {
	var out []Block
	for _, b := range blocks {
		if !strings.Contains(b.Name, "class-header") {
			out = append(out, b)
		}
	}
	return out
}

func blockSymbols(blocks []Block) string {
	var out []string
	for _, b := range blocks {
		out = append(out, b.Status+" "+b.File+" "+b.Class+"::"+b.Name)
	}
	return strings.Join(out, ", ")
}

// TestRenamedMethodCollapsesIntoOneBlock: a method renamed within the same file
// must not surface as a loose removed + added pair but as ONE modified block
// carrying its pre-rename symbol, so the reviewer gets an old-vs-new diff.
func TestRenamedMethodCollapsesIntoOneBlock(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	file := "modules/Affiliates/Http/Repositories/CommissionRepository.php"

	writeFileT(t, filepath.Join(baseDir, file),
		repoClass("CommissionRepository", method("getIndexCommissionsForPartner", movedBody)))
	writeFileT(t, filepath.Join(headDir, file),
		repoClass("CommissionRepository", method("getAsPartner", movedBody)))

	blocks, errs := parseFiles(1, []string{file}, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 merged block, got %d (%s)", len(blocks), blockSymbols(blocks))
	}
	b := blocks[0]
	if b.Name != "getAsPartner" || b.Status != StatusModified {
		t.Errorf("got %s %s, want modified getAsPartner", b.Status, b.Name)
	}
	if b.OldName != "getIndexCommissionsForPartner" || b.OldClass != "CommissionRepository" {
		t.Errorf("oldClass::oldName = %q::%q, want CommissionRepository::getIndexCommissionsForPartner", b.OldClass, b.OldName)
	}
	if b.OldFile != "" {
		t.Errorf("oldFile = %q, want empty (same file)", b.OldFile)
	}
	if b.OldLine == 0 {
		t.Error("oldLine not recorded")
	}
	if b.oldSymbol() != "CommissionRepository::getIndexCommissionsForPartner" {
		t.Errorf("oldSymbol() = %q", b.oldSymbol())
	}
	if !b.moved() {
		t.Error("moved() = false")
	}
}

// TestMovedMethodAcrossFilesCollapses: the same body reappearing in a DIFFERENT
// file and class is a move too — classifyFile can never see this (it runs per
// file), which is exactly why the detection is PR-wide.
func TestMovedMethodAcrossFilesCollapses(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	from := "modules/Affiliates/Http/Repositories/CommissionRepository.php"
	to := "modules/Affiliates/Http/Queries/CommissionQuery.php"

	writeFileT(t, filepath.Join(baseDir, from),
		repoClass("CommissionRepository", method("getAsPartner", movedBody)))
	writeFileT(t, filepath.Join(headDir, from), repoClass("CommissionRepository"))
	writeFileT(t, filepath.Join(headDir, to),
		repoClass("CommissionQuery", method("getAsPartner", movedBody)))

	blocks, errs := parseFiles(1, []string{from, to}, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	blocks = realBlocks(blocks)
	if len(blocks) != 1 {
		t.Fatalf("want 1 merged block, got %d (%s)", len(blocks), blockSymbols(blocks))
	}
	b := blocks[0]
	if b.File != to || b.Class != "CommissionQuery" || b.Status != StatusModified {
		t.Errorf("got %s %s %s::%s, want modified %s CommissionQuery::getAsPartner", b.Status, b.File, b.Class, b.Name, to)
	}
	if b.OldFile != from || b.OldClass != "CommissionRepository" || b.OldName != "getAsPartner" {
		t.Errorf("old identity = %s %s::%s, want %s CommissionRepository::getAsPartner", b.OldFile, b.OldClass, b.OldName, from)
	}
	if b.oldPath() != from {
		t.Errorf("oldPath() = %q, want %q", b.oldPath(), from)
	}
}

// TestMovedBlockPicksTheBestCandidate: two removed methods and one added one —
// only the genuinely similar pair may collapse; the other removed method must
// survive as its own "Verwijderd" block.
func TestMovedBlockPicksTheBestCandidate(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	file := "modules/Affiliates/Http/Repositories/CommissionRepository.php"

	otherBody := `        return AffiliateRevenue::query()
            ->whereNotNull('paid_at')
            ->whereBetween('created_at', [$from, $to])
            ->selectRaw('sum(total) as total')
            ->groupBy('affiliate_revenues.tenant_id')
            ->having('total', '>', 100)
            ->orderByDesc('total');`

	writeFileT(t, filepath.Join(baseDir, file), repoClass("CommissionRepository",
		method("getIndexCommissionsForPartner", movedBody),
		method("getTotalRevenueAsPartner", otherBody)))
	writeFileT(t, filepath.Join(headDir, file), repoClass("CommissionRepository",
		method("getAsPartner", movedBody)))

	blocks, errs := parseFiles(1, []string{file}, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d (%s)", len(blocks), blockSymbols(blocks))
	}
	merged := findBlock(t, blocks, "CommissionRepository::getAsPartner")
	if merged.OldName != "getIndexCommissionsForPartner" {
		t.Errorf("merged with the wrong candidate: oldName = %q", merged.OldName)
	}
	survivor := findBlock(t, blocks, "CommissionRepository::getTotalRevenueAsPartner")
	if survivor.Status != StatusRemoved {
		t.Errorf("unrelated method status = %q, want removed", survivor.Status)
	}
}

// TestUnrelatedAddRemoveStaysSplit: below the similarity threshold nothing may
// collapse — a false pair HIDES a genuinely removed method, which is the worse
// failure of the two.
func TestUnrelatedAddRemoveStaysSplit(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	file := "app/Services/OrderService.php"

	writeFileT(t, filepath.Join(baseDir, file), repoClass("OrderService", method("oldWay", movedBody)))
	writeFileT(t, filepath.Join(headDir, file), repoClass("OrderService", method("newWay",
		`        $invoice = Invoice::find($id);
        $invoice->lines()->delete();
        $invoice->refresh();
        event(new InvoiceCleared($invoice));
        Log::info('cleared', ['id' => $id]);
        return $invoice;`)))

	blocks, errs := parseFiles(1, []string{file}, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 separate blocks, got %d (%s)", len(blocks), blockSymbols(blocks))
	}
	for _, b := range blocks {
		if b.OldName != "" {
			t.Errorf("%s::%s wrongly paired with %q", b.Class, b.Name, b.OldName)
		}
	}
}

// TestTinyMethodsNeverPair: two trivial accessors with an identical one-line
// body score a perfect similarity — moveMinLines is what keeps them apart.
func TestTinyMethodsNeverPair(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	file := "app/Models/Order.php"

	writeFileT(t, filepath.Join(baseDir, file), repoClass("Order", method("total", "        return $this->amount;")))
	writeFileT(t, filepath.Join(headDir, file), repoClass("Order", method("grandTotal", "        return $this->amount;")))

	blocks, _ := parseFiles(1, []string{file}, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(blocks) != 2 {
		t.Fatalf("want 2 separate blocks, got %d (%s)", len(blocks), blockSymbols(blocks))
	}
}

// TestMovedBlockOldSideIsReadFromItsOldSymbol: the whole point of recording the
// pre-move identity — blockstats (and /api/code, which shares the readers) must
// diff against the OLD symbol, not against an absent one.
func TestMovedBlockOldSideIsReadFromItsOldSymbol(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	from := "app/Repositories/CommissionRepository.php"
	to := "app/Queries/CommissionQuery.php"

	writeFileT(t, filepath.Join(baseDir, from), repoClass("CommissionRepository", method("getAsPartner", movedBody)))
	writeFileT(t, filepath.Join(headDir, from), repoClass("CommissionRepository"))
	// One line changed on the way over, so the diff is not empty.
	writeFileT(t, filepath.Join(headDir, to), repoClass("CommissionQuery",
		method("fetch", strings.Replace(movedBody, "'desc'", "'asc'", 1))))

	blocks := realBlocks(mustParse(t, []string{from, to}, baseDir, headDir))
	if len(blocks) != 1 {
		t.Fatalf("want 1 merged block, got %d (%s)", len(blocks), blockSymbols(blocks))
	}
	rows, oldSide, newSide := blockAlignedRows(baseDir, headDir, blocks[0])
	if oldSide.Text == "" {
		t.Fatal("old side empty — it was not read from the pre-move file/symbol")
	}
	if newSide.Text == "" {
		t.Fatal("new side empty")
	}
	if got := countChangedRows(rows); got != 2 {
		t.Errorf("changed rows = %d, want 2 (the declaration and the orderBy line)", got)
	}
}
