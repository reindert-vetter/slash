# Reviewer approval & its counters

Everything about approving code and the numbers derived from it: the granular
row/call-segment model, how it is persisted, how it rolls up over the review
tree, and the indicators that show it. Split out of
`.claude/rules/blocks-and-ingest.md`.

## Granular model: `approvedRows` + `approvedCalls`

Approval is **not** a single block flag. `b.approvedRows` is an array of row
indices in `blockRows(b)` (see "Old/new line alignment" in
`.claude/rules/diff-render.md`); every granularity reduces to that (a group
approves all its rows, a `line`/`call` the one row it's on), so "is the whole
block approved?" is simply "are *all* changed rows approved?"
(`blockApproved`/`blockPartlyApproved`/`changedRows`/`approvedRowSet` in
`Block.mjs`). The `blocks` table still has an `approved` column (0/1), but the
real state lives in the `approvals` read model (see below).

The top checkbox on the block card is therefore **derived**: checked when
`blockApproved`, indeterminate when partial, with an `approve <done>/<total>`
counter; clicking approves or clears everything. A fully approved row shows a
small emerald **checkmark** in the left margin (the active indigo bar wins while
the cursor sits on it).

**Call segments are finer than a row.** At `call` level one row can hold several
segments (`segmentCalls`), so `b.approvedCalls` holds `${row}:${segStart}` keys
(`callKey`/`approvedCallSet`/`rowCallSegments` in `Block.mjs`) alongside
`b.approvedRows`. Once every segment of a row is approved that row **graduates**
into `b.approvedRows` (its keys disappear from `approvedCalls`) so the coarser
group/line approval and the block checkbox simply see it; withdrawing one
segment of an already-full row splits it back into explicit keys
(`toggleCallApprove` in `home.mjs`).

While a row is *partially* approved (not 0, not all) it shows a dot per segment
on a second, compact row below — aligned under the segment column via literal
spaces (no JS measurement needed, the code is monospace): an approved segment
gets a **solid green** dot, a pending one an **open** dot, so the row reads as a
progress strip. Nothing approved → nothing shown; everything approved → dots go
away and the checkmark returns (`partialCallApproval`/`circleRowHTML` in
`Block.mjs`). Both panes compute the dots row from the same deterministic input,
so they insert it at the same row index and stay aligned.

`b.approvedRows`/`b.approvedCalls` are always **reassigned**, never mutated in
place, so arrow.js re-renders the checkbox and the indicators.

## Durable persistence (client side)

Approval survives a refresh via the `approvals` read model
(`data/approvals.db`), fed by the `approve` workflow — **not** the URL (too
large/too volatile). `home.mjs`'s `loadApprovals` ensures the tracker on load
(`POST /api/workflows/approve {pr}` → runId in `state.approveRunId`) and
restores every block's arrays from `GET /api/approvals?pr=N`. Every mutation
(`toggleApprove`/`toggleCallApprove`, plus the card checkbox via `Block.mjs`'s
`onApprove` callback) sends, after the local reassignment, the **complete** set
for that block as a Signal (`POST /api/workflows/{runId}/signals/set {blockId,
rows, calls}`, `persistApproval`). The UI never writes directly — only this
Signal, within the write boundary. See "Persisting reviewer approval" in
`.claude/rules/workflows-trackers.md`.

## Placing a comment retracts the approval it hangs on

`revokeApprovalForComment` (`home.mjs`): a reviewer who comments on an
already-approved unit is saying "this isn't OK after all", so that anchor's
approval is retracted right after the comment is placed — via the same `set`
Signal, never a direct write. Hooked into **both** `COMPOSE_COMMANDS` items that
actually place a comment ("Plaats comment" and "Alleen voor mijzelf" — a private
note counts, the reviewer is still flagging the code). A **reply** in an
existing thread (`sendReaction`) retracts nothing.

Both call sites capture `focusedBlock()` + `commentTarget()` **before** the
`await placeComment(...)`, so the revoke targets the block/unit the comment was
actually anchored to — including a drilled column, mirroring `approveContext()`'s
own `focusLevel` handling (see `.claude/rules/command-palette.md`).

- `gran !== 'call'` (group/line, or a TRANSLATION per-key unit — same aligned-row
  range): every row in `[t.rowStart, t.rowEnd]` drops from `b.approvedRows`, plus
  any `b.approvedCalls` entry whose row falls in that range (a coarser comment
  supersedes a finer partial call approval).
- `gran === 'call'`: only the **one** segment the comment sits on (via `t.seg`,
  the same `segKey()` `commentTarget()` computed) loses approval; sibling
  segments keep theirs, and a row that had graduated into `b.approvedRows` is
  first expanded back into explicit per-segment keys (mirrors
  `toggleCallApprove`'s "wasFullRow" branch).

A comment created by the system itself (an imported GitHub comment, an AI
`code_warning` finding) never triggers this — those come from a backend Activity,
not this frontend `placeComment`/`createComment` path. Test:
`tests/comment-revokes-approval.spec.mjs`.

## Combined approval per tree (sidebar + Underlying code)

The sidebar shows a pill per top-level block (`data-testid=block-approval`) with
`done/total` for that block **plus every descendant block** — its relation
children and the PR-block definitions of its resolved/found method calls,
transitively. `home.mjs` rolls this up (`blockApproveCount` per block →
`subtreeApproveCount` over `[b, ...nestedPrBlocks(b)]`) and pushes it via a
`watch` into `state.approvalSummaries` (id→`{done,total}`).

**Deliberately decoupled from the render** (like `setRelated`/`setCommentScope`):
the sidebar reads a flat snapshot instead of every block's `b.code`, which would
make it a co-subscriber on the selected block's `b.code` and re-trigger the
diff's "stuck on loading" race (see `.claude/rules/arrowjs-pitfalls.md`).

`done` comes from the approved row indices; **`total`** comes server-side from
`GET /api/blockstats?pr=N` (see below), with a client-side fallback to
`changedRows(blockRows(b))` until the stats land. Green with a ✓ once
`done === total`, otherwise neutral; hidden only at `total === 0`.

The same `{done,total}` hangs off each child in the Underlying-code card
(`data-testid=related-approval`) — see `.claude/rules/underlying-code.md`.
Caveat: child blocks are not individually approvable yet (they're not in the
navigable `state.blocks`), so their `done` is 0; `total` still shows the review
scope of the whole call tree. Schema: `.claude/templates/schema.sql`, in sync
with `schemaDDL` in `db.go`.

## Server-side `total` (`blockstats.go`)

The number of approvable changed rows per block is computed **in the backend**,
so it is known before a block has lazily loaded its code, and in exactly the same
aligned-row index space as the approved rows in `approvals.db` — so `done/total`
is always correct.

`blockstats.go` is an **exact Go port** of the frontend's
`changedRows(blockRows(b))`: it reads old/new source from the base/head
worktrees (like `/api/code`), applies the same `dedent4` + LCS alignment
(`alignRows`/`diffLines`, whitespace-insensitive) and counts changed,
non-ws-only, non-empty rows (a pure deletion counts as 1 filler row; a ws-only
re-indent and an empty line don't count — see `rowHasContent`).
`GET /api/blockstats?pr=N` returns `{pr, totals}` (block-id → count) and is
read-only (worktree files only, fine from a read handler). Parity is pinned by
`TestChangedRowCount` (`blockstats_test.go`) on shared fixtures.

Frontend: `loadBlockStats` → `state.blockTotals`; `blockApproveCount` prefers
this backend `total`.

**Keep the two in lockstep.** Anything that changes what counts as an approvable
changed row must land in both `Block.mjs` and `blockstats.go`.

## `rowHasContent` — a blank changed line is diff noise

A row can be `rowChanged` (carries a del/ins mark) yet hold a fully empty (after
`trim()`) line — e.g. a blank line inside a fully **added** block, whose whole
body arrives as `ins` rows. Such a row has nothing to read or judge, but it used
to count in `changedRows()` (so in the approve counter and the backend `total`)
and got its own visibly empty navigation unit at `gran==='line'`/`'call'`.

`rowHasContent(r)` checks the **display side** (the new/`right` side for an `ins`
row, otherwise the old/`left` side for a pure deletion) is non-empty after
`trim()`; `changedRows`/`changeLines`/`changeCalls` and the Go `changedRowCount`
filter on it. **Deliberately NOT applied to `changeGroups`/`rowChanged`
itself** — an empty line still flows along inside the group run it falls in (like
a brackets-only line via `hasLetter`); only its own countability/landability is
suppressed, so a group's highlight never jumps around it. See
`changeLines`/`changeCalls` in `.claude/rules/keyboard-navigation.md`.

## Filler-row sweep on approve

`isBracketOnlyRow`/`isSweepableFillerRow`/`sweepBracketOnlyForward`
(`Block.mjs`), frontend-only, **no Go port**. Approving a line/group also sweeps
in a directly-**following** filler row so the reviewer doesn't have to act on it
separately. Two kinds count:

- a changed row whose display text is, trimmed, nothing but `)` `}` `;` `,` `]`
  `{` (combinations too, e.g. a lone `});`) — this still counts toward
  `changedRows`/the `total` like any other row, this is not a `rowHasContent`
  exclusion;
- a **completely blank** changed row (the one `rowHasContent` does exclude) —
  purely cosmetic: without it, approving the line above left the blank `+` line
  visibly without its own ✓.

`isSweepableFillerRow` (`isBracketOnlyRow(r) || (rowChanged(r) &&
!rowHasContent(r))`) is re-checked per row, so a run of consecutive filler rows
of either kind, in any order, sweeps as one; the chain stops at the first row
that is unchanged or carries real content. Driven by `toggleApprove` at
`gran==='group'`/`'line'` only — **not** `'call'` (`toggleCallApprove` is
untouched).

**One-way and forward-only:** the sweep only runs on the ADD path (`allIn` is
computed on the RAW, un-swept target first, so the sweep can never flip
approve↔retract), never on retract, and never looks at rows before the unit. That
sidesteps a filler row between two independently-approved neighbours; once swept
in, it stays approved.

**Why no Go port:** the sweep never changes what counts toward the `total`, only
which extra indices land in the client-only `b.approvedRows`.
`blockApproved`/`approveSummary`/the server `total` all check membership of
`changedRows(rows)` (which still excludes blank rows) against `b.approvedRows`,
so an index outside `changedRows` is simply ignored. The only visible effect is
`rowCellHTML`'s left-margin ✓ (`changed && approved.has(i)`) also lighting up on
the blank row — a shape signal, never colour-only.

## Comment-activity indicator per tree

Same subtree as the approval rollup. Three render sites, one shared meaning:

- the sidebar row (`data-testid=block-comment-activity`, `BlockList.mjs`'s
  exported `commentActivityPill`);
- a method row in the test-methodes-kolom (`TestMethodsColumn.mjs`'s
  `methodRow`, reusing that same `commentActivityPill` verbatim — see
  `.claude/rules/test-class-grouping.md`);
- an Onderliggende-code child card (`data-testid=related-comment-activity`,
  `RelatedPanel.mjs`'s `commentActivityBadge`).

Each shows the avatar of whoever posted the most recent message across every
currently **open** comment thread anchored on the block itself or anywhere in its
subtree, plus a text `+N` badge (`data-testid=block-comment-activity-count`
resp. `related-comment-activity-count` — text, never colour-only).

- **`+N` counts the OTHER open threads besides the one the avatar represents
  (total − 1)**, not the raw total: the avatar already stands for one thread, so
  the raw total reads as "avatar plus N more" and overcounts by one.
- **`+N` counts distinct open THREADS, never messages** — a thread with several
  replies counts once — and a **resolved thread stops counting and showing
  entirely**, the same rule `commentRowSet`'s 💬 row marker uses.
- **"Subtree" is exactly the approval rollup's tree** (`[b,
  ...nestedPrBlocks(b)]`; a `test_class` row is the union over all its
  `.methods`, each with its own subtree). That is deliberate — "there's a comment
  in the underlying code" is the same tree shape as "there's still something to
  approve there" — and it means a counted thread may sit on a descendant block
  that isn't visible in the current view. Hence the tooltip's "(dit block +
  onderliggende code)".

**Computation:** `commentScopeKeys` + a dedicated decoupled `watch` in `home.mjs`
for the sidebar rows, mirroring the `approvalSummaries` watch right above it
(inline deps in the getter, rollup in the callback, wholesale-reassigned into
`state.commentActivity`, id→`{count,last}`, never a co-subscriber on any
`b.code`). That same watch **also fills one entry per individual METHOD of a
`test_class` row** alongside the row's own union entry: `commentScopeKeys(m)`
works unchanged for a single method (a method carries no `.kind`, so it takes the
generic branch — its own anchor plus its own `nestedPrBlocks` subtree). No
`matchesRow` argument here; this is a per-block summary. No new reactive
dependency either: `nestedPrBlocks`/`directChildBlocks` only read
`state.allBlocks`/`state.relations`/`callRows`/`testCoverRows`, all already
inline in that getter, never a `b.code`.

For a **child descriptor** in the Onderliggende-code panel, the same
`commentScopeKeys`/`commentActivitySummary` pair is called directly per child
inside `relatedChildren`/`resolvedCallChildren`/`resolvedTestCoverChildren`/
`coveredByChildren`, right next to that child's own `approve:
blockApproveCount(...)` — safe for the same reason `approve` is: those functions
only ever run inside the decoupled `setRelated` watch callback, never a render
binding. `commentActivitySummary` is exported from `RelatedPanel.mjs`.

**No indicator** for a `kind:'comment'` sidebar item (a PR-wide comment already
shows its own thread on selection, see "Comment-index items" in
`.claude/rules/comments-panel.md`), nor for a translation child or a call/covers
target into an unchanged file (no PR block → no subtree → `commentActivity:
null`, mirroring `approve`).

Test: `tests/underlying-comment-activity.spec.mjs` (PR 970500 — a spec that
places/resolves comments needs its own PR number, see the `APPROVAL_RESET_PRS`
note in `.claude/rules/testing-playwright.md`).

## Per-diff-line underlying summary badge

The same avatar+N badge, plus a **done/total approve fraction**, also renders
directly on the diff line (`data-testid=line-underlying-summary`, `Block.mjs`'s
`lineSummaryBadge`) — so the reviewer can see, without opening the
Onderliggende-code panel, how much of the underlying code hanging off a specific
call site is still unapproved (e.g. "2/12"). Absolutely positioned at the right
edge of the row, on the same canonical side as the 💬 marker/checkmark
(`approveHere` — new/right pane, or old/left for a pure deletion). A leading
"✓ " marks a fully approved fraction; the numbers carry the meaning either way.

**Deliberately GRAN-INDEPENDENT**, unlike the panel's own `relatedChildren`
(which hides/reorders by the cursor): always visible for every visible diff card
(top-level selected/preview, or any drilled column), based purely on each child's
own anchor row.

`home.mjs`'s `lineChildSummaries(b)` builds a `Map<rowIndex, {approve,
commentActivity}>`, reusing `directChildBlocks`'s three row-attribution sources:
a relation child's own `line`, a resolved method call's site via
`findCallSites`, and a resolved `covers` target's annotation `line` when `b` is
the test. A child with no locatable site (a relation without a `line`, a
block-level synthetic callKey like `resource:`/`migration_model:`/
`data_provider:`) is skipped here — it still shows in the panel, just not pinned
to a line. A `covered_by` child never qualifies (its annotation lives in the
covering test's file, not `b`'s).

**Every child is anchored on its OWN exact row.** An earlier version rolled every
child within one of `b`'s `changeGroups(rows)` runs onto that group's first row;
that hid stacked, unrelated calls in one group behind the first one's badge and
was reversed. Don't reintroduce group-level bucketing. The per-bucket rollup
reuses `subtreeApproveCount`/`commentScopeKeys`/`commentActivitySummary`
verbatim, summed/unioned over every child anchored at that row, so the numbers
match the sidebar pill and the panel.

Threaded as a `lineSummaries` opt through `Block()` →
`codeDiff`/`unifiedCodeDiff` → `codePane`/`paneHTML`/`unifiedHTML` →
`rowCellHTML`/`unifiedRowHTML`, exactly like the existing
`approvedRows`/`commentedRows` opts (a function re-evaluated inside the pane's
`.innerHTML` binding, so it re-renders on any approve/comment change without a
new reactive slot). Because `paneHTML`/`rowCellHTML` build plain HTML **strings**,
they use `avatarHtmlString` (`avatar.mjs`, with its own attribute escaping) — the
arrow.js template `avatarHTML` would leak the template function as text (see
`.claude/rules/arrowjs-pitfalls.md`). Out of scope: the SVG preview (no "children
per line" concept). Test: `tests/line-underlying-summary.spec.mjs` (PR 100).

**The `commentActivity` half also counts a comment placed on the row itself**, not
only children's activity (app-wide, not just TRANSLATION). `lineChildSummaries`
adds an anchor bucket for every row `commentRowSet(b)` marks as commented and
includes `b`'s own `file|label` key in that anchor's `commentActivitySummary`
call. For this, `commentActivitySummary` takes an optional second `matchesRow`
predicate: a child's own comments still count regardless of row (a child's
`rowStart` lives in the child's own aligned-row space), while `b`'s own comments
are restricted to the rows rolling up onto that anchor — so a comment on one line
never bleeds onto every other line's badge.

**TRANSLATION per-key rows get both markers too.** `Block.mjs`'s
`translationSlot` threads `commentedFn`/`lineSummaryFn` into
`translationBlockView` as two callbacks (`commentMarkerFor`/`lineSummaryFor`,
mirroring the existing `onScroll` callback) rather than the raw Set/Map, so
`translationDiff.mjs` stays free of a circular import. They reuse
`commentMarkerHtml`/`translationLineSummaryHtml` — the latter shares
`lineSummaryParts` (the content logic extracted out of `lineSummaryBadge`) with a
plain inline wrapper instead of absolute positioning, since a per-key row has no
single code line to float over. Rendered inline in the key header next to the
kind pill, keyed by the unit's own `u.row`. Tests:
`tests/translation-navigation.spec.mjs` (💬 marker) and
`tests/underlying-comment-activity.spec.mjs` (avatar+N for a comment on the
block's own row).

## Hiding approved blocks (`BlockList.mjs`)

Fully approved **top-level** blocks (pill `done === total`, subtree) are hidden by
default from the "Start" list; a button at the bottom
(`data-testid=toggle-approved`, "Show N approved blocks" / "Hide …") unfolds them
(`state.showApproved`, ephemeral, not in the URL). Partial and unapproved always
stay visible. Because `total` is known server-side this works before the code has
loaded.

The "Start" heading also shows a PR-wide counter
(`data-testid=approval-summary`, "X/Y approved · N left to review") from
`state.approvalTotal`, summed in the same decoupled `watch` that fills
`approvalSummaries` — a flat snapshot, so the heading never co-subscribes on a
`b.code`.

`renderList` **always** returns a keyed array (empty state as an array-of-one) to
avoid the arrow.js single↔array slot pitfall (see
`.claude/rules/arrowjs-pitfalls.md`). One per-row exception: the block
`state.pinnedApprovedId` names stays visible while it is also the current
selection — see "Load/refresh-restore → reveal" in
`.claude/rules/keyboard-navigation.md`.
