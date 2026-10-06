package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestInlineImportRows(t *testing.T) {
	s := func(v string) *string { return &v }
	rows := []alignRow{
		{left: s("<?php"), right: s("<?php")},
		{left: s(`use Old\Thing;`), right: s(`use New\Thing;`), leftMark: "del", rightMark: "ins"},
		{right: s(`use App\Rules\{Fresh, Other as Alias};`), rightMark: "ins"},
		{left: s(`use Gone\Removed;`), leftMark: "del"},       // pure deletion: never inlined
		{left: s(`use App\Same;`), right: s(`use App\Same;`)}, // unchanged
		{right: s(`namespace App\New;`), rightMark: "ins"},    // not an import
	}
	got := inlineImportRows(rows, []importUser{
		{id: "a", src: "return [new Thing(), Alias::make(), new Same(), new Removed()];"},
		{id: "b", src: "return new Fresh();"},
		{id: "c", src: "return $thingy . 'Fresh'; // ThingFresh"},
	})
	want := map[string][]int{"a": {1, 2}, "b": {2}, "c": {2}}
	// "c" mentions 'Fresh' inside a string: the identifier match is lexical,
	// so it still counts — the same precision resolveImports had.
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPlanImportInlining(t *testing.T) {
	dataDir := t.TempDir()
	pr := 73
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	const file = "app/X/C.php"
	const nsOnly = "app/Y/D.php"
	writeWorktreeFiles(t, baseDir, map[string]string{
		file: `<?php

namespace App\X;

use Old\Thing;

final class C
{
    public function rules(): array
    {
        return [new Thing()];
    }

    public function other(): array
    {
        return [];
    }
}
`,
		nsOnly: `<?php

namespace App\Old;

use Gone\Removed;

class D
{
    public function run()
    {
        return 1;
    }
}
`,
	})
	writeWorktreeFiles(t, headDir, map[string]string{
		file: `<?php

namespace App\X;

use New\Thing;
use App\Rules\Fresh;

final class C
{
    public function rules(): array
    {
        return [new Thing(), new Fresh()];
    }

    public function other(): array
    {
        return [1];
    }
}
`,
		nsOnly: `<?php

namespace App\New;

class D
{
    public function run()
    {
        return 2;
    }
}
`,
	})
	var blocks []Block
	for _, f := range []string{file, nsOnly} {
		for _, sb := range ScanBlocks([]byte(mustRead(t, headDir+"/"+f)), f) {
			blocks = append(blocks, Block{PR: pr, File: f, Class: sb.Class, Name: sb.Name, Side: SideNew, Status: StatusModified})
		}
	}
	find := func(f, name string) Block {
		for _, b := range blocks {
			if b.File == f && b.Name == name {
				return b
			}
		}
		t.Fatalf("no block %s %s", f, name)
		return Block{}
	}
	hdr, rules, other := find(file, fileHeaderSentinel), find(file, "rules"), find(file, "other")
	nsHdr := find(nsOnly, fileHeaderSentinel)

	plan := planImportInlining(baseDir, headDir, blocks)
	pre := plan.prefixFor(rules)
	if len(pre) != 2 || *pre[0].Right != `use New\Thing;` || pre[0].Left == nil || *pre[0].Left != `use Old\Thing;` ||
		*pre[1].Right != `use App\Rules\Fresh;` || pre[1].NewLine != 6 {
		t.Fatalf("rules prefix = %+v", pre)
	}
	if len(plan.prefixFor(other)) != 0 {
		t.Errorf("other must get no imports: %+v", plan.prefixFor(other))
	}
	if !plan.empty[hdr.ID()] || len(plan.hidden[hdr.ID()]) != 2 {
		t.Errorf("header fully inlined: empty=%v hidden=%v", plan.empty[hdr.ID()], plan.hidden[hdr.ID()])
	}
	if plan.empty[nsHdr.ID()] || len(plan.hidden[nsHdr.ID()]) != 0 {
		t.Errorf("namespace-only header must stay as is")
	}

	// The canonical rows: rules starts with the two import rows, the header
	// counts nothing anymore, and the totals agree.
	rows, _, _ := prBlockRows(baseDir, headDir, rules, blocks)
	body, _, _ := blockAlignedRows(baseDir, headDir, rules)
	if len(rows) != len(body)+2 || !rows[0].imp || rows[2].imp {
		t.Fatalf("rules rows: %d vs body %d", len(rows), len(body))
	}
	if got := countChangedRows(rows); got != countChangedRows(body)+2 {
		t.Errorf("rules total %d", got)
	}
	hrows, _, _ := prBlockRows(baseDir, headDir, hdr, blocks)
	if got := countChangedRows(hrows); got != 0 {
		t.Errorf("header total %d, want 0", got)
	}

	// A file line on an inlined `use` maps into the user block's prefix row.
	hRow, ok := rowForLineIn(baseDir, headDir, hdr, blocks, 6, "RIGHT")
	if !ok {
		t.Fatal("no header row for line 6")
	}
	ub, ur, moved := redirectInlinedImport(baseDir, headDir, hdr, blocks, hRow)
	if !moved || ub.ID() != rules.ID() || ur != 1 {
		t.Errorf("redirect = %s %d %v", ub.ID(), ur, moved)
	}
	// A body line of rules still maps past the prefix.
	if r, ok := rowForLineIn(baseDir, headDir, rules, blocks, 12, "RIGHT"); !ok || strings.TrimSpace(*rows[r].right) != "return [new Thing(), new Fresh()];" {
		t.Errorf("body line 12 → row %d ok=%v", r, ok)
	}
}
