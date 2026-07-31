# Blocks & ingest

The first feature: turn a PR into a list of **blocks** (a block = one
PHP function/method, or the whole file if parsing fails) and show them on the
left as a navigable list.

- **Storage:** the `blocks` table (this *is* the `nodes`/function table from the
  graph, renamed + extended with `class/category/end_line/status/side/pr`). The
  `approved` column (0/1) marks whether the reviewer has approved a block.
  Approval is, however, **granular**: not a single block flag but a set of
  approved **changed rows** — `b.approvedRows`, an array of row indices in
  `blockRows(b)`. Every granularity reduces to that (a group approves all its
  rows, a `line`/`call` the one row it's on), so "is the whole block approved?"
  is simply "are *all* changed rows approved?"
  (`blockApproved`/`blockPartlyApproved`/`changedRows`/`approvedRowSet` in
  `Block.mjs`). The top checkbox on the block card is therefore **derived**:
  checked when `blockApproved`, indeterminate when partial, with an
  `approve <done>/<total>` counter; clicking approves everything or clears
  everything. A fully approved row shows a small emerald **checkmark** in the
  left margin (the active indigo bar wins as long as the cursor sits on it). At
  `call` level a single row can contain **multiple** call segments
  (`segmentCalls`); approval there is thus finer-grained than the row:
  `b.approvedCalls`, an array of `${row}:${segStart}` keys (`callKey`/
  `approvedCallSet`/`rowCallSegments` in `Block.mjs`) alongside `b.approvedRows`.
  Once all segments of a row are approved, that row **graduates** into
  `b.approvedRows` (and its keys disappear from `approvedCalls`) so the coarser
  group/line approval and the block checkbox simply see it; the reverse
  (withdrawing one segment of an already-fully-approved row) splits it back
  into explicit keys (`toggleCallApprove` in `home.mjs`). As long as a row is
  *partially* approved (not 0, not all) it shows a dot per segment on a second,
  compact row below — aligned under the segment column via literal spaces
  (works without JS measurement since the code is monospace): an already-
  approved segment gets a **solid green** dot, a still-pending segment an
  **open** dot, so the row reads as a progress strip at a glance. If nothing is
  approved, we show nothing; if everything is approved, the dots disappear and
  the checkmark comes back (`partialCallApproval`/`circleRowHTML` in
  `Block.mjs`). Both panes compute that dots-row from exactly the same
  (deterministic) input, so they add it at the same row index and stay aligned
  line by line. `b.approvedRows`/`b.approvedCalls` are always **reassigned**
  (never mutated in place) so arrow.js re-renders the checkbox and the
  indicators. `edges` remains for the later call graph.
- **Durable persistence (`approve` workflow + `modules/approvals`):** approval
  survives a refresh. `b.approvedRows`/`b.approvedCalls` live per block durably
  in the `approvals` read model (`data/approvals.db`), fed by the `approve`
  workflow — **not** in the URL (too large/too volatile). `home.mjs`
  (`loadApprovals`) ensures the tracker on load (`POST /api/workflows/approve
  {pr}` → runId remembered in `state.approveRunId`) and then restores every
  block approval from `GET /api/approvals?pr=N` (per block-id →
  `b.approvedRows`/`b.approvedCalls` reassigned). Every approval mutation
  (`toggleApprove`/`toggleCallApprove` in `home.mjs`, plus the top checkbox via
  `Block.mjs`'s `onApprove` callback) sends, after the local reassignment, the
  **complete** set for that block as a Signal
  (`POST /api/workflows/{runId}/signals/set {blockId, rows, calls}`,
  `persistApproval`). The UI thus **never** writes directly — only this signal,
  within the write boundary. See `.claude/rules/tembed-workflows.md` (section
  "Persisting reviewer approval").
- **Placing a comment retracts the approval it hangs on
  (`revokeApprovalForComment`, `home.mjs`):** a reviewer who places a comment
  on an already-approved unit is signalling "this isn't OK after all" — the
  approval of exactly that anchor is therefore retracted right after the
  comment is placed, via the same `set` Signal (`persistApproval`), never a
  direct write. Hooked into **both** `COMPOSE_COMMANDS` items that actually
  place a comment ("Plaats comment" and "Alleen voor mijzelf" — a private
  note counts too, since the reviewer is still flagging the code, even though
  it never reaches GitHub); a **reply** in an existing thread
  (`sendReaction`) does **not** retract anything — only placing a fresh
  comment does. Both call sites capture `focusedBlock()` + `commentTarget()`
  **before** the `await placeComment(...)` (the same anchor `placeComment`
  itself posts with), so the revoke always targets the block/unit the
  comment was actually anchored to — including a drilled column, mirroring
  `approveContext()`'s own `focusLevel` handling.
  At `gran !== 'call'` (group/line, or a TRANSLATION per-key unit — both
  already flow through the same aligned-row range) every row in
  `[t.rowStart, t.rowEnd]` is dropped from `b.approvedRows`, plus any
  `b.approvedCalls` entries whose row falls in that range (a coarser comment
  supersedes a finer, partial call approval on the same rows). At
  `gran === 'call'` it's precise instead: only the **one** segment the
  comment is on (found via `t.seg`, the same `segKey()` `commentTarget()`
  itself computed) loses its approval — sibling segments on the same row
  keep theirs; a row that had graduated into `b.approvedRows` (every segment
  already approved) is first expanded back into explicit per-segment keys,
  mirroring `toggleCallApprove`'s own "wasFullRow" branch. Both arrays are
  always reassigned wholesale (never mutated in place), per the arrow.js
  reactivity rule below. A comment placed by the system itself (an imported
  GitHub comment, or an AI risk-check `code_warning` finding) does **not**
  trigger this — those are created directly by a backend Activity, never
  through this frontend `placeComment`/`createComment` path. Test:
  `tests/comment-revokes-approval.spec.mjs` (both the group/line case and
  the call-segment precision case).
- **Combined approval per tree (sidebar + Underlying code):** the left sidebar
  shows a pill per top-level block (`data-testid=block-approval`) with
  `done/total` for that block **plus all descendant blocks combined** — its
  relation children and the PR-block definitions of its resolved/found
  method calls, transitively. `home.mjs` rolls this up (`blockApproveCount` per
  block → `subtreeApproveCount` over `[b, ...nestedPrBlocks(b)]`) and pushes it
  via a `watch` into `state.approvalSummaries` (id→`{done,total}`) — **deliberately
  decoupled from the render** (like `setRelated`/`setCommentScope`): the sidebar
  reads a flat snapshot instead of every block's `b.code`, since that would make
  the sidebar a co-subscriber on the `b.code` of the selected block and
  re-trigger the diff's "stuck on loading" race (see
  `.claude/rules/conventions.md`). The count tallies approved changed-rows. The
  `done` side comes from the approved row indices; the **`total`** (number of
  approvable changed-rows per block) comes **server-side** from
  `GET /api/blockstats?pr=N` — see below — with a client-side fallback to
  `changedRows(blockRows(b))` while the stats haven't arrived yet. The pill is
  green with a ✓ once `done === total`, otherwise neutral; hidden only when
  `total === 0`. The same `{done,total}` hangs off each child in the
  **Underlying code** card (`data-testid=related-approval` + a header rollup
  `related-approval-total`) — see `.claude/rules/detail-layout.md`. Caveat:
  child blocks are not (yet) individually approvable (they're not in the
  navigable `state.blocks`), so their `done` is 0 for now until that exists;
  `total` still makes the review scope of the whole call tree visible.
  Schema: `.claude/templates/schema.sql` (in sync with the `schemaDDL` constant
  in `db.go`).
- **Comment-activity indicator per tree (sidebar, the test-methodes-kolom AND
  every Onderliggende-code child card), same subtree as the approval rollup
  above:** a sidebar row (`data-testid=block-comment-activity`,
  `BlockList.mjs`'s exported `commentActivityPill`) — a method row in the
  test-methodes-kolom (`TestMethodsColumn.mjs`'s `methodRow`, reusing that
  same `commentActivityPill` verbatim, not a parallel implementation) — and,
  identically, a child card in the "Onderliggende code" panel
  (`data-testid=related-comment-activity`, `RelatedPanel.mjs`'s
  `commentActivityBadge`) — shows the avatar of whoever posted the most recent
  message across every currently OPEN comment thread anchored on the block
  itself or anywhere in its subtree, plus a text "+N" badge
  (`data-testid=block-comment-activity-count` resp.
  `related-comment-activity-count`, deliberately text, never color-only — see
  the colorblind note in `conventions.md`) once there's more than one such
  thread. **"+N" counts the OTHER open threads besides the one the avatar
  already represents (total − 1), not the raw total** — the avatar itself
  already visually stands for one thread, so showing the full total next to it
  would read as "avatar plus N more" and overcount by one (a real, reported
  confusion: seeing "+2" next to one avatar while only one thread was visible
  in the currently open view). "Subtree" is exactly the same tree as the
  approval rollup (`[b, ...nestedPrBlocks(b)]`; a `test_class` row is the union
  over all of its `.methods`, each with its own subtree) — "there's a comment
  in the underlying code" is deliberately the same tree shape as "there's
  still something to approve in the underlying code", which is also why the
  count can legitimately include a thread that isn't otherwise visible in the
  currently open diff/panel (it sits on a descendant block instead) — the
  tooltip says "(dit block + onderliggende code)" rather than implying every
  counted thread lives in the underlying code specifically. Computed by
  `commentScopeKeys`/a dedicated decoupled `watch` in `home.mjs` for the
  sidebar rows (mirrors the `approvalSummaries` watch immediately above it:
  inline deps in the getter, the actual rollup in the callback,
  wholesale-reassigned into `state.commentActivity`, id→`{count,last}` — never
  a co-subscriber on any block's `b.code`). **That same watch ALSO fills one
  entry per individual METHOD of a `test_class` row** (method id →
  `{count,last}`, alongside the row's own union entry): `commentScopeKeys(m)`
  works unchanged for a single method — a method carries no `.kind`, so it
  falls into `commentScopeKeys`'s generic branch (its own anchor + its own
  `nestedPrBlocks` subtree), exactly the shape any other top-level block's own
  entry already gets, just scoped to that one method instead of the whole
  class. No `matchesRow` argument is passed here (unlike `lineChildSummaries`'
  per-diff-line use of that parameter, see below) — this is a per-BLOCK
  summary like every other `state.commentActivity` entry, so there's nothing
  to restrict. No new reactive dependency either: `nestedPrBlocks`/
  `directChildBlocks` only read `state.allBlocks`/`state.relations`/
  `callRows`(→`state.callResolve`)/`testCoverRows`(→`state.testCovers`) —
  already inline in the same watch's getter — and never a block's own
  `b.code`, so this can't introduce the "stuck on loading" race; for a child descriptor in the
  Onderliggende-code panel, the same `commentScopeKeys`/`commentActivitySummary`
  pair is instead called directly per child inside `relatedChildren`/
  `resolvedCallChildren`/`resolvedTestCoverChildren`/`coveredByChildren` (right
  next to that child's own `approve: blockApproveCount(...)` field) — safe
  there for the same reason `approve` already is: those functions only ever
  run inside the decoupled `setRelated` watch callback, never a render
  binding. Both read `commentActivitySummary` (`RelatedPanel.mjs`, exported)
  with the block's own subtree keys. **"+N" counts distinct open THREADS,
  never individual messages** — a thread with several replies still counts
  once; **a resolved thread stops counting (and showing) entirely** — the
  exact same rule `commentRowSet`'s own 💬 row marker already uses ("once
  resolved there's nothing left to look at"). A `kind:'comment'` sidebar item
  (a PR-wide comment, see "Comment-index items" in `detail-layout.md`) never
  gets this indicator — it already shows its own thread directly on
  selection, there's no separate "underlying code" to roll up; likewise, a
  translation child or a call/covers target into an unchanged file (no PR
  block, so no subtree) gets `commentActivity: null`, mirroring `approve` for
  the same targets. Test: `tests/underlying-comment-activity.spec.mjs` (PR
  970500, own PR number per the `APPROVAL_RESET_PRS` note in `_fixtures.mjs` —
  a spec that places/resolves comments needs a PR nobody else's assertions
  depend on; covers the sidebar pill, a `test_class` row's own method rows in
  the test-methodes-kolom, and the child card in the Onderliggende-code
  panel).
- **A THIRD place the same avatar+N badge appears: directly on the diff line
  itself (`data-testid=line-underlying-summary`, `Block.mjs`'s
  `lineSummaryBadge`), plus a NEW done/total approve fraction next to it —**
  so a reviewer can tell, without opening the Onderliggende-code panel, how
  much of the underlying code hanging off a specific call site is still
  unapproved (e.g. "2/12"). Absolutely positioned at the right edge of the
  row (mirrors the left-edge checkmark overlay), on the same canonical side
  as the existing 💬 marker/checkmark (`approveHere` — new/right pane, or
  old/left only for a pure deletion). A leading "✓ " marks a fully approved
  fraction — never colour alone, per the colorblind rule; the numbers
  themselves already carry the meaning either way.
  **Deliberately GRAN-INDEPENDENT** (unlike the Onderliggende-code panel's own
  `relatedChildren`, which hides/reorders by the current cursor): the badge
  is always visible for every visible diff card (top-level selected/preview,
  or any drilled column), based purely on each child's own anchor row, not on
  navigation state. `home.mjs`'s `lineChildSummaries(b)` builds a
  `Map<rowIndex, {approve, commentActivity}>`: it reuses `directChildBlocks`'s
  three row-attribution sources directly (a relation child's own `line`, a
  resolved method call's site via `findCallSites`, a resolved `covers`
  target's annotation `line` when `b` is the test) — a child with no
  locatable site (an event-listener/relation without a `line`, or a
  block-level synthetic callKey like `resource:`/`migration_model:`/
  `data_provider:`) is simply skipped here, it still shows in the panel, just
  not pinned to one line; a `covered_by` child never qualifies either (its
  annotation lives in the covering test's own file, not `b`'s). **Every child
  is anchored on its OWN exact row — deliberately NOT rolled up onto a wider
  structural change-group.** An earlier version (2026-07-30, the same commit
  that introduced this whole badge) rolled every child anchored anywhere
  within one of `b`'s own `changeGroups(rows)` runs up onto that group's
  FIRST row ("if it's on a group, show it on the group's first line"); that
  was reported as a bug (Reindert, 2026-07-31) as soon as a group contained
  several stacked, unrelated calls (e.g. three separate `requestCss(...)`
  calls in one group) — they all collapsed onto the first call's line,
  hiding that the other two calls even had underlying code of their own. Each
  bucket in `lineChildSummaries` is now keyed on the raw row directly, so N
  calls stacked in one structural group show N independent badges, one per
  line, each with its own done/total fraction. The per-bucket rollup itself
  still reuses `subtreeApproveCount`/`commentScopeKeys`/
  `commentActivitySummary` verbatim (summed/unioned over every distinct
  child anchored at that one row), so it's mathematically the same numbers
  the sidebar pill and the panel already show — just presented per line
  instead of per block. Threaded as a
  `lineSummaries` opt through `Block()` → `codeDiff`/`unifiedCodeDiff` →
  `codePane`/`paneHTML`/`unifiedHTML` → `rowCellHTML`/`unifiedRowHTML`,
  exactly like the existing `approvedRows`/`commentedRows` opts (a function
  re-evaluated inside the pane's own `.innerHTML` binding, so it re-renders
  on any approve/comment change without a new reactive slot). Since
  `avatarHTML` (`avatar.mjs`) returns an arrow.js `html`` ` template and
  `paneHTML`/`rowCellHTML` build plain HTML STRINGS (assigned via
  `.innerHTML`, not mounted as an arrow.js template), a raw-string sibling
  `avatarHtmlString` was added to `avatar.mjs` with its own attribute
  escaping — reusing `avatarHTML`'s template there would have leaked the
  template function itself as text (see the "leaks the template function as
  text" pitfall in `conventions.md`). Out of scope: the SVG preview (no
  "children per line" concept there). Test:
  `tests/line-underlying-summary.spec.mjs` (PR 100, reusing the existing
  call-arrow fixture — `ArrowCallerAction::execute`'s call to
  `ArrowHelperService::arrowHelper`, itself calling
  `ArrowNestedService::arrowNested` — proves the badge shows "0/3" on the
  call-site line before either is approved, and "✓ 3/3" once both are, via
  drilling in and approving each with the command palette).
  **The `commentActivity` half also counts a comment placed directly on the
  row itself, not only underlying-code-children activity** (Reindert,
  2026-07-30: seeing a comment on a TRANSLATION key with no indicator at all
  — see below — surfaced that the badge only ever rolled up children;
  explicit choice: "avatar+N ook voor de regel zelf", everywhere in the app,
  not just TRANSLATION). `lineChildSummaries` adds an anchor bucket for
  every row `commentRowSet(b)` already marks as commented (the same
  row-presence Set the 💬 marker uses) and always includes `b`'s own
  `file|label` key in that anchor's `commentActivitySummary` call —
  `commentActivitySummary` grew an optional second `matchesRow` predicate for
  this (`RelatedPanel.mjs`): a child's own comments still count regardless of
  row (a child is a separate block — its `rowStart` lives in the child's OWN
  aligned-row space), only `b`'s own comments are restricted to the rows
  that actually roll up onto that one anchor, so a comment on one line never
  bleeds onto every other line's badge.
  **TRANSLATION per-key rows now get both markers too** (previously entirely
  missing on this render path — a comment on a lang-file key showed no 💬 and
  no avatar+N at all, unlike ordinary PHP code): `Block.mjs`'s `translationSlot`
  threads `commentedFn`/`lineSummaryFn` into `translationBlockView` as two
  small callbacks (`commentMarkerFor`/`lineSummaryFor`, mirroring the
  existing `onScroll` callback) instead of the raw Set/Map, so
  `translationDiff.mjs` stays decoupled from `Block.mjs` (no circular
  import) — the callbacks reuse `commentMarkerHtml`/`translationLineSummaryHtml`
  (the latter shares `lineSummaryParts`, the content logic extracted out of
  `lineSummaryBadge`, with a plain inline wrapper instead of `lineSummaryBadge`'s
  own absolute positioning — a per-key row has no single code line whose
  right edge it could float over). Rendered inline in the key header, next
  to the existing kind pill, keyed by the unit's own `u.row` (the same
  aligned-row index `translationRowUnits` already maps every key onto).
  Tests: `tests/translation-navigation.spec.mjs` (💬 marker after placing a
  comment on a key) and `tests/underlying-comment-activity.spec.mjs` (the
  avatar+N badge now also firing for a comment on the block's own row, no
  children involved).
- **Server-side `total` (`blockstats.go` + `GET /api/blockstats`):** the number
  of approvable changed-rows per block is computed **in the backend** so it's
  known immediately — even before a block has lazily loaded its code — and
  lives in exactly the same aligned-row index space as the approved rows in
  `approvals.db`, so `done/total` is always correct. `blockstats.go` is an
  **exact Go port** of the frontend's `changedRows(blockRows(b))` (`Block.mjs`):
  it reads the old/new source from the base/head worktrees (like `/api/code`),
  applies the same `dedent4` + LCS line alignment (`alignRows`/`diffLines`,
  whitespace-insensitive), and counts the changed, non-ws-only, non-empty rows
  (a pure deletion counts as 1 filler row; a ws-only re-indent doesn't count; an
  empty line doesn't count — see `rowHasContent` below). `GET
  /api/blockstats?pr=N` returns `{pr, totals}` (block-id → count) and is
  **read-only** — it only reads worktree files, so it's fine from a read
  handler (write boundary). Parity with the JS is proven by
  `TestChangedRowCount` (`blockstats_test.go`) on shared fixtures (including
  pure deletion + ws-only + an empty line in an added/removed block).
  Frontend: `home.mjs` (`loadBlockStats` → `state.blockTotals`);
  `blockApproveCount` prefers this backend `total`.
- **`rowHasContent` — an empty added/removed line is diff noise, not a
  countable/landable unit (`Block.mjs` + the Go port in `blockstats.go`, exactly
  in lockstep).** A row can be `rowChanged` (carries a del/ins mark) yet still
  contain a fully empty (after `trim()`) line — e.g. an empty line between two
  statements inside a **fully added** block (`status:'added'`, so the whole
  body comes purely as `ins` rows from `newText.split('\n')`, including its
  empty lines), or an empty removed line. Such a row has nothing for the
  reviewer to read or judge, but before this fix it simply counted in
  `changedRows()` (so in the approve counter/`blockApproved`/the backend
  `total`) and got its own, visibly-empty navigation unit at
  `gran==='line'`/`'call'` (`changeLines`/`changeCalls`) — you could select and
  even approve it despite nothing being there ("there's nothing there, but I
  can still select/approve it", and the approve counter ran ahead of the number
  of visible code lines). `rowHasContent(r)` checks whether the **display
  side** of the row (the new/`right` side for an `ins` row, otherwise the
  old/`left` side for a pure deletion) is non-empty after `trim()`;
  `changedRows`/`changeLines`/`changeCalls` (and the Go `changedRowCount`)
  filter on top of that. **Deliberately NOT applied to `changeGroups`/
  `rowChanged` itself:** an empty line still simply flows along within the
  group run it falls in (like a brackets-only line via `hasLetter`) — only its
  own countability/landability is suppressed, not its place in a broader
  group highlight (no visual jump in a group's diff highlighting). See also
  `changeLines`/`changeCalls` in `.claude/rules/keyboard-navigation.md`.
- **Approving a line/group also sweeps in a directly-FOLLOWING bracket/
  punctuation-only row — `isBracketOnlyRow`/`sweepBracketOnlyForward`
  (`Block.mjs`), frontend-only, no Go port.** A changed row whose display
  text (same side-selection as `rowHasContent`) is, after `trim()`, nothing
  but `)` `}` `;` `,` `]` `{` (combinations count too, e.g. a lone `});`
  closing a callback) still counts toward `changedRows`/the approve
  `total` like any other row (that part is unchanged — this is NOT another
  `rowHasContent`-style exclusion), but the reviewer no longer has to
  approve it separately: `toggleApprove` (`home.mjs`, `gran==='group'`/
  `'line'` only — **not** `'call'`, `toggleCallApprove` is untouched) sweeps
  it into `b.approvedRows` automatically the moment the line/group right
  before it gets approved. Deliberately **one-way and forward-only**: the
  sweep only runs on the ADD path (`allIn` — whether this action approves
  or retracts — is computed on the RAW, un-swept target first, so the sweep
  itself can never flip that decision), never on retract, and only looks at
  rows AFTER the approved unit, never before. That sidesteps the edge case
  of a bracket-only row sitting between two independently-approved
  neighbors (retracting one side would otherwise have to decide whether to
  un-sweep a row the other side still relies on) — once swept in, a
  bracket-only row simply stays approved regardless of what happens next to
  a neighboring line.
- **Sort order of the left list (`categoryRank` in `recomputeLeftList`,
  `home.mjs`):** the left list is not simply ingest/source order — it sorts by
  category priority: **ROUTE** first (the root of the
  route→controller→request/resource/model hierarchy, see Task 7), then
  **CONTROLLER**, then everything else unchanged — and **relation children
  after everything** (the "Onderliggende code" section at the bottom, see
  `recomputeLeftList`/`state.underlyingIds` in
  `.claude/rules/detail-layout.md`). The sort happens **after** the existing
  filters (resolved-call-targets/search term) and is a
  **stable** sort (`Array.prototype.sort`, guaranteed stable in modern JS
  engines) — within each rank the original order thus stays intact. This is
  safe for `sameFileNeighbour`/`stepBlock` (the same-file connector +
  `↑`/`↓` flow-through to a neighboring block, see `keyboard-navigation.md`):
  those only look at the **direct index neighbor** in `state.blocks`, but
  because `classify.go` derives the category from the file path, all blocks
  from the same file always share the same category and thus the same rank —
  the stable sort therefore guarantees they stay together. `sel`/refresh
  restore remain unaffected: those look up by block **id**/`file:line`, not by
  index (see the URL-state section in `CLAUDE.md`), so a different order
  changes nothing about where a restored selection lands.
- **Trait blocks (`TRAIT` category, keyword-based, not path-based).** A method
  declared directly inside a PHP `trait` body classifies as **`TRAIT`**
  instead of falling through to `OTHER`/whatever its directory would
  otherwise suggest — mirrors the existing `INTERFACE` override exactly:
  `phpscan.go`'s `scanPHP` already tracks each `classFrame`'s `kind`
  (`class`/`trait`/`interface`/`enum`) while scanning, so it stamps
  `Block.IsTrait` (transient, `json:"-"`, alongside `Block.IsInterface`) on
  every method/header block declared inside a `trait`; `classifyFile`
  (`classify.go`) overrides `Category` to `"TRAIT"` whenever that flag is
  set, **regardless of the file's path**. This is deliberately
  **keyword-based, not path-based**, unlike most other `categoryRules`
  entries: a trait file isn't confined to one directory convention
  (`app/Traits/`, `packages/*/Traits/`, or no dedicated directory at all)
  and has no reliable filename-suffix convention either (unlike
  `*Interface.php`), so a pure path rule would miss most real-world traits.
  A narrow **path-based fallback** (`hasSeg(p, "Traits/")` in
  `categoryRules`, placed early like the `*Interface.php` fallback) only
  matters for the scanner's whole-file-fallback scenario (unparseable file,
  so `Block.IsTrait` is never set) — the same two-layer shape as
  `INTERFACE`. **Deliberately not** wired through
  `callresolve_analysis.go`'s `scanTraits`/`idx.traits`: that's a separate,
  whole-worktree regex scan used by the `build_relations` Activity to link
  trait *usage* (`use HasIncludeLabel;`) to its declaration as an
  Underlying-code child (see "Resolving (also unchanged) called … methods"
  in `.claude/rules/tembed-workflows.md`) — a different life-cycle/input
  than classifying an already-scanned `Block` during per-file ingest, and
  `phpscan.go`'s own lexer already has the `kind` it needs. Frontend:
  `CATEGORY_STYLE.TRAIT` in `src/BlockList.mjs` uses the separate "gray"
  Tailwind family (distinct from `OTHER`'s `slate`/`zinc`) at a noticeably
  darker/higher-contrast shade, so the pill reads apart from `OTHER`/`TEST`
  by **lightness**, not hue — color-blind-safe; the pill's text label
  ("TRAIT" vs "OTHER") still carries the meaning either way. Tests:
  `TestTraitMethodIsFlaggedIsTrait`/`TestClassMethodIsNotFlaggedIsTrait`
  (`phpscan_test.go`),
  `TestTraitMethodClassifiesAsTraitRegardlessOfPath`/
  `TestCategoryForTraitPathFallback` (`classify_test.go`).
- **Translation blocks (`TRANSLATION` category + a clean key overview instead
  of raw code):** a PHP Laravel lang file (`resources/lang/<locale>/<name>.php`,
  `lang/<locale>/<name>.php`, or a module's own
  `modules/<Name>/Resources/lang/<locale>/<name>.php` — any `.php` path with a
  `/lang/` segment) classifies as **`TRANSLATION`** (`classify.go`,
  `categoryRules` — before the `MODULE` rule, so a module's own lang file
  doesn't get swallowed by the broader `modules/` path match, and before the
  `OTHER` fallback) instead of `MODULE`/`OTHER`, with its own yellow
  `CATEGORY_STYLE` badge.
  Such a file has no functions, so it stays one whole-file block. Instead of
  the line-based `codeDiff`, `Block.mjs` renders it (via `translationSlot` →
  `translationBlockView`, `src/translationDiff.mjs`) as a **changes-only key
  overview**: only added / removed / changed keys (dotted `file.a.b` form,
  old→new value), unchanged keys hidden. `translationDiff.mjs` is a small,
  tolerant, quote-aware PHP-`return [...]`-array parser (nested arrays,
  single/double-quoted strings with escapes, `//`/`#`/`/* */` comments; legacy
  `array( ... )` and numeric/list arrays are out of v1 scope — plug-and-pay
  lang files use `[...]` with string keys). Values render as plain text
  (arrow.js escapes them), so HTML in a translation shows literally.
  **Sibling locales as extra columns in the SAME card (superseded design —
  see below for the "two separate cards" precedent this replaced):** every
  OTHER locale that has the same lang filename gets its own read-only column,
  appended to every per-key row of the block currently being reviewed —
  `key | <own locale value(s)> | <sibling 1> | <sibling 2> | …`, one column
  per locale actually present under the lang root (2 locales → 3 columns
  incl. the key, 4 locales → 5, and so on — not capped at a fixed 2).
  Deliberately **visual only, not a structural merge**: navigation, approve
  and comment all keep working exactly as described in "Per-key navigation"
  below, scoped to the SELECTED block's own rows (its own
  `translationChangeUnits`) — a sibling column shows that locale's *current*
  value for the same key (or a "missing" marker), it never gets its own
  cursor/approve state, and the row list itself is never a union/intersection
  merge across locales. Concretely this means: **the sidebar still shows one
  row per lang file** (e.g. both `nl`/`checkout.php` and `en`/`checkout.php`
  if both changed in this PR) — there is no combined sidebar entry, no new
  `?sel=` scheme, and `recomputeLeftList`/`applyBlockRefRestore` are
  unaffected; **approve stays keyed to the selected file's own block id** in
  `approvals.db`, exactly as for any other block — selecting the `nl` row and
  approving a row only ever touches the `nl` block's own `approvedRows`, the
  `en` row (if it's also a changed PR block) keeps its own, separate
  approve state, shown when *that* row is selected instead.
  `translationBlockView` (`src/translationDiff.mjs`) renders the columns:
  `opts.siblings` (an array of `{locale, text}`) is appended, per row, via
  `siblingColumnHTML(sib, key)` — the primary column (key + value(s), see
  `translation-primary-col`) and every sibling column share the row's width
  **equally** (each `min-w-0 flex-1`, the same flex-grow share): 1 sibling
  locale gives 50/50, 2 give 33/33/33, and so on. The row therefore always
  fills **exactly** the card's own width, never wider and never leaving the
  primary column disproportionately wide next to a narrow sibling column
  (the reported bug this replaced a fixed `w-56 shrink-0` sibling column
  with) — the card itself never grows to fit more locales, and no horizontal
  scroll is needed for the column count itself.
  The sibling files (the OTHER locales, excluding the file's own locale and
  the `vendor/` namespace dir) come from the read-only
  `GET /api/langsiblings?pr=N&file=<lang file>` (`langsiblings.go`, reads the
  head worktree like `/api/code`, within the write boundary) — unchanged,
  fetched by `ensureLangSiblings`/`home.mjs` regardless of whether that other
  locale ALSO happens to be a changed PR block in this PR: it works whether
  the other locale changed or not, exactly like the design it replaced. See
  also "Resolving translation keys" in `.claude/rules/tembed-workflows.md`
  for the resolved `trans()`-child render (the second render mode, untouched).
  **The sibling columns landing after the initial render needed a SECOND,
  card-level keyed-node-reuse fix, on top of the existing `state.codeVersion`
  bump.** Bumping `state.codeVersion` does make `home.mjs`'s DetailPanel
  closure re-run and `Block(b, {...})` genuinely get called again with the
  freshly-fetched siblings — but `Block()`'s whole `<article>` output is
  embedded into the block card via a plain, statically-interpolated `${inner}`
  (not a `${() => ...}` binding), inside a node whose OWN `.key(...)` (in
  `home.mjs`, right where the card is built) did not change across that
  re-run — so arrow.js matched the card by its unchanged key and reused the
  already-mounted node (move+patch), which never re-applies that static
  interpolation (reproduced: `translationSlot` demonstrably ran again with a
  non-empty sibling array, yet the DOM never showed the columns). The card's
  `.key(...)` therefore also folds in, for a TRANSLATION block only,
  `state.langSiblings[b.id].length` (`langSibKeyPart`) — the same "key
  encodes the async-loaded state" idiom that key's other components
  (`code`/`load`/`err`, `foc`/`unfoc`) already use for exactly this reason.
  `translationBlockView`'s own per-row `.key(...)` additionally folds in a
  signature of the sibling locales for the same reason, one level down — a
  belt-and-braces defense in case a future change ever lets the ROWS get
  patched without the whole card remounting.
  **Previously (superseded): a separate companion card per sibling locale
  (`companionCard`, `data-testid=translation-companion`), placed directly
  next to the primary block in the block column — "option a: two separate
  cards, never merged".** That was a deliberate choice at the time; it has
  since been reversed on explicit request, in favor of the columns-in-one-card
  design above. `companionCard` and `translationSiblingView`
  (`translationDiff.mjs`) are removed;
  `siblingColumnHTML` is their replacement. What carries over unchanged: the
  data source (`ensureLangSiblings`/`GET /api/langsiblings`), the "missing in
  `<locale>`" marker for a key absent in a sibling, and the requirement that
  `ensureLangSiblings`'s fetch-then-render also bump `state.codeVersion` —
  reassigning `state.langSiblings` alone has been observed to intermittently
  not re-notify a dependent closure, the exact same "multiple reactive
  consumers of the same property" pitfall `.claude/rules/conventions.md`
  describes for the diff render itself; bumping the SAME `state.codeVersion`
  counter every other `b.code`-adjacent update in `home.mjs` already relies on
  is the same, already-established fallback trigger. Regression test:
  `tests/translation-navigation.spec.mjs` (moved from asserting a separate
  companion card to asserting the sibling column inline on each row).
  **Per-key navigation, approve and comment (`translationRowUnits`,
  `Block.mjs`):** the reviewer navigates a TRANSLATION block **per changed
  key** — `↑`/`↓` step through the key rows (highlighting one at a time, an
  indigo inset bar exactly like the diff's active-row highlight); `f`/`d`/`s`
  are a deliberate no-op (no group/line/call zoom — a key is always exactly
  one step). This deliberately reuses the EXISTING row-indexed
  approve/comment infrastructure instead of a parallel system:
  `translationRowUnits(b)` (`Block.mjs`) maps each changed/added/removed key
  (`translationChangeUnits`, `translationDiff.mjs` — the same
  changed/added/removed list `translationBlockView` renders, now carrying a
  1-based source line per key via a small position-tracking addition to the
  hand-rolled array parser: every parsed leaf entry records the byte offset
  of its own key token, converted to a line number) onto the **aligned-diff
  row** `blockRows(b)` already computes for the same block (a `newLineToRow`/
  `oldLineToRow` index built once from `blockRows`, since aligned rows carry
  no line numbers of their own). Once a key has a `row`, it slots directly
  into everything that already operates on `{start, end}` row ranges —
  `b.approvedRows` (approve/retract, the existing `changedRows`-based
  "approve X/Y" counter — deliberately **not** ported to Go/blockstats.go;
  each key falls on its own row in the common case, so the existing counter
  already reflects per-key approval correctly), `unitLineRange`/
  `commentTarget` (comment anchoring: a changed/added key anchors on its
  **new** line, a removed key on its **old** line, exactly like an ordinary
  code comment), and the "next unapproved" walk. `home.mjs`'s `navUnitsOf(b,
  rows, gran)` is the one dispatch point (used by `unitsOf`/`groupsFor`/
  `commentTarget`/`approveTargetRows`/`firstUnapprovedOwnUnit`/`openTask`):
  for a TRANSLATION block it always returns the per-key unit list regardless
  of `gran` (which stays pinned at `'group'`, since `setGran`/`extendRange`
  early-return for this category); every other block keeps using the
  granularity-based `unitsFor`. Each unit also carries its own `idx` (its
  index into `translationRowUnits`) alongside `{start, end}` — needed because
  two **different** keys can share the same aligned row (an added key
  directly followed by a removed one gets zipped into one del+ins row by
  `alignRows`, the same way an ordinary code block would) — `row` alone is
  therefore not always a reliable way back to "which key", so
  `Block.mjs`'s `translationSlot` reads `idx` directly instead of
  re-deriving the unit from its row. Rendering the active/approved state per
  row lives in each row's **own** nested `${() => …}` binding (not resolved
  once up front) — `translationBlockView`/`translationSlot` are otherwise
  only re-invoked on a `codeVersion`/focus change, not on every `↑`/`↓`
  step, so a synchronous, one-shot computation would freeze the highlight at
  whatever it was on that render (the same "outer closure vs. nested
  reactive slot" distinction as the `stepChevronSlot` pitfall in
  `conventions.md`). Test: `tests/translation-navigation.spec.mjs`.
  **A lang file with many changed keys scrolls out of view — and back into
  view — exactly like a tall code diff, by reusing the SAME mechanism, not a
  parallel one.** `translationBlockView`'s outer `[data-testid=
  translation-overview]` div is the block's actual scroll container once its
  rows overflow the card — this was already true before this paragraph was
  added, but only as an **unintended side effect** of the sibling-locale
  columns' own `overflow-x-auto` (see the "sibling columns" note above): the
  CSS overflow spec says that if one axis is anything other than `visible`
  and the other axis IS `visible`, the visible axis is computed as `auto`
  too — so `overflow-x-auto` alone silently made this element scroll
  vertically as well, with nothing to ever move that scroll position (↑/↓
  only ever advanced `state.change`/the highlight, see above — nothing
  scrolled the newly-active row into view, and there was no hint that more
  keys existed off-screen). That's now made **deliberate**: the div carries
  an explicit `overflow-auto` (both axes, `min-h-0 flex-1 no-scrollbar` to
  actually shrink within its card, mirroring `codePane`'s own scrolling div)
  plus the existing `data-scrollsync` attribute, `data-changed="1"` on every
  row (a changes-only list — every visible row already IS a change), and a
  reactive `data-change-active`/`data-change-active-end` on the currently
  active row (both on the SAME row, since a key-unit always spans exactly
  one row — mirrors a single-row `line`/`call` code unit). Those are
  EXACTLY the attributes `home.mjs`'s existing `scrollChangeIntoView` (every
  ↑/↓) and `Block.mjs`'s existing `updateHints`/`scrollHint` (the green
  in-card chevrons, see keyboard-navigation.md) already look for — neither
  function needed a single line of TRANSLATION-specific logic.
  `Block.mjs`'s `translationSlot` wraps `translationBlockView`'s return value
  in the SAME shell `codeDiff`'s own single-pane branches use
  (`data-testid="code-diff"` + a reactive `data-hints`, driven by the same
  `hintsEnabled` opt every card already gets) plus the two, unmodified
  `scrollHint('up')`/`scrollHint('down')` chevrons, and threads a small
  `onScroll` callback into `translationBlockView` (an `opts.onScroll`, the
  same shape as `opts.activeIndex`/`opts.approvedRowSet` — keeps
  `translationDiff.mjs` decoupled from `Block.mjs`, no circular import) that
  calls the existing, unmodified `updateHints` on manual scroll. Reusing the
  `code-diff` testid is doubly load-bearing, both for free: `home.mjs`'s
  `refreshHints()` (window resize) already sweeps every `[data-testid=
  "code-diff"]` on the page, so a TRANSLATION card's hints stay correct on
  resize without touching that function; and `menuAnchor()`'s existing
  `[data-change-active-end]` fallback now anchors the command palette on the
  active key row itself instead of the whole card — checked that this can't
  misbehave on a row with several wide sibling-locale columns:
  `menuAnchor()`/`positionMenu()` only ever read that element's `top`/
  `bottom` (the vertical anchor), never its `left`/`width` — the palette's
  width/left instead comes from `menuRegion()`, which for a TRANSLATION card
  already falls back to the whole block column (no `[data-pane]` exists in
  this render), unaffected by how many sibling columns scroll off-screen.
- **SVG blocks (`isSvgFile`/`svgSlot`, `Block.mjs`) — REPLACES the raw text
  diff with rendered old/new `<img>` previews, the same "replace, don't add
  alongside" precedent as `translationSlot` above.** A changed `.svg` file
  has no PHP function to scan, so it's a whole-file `OTHER` block (the same
  `ScanBlocks` whole-file fallback the TRANSLATION category also relies on).
  Old + new always render side by side; a one-sided (`added`/`removed`)
  block shows only the side it has (`singleSide(b)`, the same pane choice
  `codeDiff` itself uses). Deliberately **unaffected by the `a`
  split/unified/fit toggle** — that toggle exists to control how much CODE
  TEXT is visible/how wide a line is, and this preview has no such
  text-width concern, so `viewMode` is never read here; the card's own
  width is untouched too (an `.svg` file is not a PHP file, so it already
  gets the existing non-PHP width treatment, `boundedWrapWidthCls`, in
  every stand). **Security — never render the SVG source via `.innerHTML`
  (no inline `<svg>` in the DOM):** the content comes from the PR itself, so
  it's untrusted and could carry a `<script>`, an `onload=`/`onerror=`
  handler, or a `<foreignObject>`. `svgDataUri` instead turns the raw text
  into a `data:image/svg+xml;base64,...` URI for a plain `<img>` — a
  browser disables script execution/event handlers for an SVG rendered as
  an image, so a hostile SVG can't do anything beyond rendering its shapes.
  Returns `''` (→ a muted "geen preview" placeholder) for empty content or
  anything that doesn't even look like an SVG document (no `<svg` tag).
  **No raw-text fallback:** there is deliberately no toggle back to the
  plain text diff for a changed `.svg` file (the source stays reachable via
  `GET /api/code`/"Open on GitHub", just not surfaced in this card) — a
  dedicated toggle would need new ephemeral (or URL) state for a narrow
  case, out of scope for this change. Test: `tests/svg-preview.spec.mjs`
  (fixture PR 109, `svg-blocks.json` + `materializeSvgWorktrees` — including
  a hostile `<script>`/`onload=` payload that never fires).
- **Hiding approved blocks (`BlockList.mjs`):** fully approved **top-level**
  blocks (the pill `done === total`, subtree) are hidden by default from the
  "Start" list; a button at the bottom (`data-testid=toggle-approved`, "Show N
  approved blocks" / "Hide …") unfolds them (`state.showApproved`, ephemeral —
  not in the URL). Partial + unapproved always stay visible. Because `total` is
  known server-side, this works reliably before the code has loaded. The
  "Start" heading additionally shows a **PR-wide** counter
  (`data-testid=approval-summary`, "X/Y approved · N left to review") from
  `state.approvalTotal` — summed over the subtree counts in the same decoupled
  `watch` that fills `approvalSummaries` (a flat snapshot, so the heading never
  becomes a co-subscriber on a block's `b.code`). `renderList` **always**
  returns a keyed array (empty state as an array-of-one) to avoid the
  arrow.js single↔array slot pitfall (see `.claude/rules/conventions.md`). One
  per-row exception: the block `state.pinnedApprovedId` names stays visible
  while it's also the current selection — see "Load/refresh-restore → reveal"
  in `.claude/rules/keyboard-navigation.md`.
- **Pipeline:** `gh pr view` → `git fetch` (pull-ref + develop, fallback by
  sha) → two detached worktrees under `data/worktrees/pr-<pr>-{base,head}`
  (**absolute paths**!) → `git diff --unified=0` → PHP scanner (`phpscan.go`,
  brace lexer, no external parser) → classify (`classify.go`) → store. See
  skill `ingest-pr`.
- **Leading attributes (`#[...]`) belong to the block of the function below
  (`phpscan.go`).** A PHP attribute right above a method/function —
  `#[DataProvider('providerMethod')]`, `#[Route('/x')]`, stacked attributes, or
  an attribute whose arguments span multiple lines — counts as part of
  **that block**, not as loose text in between: `Block.Line` starts at the
  **first** attribute line of a contiguous run, instead of at the `function`
  line itself. `scanPHP` keeps a `pendingAttrLine` for this: every `#[` (now
  scanned via an explicit `skipAttribute` lexer — respects nested `[`/strings,
  so an attribute argument like `#[Attr(['a', 'b'])]` or a quote containing a
  `]` doesn't break the scan prematurely) sets it, if still empty; modifier
  keywords (`public`/`protected`/`private`/`static`/`abstract`/`final`/
  `readonly`/`var`) leave it intact as long as they sit between the attribute
  and `function`; **any other token** (a type hint, a variable name, `;`, a
  `class`/`trait`/`interface`/`enum` keyword) resets it to 0 — so an attribute
  on a property (`#[Deprecated] private string $x;`) never leaks to a
  further, unrelated method. The class-header sentinel (`classHeaderSentinel`)
  and the body scan itself remain unchanged: only the moment `Block.Line` is
  captured shifts (`scanFunction` got a `declLineOverride` parameter for this).
  **Consequence for `classify.go`:** because `classifyFile`'s "is this block
  changed?" check simply does `intersects(nb.Line, nb.EndLine)` on the changed
  lines, a change that **exclusively** touches the attribute line (e.g. a newly
  added `#[DataProvider(...)]` above an otherwise unchanged test method) now
  also counts as "modified" — before this change, such an attribute-only diff
  fell outside every block and the block therefore never appeared in the
  review tree at all. **Consequence for consumers that scan "the text above the
  declaration"** (like `testcovers_analysis.go`'s `methodZone`, which reads
  annotations like `#[CoversMethod]`/`#[Test]`/`@covers`): part of that text
  now sits, for a block with leading attributes, already **inside** the block
  itself instead of above it. `testcovers_analysis.go`'s `funcDeclLine`
  (searches for the real `function` keyword within the block, since annotation
  attributes never contain that word) resolves this: `methodZone` uses that
  line — no longer `b.Line` — as the upper bound of the scanned zone, so the
  already-folded attributes are counted anyway. Any new detector that reads
  "the zone above a method" (see e.g. `data_provider` in
  `tembed-workflows.md`) must reuse the same `methodZone`/`funcDeclLine`
  approach, not rely on `b.Line` itself. Tests: `phpscan_test.go`
  (`TestLeadingAttributeIncludedInBlock`,
  `TestMultilineLeadingAttributeIncludedInBlock`,
  `TestStackedAttributesUseFirstLine`,
  `TestPropertyAttributeNotLeakedToNextMethod`), `classify_test.go`
  (`TestAttributeOnlyChangeClassifiesAsModified`).
- **PHPDoc description as block description (`phpscan.go`, deterministic,
  NO AI).** If a `/** ... */` PHPDoc sits directly above a method/function
  (two asterisks at open — a bare `/* ... */` doesn't count), `scanPHP`
  extracts the **free-text lines** (any line that, after stripping the
  framing and a leading `*`, doesn't start with `@` — so no
  `@param`/`@return`/`@var`/etc.) and joins them into one paragraph
  (space-separated) into the new field **`Block.Description`** (`model.go`).
  Purely textual extraction from the source — no LLM call, so no cost/latency,
  and fully deterministic on re-ingest.
  Mechanism, analogous to `pendingAttrLine` above but independent of it:
  `scanPHP` keeps its own `pendingDocText`, set whenever a `/**` comment is
  scanned (`phpDocDescription`, only overwritten by a later non-empty PHPDoc —
  "last before the declaration wins"), and survives — unlike `pendingAttrLine`
  — the presence of intervening attributes/modifiers: a PHPDoc can simply sit
  **above** a leading `#[...]` attribute (`/** */` then `#[Test]` then
  `function`), and must still be attributed to that method even though the
  attribute itself pulls `Block.Line` toward itself (see above).
  **A PHPDoc has recently also started pulling `Block.Line` toward itself,
  just like a leading attribute** (previously this was deliberately the
  opposite: the PHPDoc explicitly did not influence `Block.Line`/`EndLine` —
  that left a gap: a change that **exclusively** touched the PHPDoc text
  (typo fix, an adjusted `@param`/`@return`) fell outside
  `[Block.Line, EndLine]` and `classifyFile`'s `intersects` check never saw it;
  the block then never appeared in the review tree at all). `scanPHP` keeps
  its own `pendingDocLine` for this (analogous to `pendingAttrLine`, but
  tracked separately): set on the opening line of **every** real `/**` PHPDoc,
  even one with only `@tag` lines and no extractable free text (symmetrical
  with how an empty `#[...]` attribute counts too) — a bare `/* ... */`
  comment stays out of scope, that never triggers `pendingDocLine`. In the
  `"function"` branch, `declLine` becomes the **earliest** (topmost) non-zero
  value of `pendingAttrLine`/`pendingDocLine` — a PHPDoc can sit either above
  or below a leading attribute, and in both orders the topmost line wins.
  `EndLine` remains unchanged (the docblock/attributes are by definition
  before the function, never after). `pendingDocText`/`pendingDocLine` reset
  to `""`/`0` on exactly the same triggers as `pendingAttrLine` (a `;`, a
  `class`/`trait`/`interface`/`enum` keyword, or any other unrelated
  identifier) so a PHPDoc above a property (`/** ... */ private $legacy;`)
  never leaks to a further, unrelated method. Class-level PHPDoc (above
  `class X {` itself) and the synthetic blocks (class-header sentinel,
  enums/models/macros/commands in `callresolve_analysis.go`) deliberately get
  **no** description **and** are not captured in a `Block.Line` — only a real
  `function` declaration in `scanPHP` does that.
  **Consequence for `testcovers_analysis.go`'s `funcDeclLine`:** because a
  PHPDoc's free-text prose can plausibly contain the word "function" (e.g.
  "This function creates an order."), `reFunctionKeyword` was tightened from a
  bare `\bfunction\b` to `\bfunction\b\s*&?\s*\w*\s*\(` (requires a `(` shortly
  after, like a real declaration/closure) — otherwise `funcDeclLine` would
  falsely match such a docblock line instead of the real `function` line below
  it, corrupting `methodZone`/`onlyBareTestAttributeLinesChanged`/the
  data-provider resolution. Test:
  `TestFuncDeclLineIgnoresFunctionWordInDocProse`
  (`testcovers_analysis_test.go`).
  **Storage:** column `description` (TEXT, default `''`) on `blocks` (light
  migration in `openDB`: `ALTER TABLE … ADD COLUMN`, duplicate-column error
  ignored — same pattern as `file_deleted`; `schemaDDL` + `schema.sql` in
  sync), written by both `replacePRBlocks` and `upsertPRFileBlocks` and read by
  `blocksByPR` → automatically in `/api/blocks` via the plain struct tag
  (`json:"description"`, no `MarshalJSON` special case needed).
  **Display:** no new UI needed — `src/Block.mjs` already had a section on the
  block card that shows `b.description` (with an italic "no description yet"
  fallback when empty, and otherwise **no** label in front of it — see the
  section "Folding PHPDoc types into the signature, `description` already
  stands apart from it" below for why a separate "Purpose:" label is no longer
  needed); that section was already there before this change, only the field
  was never filled. Test: `phpscan_test.go`
  (`TestPHPDocDescriptionCapturedForMethod`,
  `TestPHPDocDescriptionSurvivesLeadingAttribute`,
  `TestPHPDocDescriptionNotLeakedAcrossProperty`,
  `TestPlainBlockCommentIsNotADescription`, `TestNoPHPDocMeansNoDescription`,
  `TestPHPDocPullsBlockLineLikeAttribute`,
  `TestPHPDocAndAttributeBothPullBlockLine`); `classify_test.go`
  (`TestPHPDocOnlyChangeClassifiesAsModified`, the PHPDoc mirror of
  `TestAttributeOnlyChangeClassifiesAsModified` below).
- **Folding PHPDoc types into the signature, `description` already stands
  apart from it (`codesig.go`).** A PHPDoc's free text already lives on
  `Block.Description` (see above) — but the PHPDoc *lines themselves* remained
  visible in the diff after 49fd34c (which pulled `Block.Line` up to the doc,
  see above), because `extractBlockSource`/`blockSource` literally slice
  `[Block.Line, Block.EndLine]` out of the worktree and that range now
  includes the doc. `codesig.go`'s `enrichSignatureWithDocTypes(text)`
  therefore folds a leading PHPDoc's `@return`/`@param` types **into the
  visible function signature** — as if PHP were strictly typed, with the
  docblock syntax carried over literally (e.g. `array<string, mixed>|null`,
  even though that isn't valid native PHP syntax — purely cosmetic, Prism just
  highlights such a token more plainly) — and removes the doc lines themselves
  from the text. An existing native `?array` return type gets **replaced** by
  the docblock type; if a native return type is entirely absent, `: <type>` is
  **added** before the `{`/`;`. An `@param TYPE $name` tag only replaces the
  type portion of that one parameter (modifiers like `public readonly`, a
  leading `#[...]` attribute, and the `&`/`...` markers stay intact) — a
  parameter without a matching `@param` name is left untouched.
  **Type folding is "all-or-nothing" per block:** if the signature can't be
  found/rewritten with certainty (see the two scope boundaries below, or just
  an unparseable edge case), **no type at all is folded** — there is no
  in-between form where the doc is partially gone without its type being
  fully folded.
  **But the leading PHPDoc disappears either way** (`code.go`'s
  `enrichedCodeSide` → `stripLeadingPhpDoc` in `codesig.go`): if
  `enrichSignatureWithDocTypes` folded nothing (`removed == 0` — a **doc with
  only free text** and no `@param`/`@return`, or a non-rewritable signature),
  the leading `/** … */` still gets **unconditionally clipped**, with the
  same `Start += removed-lines` correction as folding. This way a raw
  docblock never remains in the displayed "Underlying code" — the free-text
  description already lives separately on `Block.Description` (see above).
  For a free-text-only doc no type is lost (there wasn't one, that's exactly
  why folding did nothing); for a non-rewritable-signature doc with
  `@param`/`@return` types, those types do disappear from view — a
  deliberately accepted trade-off (v1), the point being that a half/raw
  docblock is uglier than a single missed type. The same
  `stripLeadingPhpDoc` fallback is mirrored in `blockstats.go`'s
  `blockChangedRowCount` (after its direct `enrichSignatureWithDocTypes` call,
  only when that folded nothing) so the approve-counter `total` never counts
  clipped doc lines — the existing Go/JS parity pattern. **Leading-only
  scope**, same as folding and `trimTrailingBlankLine`: only a `/**` as the
  first non-whitespace token is picked up (an `#[Attr]` before the doc stays
  put); a bare `/* … */` (single star) is not a PHPDoc and is left alone.
  **Two deliberate scope boundaries (v1):**
  - The PHPDoc must be the **very first** thing in the sliced block text — an
    attribute before the doc (`#[Foo]` then `/** */` then `function`) is
    **not** supported; such a block stays unchanged (doc remains visible). An
    attribute **after** the doc (`/** */` then `#[Foo]` then `function`)
    works fine — it simply stays put, literally, between the removed doc and
    the rewritten signature.
  - **Multi-line signatures are supported** (a parameter list or return type
    spanning multiple lines, e.g. constructor property promotion) — the
    parsing works on byte offsets, not lines, so it just scans right through
    line breaks (`matchBracket`/`splitTopLevel` track bracket depth + quote
    escaping, regardless of newlines).
  **The `Start` correction is load-bearing:** `code.go`'s `enrichedCodeSide`
  bumps `codeSide.Start` by exactly the number of removed lines when the doc
  disappears — without that correction `unitLineRange`/`commentTarget`/
  `githubFileLine` (`home.mjs`, counting absolute line numbers from
  `c.new.start`/`c.old.start`) would shift a GitHub comment anchor or the
  "Open GitHub" deep link by exactly as many lines as doc lines were removed.
  **Where this is/isn't applied:** only at the two call sites that are
  "display/counting" — `api.go`'s `handleCode` (feeds `/api/code`, so
  `Block.mjs`'s diff — both the top-level block and any drilled column that's
  a real PR block, since those all go through the same `ensureCode`) and
  `blockstats.go`'s `blockChangedRowCount` (the approve counter/`total` — the
  same function feeds both, so diff display and approve counter automatically
  stay in lockstep, the existing `changedRowCount` Go/JS parity pattern).
  **`extractBlockSource`/`blockSource` themselves remain unchanged** —
  `relations.go`/`callresolve_analysis.go`/`testcovers_analysis.go` still read
  the raw, line-accurate text (their `matchLine`/`funcDeclLine`/`methodZone`
  rely on that 1-to-1 line↔`Block.Line` correspondence).
  **Also applied to embedded "Underlying code" children** (a
  `method_call`/`covers` child whose code is **embedded** in its
  callresolve/testcovers row — an unchanged file, code captured directly via
  `blockSource` at analysis time, see "Resolving called … methods"/"Coupling
  test coverage" in `.claude/rules/tembed-workflows.md`):
  `ChildCode`/`CoveredCode` go through the same `enrichedCodeSide(blockSource(…))`
  before they end up in the `callresolve`/`testcovers` row, in
  `callresolve_analysis.go` (the `method_call` rules 1-5b/2c via `emitKind`,
  the enum-case rule 6, `resolveMigrationModels`, `resolveDataProviders`),
  `testcovers_analysis.go` (`coverEntriesForTest`, the method-level Go
  resolution), and the two LLM `found` paths (`resolve_call.go`'s
  `verifyDefinition`, `resolve_test_covers.go`'s `resolveTestCoversWithModel`).
  `ChildLine`/`CoveredLine` shift along (`code.Start` instead of `def.Line`/
  `e.Line`) — those fields aren't read by any frontend consumer today, but
  stay in lockstep with `Code` should that ever change. An enum-case/
  migration-model child (a synthetic whole-class/whole-enum block, see
  `scanEnums`/`scanModels`) carries by construction no leading PHPDoc in its
  `Block.Line`, so this is a practical no-op there — the wrapper is applied
  anyway, for uniformity and so nothing has to be special-cased in a later
  scanner change. A sibling-reused testcovers row (`reuseSiblingCovers`,
  `resolve_test_covers.go`) copies an already-enriched `CoveredCode` verbatim,
  so it needs no adjustment of its own. A drilled column that's a real PR
  block (i.e. via `/api/code`) already got the transformation for free, like
  any other block.
  Test: `codesig_test.go` (single-line and multi-line signatures, constructor
  property promotion, missing native return type, a bare/tag-less doc that
  stays unchanged, no-doc, attribute-before-doc that stays unchanged,
  attribute-after-doc that stays intact, a stale `@param` name that only
  affects the matching parameter, and the `&`-by-ref- vs. intersection-type
  disambiguation); plus a parity test showing that `blockChangedRowCount`'s
  result drops when only the doc is folded. The embedded-child transformation
  itself is tested in `callresolve_analysis_test.go`/`testcovers_analysis_test.go`
  (a resolved `method_call`/`data_provider`/`covers` target with a leading
  PHPDoc yields a folded `ChildCode`/`CoveredCode` without `/**` and a shifted
  `ChildLine`/`CoveredLine`) and `resolve_call_test.go`/
  `resolve_test_covers_test.go` (the same for the LLM `found` path).
- **Trimming a blank trailing line (`trimTrailingBlankLine`, `codesig.go`),
  independent of the PHPDoc fold above.** `classHeaderSentinel` (`phpscan.go`,
  see the doc comment there) has no closing `}` of its own — its `EndLine` is
  **derived** as `declLine - 1` (the line right before the next method
  declaration, itself possibly pulled back to a leading PHPDoc/attribute by
  the "PHPDoc pulls Block.Line" change above), or as the line right before the
  class's closing `}` if the class never gets a method. If — perfectly normal
  PHP style — there's a blank line between the last header content (a `case`,
  property, constant) and what follows, that blank line gets literally
  sliced in as the **last line** of the header block text: a visibly empty,
  highlighted row at the bottom of the diff card, without any meaning (the
  row is already uncountable/unnavigable anyway — `rowHasContent` already
  excludes it from `changedRows`/the approve `total`, this is purely a render
  artifact). `trimTrailingBlankLine(text)` clips exactly **one** wholly-blank
  trailing line from `text` (regex-free: find the last `\n`, `TrimSpace` on
  what follows) and reports how many lines that was (0 or 1) — deliberately
  no loop (multi-blank-line trimming), this covers the observed case (one
  stylistic blank separator line) without further guessing. **Fully
  orthogonal to the PHPDoc fold:** it fires regardless of whether
  `enrichSignatureWithDocTypes` did anything, and it corrects the **tail**
  (`End`) instead of the **start** (`Start`) — the two corrections thus live
  independently side by side in `enrichedCodeSide` and in `blockstats.go`'s
  `blockChangedRowCount` (exactly the same two call sites as the PHPDoc fold,
  for the same Go/Go parity reason; in `blockstats.go` a numeric no-op since
  the row was already excluded by `rowHasContent` anyway, but applied so the
  two transform pipelines don't diverge). **Deliberately does NOT touch**
  `phpscan.go`'s `Block.Line`/`EndLine` or `classify.go`'s "is this block
  touched by the diff" decision — pure display, exactly like the PHPDoc fold
  itself: a block that only classifies as `modified` via this blank trailing
  line (like an enum's `<class-header>` where nothing else changed in the
  cases, only a new method + the separator line beneath it was added) thus
  simply stays visible in the review tree — only the blank row itself
  disappears from what the reviewer sees. (An alternative that would have
  adjusted `phpscan.go`'s `EndLine` calculation is deliberately rejected: that
  would drop this specific block — which otherwise changed nothing — entirely
  out of the diff and thus out of the review tree, a far bigger behavior
  change than "remove the blank row from the display.") Safe by construction
  for every other block: a real function/method's `EndLine` is always its own
  closing `}` (never blank), so this trim is a no-op for the vast majority of
  blocks — including every embedded Underlying-code child (the same
  `enrichedCodeSide` wrapper, see above), with no separate wiring.
  Test: `codesig_test.go` (`trimTrailingBlankLine` itself: a blank last line
  via a trailing `\n`, a whitespace-only last line, a no-op on real
  content/single-line/empty string, and that two consecutive blank lines are
  deliberately trimmed only once; `enrichedCodeSide` with only the tail trim,
  no transform at all, and with the PHPDoc fold + tail trim combined in one
  call to prove the `Start` bump and `End` lowering stay independently
  correct).
- **Exception: a bare `#[Test]`-only change deliberately does NOT count as
  "modified" (`classify.go`).** An added/removed/adjusted `#[Test]` (PHPUnit's
  argument-less test marker) has no reviewable meaning — unlike
  `#[DataProvider(...)]` above, which should keep counting as a real change.
  `classifyFile` therefore calls, after the existing `intersects` check,
  `isBareTestAttributeOnlyChange(fd, oldLines, newLines, ob, nb)`: that's only
  true if **every** changed line within the block (a) lies in the
  leading-attributes prefix (before the real `function` line, via the same
  `funcDeclLine` that `testcovers_analysis.go` already uses) and (b) is,
  trimmed, literally `#[Test]` — no arguments, no other attributes on the
  same line. If so, `modified` is set back to `false` and the block doesn't
  appear at all (just like a truly unchanged block) instead of showing the
  entire, otherwise untouched test method. A `#[Test]` addition **together
  with** a real body change still stays "modified" — the carve-out only
  applies when `#[Test]` is the *only* reason. Tests: `classify_test.go`
  (`TestBareTestAttributeOnlyChangeIsIgnored`,
  `TestBareTestAttributeChangeStillModifiedWithRealEdit`).
- **Truly deleted file (`file_deleted`):** "all blocks of this file are
  `removed`" is not a reliable file-deleted signal (the blocks table only
  contains *affected* blocks — a file with one removed method still simply
  exists). The real signal comes from the scan: `parseOneFile`
  (`parse_pool.go`) reads both worktrees, and a file that's **absent from the
  head worktree** (equivalent to git's `+++ /dev/null`) is truly deleted;
  `classifyFile` stamps that as `FileDeleted` on every removed block of that
  file. Persisted as column `file_deleted` (0/1) on `blocks` (light migration
  in `openDB`: `ALTER TABLE … ADD COLUMN`, duplicate-column error ignored —
  same pattern as the comments/relations modules; `schemaDDL` + `schema.sql`
  in sync), written by both `replacePRBlocks` and `upsertPRFileBlocks` and
  read by `blocksByPR` → `fileDeleted` in `/api/blocks` (via the plain struct
  tag, no `MarshalJSON` special case). The frontend marks it in **three**
  places, all rose/bold, via the shared helper `removedLabel(b)`
  (`Block.mjs`): "Deleted file" for `fileDeleted`, "Deleted" for a lone
  removed method — (1) the **card header badge** (`data-testid=
  block-status-badge`, replaces the bare status word; one stable span with
  whole-value class/text function bindings), (2) the **sidebar pill**
  (`data-testid=block-row-removed`, `removedPill` in `BlockList.mjs`, a nested
  slot next to `approvalPill` — `statusInfo`/`STATUS_STYLE` unchanged), and
  (3) the **diff banner** (`data-testid=removed-banner`) above the old-only
  pane in `codeDiff`'s `effectiveOnly==='left'` branch (only that branch was
  restructured: the outer `flex-col` holds `data-testid=code-diff`/
  `data-hints`, a nested `relative` flex-row carries the pane + scroll hints
  so `updateHints`/`syncScroll` keep working). Tests: `classify_test.go`
  (detection, DB round-trip via both write paths, migrate) and
  `tests/removed-file.spec.mjs` (PR 98 fixture
  `tests/fixtures/filedeleted-blocks.json`).
- **Moved/renamed file as 1 block (`OldFile`/`old_file`):** a file that the PR
  **moved** (a git-detected rename) is scanned as **one logical file** instead
  of removed@oldpath + added@newpath. `detectRenames` (`gh.go`, `git diff
  --find-renames --name-status` → `map[newpath]oldpath`) supplies the rename
  map; the **full ingest** (`scanAndStoreIngestBlocksLocked`, `ingest.go`) uses
  it to (a) include the old paths in the diff pathspec so git pairs the
  rename hunk under the new path (`diffBetweenSHAs` runs with
  `--find-renames`; a pathspec containing only the new path would suppress
  rename detection), and (b) have `parseOneFile` read the **old** source from
  `baseDir/oldpath` (new from `headDir/newpath`). Both block sets are scanned
  under the **new** path, so the existing `classifyFile` symbol matching
  (`Class::method`) pairs them **for free**: a method present in both versions
  → one `modified` block (with a real old↔new diff), new-only → `added`,
  old-only → `removed`. `File` always stays the **new** path (stable block-id
  on the head side); the pre-rename path lives on `Block.OldFile` (`model.go`),
  persisted as column `old_file` (light `ALTER TABLE … ADD COLUMN` migration,
  same pattern as `file_deleted`/`description`; `schemaDDL` + `schema.sql` in
  sync), written by both write paths and read by `blocksByPR` → `oldFile` in
  `/api/blocks`. **Go/JS parity on the old side:** both `/api/code`
  (`handleCode`, via an `oldFile` query param that `ensureCode` passes along)
  and `blockstats.go` (`blockChangedRowCount`, via `Block.oldPath()`) read the
  **old** diff side from `baseDir/<oldFile>` instead of `baseDir/<file>` —
  otherwise a moved block would diff against an empty base path and count
  entirely as `added`. **Display** (`Block.mjs`): when
  `b.oldFile && b.oldFile !== b.file`, the card shows the **old path (struck
  through) above** the new `file:line` line, in a stable `flex-col` root (the
  toggling `${() => …}` slot sits within that root — the "naked toggling
  expression" pitfall, `conventions.md`); `data-testid=block-old-path`.
  **Deliberate boundary ("best-effort"):** a move that git doesn't recognize
  as a rename at its default `-M` threshold (~50% similarity, too much content
  change) isn't in the rename map and just stays removed+added — no crash,
  exactly the old behavior. **Scope:** only the **full ingest**; the
  delta-refresh (`refreshIngestDelta`, `parseFiles(… nil …)`) keeps its
  deliberate `--no-renames` split (`changedFileNames`) — a rename that appears
  mid-refresh stays removed+added until a full re-ingest. Tests:
  `classify_test.go` (`TestRenamePairsBlocks` — pairing + `OldFile` stamping),
  `blockstats_test.go` (`TestBlockChangedRowCountReadsRenamedOldPath` — old
  side read from the old path), `tests/rename-file.spec.mjs` (PR 104 fixture
  `tests/fixtures/rename-blocks.json`, old-above-new display).
- **Runs as the `ingest` workflow (write boundary):** the blocks-table write +
  the git-worktree mutations no longer happen directly from an HTTP handler
  or the CLI, but within a tembed **Workflow Execution** (Workflow Type
  `ingest`, `workflows.go`), split into two Activities:
  `prepareWorktrees` (gh fetch + `ensureCommits` + the two `ensureWorktree`
  calls, returns only the small `worktreeSHAs` summary — base/head SHA + the
  changed file paths, not the worktree contents) and `scanAndStoreBlocks`
  (`git diff` + PHP scan/classification + `replacePRBlocks`, returns only the
  small `ingestResult` summary, not the blocks themselves — so the event
  history stays compact, as with `build_relations`/`pr_inbox`). Both Activity
  bodies (`prepareIngestWorktrees`/`scanAndStoreIngestBlocks` in `ingest.go`)
  remain ordinary, directly testable functions; they're just now called
  **exclusively** from these Activities. `TaskManager.StartIngest(ctx, pr)`
  starts the Execution (which, without a Signal, runs synchronously to
  completion) and returns the `ingestResult` summary.
- **Incremental refresh (new commits, no full re-ingest):** alongside this
  manual, full pipeline, `pr_status` automatically runs a **delta refresh** on
  its poll cadence as soon as a PR's live head SHA is ahead of what was last
  ingested (`pollIngestRefresh` → `PRStateSignal` → `refreshIngestDelta`
  Activity, `ingest.go`). That diffs only the **previously stored** head SHA
  (new `pr_ingest` table, `db.go`) against the new one, rescans **only the
  files changed since then**, and writes them via **`upsertPRFileBlocks`**
  (a DELETE+INSERT scoped to exactly those files — `DELETE FROM blocks WHERE
  pr=? AND file IN (...)`) instead of `replacePRBlocks`'s full per-PR swap.
  Every other file's own blocks — and thus everything hanging off their
  **stable** block-id in the separate comments/approvals/callresolve read
  models (no FK, so untouched anyway) — is left completely alone.
  **For a file the refresh DID re-scan, "untouched" is not enough**, and this is
  the one thing not to reason about from the block-id's stability: a comment's
  `row_start`/`row_end` and an approval's approved row indices are positions in
  the block's **aligned-row space**, and re-scanning the file rewrites that space.
  The rows survive the refresh, their meaning doesn't — a stale index points at
  whatever code took its place (the 💬 marker on the wrong line; the emerald ✓
  inherited by a line inserted above an approved one). **Every** path that swaps
  blocks — `prStatusWorkflow` after a non-skipped refresh, and `ingestWorkflow`
  after a full ingest, so also "Regenereren"/`slash ingest`, which never touch
  `pr_status` — therefore runs a **re-anchor pass** (`reanchorAfterRefresh` +
  `reanchor.go`), which moves each anchor onto the rows it
  now belongs to (matching a comment's stored code snippet; rebuilding the
  previous row space from the pre-refresh SHAs for approvals, which store no text)
  or degrades it honestly — unpinned to `row_start -1`, or marked `anchor_state
  'orphan'` when the symbol itself is gone. See the "Ingest refresh" section under
  `pr_status` in `.claude/rules/tembed-workflows.md` for the full mechanism (the
  heartbeat cadence, the base-SHA-changed fallback to the full pipeline, the
  re-anchor pass itself, and why relations/callresolve deliberately keep
  recomputing "fully" — over the PR's full current block list, not delta-scoped).
- **Running:** `go run . ingest <pr> [-db data/graph.db]` starts the `ingest`
  workflow headlessly (builds a standalone engine without server runtime — no
  poller resume, no inbox fetch, see `newTasks(..., resumeRuntime)` in
  `tasks_api.go`) and immediately after that `EnsureRelations`, just like the
  HTTP flow. The server side is `POST /api/ingest {"pr":N}` (`handleIngest` →
  `StartIngest` → `EnsureRelations`). Server: `go run . [-db path]
  [-data dir] [-addr host:port] [-static dir]`. DB path also via `SLASH_DB`;
  the **data dir** (holding `worktrees/pr-<n>-{base,head}`, which the read
  handlers `/api/code`, `/api/blockstats`, `/api/approvalsummary` and
  `/api/langsiblings` slice their diffs out of) also via **`SLASH_DATA`**,
  default `"data"` (`dataDirPath` in `main.go`, mirroring `dbPath`). It is
  configurable so the Playwright harness can point every worker server at its
  own throwaway fixture tree and never read or write the live `data/` tree —
  see "Playwright test infra" in `.claude/rules/conventions.md`. **The local
  clone** where all git/worktree operations run (`repoDir()` in `gh.go`) comes
  from **`SLASH_REPO_DIR`** (env), defaulting to `~/dev/plug-and-pay` — a
  leading `~` is expanded via `os.UserHomeDir()`, so `SLASH_REPO_DIR=
  ~/dev/...` also works. Serve: `GET /api/blocks?pr=N` (delta) and `GET
  /api/code?pr=N&file=..&class=..&name=..` (the old + new source of one
  block, from the base/head worktrees — for the side-by-side diff under the
  block info; `file` must be a stored block of that PR). The frontend
  (`Block.mjs`) aligns that old/new source **line by line** with its own LCS
  line diff (`alignRows`/`diffLines`, pure JS — no AI): matching lines share
  a row, a removed line leaves an empty filler row on the right, an added
  line leaves an empty filler row on the left, and changed lines get red
  (old) / green (new). Both panes render the same number of rows at the same
  row height, so they align vertically automatically. The line diff matches
  lines **whitespace-insensitively** (`diffLines` compares on
  `s.replace(/\s+/g,'')`, à la `git diff -w`): a line that's only been
  re-indented (e.g. an array nested one level deeper inside
  `array_merge(…)`) still pairs with its counterpart and shows as a
  whitespace-only re-alignment (`wsOnly`) — only the shifted whitespace gets
  a soft tint, the word itself is never char-marked — instead of shifting the
  positional del/ins pairing and marking unchanged words as "changed".
- **`blockRows(b)` is memoized (`blockRowsCache`, a module-level `WeakMap` in
  `Block.mjs`), outside reactive state — otherwise `diffLines`'s O(n·m) DP
  table gets refilled on every call.** `blockRows` has 20+ call sites (every
  diff render, every navigation unit, and — the most expensive case —
  `home.mjs`'s `approvalSummaries` watch, which on **every**
  `state.codeVersion` bump (so on every code load, including a look-ahead
  preview during ordinary ↑/↓ navigation in the sidebar) recomputes
  `subtreeApproveCount`/`blockRows` for **all** top-level blocks). For a
  normal PHP block (tens of lines) that's unnoticeable; for a non-PHP
  whole-file-fallback block (e.g. a several-thousand-line locale JSON, see
  "Pipeline" above — the scanner falls back to the whole file if parsing
  fails) that DP table is `(n+1)×(m+1)` cells and, without a cache, a
  repeated burden: measured once on a 9000-line JSON file, navigating the
  sidebar **after** touching that block cost 400–4900ms per step (instead of
  the usual tens of ms) as long as new blocks kept getting touched, with a
  6–15s peak on first contact. The cache key is the **reference identity** of
  `b.code`, not of `b` itself: `ensureCode` (`home.mjs`) always sets `b.code`
  **wholesale** (never mutated in place), so a changed reference is an exact,
  correct invalidation check — no staleness risk. The cache deliberately
  lives in a module-level `WeakMap`, not as a field on `b`, so it doesn't
  trigger an arrow.js reactive-proxy notify on something that's never read
  reactively anyway (the same pattern as `codeRequested` in `home.mjs`).
- **Huge blocks: `diffLines` prefix/suffix trim + context collapsing
  (`collapsePlan`/`collapsedRunHTML` in `Block.mjs`).** Two performance
  measures for a whole-file fallback block of thousands of lines (PR 13166's
  9179-line locale JSONs, ~7 changed lines — sidebar steps took 0.3–2.2s):
  (1) `diffLines` trims the common prefix/suffix (whitespace-insensitively,
  the same `key` as its DP) before building the O(n·m) LCS table, so the
  one-time first-contact spike collapses to the changed middle; and
  (2) blocks over **`COLLAPSE_MIN_ROWS` (300 rows)** collapse runs of ≥
  `COLLAPSE_MIN_RUN` (10) unchanged rows into one **clickable** "⋯ N
  ongewijzigde regels" spacer (`data-testid=collapsed-run`) — smaller blocks
  render byte-identically to before. The plan is a pure function of
  (rows, commented set, expanded runs), deliberately **not** of the active
  cursor: ↑/↓ never changes which rows exist in the DOM, and both panes
  collapse identically (row-for-row alignment). Changed rows +
  `COLLAPSE_CONTEXT` (3) context rows and commented rows are always kept, so
  every metadata-carrying row (`data-change-active`, ✓, 💬, `data-changed`,
  call-site `data-row`) is by construction rendered — navigation/approve/
  comments/`scrollChangeIntoView`/`updateHints`/`callArrows` needed no
  changes. Expanding goes via click delegation on the pane's `<code>`
  (`onPaneClick` — the spacer lives in an `.innerHTML` string, so it can't
  carry an arrow.js binding): the run lands in `expandedRunsByRows` (a
  non-reactive `WeakMap` keyed on the memoized `rows` array, ephemeral —
  resets on a code reload) and a reactive `collapseUi.v` bump re-renders
  exactly the subscribed big-block panes (a small block's `collapsePlan`
  early-returns before that read, so it never subscribes). Test:
  `tests/diff-trim-collapse.spec.mjs`.
- **Char diff: line background only, no word background.** A truly changed
  line (paired del/ins, not `wsOnly`) gets its red/green line background
  (pane tint), but the **individual changed characters/words within that
  line no longer get their own background** — that would give a double,
  darker "pill" on top of the line tint. `highlightChanges` in `Block.mjs`
  renders such a line without a word background; the token-granular
  `charDiffSides`/`tokenize`/`diffChars` pass (LCS on `[A-Za-z0-9]` runs, à la
  git word diff) now only runs for a `wsOnly` row, to mark the shifted
  whitespace itself (the soft `bg-rose-200`/`bg-emerald-200` tint above) —
  not for a real content change. The **call underline** (`UNDERLINE_CLS`,
  indigo, the active segment at `gran==='call'`) is a separate layer on top
  of the same `markChars` pass and continues to work unchanged, even on a
  line without a word background.
