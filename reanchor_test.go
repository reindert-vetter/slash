package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/approvals"
	"slash/modules/comments"
	"slash/modules/github"
)

// reanchor_test.go covers the matcher in reanchor.go: given the worktree pair a
// refresh left behind, does each stored anchor move with its code, and does it
// degrade the way it's supposed to when it can't?
//
// Every case writes real files into a base/head worktree pair (writeWorktreeFile,
// shared with comment_import_test.go) so the aligned rows come out of the same
// blockAlignedRows the app itself uses — never a hand-built row list, which could
// silently drift from the real alignment.

// fooPHP renders the fixture class with the given body lines inside total().
func fooPHP(body ...string) string {
	src := "<?php\nclass Foo {\n    public function total() {\n"
	for _, l := range body {
		src += "        " + l + "\n"
	}
	return src + "    }\n}\n"
}

// bodySnippet renders one body line of the fixture the way it actually appears in
// the aligned rows — and therefore the way commentTarget (home.mjs) would have
// stored it: dedent4 (blockstats.go) strips the 4 spaces every line of the block
// shares, so the fixture's 8-space body indent shows up as 4. Only the call-segment
// check compares this byte-for-byte; the row match itself is
// whitespace-insensitive, so it wouldn't notice either way.
func bodySnippet(line string) string { return "    " + line }

func fooBlock(pr int) Block {
	return Block{PR: pr, File: "Foo.php", Class: "Foo", Name: "total",
		Line: 3, EndLine: 6, Label: "Foo::total", Status: "modified", Side: "new"}
}

// anchoredComment is a comment pinned to rowStart..rowEnd with code as its stored
// snippet — the shape taskCodeCommentWorkflow's saveComment writes.
func anchoredComment(pr int, code string, rowStart, rowEnd int) comments.Comment {
	return comments.Comment{
		ID: "c1", RunID: "c1", PR: pr, File: "Foo.php", Label: "Foo::total",
		Body: "why?", Gran: "line", Code: code, RowStart: rowStart, RowEnd: rowEnd,
	}
}

// A line comment whose code is untouched but has moved down (a line inserted
// above it) re-anchors onto its new row.
func TestReanchorCommentFollowsShiftedRow(t *testing.T) {
	dir, pr := t.TempDir(), 940001
	// base == the previous head; the new head inserts a line above `return $x;`.
	old := fooPHP("$x = 1;", "return $x;")
	head := fooPHP("$x = 1;", "$x++;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)

	// In the OLD rows `return $x;` sat on row 2 (decl, $x = 1;, return).
	c := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)})

	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	u := got[0]
	if u.AnchorState != comments.AnchorPinned {
		t.Errorf("anchorState = %q, want pinned", u.AnchorState)
	}
	if u.RowStart != 3 || u.RowEnd != 3 {
		t.Errorf("rows = %d..%d, want 3..3 (one line inserted above)", u.RowStart, u.RowEnd)
	}
	if u.Gran != "line" {
		t.Errorf("gran = %q, want line (unchanged)", u.Gran)
	}
}

// An anchor that still resolves to the very same rows produces NO update, so a
// repeated refresh is a no-op instead of a burst of identical Signals.
func TestReanchorUnchangedAnchorEmitsNothing(t *testing.T) {
	dir, pr := t.TempDir(), 940002
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)

	c := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	if got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)}); len(got) != 0 {
		t.Fatalf("updates = %+v, want none", got)
	}
}

// The anchored code itself was edited away: there is nothing to move onto, so the
// comment unpins (rowStart -1) — visible anywhere in its block — rather than
// silently keeping a row that now shows different code.
func TestReanchorEditedCodeUnpins(t *testing.T) {
	dir, pr := t.TempDir(), 940003
	old := fooPHP("$x = 1;", "return $x;")
	head := fooPHP("$x = 1;", "return $x * 2 + 7;")
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)

	c := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)})

	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	if got[0].AnchorState != comments.AnchorUnpinned || got[0].RowStart != -1 || got[0].RowEnd != -1 {
		t.Errorf("got %+v, want unpinned with rows -1..-1", got[0])
	}
}

// A snippet that occurs several times in the new rows is ambiguous; guessing would
// move the comment somewhere the reviewer never put it, so it unpins too.
func TestReanchorAmbiguousSnippetUnpins(t *testing.T) {
	dir, pr := t.TempDir(), 940004
	old := fooPHP("$x = 1;", "return $x;")
	head := fooPHP("$x = 1;", "if ($x) {", "return $x;", "}", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)

	c := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)})

	if len(got) != 1 || got[0].AnchorState != comments.AnchorUnpinned {
		t.Fatalf("got %+v, want a single unpinned update", got)
	}
}

// A re-indent is not a content change: the line alignment itself pairs lines
// whitespace-insensitively (diffLines/wsKey), so the anchor must follow it rather
// than treat the line as gone.
func TestReanchorFollowsReindentedRow(t *testing.T) {
	dir, pr := t.TempDir(), 940005
	old := fooPHP("$x = 1;", "return $x;")
	// Same two statements, wrapped in a condition so both get an extra indent.
	head := "<?php\nclass Foo {\n    public function total() {\n        if (true) {\n            $x = 1;\n            return $x;\n        }\n    }\n}\n"
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)

	c := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)})

	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	if got[0].AnchorState != comments.AnchorPinned {
		t.Errorf("anchorState = %q, want pinned — a re-indent must not unpin", got[0].AnchorState)
	}
}

// The symbol is gone from the PR entirely: no rows to re-derive, so the comment is
// marked orphan (and keeps its old rows as a record of where it was) instead of
// becoming invisible in every view.
func TestReanchorMissingSymbolOrphans(t *testing.T) {
	dir, pr := t.TempDir(), 940006
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)

	c := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	// The refresh left the file with a differently-named method, so no block of
	// the PR carries the comment's label any more.
	other := Block{PR: pr, File: "Foo.php", Class: "Foo", Name: "subtotal",
		Line: 3, EndLine: 6, Label: "Foo::subtotal", Status: "added", Side: "new"}
	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{other})

	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	if got[0].AnchorState != comments.AnchorOrphan {
		t.Errorf("anchorState = %q, want orphan", got[0].AnchorState)
	}
	if got[0].RowStart != 2 {
		t.Errorf("rowStart = %d, want the old 2 kept as a record", got[0].RowStart)
	}
}

// A comment written before the PR moved its file re-attaches through the block's
// pre-rename path instead of orphaning.
func TestReanchorMatchesRenamedFile(t *testing.T) {
	dir, pr := t.TempDir(), 940007
	src := fooPHP("$x = 1;", "return $x;")
	// The base worktree still holds the file at its old path, the head at the new.
	baseDir, headDir := worktreeDirs(dir, pr)
	writeFileT(t, filepath.Join(baseDir, "Old/Foo.php"), src)
	writeFileT(t, filepath.Join(headDir, "New/Foo.php"), src)

	moved := Block{PR: pr, File: "New/Foo.php", OldFile: "Old/Foo.php",
		Class: "Foo", Name: "total", Line: 3, EndLine: 6, Label: "Foo::total"}
	c := comments.Comment{ID: "c1", RunID: "c1", PR: pr, File: "Old/Foo.php",
		Label: "Foo::total", Gran: "line", Code: bodySnippet("return $x;"), RowStart: 9, RowEnd: 9}

	got := planCommentReanchor(dir, pr, []string{"Old/Foo.php"}, []comments.Comment{c}, []Block{moved})
	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	if got[0].AnchorState != comments.AnchorPinned || got[0].RowStart != 2 {
		t.Errorf("got %+v, want pinned on row 2 via the pre-rename path", got[0])
	}
}

// A 'call' anchor addresses character offsets within its row, so it only survives
// while the row's text is byte-identical. A re-indent moves those offsets, so the
// comment degrades to the whole line — still the right line, one step coarser.
func TestReanchorCallSegmentDemotesOnReindent(t *testing.T) {
	dir, pr := t.TempDir(), 940008
	old := fooPHP("return $this->order()->total();")
	head := "<?php\nclass Foo {\n    public function total() {\n        if (true) {\n            return $this->order()->total();\n        }\n    }\n}\n"
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)

	c := comments.Comment{ID: "c1", RunID: "c1", PR: pr, File: "Foo.php", Label: "Foo::total",
		Gran: "call", Seg: "r:15-24", Code: bodySnippet("return $this->order()->total();"), RowStart: 1, RowEnd: 1}

	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)})
	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	if got[0].Gran != "line" || got[0].Seg != "" {
		t.Errorf("got gran=%q seg=%q, want line with no segment", got[0].Gran, got[0].Seg)
	}
	if got[0].AnchorState != comments.AnchorPinned {
		t.Errorf("anchorState = %q, want pinned — the line itself was found", got[0].AnchorState)
	}
}

// A 'call' anchor whose row is byte-identical keeps its segment: the character
// offsets still address the same characters.
func TestReanchorCallSegmentSurvivesPureShift(t *testing.T) {
	dir, pr := t.TempDir(), 940009
	old := fooPHP("return $this->order()->total();")
	head := fooPHP("$x = 1;", "return $this->order()->total();")
	writeWorktreeFile(t, dir, pr, "Foo.php", old, head)

	c := comments.Comment{ID: "c1", RunID: "c1", PR: pr, File: "Foo.php", Label: "Foo::total",
		Gran: "call", Seg: "r:15-24", Code: bodySnippet("return $this->order()->total();"), RowStart: 1, RowEnd: 1}

	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{c}, []Block{fooBlock(pr)})
	if len(got) != 1 {
		t.Fatalf("updates = %d, want 1: %+v", len(got), got)
	}
	if got[0].Gran != "call" || got[0].Seg != "r:15-24" {
		t.Errorf("got gran=%q seg=%q, want the call segment preserved", got[0].Gran, got[0].Seg)
	}
	if got[0].RowStart != 2 {
		t.Errorf("rowStart = %d, want 2", got[0].RowStart)
	}
}

// A PR-wide comment has no row anchor, and a comment in a file the refresh didn't
// touch still lines up — neither may produce an update.
func TestReanchorSkipsPRWideAndUntouchedFiles(t *testing.T) {
	dir, pr := t.TempDir(), 940010
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)

	prWide := comments.Comment{ID: "c1", RunID: "c1", PR: pr, File: "Foo.php",
		Kind: "issue", Body: "general", RowStart: -1, RowEnd: -1}
	elsewhere := anchoredComment(pr, bodySnippet("return $x;"), 2, 2)
	elsewhere.ID, elsewhere.RunID, elsewhere.File = "c2", "c2", "Other.php"

	got := planCommentReanchor(dir, pr, []string{"Foo.php"}, []comments.Comment{prWide, elsewhere}, []Block{fooBlock(pr)})
	if len(got) != 0 {
		t.Fatalf("updates = %+v, want none", got)
	}
}

// Approvals store no snippet, so their old rows are rebuilt from the previous
// sides: an approved row whose text still exists moves to its new index, and one
// whose code was replaced is dropped — you did not approve what took its place.
func TestReanchorApprovalsRemapAndDrop(t *testing.T) {
	dir, pr := t.TempDir(), 940011
	// Previous head: two changed lines. New head: a line inserted above them and
	// the second one rewritten.
	prevSrc := fooPHP("$x = 1;", "return $x;")
	newSrc := fooPHP("$x = 1;", "$x++;", "return $x * 2;")
	writeWorktreeFile(t, dir, pr, "Foo.php", prevSrc, newSrc)
	// The "previous" pair a shadow worktree would have produced: both sides at the
	// old head, so every old row is a context row carrying the old text.
	oldBase, oldHead := t.TempDir(), t.TempDir()
	writeFileT(t, filepath.Join(oldBase, "Foo.php"), prevSrc)
	writeFileT(t, filepath.Join(oldHead, "Foo.php"), prevSrc)

	b := fooBlock(pr)
	baseDir, headDir := worktreeDirs(dir, pr)
	// Rows 1 and 2 of the old space are `$x = 1;` and `return $x;`.
	ap := approvals.Approval{PR: pr, BlockID: b.ID(), Rows: []int{1, 2}, Calls: []string{"2:15"}}

	got := planApprovalRemap(baseDir, headDir, oldBase, oldHead,
		[]approvals.Approval{ap}, []Block{b}, map[string]bool{"Foo.php": true})

	if len(got) != 1 {
		t.Fatalf("remaps = %d, want 1: %+v", len(got), got)
	}
	// `$x = 1;` still exists (row 1); `return $x;` became `return $x * 2;` and is
	// gone, so only one row survives.
	if len(got[0].Rows) != 1 || got[0].Rows[0] != 1 {
		t.Errorf("rows = %v, want [1] — the rewritten line's approval must drop", got[0].Rows)
	}
	// The call key hung off the dropped row, so it goes with it.
	if len(got[0].Calls) != 0 {
		t.Errorf("calls = %v, want none", got[0].Calls)
	}
}

// An approval set that still maps onto exactly the same rows produces no remap.
func TestReanchorApprovalsUnchangedEmitsNothing(t *testing.T) {
	dir, pr := t.TempDir(), 940012
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)
	oldBase, oldHead := t.TempDir(), t.TempDir()
	writeFileT(t, filepath.Join(oldBase, "Foo.php"), src)
	writeFileT(t, filepath.Join(oldHead, "Foo.php"), src)

	b := fooBlock(pr)
	baseDir, headDir := worktreeDirs(dir, pr)
	ap := approvals.Approval{PR: pr, BlockID: b.ID(), Rows: []int{1, 2}}

	got := planApprovalRemap(baseDir, headDir, oldBase, oldHead,
		[]approvals.Approval{ap}, []Block{b}, map[string]bool{"Foo.php": true})
	if len(got) != 0 {
		t.Fatalf("remaps = %+v, want none", got)
	}
}

// An approval whose old side can't be read (no previous revision on disk) is left
// completely alone rather than having its rows dropped on a guess.
func TestReanchorApprovalsKeepsUnreadableOldSide(t *testing.T) {
	dir, pr := t.TempDir(), 940013
	src := fooPHP("$x = 1;", "return $x;")
	writeWorktreeFile(t, dir, pr, "Foo.php", src, src)

	b := fooBlock(pr)
	baseDir, headDir := worktreeDirs(dir, pr)
	empty := t.TempDir() // nothing written: git show found the path at neither SHA
	ap := approvals.Approval{PR: pr, BlockID: b.ID(), Rows: []int{1, 2}}

	got := planApprovalRemap(baseDir, headDir, empty, empty,
		[]approvals.Approval{ap}, []Block{b}, map[string]bool{"Foo.php": true})
	if len(got) != 0 {
		t.Fatalf("remaps = %+v, want none (leave the approval untouched)", got)
	}
}

// SetAnchor moves the stored anchor and its Path's codeRef together, so a prefix
// Search keeps finding the comment under the unit it now actually hangs on.
func TestSetAnchorRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cs, err := comments.Open(filepath.Join(dir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	ctx := t.Context()

	c := comments.Comment{ID: "c1", RunID: "c1", PR: 940014, File: "Foo.php", Label: "Foo::total",
		Body: "why?", Gran: "call", Seg: "r:1-4", RowStart: 2, RowEnd: 2,
		Path: "/pr-940014/Foo.php/Foo::total/call-2-r:1-4/comment-c1"}
	if err := cs.Save(ctx, c); err != nil {
		t.Fatal(err)
	}
	newPath := "/pr-940014/Foo.php/Foo::total/line-5/comment-c1"
	if err := cs.SetAnchor(ctx, "c1", 5, 5, "", "line", comments.AnchorPinned, newPath); err != nil {
		t.Fatal(err)
	}

	got, err := cs.List(ctx, 940014)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("comments = %d, want 1", len(got))
	}
	if got[0].RowStart != 5 || got[0].RowEnd != 5 || got[0].Seg != "" || got[0].Gran != "line" {
		t.Errorf("anchor = %+v, want rows 5..5, no seg, gran line", got[0])
	}
	if got[0].Path != newPath {
		t.Errorf("path = %q, want %q", got[0].Path, newPath)
	}
	// The snippet is what the matcher searches for next time — never rewritten.
	if got[0].Body != "why?" {
		t.Errorf("body = %q, want it untouched", got[0].Body)
	}

	// And the moved comment is findable under its new unit prefix, not the old one.
	under, err := cs.Search(ctx, "/pr-940014/Foo.php/Foo::total/line-5")
	if err != nil {
		t.Fatal(err)
	}
	if len(under) != 1 {
		t.Errorf("prefix search under the new unit found %d, want 1", len(under))
	}
}

// The write path end to end: a "reanchor" ReactionSignal on a live comment
// Execution moves the stored anchor AND rewrites its Path's codeRef, so a prefix
// search keeps finding the comment under the unit it now hangs on. The reply loop
// must treat it as pure metadata — no reaction stored, thread untouched.
func TestReanchorSignalMovesStoredAnchor(t *testing.T) {
	dir := t.TempDir()
	cs, err := comments.Open(filepath.Join(dir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t),
		nil, nil, nil, nil, nil, nil, nil, nil, dir, "test/repo")

	ctx := context.Background()
	pr := 940016
	in := CodeCommentInput{PR: pr, File: "Foo.php", Label: "Foo::total", Line: 4,
		Body: "why?", Gran: "line", Code: bodySnippet("return $x;"), RowStart: 2, RowEnd: 2, Local: true}
	runID, err := engine.StartWorkflow(WorkflowTaskCodeComment, in)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(ctx, pr)
		return len(got) == 1 && got[0].RowStart == 2
	})

	if err := m.Signal(runID, ReactionSignal{
		ID: "sys-1", Source: "system", Action: "reanchor",
		Anchor: &commentAnchorUpdate{RowStart: 5, RowEnd: 5, Gran: "line", AnchorState: comments.AnchorPinned},
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(ctx, pr)
		return len(got) == 1 && got[0].RowStart == 5
	})

	got, err := cs.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	c := got[0]
	if c.RowEnd != 5 || c.Gran != "line" {
		t.Errorf("anchor = rows %d..%d gran %q, want 5..5 line", c.RowStart, c.RowEnd, c.Gran)
	}
	// The path's codeRef moved with it, so the unit prefix search follows.
	if want := "/pr-940016/Foo.php/Foo::total/line-5/comment-" + runID; c.Path != want {
		t.Errorf("path = %q, want %q", c.Path, want)
	}
	// Pure metadata: no reaction stored, body and stored snippet untouched.
	if c.ReactionCount != 0 || len(c.Reactions) != 0 {
		t.Errorf("reactions = %d/%d, want none — a reanchor is not a reply", c.ReactionCount, len(c.Reactions))
	}
	if c.Body != "why?" || c.Code != bodySnippet("return $x;") {
		t.Errorf("body/code changed: %q / %q", c.Body, c.Code)
	}

	// And the thread is still alive: an ordinary reply after a reanchor still lands.
	if err := m.Signal(runID, ReactionSignal{ID: "r1", Source: "ui", Author: "reviewer", Body: "ack"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cs.List(ctx, pr)
		return len(got) == 1 && got[0].ReactionCount == 1
	})
}

// An orphan mark round-trips through the read model and reaches the API shape the
// frontend reads (anchorState).
func TestAnchorStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cs, err := comments.Open(filepath.Join(dir, "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	ctx := t.Context()

	if err := cs.Save(ctx, comments.Comment{ID: "c1", RunID: "c1", PR: 940015,
		File: "Foo.php", Label: "Foo::gone", Body: "orphaned", RowStart: 2, RowEnd: 2}); err != nil {
		t.Fatal(err)
	}
	if err := cs.SetAnchor(ctx, "c1", 2, 2, "", "line", comments.AnchorOrphan, ""); err != nil {
		t.Fatal(err)
	}
	got, err := cs.List(ctx, 940015)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].AnchorState != comments.AnchorOrphan {
		t.Fatalf("anchorState = %+v, want orphan", got)
	}
}
