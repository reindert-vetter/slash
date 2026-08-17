# Reviewer approval & its counters

Everything about approving code and the numbers derived from it: the granular
row/call-segment model, how it is persisted, how it rolls up over the review
tree, and the indicators that show it. Split out of
`.claude/docs/blocks-and-ingest.md`.

## Granular model: `approvedRows` + `approvedCalls`

Approval is **not** a single block flag. `b.approvedRows` is an array of row
indices in `blockRows(b)` (see "Old/new line alignment" in
`.claude/docs/diff-render.md`); every granularity reduces to that (a group
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

The methodes-kolom header of a grouped test class has its own checkbox in the
same shape, but for the whole **class** at once (every method, not one
block's rows) — see "Approving the whole class in one action" in
`.claude/docs/test-class-grouping.md`.

**Call segments are finer than a row.** At `call` level one row can hold several
segments (`segmentCalls`), so `b.approvedCalls` holds `${row}:${segStart}` keys
(`callKey`/`approvedCallSet`/`rowCallSegments` in `Block.mjs`) alongside
`b.approvedRows`. Once every segment of a row is approved that row **graduates**
into `b.approvedRows` (its keys disappear from `approvedCalls`) so the coarser
group/line approval and the block checkbox simply see it; withdrawing one
segment of an already-full row splits it back into explicit keys
(`toggleCallApprove` in `home.mjs`).

While a row is *partially* approved (not 0, not all) every segment gets a dot
marker directly **under its own first non-space character**: an approved segment
a **solid** dot, a pending one an **open** ring, so the line reads as a progress
strip. Nothing approved → nothing shown; everything approved → the dots go away
and the checkmark returns (`partialCallApproval`/`segDotMarkers` in
`Block.mjs`).

**The dot lives INSIDE the code line**, as a `::after` pseudo-element on that
character's own `markChars` span (`SEG_DOT_DONE_CLS`/`SEG_DOT_TODO_CLS`,
`data-seg-dot="<charIndex>"`), composing with the active-segment underline on
the same pass. It replaced a separate monospace row below the line that placed
its dots with literal leading spaces and a `col = start + 1` step: that assumed
a dot is exactly one character cell wide (≈6px in a ≈6.6px cell), so every dot
after the first drifted left — the reported "the dots aren't under the start of
their call" — and it could not follow a **wrapped** line in the `fit` stand at
all. As a pseudo-element it needs no column arithmetic, adds no row and no flow
width, so both panes stay line-for-line aligned for free (the `BLANK_MARK_ROW`
filler the old second row needed is gone). Don't reintroduce the column
arithmetic. Test: `tests/call-approval-dots.spec.mjs`.

`b.approvedRows`/`b.approvedCalls` are always **reassigned**, never mutated in
place, so arrow.js re-renders the checkbox and the indicators.

**Partial-up-to-a-call approval** (`approveThroughCall`, `home.mjs`) is the one
writer that approves *part* of a unit: `Space` on a unit that calls into code
with unapproved work of its own approves only up to and including that call's
segment and drills there — see "`Space` — approve + continue in one keypress"
in `.claude/docs/keyboard-navigation.md`.

## Durable persistence (client side)

Approval survives a refresh via the `approvals` read model
(`data/approvals.db`), fed by the `approve` workflow — **not** the URL (too
large/too volatile). `home.mjs`'s `loadApprovals` ensures the tracker on load
(`POST /api/workflows/approve {pr}` → runId in `state.approveRunId`) and
restores every block's arrays from `GET /api/approvals?pr=N`. Every mutation
(`toggleApprove`/`toggleCallApprove`, plus the card checkbox via `Block.mjs`'s
`onApprove` callback) sends, after the local reassignment, the **complete** set
for that block as a Signal (`POST /api/workflows/{runId}/signals/set {blockId,
rows, calls, anchors}`, `persistApproval`). The UI never writes directly — only
this Signal, within the write boundary. See "Persisting reviewer approval" in
`.claude/docs/workflows-trackers.md`.

### An approval carries the CODE it approved, not just a row index

`anchors` (`approvalAnchors` in `home.mjs` → `approvals.RowAnchor` → the
`anchors` column) describes every row the approval covers — the approved rows
plus the rows its call keys sit on — as `{row, text, prev, next}`, using
`rowAnchorText` (`Block.mjs`, the exact rule Go's `rowDisplayText` uses; keep
the two in lockstep). Neighbours included, because that is what tells a repeated
line (a bare `}`, a mirrored array literal) from its twins.

**Why:** a row index means nothing once the PR gets new commits.
`reanchor.go` remaps approvals on an ingest refresh, but it used to have to
recover the old text from the **previous base/head SHAs** — which is exactly
what cannot work when the base branch moved (a rebase/merge of main makes every
file "changed" and re-diffs the whole PR), after a force-push, or on a full
re-ingest. The reported symptom was an approval that had simply vanished after
the PR owner processed feedback. With its own anchors an approval re-anchors the
same way a comment does, from data it carries itself.

- **Never sent → never cleared.** `approvalAnchors` returns `null` (the field is
  then omitted) when the block's code isn't loaded, and `approvals.Replace`
  reads `nil` as "keep what is stored". An explicitly empty list does clear.
- **A legacy approval upgrades itself:** `planApprovalRemap` falls back to the
  old shadow-worktree path when there are no anchors, and always emits **fresh**
  anchors for the rows that survived — so the first refresh after this change
  gives every stored approval a proper description, and the remap plan rewrites
  them to the new indices on every later refresh.
- **Ambiguity is still dropped, never guessed** (`remapFromAnchors`): unique
  text wins outright; several candidates must be singled out by
  `anchorContextMatches`; a tie drops the row. A wrong ✓ on code the reviewer
  never read is worse than an approval they have to redo.

Tests: `reanchor_test.go` (`TestReanchorApprovalsFollowShiftedRowsViaAnchors`
— no previous worktree at all — plus the duplicate-context and rewritten-row
cases), `approvals_test.go`, `tests/space-descends-into-call.spec.mjs`.

## An open comment is an unapproved unit, resolved via its own Enter menu

Every UNRESOLVED comment gets its own blokken-index row (`indexComments`,
`RelatedPanel.mjs`, plus the "its block must be in the tree" condition in
`recomputeLeftList`), and `blockApproveCount`'s comment branch already scores
such a row as "resolved == approved" (0/1 → 1/1). Two deliberate consequences,
both confirmed by the reviewer: an open comment is a stop on the ↑/↓ walk and on
`findNextUnapproved`'s, and the PR is only ever fully approved once every comment
is resolved — **including other people's**.

**Space does NOT resolve a comment row — that was reverted.** An earlier cut
had `spaceKey` (`home.mjs`) resolve the comment directly
(`resolvePrCommentItem`, the ordinary `reply` Signal with `done: true`) the
moment the row also grew a comment_batch checkbox (see "The comment_batch
checkboxes and the bottom action row" in `.claude/docs/comments-panel.md`);
reported back as "too easy to trigger by accident" ("dat gaat te snel") once
`Space` also had to do checkbox duty on the same row. `spaceKey`'s comment-row
branch now toggles the checkbox instead (or advances to the next row when
there is no checkbox), and **resolving only happens through the row's own
`Enter` menu** ("Resolve comment", already the default item for the
reviewer's own comment — `prCommentCommandsFor`). Not a toggle there either: a
resolved block-anchored comment leaves the index, and "Unresolve" stays in
that same menu. Test: `tests/comment-batch.spec.mjs`.

## Placing a comment (or an AI finding) does NOT retract an approval

Deliberately reversed, on explicit request: a comment on an already-approved
unit used to retract that unit's approval (`revokeApprovalForComment`,
`home.mjs`, hooked into both `COMPOSE_COMMANDS` items that place a comment),
and an AI `code_warning` finding did the same server-side
(`revokeApprovalForWarning` + `markWarningRevocation`, driven by
`codeWarningWorkflow`, with `modules/warnrevoke` remembering the
`(pr, blockId, row)` tuple so it only fired once). **All of it is gone** — the
function, both Activities, the `warnrevoke` module, and its purge sweep in
`cleanup.go`.

An approval means "I have read this code", and neither a comment nor a risk
hint changes that fact; retracting it silently cost the reviewer work they had
already done (an automatic risk check runs on every ingest refresh, so a
recurring finding kept eating approvals unattended). Both the comment and the
warning still appear exactly as before — only the retraction is gone. Don't
reintroduce either half without asking.

## Combined approval per tree (sidebar + Underlying code)

The sidebar shows a pill per top-level block (`data-testid=block-approval`) with
`done/total` for that block **plus every descendant block** — its relation
children and the PR-block definitions of its resolved/found method calls,
transitively. `home.mjs` rolls this up (`blockApproveCount` per block →
`subtreeApproveCount` over `[b, ...nestedPrBlocks(b)]`) and pushes it via a
`watch` into `state.approvalSummaries` (id→`{done,total}`).

**A pill may overlap with its neighbour's, and that is correct.**
`nestedPrBlocks`' cycle guard is per **call**, so one shared helper hangs under
every top-level row that calls it and counts in each of their pills — a pill
answers "how much is left under THIS entry". The PR-wide header count must not
be the sum of those pills; see `prWideApproveTotal` below.

**Deliberately decoupled from the render** (like `setRelated`/`setCommentScope`):
the sidebar reads a flat snapshot instead of every block's `b.code`, which would
make it a co-subscriber on the selected block's `b.code` and re-trigger the
diff's "stuck on loading" race (see `.claude/rules/arrowjs-pitfalls.md`).

`done` comes from the approved row indices; **`total`** comes server-side from
`GET /api/blockstats?pr=N` (see below), with a client-side fallback to
`changedRows(blockRows(b))` until the stats land. Green with a ✓ once
`done === total`, otherwise neutral; hidden only at `total === 0`.

The same `{done,total}` hangs off each child in the Underlying-code card
(`data-testid=related-approval`) — see `.claude/docs/underlying-code.md`.
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
`changeLines`/`changeCalls` in `.claude/docs/keyboard-navigation.md`.

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

## Approving from the mouse: a call-segment hover ring, and the passive palette for everything else

A first cut of this added three clickable gutter glyphs — a round `✓`/`○` per
line, a square `▣`/`▢` on a group's last row, and a hover-only ring per call
segment — reusing `toggleApprove`/`toggleCallApprove` and Space's own
approve-and-continue chain (`mouseApprove`). **The line and group glyphs were
removed again on reviewer request**: "rondjes/vormpjes aan de linkerkant kan
weg (vinkje mag blijven) … ik wil direct een menu zien onder de onderste
geselecteerde regel (zelfde menu als Enter)". Only the plain, always-visible
✓ checkmark (unconditional, non-clickable — restored to its original form)
and the **call-segment hover ring** stayed; a mouse **selection** (not a
hover) now shows the same command palette `Enter` would open, passively —
see "A mouse selection shows the palette passively" in
`.claude/docs/command-palette.md` for that replacement mechanism.

**Call** — the existing per-segment dot markers (`segDotMarkers`, above) are
clickable once a row is partially approved; `segHoverRingMarkers` adds a
HOVER-ONLY hollow ring at the same per-character position for a row that has
real call structure (more than one segment) but carries **no** approval at
all yet (segDots and hoverSegMarks are mutually exclusive — a
partially-approved row already shows its real dots). Same `SEG_DOT_BASE`
`::after` mechanism as the real dots, just gated by
`group-hover/row:after:opacity-100` instead of always-on. The glyph is CSS
content, never real text (`before:content-['…']`/`::after` pseudo-elements) —
a real text node here would leak into `rowEl.textContent` (and any
TreeWalker over the row's text nodes), shifting every downstream char-index
computation by however many glyph characters came before it — regression
caught by `tests/call-approval-dots.spec.mjs`, which locates a segment's own
first character by scanning `textContent`. Don't reintroduce a real-text
glyph here.

**Click routing:** one delegated `click`-in-`mousedown` branch in
`onBlockMouseDown` (`Block.mjs`), checked **before** the ordinary
row-selection logic, for `[data-seg-dot]` — a single event either selects a
row/segment OR approves, never both. `[data-seg-dot]` deliberately carries
**no `data-row` of its own** (`data-row` must stay unique per aligned row —
`callArrows.mjs` and several tests rely on exactly one match per index); the
row index comes from the existing `closest('[data-row]')` walk on the
ancestor row `<div>`, which resolves correctly whether the click landed on
ordinary text or on one of these nested spans.

`home.mjs`'s `onApproveClick` prop (wired next to `onRowMouseDown` at both
real, non-preview card call sites — top-level and a drilled column) calls
`approveClickAt(level, b, i, row, kind, segStart)`, always with `kind:'call'`
now: resolves the clicked segment to a navigation unit via `navUnitsOf`
(mirroring `selectRowAt`'s own level/i plumbing), **forces** `'call'`
granularity onto the keyboard cursor — the same "a click overrides whatever
gran the keyboard had active" rule the plain row click already applies (see
"Line selection" in `.claude/docs/diff-render.md`) — and then runs
`mouseApprove()`.

**`mouseApprove()` is the mouse counterpart of `Space`, with ONE deliberate
difference.** It reuses the exact same
`approveContext()`/`descendIntoUnapprovedCall`/`toggleApprove(true)` chain as
`spaceKey` (see "`Space` — approve + continue in one keypress" in
`.claude/docs/keyboard-navigation.md`) — approve (or descend into an
unapproved call first) plus auto-continue to the next unapproved unit, no
`postApprove` confirm menu, exactly one click. The difference, per explicit
reviewer answer ("al goedgekeurd → intrekken"): clicking an ALREADY approved
marker **retracts** it (`toggleApprove(true)` already flips either direction
depending on `allIn`), where `spaceKey`'s own "already done" branch instead
only continues (`isApproveDone` → skip straight to "Ga door", no toggle at
all) — a reviewer clicking directly on a solid dot is asking to undo it, not
to skip past it. A retract never auto-advances either
(`afterApproveAction`'s `if (!approving) return`), same as every other
retract path in this app.

**One deliberate DIVERGENCE from `Space`, added later:** `mouseApprove()`
shows the passive command-palette preview (see "A mouse selection shows the
palette passively" in `.claude/docs/command-palette.md`) once the
approve-and-continue chain has actually settled — `Space` itself still shows
no menu at all (unchanged, see its own doc comment in
`.claude/docs/keyboard-navigation.md`). Reviewer report: a click on a call
that auto-continued the cursor elsewhere (a sibling unit, a different block,
or down into a resolved call's own subtree via `descendIntoUnapprovedCall`)
left no visible menu at the new landing spot at all, unlike a plain click
selection. `toggleApprove`/`toggleCallApprove`/`afterApproveAction` all
return their promise chain for exactly this reason; `mouseApprove` calls
`showPassiveMenu()` directly once that chain resolves — not the
mousedown/mouseup-deferred `schedulePassiveMenu()`, since a click on an
approve dot never starts a drag-range gesture that a preview could visually
collide with. `showPassiveMenu`'s own `if (menu.open) return` guard makes
this a no-op on the "nothing left ahead" branch, which opens the real,
keyboard-owning `reviewApprove`/`reviewChoice` menu instead.

**Deliberately scoped to the split/fit stands only** (`rowApproveEnabled`
gates on `!gutter`, and `opts.gutter` is only ever true from
`unifiedRowHTML`): the unified stand's own inline `"- "`/`"+ "` gutter
checkmark (`gutterSpan`) is untouched, not a click target — the same
"not every stand" precedent as SVG/TRANSLATION blocks (see
`.claude/docs/diff-render.md`), accepted rather than squeezing a second icon
into that fixed-width inline slot. `fit` inherits full support for free: it
reduces to the same single-pane `codePane`/`paneHTML` path as `split`'s own
right pane (`codeDiff`'s `effectiveOnly === 'right'` branch).

Test: `tests/mouse-approve.spec.mjs`.

## Comment-activity indicator per tree

Same subtree as the approval rollup. Three render sites, one shared meaning:

- the sidebar row (`data-testid=block-comment-activity`, `BlockList.mjs`'s
  exported `commentActivityPill`);
- a method row in the test-methodes-kolom (`TestMethodsColumn.mjs`'s
  `methodRow`, reusing that same `commentActivityPill` verbatim — see
  `.claude/docs/test-class-grouping.md`);
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
`.claude/docs/comments-panel.md`), nor for a translation child or a call/covers
target into an unchanged file (no PR block → no subtree → `commentActivity:
null`, mirroring `approve`).

Test: `tests/underlying-comment-activity.spec.mjs` (PR 970500 — a spec that
places/resolves comments needs its own PR number, see the `APPROVAL_RESET_PRS`
note in `.claude/docs/testing-playwright.md`).

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

**A row whose comment threads are ALL local shows a note glyph, not an avatar.**
`commentActivitySummary` also returns `local` (every counted thread satisfies
`isLocalComment` — no `githubId` of its own and not github-sourced; the single
frontend definition of "local", shared with `needsPublishChoice`), and
`lineSummaryParts` then renders `noteIconHtmlString` instead of
`avatarHtmlString`. Reindert: *"als ik alleen een local comment heb op een
regel, maak hier dan een note icoontje van ipv mijn avatar"* — an avatar answers
"who is waiting for you", which says nothing about a private "Alleen voor
mijzelf" note, and your own face on your own note is noise. **One real GitHub
thread in scope flips it back to the avatar**: a mixed scope genuinely has
someone in it. The distinction is carried by **shape** (square note vs. round
avatar) plus the badge's `title` ("eigen notitie(s)" vs "open reactie(s)"),
never by colour — the colorblind rule. Deliberately **only** this per-line
badge: the sidebar pill (`commentActivityPill`) and the Underlying-code card
(`commentActivityBadge`) keep the avatar, per Reindert's explicit scope. Note a
comment placed through the ordinary "Plaats comment" path is **not** local — it
gets a GitHub root — so this only ever fires for a private note (or a post that
failed). Test: the two comment cases in `tests/line-underlying-summary.spec.mjs`
(the posted one on PR 100, the private note on PR 112 — deliberately different
PRs, since a row holding both is a mixed scope).

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
`state.approvalTotal`, filled in the same decoupled `watch` that fills
`approvalSummaries` — a flat snapshot, so the heading never co-subscribes on a
`b.code`.

**That total is a UNION over the whole tree, never the sum of the pills**
(`prWideApproveTotal`, `home.mjs`): it walks every top-level row's subtree into
one id-keyed `Set` and calls `blockApproveCount` **once** per block. Summing
`subtreeApproveCount` per row instead counted every shared descendant once per
ancestor and inflated both halves by the same factor — measured on PR 13255:
**10210/10742 instead of the real 1831/1856** ("532 left to review" where 25
were left), which is exactly the number a reviewer reads as "this PR is endless".
`ProgressBar.mjs` reads the same `state.approvalTotal`. Don't reintroduce the
per-row sum; the `state.underlyingIds` skip is not enough, it only covers the
one case where the shared descendant is itself a top-level index row.

`renderList` **always** returns a keyed array (empty state as an array-of-one) to
avoid the arrow.js single↔array slot pitfall (see
`.claude/rules/arrowjs-pitfalls.md`). One per-row exception: the block
`state.pinnedApprovedId` names stays visible while it is also the current
selection — see "Load/refresh-restore → reveal" in
`.claude/docs/keyboard-navigation.md`.

## A reference unit has nothing to approve

An unchanged line that only carries a resolved call is a landable navigation
unit (`unit.ref` — see "Reference units" in
`.claude/docs/keyboard-navigation.md`) but contributes **nothing** to any
counter: it holds no `changedRows`, so `approveTargetRows`, `blockApproveCount`,
`subtreeApproveCount`, the PR-wide total and the Go port in `blockstats.go` are
all untouched by design. `unitFullyApproved` short-circuits on `unit.ref` (its
`'call'` branch would otherwise report such a unit as permanently unapproved to
`findNextUnapproved`), `toggleApprove`/`toggleCallApprove` no-op there, and
`blockCommands()` leaves the "Keur … goed" item out of the palette.

## A block with zero changed rows has nothing to approve

A whole top-level block can itself have a server-confirmed total of **0**
approvable changed rows (`GET /api/blockstats`'s `blockstats.go`, e.g. a
whitespace/reformat-only diff that its whitespace-insensitive row alignment
doesn't count at all — see "Server-side `total`" above) while still carrying
PR status `modified`. Reported case: PR 13255's `RunCommandActivity::run`.

**The card checkbox is hidden**, same as the existing `b.status === 'unchanged'`
case right above (`Block.mjs`): `blockApproved` permanently returns `false` for
a block whose `changedRows(blockRows(b))` is empty — deliberately, so the
checkbox doesn't flash "approved" while the code is still loading (`blockRows`
also returns `[]` before `b.code` arrives) — so once the code HAS loaded and
the count is a genuine zero, a visible checkbox there is a dead control
forever (`toggleBlockApproval` recomputes the same empty `changedRows(...)` on
every click, so ticking it is a no-op). The extra `b.code` gate is exactly
what tells "still loading" apart from "loaded, genuinely empty" here.

**Deliberately NOT folded into `isFullyApproved` (`BlockList.mjs`) — it still
sits in the visible "nog te reviewen" section, just with no checkbox.** A
first attempt made a confirmed-zero-total block count as "handled" there too
(hidden by default, skipped by the arrow-key walk/`findNextUnapproved`), via a
new `isTriviallyDone(state, b)` reading `state.blockTotals[b.id]` directly
(the one place that needs "confirmed zero" and "stats not loaded yet" to stay
distinguishable, since `blockApproveCount`/`state.approvalSummaries` collapse
both onto the same `{done:0,total:0}`). That broke two existing, deliberately
built regression tests (`tests/navigate.spec.mjs`'s "↓ flows into the next
same-file block"/"↑ flows back into the previous same-file block"): PR 12903's
fixture (`materializeMainWorktrees`, `tests/_setup.mjs`) purposely gives
`CreatePaymentAction::findOrCreateCustomer` PR status `modified` with zero
changed rows of its own, specifically so a same-file neighbour with nothing to
approve still occupies its own sidebar slot and stays a normal navigation
stop. Hiding every zero-total block by default silently swallowed that block
too, shifting every `data-idx` after it. So a zero-total block is a narrower
case than "fully approved": the checkbox-hiding fix above is safe (it only
ever removes a dead per-card control), but folding it into `isFullyApproved`
is not — that predicate's callers assume it only ever matches a block the
reviewer actually finished, not one that was simply never approvable to begin
with. Left as-is pending a decision on where such a block should actually sit
in the list (the reported symptom this section opened with — "it sits forever
in the 12 nog-te-reviewen count" — is a real UX rough edge, but the review
tree's existing same-file-neighbour navigation is the incumbent here).
