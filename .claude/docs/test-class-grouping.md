# Grouping test methods per class (`test_class` rows + the methodes-kolom)

Every TEST-category block (a PHP test method, or the `<class-header>` sentinel —
see `phpscan.go`/`classify.go`) sharing the same `file + '::' + class` groups into
**one synthetic sidebar row**: `TriggersIndexTest` with a combined pill, not five
separate `TriggersIndexTest::it_should_…` rows. This mirrors the `kind:'comment'`
synthetic-row mechanism (`.claude/docs/comments-panel.md`) but inserts a **new,
always-present column** between the pr-index and the diff instead of replacing
the diff card.

## The synthetic row

`testClassRowItem`/`groupTestClasses` (`home.mjs`, called from
`recomputeLeftList`) build
`{ id: 'testclass:'+file+'::'+class, kind: 'test_class',
label: class || file's basename, methods: [...] }` — grouped on `file + class`
(never the bare class name: two same-named classes in different files must not
merge), **always**, even for a class with a single changed method (a deliberate,
discussed choice: a predictable flow, no special-cased exception).

The member methods disappear from `state.blocks` exactly the way a resolved-call
target already does (`hidden = resolvedCallTargetIds()`) but stay untouched in
`state.allBlocks`, so every mechanism reading `state.allBlocks` directly
(`coveredByChildren`, `resolvedTestCoverChildren`, drilling via `blockId`) needs
no change. A `<class-header>` sentinel is grouped in too and gets a readable label
in the methodes-kolom (`methodLabel` in `TestMethodsColumn.mjs`: "Class-header",
never the raw `<class-header>` name).

## `curBlock()` resolves through the active method

```js
function curBlock() {
  const row = curTestClassRow()
  return row ? row.methods[state.classMethodSel] || null : state.blocks[state.selected]
}
```

`state.classMethodSel` indexes the selected row's `.methods`. This single
load-bearing abstraction lets every existing block-centric mechanism
(`ensureCode`, approve, comments, drilling, the footer, call-arrows,
`findNextUnapproved`) keep working **unchanged** on whichever method is active —
none of them had to learn that test classes exist.

Only the functions that step **between** top-level `state.blocks` entries
(`sameFileNeighbour`/`stepBlock`, the sidebar's own ↑/↓) still read
`state.blocks[state.selected]` directly, on purpose — they guard
`kind === 'test_class'` on both sides exactly like they already guard
`kind === 'comment'`, so a class row never gets a same-file connector to an
adjacent row. Decision: two test classes in the same file get no connector
either — a third kind of flow-through for a rare case isn't worth it.

## The methodes-kolom (stop 2b)

Rendered by `TestMethodsColumn.mjs` directly in `<main>`'s column flow, to the
**left** of the diff card (`data-testid=test-methods-column`,
`state.testColumnFocused`). Stop 2b of the left→right nav chain (see
`.claude/docs/keyboard-navigation.md`).

- **Always visible in list mode** as soon as a `test_class` row is selected, next
  to the existing diff preview (decision: no separate reveal-on-`→` step, unlike
  drilling), but **hidden in diff mode**: `→` into the active method's diff
  removes the column exactly like the pr-index slides away, and `←` brings it
  straight back (`state.testColumnFocused` survives the transition).
- Focusing the column with the first `→` also slides the **pr-index** away
  (`BlockList.mjs`'s translate ternary gained a `state.testColumnFocused` branch
  next to `mode==='diff'`, and `<main>`'s left ternary moves to `left-0` in
  lockstep) — stepping right past a column hides it, `←` reverses one stop at a
  time.
- The look-ahead **preview** slot (the next sidebar row, dimmed) gets a small,
  non-interactive summary card instead (`testClassPreviewCard`, `home.mjs`) — the
  full interactive column only renders for the actually-selected row.
- Each method row shows its own approve pill + status mark (parity with the
  individual rows that disappeared — the reviewer must not lose information) and
  highlights the active method; no search field of its own.
- `f`/`d`/`s`/`a` are a deliberate no-op while this column owns the keyboard
  (`isTestColumnActive`) — no diff context to zoom/toggle, mirroring stop 1.
- The column and its method rows follow the app-wide indigo focus border /
  selected-row tint — see "Focus highlight per stop" in
  `.claude/docs/keyboard-navigation.md`.

## Keyboard

- **`→`** on a selected class row (pr-index, stop 2) first moves focus onto the
  methodes-kolom without changing `state.mode`; a **second** `→` steps into the
  diff of the active method, exactly like `→` on an ordinary block from stop 2.
- **`Enter` does NOT mirror `→`** — it opens the ordinary block-scoped command
  palette (see `.claude/docs/command-palette.md`), the same one that opens on
  `Enter` when the `test_class` row itself is selected: `curBlock()` already
  resolves to the active method regardless of `testColumnFocused`, so the generic
  `openMenu('block')` branch just falls through. Only `→` steps into the diff.
- **`←`** from that diff steps back onto the methodes-kolom (not all the way to
  the pr-index — `state.testColumnFocused` simply survives the
  `mode: 'diff' → 'list'` transition); a **second** `←` leaves the column.
- Within the column, **`↑`/`↓`** walk the class's own methods; at the class edges
  they **exit back to the index and step exactly ONE row** — the next/previous
  visible row, **also a non-test row**, via `stepVisibleSelected` + `selectRow` in
  `onKeydown`'s `isTestColumnActive()` branch, so the index owns the keyboard
  again. No further row → clamp (nothing happens, the column keeps the keyboard —
  never a fall-through into the toggle-rows/search-box loop). This replaced, on
  explicit request, an earlier list-mode flow-through that jumped to the
  first/last method of the next/previous `test_class` row and skipped every
  non-test row in between; index navigation is per row/class, never per method.
- **The cross-class flow-through does still apply inside the diff**
  (`stepTestMethod`, now only called by `stepTestMethodChange`): stepping past the
  last/first change of one method first tries the next/previous method of the
  **same** class, then the next/previous class row, before falling back to the
  coarser same-file `stepBlock` path (which never applies to a `test_class` row
  itself, only to its active method's diff — and `sameFileNeighbour` excludes
  `test_class` rows on both sides anyway).

Any keyboard action that deliberately changes the top-level selection (a sidebar
click, `stepListSelection`, `setSearch`, `clampSelectedToVisible`) resets
`state.classMethodSel`/`testColumnFocused` to their defaults via the shared
`selectRow` helper (`home.mjs`) — a stale "which method"/"is the column focused"
must never leak onto whatever gets selected next.

## `findNextUnapproved` and the remaining methods

`findNextUnapproved`/`applyNextUnapproved` got a `methodIdx` field on their
landing plan: a `test_class` candidate is searched method-by-method (continuing
through the REMAINING methods of the currently active class before moving to a
different top-level row), and landing on a different method automatically opens
the column and selects it, exactly like "Ga door" already opens a drilled column.

**This "remaining methods" search runs regardless of whether the reviewer ever
stepped into the active method's diff.** It used to sit inside
`findNextUnapproved`'s `inDiff` gate, so approving a method straight from the list
(the ordinary way to review a small freshly-ADDED test method) never looked at its
siblings and wrongly reported nothing left to approve. See
"`findNextUnapproved()`'s 'descend into children / walk sideways' steps run
regardless of `inDiff`" in `.claude/docs/command-palette.md` and
`tests/findnextunapproved-list-mode.spec.mjs`.

**Approving a method straight from the list (Space, or the palette's "Keur
... goed") jumps to the next unapproved method exactly like the general
blokken-index jumps to the next unapproved block** — `applyNextUnapproved`'s
`keepList` branch (`state.mode` was `'list'`, not `'diff'`, see
`.claude/docs/command-palette.md`'s "EXCEPTION 2") sets `state.classMethodSel`
to `target.methodIdx` **and keeps `state.testColumnFocused` TRUE**, so the
methodes-kolom stays focused/highlighted and keeps owning `↑`/`↓`
(`isTestColumnActive()`) right after the jump — the reviewer was already
working that column, so the jump must not silently hand keyboard ownership
back to the pr-index. `spaceKey`'s own "already approved → just continue"
branch captures `keepList` (`state.mode !== 'diff'`) the same synchronous way
`afterApproveAction` does and merges it into the plan for the same reason:
without it, `applyNextUnapproved`'s non-`keepList` path unconditionally sets
`state.mode = 'diff'`, so pressing Space on an already-done method while still
in the list forced the diff open instead of just moving the cursor. Test:
`tests/test-class-grouping.spec.mjs` ("Space on a method row jumps to the
next unapproved method and keeps the column focused" / "...stays in the list
instead of forcing the diff open").

## Approve rollup — two deliberately different numbers

`blockApproveCount`/`subtreeApproveCount` (`home.mjs`), reconciled rather than in
conflict:

- The class row's own **sidebar pill** (and the methodes-kolom's header pill) sums
  only its methods' **own** changed rows (`blockApproveCount`'s `test_class`
  branch: `Σ blockApproveCount(method)`, no recursion into a method's
  Onderliggende-code subtree) — a product decision to keep that pill narrow.
- The **PR-wide** "X/Y goedgekeurd" header (`state.approvalTotal`) must not lose
  what a method's subtree contributed before grouping (a resolved-but-hidden
  method-call target, a `covers` child), so `subtreeApproveCount`'s `test_class`
  branch sums the FULL `Σ subtreeApproveCount(method)` — mathematically identical
  to the pre-grouping sum (grouping changes only how the terms are iterated).

The one watch that fills both stores the **narrow** value into
`approvalSummaries[row.id]` for display while adding the **full** value into the
running `done`/`total` sum — two numbers computed side by side in the same loop
iteration. See `.claude/docs/approval.md` for the generic rollup and
`tests/test-class-grouping.spec.mjs` ("approving a method rolls up into the class
pill, and the PR-wide total stays correct").

## Approving the whole class in one action

The methodes-kolom header's `done/total methodes` pill (fed by the same
`approvalSummaries[row.id]` above) doubles as a checkbox
(`data-testid=test-class-approve-checkbox`, `TestMethodsColumn.mjs`) — the
class-level counterpart of `Block.mjs`'s top checkbox
(`blockApproved`/`blockPartlyApproved`/`toggleBlockApproval`, see
`.claude/docs/approval.md`): checked once every method is fully approved,
indeterminate while partial, a click approves or clears **every** method of
the class in one action (`toggleTestClassApproval`, `home.mjs`) instead of
having to step through each method individually.

Only the currently **active** method has its code loaded (`curBlock()`/
`ensureCode`, lazy per method) — the rest have no fetched diff yet, so
`blockRows(m)`/`changedRows(...)` would be empty for them. Approving therefore
first `await`s `ensureCode(m)` for every method (a no-op for one already
loaded/loading, see `codeRequested`) before computing each method's full
changed-row set; clearing needs no such wait, it just sets every method's
`approvedRows` to `[]`. Each method is persisted individually through the
existing single-block `approve` Signal (`persistApproval`) — the class
checkbox issues one Signal per method, never a batch/direct write. Same scope
decision as the block checkbox: no `afterApproveAction`/postApprove-menu
follow-up, this is a bulk toggle, not a step in the review flow.

Test: `tests/test-class-grouping.spec.mjs` ("the class checkbox approves every
method, and clears them again").

## URL state

`?sel=testclass:<file>::<class>` mirrors the selected class row
(`state.blockRef`, exactly like `comment:<id>` does — `applyTestClassRefRestore`,
`home.mjs`); a separate `?tmethod=<file:line>` mirrors which method is active
(`state.testMethodRef`, resolved in the same restore call). Not found
(stale/shared link) → the same silent not-found fallback as every other restore
path.

## `openTask`

A "Taken" row pointing at a comment placed on a test method searches every
`test_class` row's own `.methods` once a direct top-level match fails — a comment
on a grouped method would otherwise never be found.

Test: `tests/test-class-grouping.spec.mjs` (grouping itself, the always-visible
methodes-kolom in list mode, the `→`/`←`/`↓` mechanics, a single-method class,
and the approve-rollup reconciliation).
