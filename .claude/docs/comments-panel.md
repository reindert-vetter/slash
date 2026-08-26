# Comments in the review tree

Two distinct surfaces for the same `task_code_comment` data: **PR-wide** comments
become navigable rows in the sidebar ("Start" index), **block-scoped** threads
render as inline cards in `<main>`'s column flow above the Underlying-code card.

## Comment-index items (PR-wide comments as navigable "Start" rows)

A PR-wide comment (`kind !== ''` — GitHub-imported issue/review(-summary)
comments, plus a `code_warning` finding that couldn't be pinned to a block,
`kind:'ai_warning'`) has no `file:line` to anchor it, so it never shows in the
block-scoped comments index (`RelatedPanel.mjs`'s `recomputeView` excludes
`kind !== ''`). `home.mjs` instead turns each one into a **synthetic, fully
navigable item in the "Start" sidebar** — selected with `↑`/`↓`/click exactly
like an ordinary PR block. (This replaced the removed `PrWideComments` card,
see `.claude/docs/detail-layout.md`.) Its thread renders next to the index in
the SAME merged `comment-claude-row` an ordinary block-scoped comment+Claude
pair gets — not in the block column, which hides entirely for this case — see
"The comment-detail card moved into the merged comment-claude-row" below.

### Every UNRESOLVED comment gets such a row too, not only the PR-wide ones

Reviewer request ("ik wil dat alle niet resolved comments in de blokken index
komen"): `indexComments` also returns every block-anchored (`kind === ''`)
comment that is still open, on top of the PR-wide/orphan/`@`-mentioned ones it
already returned. Such a comment then lives in TWO places — its own index row and
its block's own inline thread — which is deliberate: an open comment must not be
able to hide inside a block you haven't opened yet.

One extra condition lives in `recomputeLeftList` (`home.mjs`) rather than in
`indexComments`, because it needs `state.blocks`: the comment's block must
actually be in this tree. Otherwise the row would be a dead end — the card shows
the comment, but there is no code to step into. The PR-wide/orphan kinds and an
`@`-mention keep their row unconditionally, as before.

Consequences documented elsewhere: it makes every open comment a stop on the ↑/↓
walk and an unapproved unit of the PR total, resolved via the row's own
**`Enter` menu** ("Resolve comment" — see `.claude/docs/approval.md`; `Space`
does NOT resolve a comment row, see "The comment_batch checkboxes and the
bottom action row" below), and it is what the `comment_batch` progress
hangs off (`batchPill` on the row, the log line in the card's footer — see
`.claude/docs/workflows-comments.md`).

### The comment_batch checkboxes and the bottom action row

Reviewer request: "verplaats deze lijst naar de index, dat moet dan checkboxes
krijgen met de actie row onderin" — followed by "die zijn toch hetzelfde? dat
moet hetzelfde zijn" once asked whether the palette's comment_batch list and
this very index were meant to be two different things. They weren't: the
`comment_batch` run (`.claude/docs/workflows-comments.md`) now works entirely
off THIS list, not a separate one.

- **Eligibility is the one existing rule, reused verbatim** — `isBatchEligible`
  (`commentBatch.mjs`): still open, not one of our own AI findings
  (`source==='ai'`/`kind==='ai_warning'`). `batchEligibleRows(state)`
  (`BlockList.mjs`) applies it to `state.blocks` itself — deliberately the rows
  ALREADY in this list, not the wider `commentListSnapshot()` the removed
  palette read: the checkbox lives on the row, so a comment with no row (e.g.
  its block isn't in this tree, see "Every UNRESOLVED..." above) simply can't
  be checked. A kilo-review bot summary needs no separate exclusion here either
  — it never gets a row at all (see `isKiloReview`'s call sites in
  `prWideComments`), so it never reaches `batchEligibleRows`.
- **The checkbox** (`batchCheckbox`, `data-testid=batch-checkbox`) renders on
  every eligible row, right before its avatar/category badge — **checked by
  default** (`state.batchChecked` only ever records an explicit *un*check,
  mirroring `state.ignoredComments`' shape, and is ephemeral/session-only,
  unlike that durable map: excluding one comment from THIS run is a momentary
  curation, not a standing reviewer decision). Toggling it never touches
  `state.selected` (`e.stopPropagation()` first, per the nested-`@click` rule
  in `.claude/rules/arrowjs-pitfalls.md`).
- **`Space` toggles it — reworked after a follow-up reviewer report.** The
  first cut left `Space` resolving the comment (unrelated to the checkbox) and
  added a separate `x` key for the checkbox itself; reported back as "does not
  work well with keyboard navigation" — resolving via a single, easy-to-hit
  key next to a checkbox was "too easy to trigger by accident", and clicking
  the checkbox with the MOUSE first (to test it) left the input holding real
  DOM focus, which silently broke every later `Enter`/`Space` on that row (see
  "Generic input-focus guard" in `.claude/docs/keyboard-navigation.md` for the
  `isEditableFocused()` root cause and its fix). Now: `Space` on a
  comment-index row (`spaceKey`, checked BEFORE any approve logic) toggles the
  SELECTED row's own checkbox (`toggleBatchChecked`, same function the
  checkbox's own click uses) when it has one; on a row with **no** checkbox
  (an AI finding, or an ignored-and-revealed comment) it instead **advances to
  the next row**, mirroring the existing "↓ falls through" convention rather
  than doing nothing. Resolving a comment no longer has ANY single-keypress
  shortcut — it only happens through the row's own `Enter` menu ("Resolve
  comment", already the default item for the reviewer's own comment). The `x`
  key from the first cut is gone outright (not kept as an alias): `Space` now
  covers the same ground and is the more discoverable, checkbox-native key.
- **The bottom action row** (`batchActionRow`, `data-testid=batch-action-row`)
  sits right after the two toggle rows and before the push-todo section (it
  acts on comments that are already in this list, so it belongs with the rest
  of the comment machinery rather than with the branch-level push todo) —
  "Verwerk N comments met Claude (Opus 5)", `N` = `checkedBatchComments(state)`,
  and shown only while at least one eligible row exists at all. Disabled while
  a batch is already running (the label then switches to the three-line
  running state — counter, "Bezig met: &lt;comment&gt;", and the live
  `claudeStatusText` activity, see "Where the reviewer sees it" in
  `.claude/docs/workflows-comments.md`) or while nothing is checked. Enter/click run
  `startBatchFromRow()` **directly — no confirm submenu**, since the
  checkboxes above already are the deliberate curation step (contrast the
  push-todo row right below it, which DOES open a confirm menu because pushing
  writes to a branch other people work on). It is itself a stop of the
  sidebar's `↑`/`↓` loop (`state.batchRowFocused`) — see "The sidebar's `↑`/`↓`
  cursor forms one circular loop" in `.claude/docs/keyboard-navigation.md`.
- **Starting the run** jumps to the first CHECKED comment (`jumpToCommentRow`),
  where the live pill/log show up, exactly as the removed palette did for its
  own first row.

### The old palette entry point was removed

`REVIEW_BATCH_COMMENTS_ITEM` (the "Laat Claude alle openstaande comments
verwerken" row in both review-submit follow-ups, and thus in `/` → GitHub →
"PR keuren") and the `'bulkComments'` palette mode it opened are gone —
**deliberately with no replacement shortcut**: the bottom action row above is
now always visible in the sidebar whenever there's something to batch, which
already covers that entry point. See `.claude/docs/command-palette.md`.

### Selecting a "Start" item empties the block-scoped index

A `kind:'comment'` sidebar item is itself unanchored, so the block-scoped index
next to it must show **nothing** — not "no filter". `commentTarget()`
(`home.mjs`) already returns `null` for it, but for a different reason (its own
"nothing to anchor a NEW comment to" no-op, load-bearing for `placeComment`);
reusing that `null` for the comment index too was indistinguishable from
"nothing selected yet", and `recomputeView`'s `!s` branch reads a null scope as
"no filter" — so selecting a PR-wide comment used to show the index's
**entire** unfiltered anchored list next to it. `commentScope()` (`home.mjs`)
therefore checks `focusedBlock().kind === 'comment'` directly (ahead of, and
independently from, `commentTarget()`) and returns a sentinel scope
(`{ none: true }`); `setCommentScope`'s signature (`RelatedPanel.mjs`) gives
that sentinel its own fixed signature (`'none'`, distinct from both the real-scope
join and the null-scope `''`) so the switch always re-triggers `recomputeView`,
which checks `s.none` **before** the `!s` branch and assigns `cs.view = []`.
`hasVisibleComments()` then reports `false`, so the inline `comment-item` cards
disappear and — per `claudeChatVisible()` — so does the Claude-chat column,
which is correct: there is no comment here to hang a chat on. The "Start"
item's own detail card (`commentDetailCard`, reading `prWideComments()`, not
`cs.view`) and its own thread cursor (`pct`/`enterPrCommentThread`) are a wholly
separate mechanism and are unaffected.

### Comment-index rows: grouping per source line was reverted — one row per comment, always

`commentGroupKeyOf`/`commentBlockItem` (`home.mjs`, called from
`recomputeLeftList`) USED TO merge every candidate comment that resolves to
the same real block AND the same source line (`file + '|' + label + '|' +
line`) into ONE index row instead of one row per comment — reviewer request:
several open threads on the same line used to clutter the "Start" list with
that many separate rows.

**Deliberately reverted (2026-08-27), `commentGroupKeyOf` now always returns
`null`.** Reported bug: a reviewer selected the ONE row for `SessionFlow::run`
line 131 and saw TWO comment cards on the right — a human review comment
(`ricky-imu`, "IsBotActivity check doet waarschijnlijk niets") stacked above
an unrelated AI-controle risk finding (`code_warning`, "bot workflow id blijft
sessie"), each with its own reply box. Root cause: an anchored `ai_warning`
finding drops to `kind === ''` once it resolves to a real line (see
`anchoredWarning` in `code_warning.go`), so it groups with an ordinary human
comment on the same line exactly like the grouping was designed to do — the
`onlyIds` narrowing ("Comments op regels shows only its own comment" below)
then correctly showed the WHOLE group, which is precisely what broke the
harder invariant the reviewer actually wants: **selecting one row on the left
must show exactly one card on the right, never another comment from the same
block/selection** — even two purely human comments on the same line. Given
that choice, the reviewer chose to drop the grouping feature entirely rather
than special-case AI-vs-human within it, explicitly accepting that the
original clutter complaint (many open threads on one line = many rows) is
back. **Do not reintroduce a grouping key in `commentGroupKeyOf` — if line
clutter becomes a problem again, solve it without merging distinct comments
into one selectable index row/right-hand view.**

The rest of the group machinery (`comments` on a comment-index item,
`commentAnchorOnlyIds`, the `· +N` label suffix) is left in place — every
group is now a group of exactly one, and that's the existing "solo comment"
fallback path described below, not new code. `c.line` (used by the now-inert
grouping key, kept for that same "first row of a range" reasoning below in
case grouping ever needs it again) is already the range's own FIRST row for a
comment placed on a whole group or a Shift+↑/↓ range: every comment is created
with `line: anchorLineFor(t, b)` (`ensureClaudeAnchorForNew` and the plain
composer, `RelatedPanel.mjs`), which starts at `t.startLine`, never the last or
middle row.

**`anchorLineFor(t, b)` falls back to the FOCUSED block's line, not the
top-level one.** Both call sites used to read `(t && t.startLine) || b.line`,
and `b` there is `state.blocks[state.selected]` — the top-level block, even
while a drilled Onderliggende-code column owns the keyboard. A drilled column
on an UNCHANGED block has no navigable unit, so `t.startLine` is 0
(`commentTarget`'s own `!unit` branch) and the anchor silently jumped up to the
parent: a chat started on `SessionEnricher::DEFAULT_UTM_VALUES` (line 29) was
stored on its `<class-header>` parent (line 28). The helper therefore tries
`t.startLine` → `t.line` → `b.line`; `t.line` is the focused block's own start
line, since `commentTarget()` follows `focusedBlock()` (see
`.claude/docs/drilling.md`).

The resulting item (`kind: 'comment'`, unchanged — no new kind was
introduced) carries the full group as `comments` alongside the existing
`comment` field, which stays the group's PRIMARY (first) comment — every
pre-existing single-comment mechanism (`selectedComment`,
`prCommentCommandsFor`'s Beantwoorden/Resolve/Chat/Ignore, the unanchored →
thread-walk below) keeps reading `comment` unchanged and simply acts on the
line's first comment; only `blockApproveCount` (done/total summed over the
whole group) and `spaceKey`'s resolve target (`firstUnresolvedComment`, which
walks to the first still-open comment in the group instead of getting stuck
once the primary one happens to already be resolved) look at `comments`. The
row's own label gets a `· +N` suffix once the group holds more than one
comment — dead code for now since `commentGroupKeyOf` no longer produces a
group bigger than one (see above), kept only because ripping it out would mean
re-adding it if grouping ever comes back in some other shape.

### An anchored "Start" item instead opens its block "as if fully expanded" — automatically, but the keyboard only follows on ArrowRight

The section above is for a genuinely unanchored item (a PR-wide comment, an
orphan, or one with no matching block at all). A comment-index row that DOES
resolve to a real block (`commentAnchorBlock(b.comment)`, `home.mjs` — the
same `file`+`label` identity `anchoredBlocks` already checks to decide
whether the comment gets a row at all, per "Every UNRESOLVED comment gets
such a row too" above) instead shows that block's own diff, its
Underlying-code panel and the embedded Claude column — reviewer request:
such an item should look "as if the code were already fully expanded", not
just the bare read-only thread card.

`openCommentAnchorDrill(b)` (`home.mjs`, called from the `state.selected`
watch) opens the anchor as a **drilled column** (`state.drill[0]`) — exactly
the mechanism `Enter` on an Onderliggende-code child uses (`drillIntoChild`)
— but **without leaving list mode**. That one difference is deliberate and
is the whole point: `BlockList` only hides the blokken-index in
`state.mode === 'diff'`, so it stays visible next to the expanded diff
**while the index is still being walked with `↑`/`↓`** (reviewer request:
"ook met de blokken index zichtbaar") — from the first `→` onward it does
collapse after all, see "The first `→`" below — and
`state.selected` is never touched, so the sidebar highlight stays on the
comment row itself rather than jumping to the block. The top-level
block-column (which would otherwise render the comment's own
`commentDetailCard`) is **hidden entirely** — see "The anchored column IS the
leading column" below — since `focusedBlock()` now resolves through
`state.focusLevel > 0` to the drilled anchor — `commentTarget()`/`commentScope()`/`relatedChildren()` all follow
that for free, so the comment thread (correctly scoped now, since an
anchored finding's own `Kind` is `''` per `anchoredWarning` in
`code_warning.go` — it passes `recomputeView`'s `!c.kind` filter like any
ordinary comment), the Underlying-code panel and the embedded Claude column
need no further wiring. The drilled cursor is set from the group's PRIMARY
comment's own unit (`b.comment.gran`/`b.comment.rowStart`, recomputed once
the anchor's code — and thus its aligned rows — actually arrives, since the
very first open has to guess against an empty row list).

**Only this row's own comment(s) show next to it — a later reviewer request
narrowed this back down.** `commentScope`'s ordinary row-range filtering
(`commentUnder`) on its own would show **every** comment that falls under
that cursor unit, not only the ones in this synthetic sidebar group — fine
for ordinary code navigation, but not what "alleen die comment en chat zien"
asks for here: a second, unrelated open comment on the very same unit (both
commonly have an unknown `rowStart`, which `commentUnder` treats as "matches
every unit of the block") used to render right next to it. `commentScope`
(`home.mjs`) therefore adds **`onlyIds`** — the id(s) of this row's own
group (`commentAnchorOnlyIds()`, `b.comments`/`b.comment`) — whenever
`isCommentAnchorDrillActive(1)` is true; `recomputeView` (`RelatedPanel.mjs`)
filters `cs.view` down to exactly those ids on top of its usual
`commentUnder` pass. The diff card and the Underlying-code panel are
UNAFFECTED by this — the reviewer explicitly kept those ("hetzelfde zien als
dat je via de code hebt genavigeerd" still holds for them, see "The anchored
column IS the leading column" below); only the comment/Claude side is scoped
down to this one thread. Test: "shows only its own comment, not another
unrelated one on the same block" in `tests/comment-anchor-expanded-view.spec.mjs`.

**Stepping to a SECOND row anchored to the same block must also move the
cursor, not just `onlyIds`.** `commentAnchorBlock` resolves the anchor purely
by `file`+`label`, so two different comment-index rows (two ai_warning
findings on separate lines of one function is the common real case, see
`anchoredWarning` in `code_warning.go`) resolve to the exact same anchor
object. `openCommentAnchorDrill`'s own re-entrancy guard ("already open on
this anchor, leave `state.drillCursor` alone so an in-progress
granularity/viewMode change survives" — needed for the comment-poll's 5s tick
retriggering the `state.selected` watch on the SAME row) used to compare only
`state.drill[0] === anchor`, so it fired just as readily for a genuinely
DIFFERENT row that merely shares that block — `state.drillCursor` then never
moved to the new row's own unit, and `commentTarget()`/`commentUnder` kept
scoping the panel to the FIRST row's comment forever, no matter which row was
actually selected (reported: "ik zie rechts alleen de eerste warning van de
3 [...] als ik naar de 2e ga, wil ik rechts ook de 2e zien"). Fixed by
snapshotting `sameComment = commentAnchorDrillFor === b.id` **before**
overwriting `commentAnchorDrillFor`, and gating the guard on `sameComment`
too — a different row now always recomputes `state.drillCursor` even when it
shares an anchor with the previously open row. Test: "switching between two
rows anchored to the SAME block shows the newly selected one, not the first"
in `tests/comment-anchor-expanded-view.spec.mjs`.

**This opens automatically while merely walking ↑/↓ through the index — a
later reviewer request restored that original behaviour after a brief
detour where it required an explicit ArrowRight (don't reintroduce that
detour): "als ik door blokken index langs ga, wil ik dat het al uitgeklapt
is".** The keyboard/focus itself deliberately does NOT follow along: the
watch calls `leaveRelated()` right before `openCommentAnchorDrill`, and the
call itself never touches `cs.focus`, so no comment card ever STEALS the
keyboard on mere selection — the row reads "already visible, but not yet
selected inside". Its comment card, however, DOES render fully expanded
(`expandedConversation`, not the compact preview) from the moment the row is
selected — reviewer request: "comment en chat moet ook volledig
opengevouwen zijn (ook met gegenereerde blokken die eronder staan)", i.e.
both the code-block preview cards a Claude/comment fence generates and the
Underlying-code children of the anchor unit. `commentCard` (`RelatedPanel.mjs`)
checks **`isAnchorOnlyComment(c)`** — `cs.scope.onlyIds` includes `c.id` —
ahead of its ordinary `cs.focus`-driven compact/expanded switch, so this one
comment renders expanded independent of `cs.focus`; since `onlyIds` already
narrows `visibleComments()` down to just this row's own comment(s), it can
never also expand some OTHER, unrelated card. Only an explicit **`→`** hands
the KEYBOARD IN, by calling the exact same `enterCommentsOrRelated()`
(`RelatedPanel.mjs`) the ordinary `state.mode === 'diff'` ArrowRight branch
already uses (`onKeydown`) — see "→ skips an already-resolved default
comment" below for what that function does, and how it is bypassed for this
one case. This is what makes the expanded view fully **keyboard-navigable**
(a separate, still-standing reviewer request) despite `state.mode` staying
`'list'`: `relatedActive()`'s `↑`/`↓`/`←`/`→` handling in `onKeydown` is
unconditional on `state.mode` — it only checks `cs.focus` — so once
`enterCommentsOrRelated()` sets that, the existing generic
comment/thread/Claude-column walk takes over exactly as it would for any
other block. "Uitgeklapt, maar niet direct geselecteerd" — the card is
already expanded the moment the row is selected; only `→` moves the
KEYBOARD into it.

### → skips an already-resolved default comment

`enterCommentsOrRelated(pr)` (`RelatedPanel.mjs`) is the single entry point
both `→` sites above call — **except while `cs.scope.onlyIds` is set**
(a "Comments op regels" row's own drilled anchor, see above): the function's
very first check short-circuits straight to `enterCommentsHead()` whenever
`hasVisibleComments()` is true, skipping every resolved/stale-skip rule
below entirely. Reviewer request: "als ik dus 2x naar rechts ga, wil ik
altijd in die comment blok zitten" — for this one row the whole point of `→`
is landing on THIS comment, never on a sibling or on Underlying code instead
(the skip logic below exists for ordinary code navigation, where that IS the
more useful landing). Since `onlyIds` already narrows `visibleComments()`
down to just this row's own comment(s) — always at least one open one, by
construction (a row only exists for an unresolved comment/group in the first
place) — this can never land the keyboard on some unrelated thread.

`hasVisibleComments()`/`visibleComments()` do not
filter out a resolved comment — `enterCommentsHead()` always lands on index
0 regardless of its status — so a unit whose only (or first) comment is
already resolved used to default the keyboard onto a thread that's done.
Reviewer request: "als die comment al resolved is, ga dan (als ze bestaan)
direct naar de volgende comment of onderliggende code. als die niet bestaan,
wil ik wel direct naar resolved comment blok". `enterCommentsOrRelated` checks
only `visibleComments()[0].status` — the exact comment `enterCommentsHead()`
would land on: unchanged (`enterCommentsHead()`) when it isn't resolved,
including a mixed unit whose OPEN comment sits at some later index (that
case was already reachable only via index 0 before this change, and stays
so — out of scope here). When index 0 IS resolved: jump straight to the
first still-open comment on the unit if one exists (`findIndex`, so a run of
several resolved comments ahead of it is skipped in one step, not one `↓` at
a time); else to the Underlying-code panel if this unit has any children;
else — nothing else to land on — the resolved comment anyway, same as
before.

### The anchored column IS the leading column, and follows the shared stand

Reviewer request (2026-08-19): "als je een comment op regel selecteert, [wil
ik] hetzelfde zien als dat je via de code hebt genavigeerd." Two differences
made this view read as its own thing rather than as the block you'd have
navigated to, and both are gone:

- **No collapsed rail.** The top-level block-column used to collapse to the
  same 56px rail an ordinary block gets once one of ITS children is drilled
  into, which pushed the anchor's diff card one rail plus one of `<main>`'s
  `gap-4` gaps to the right of where an ordinary block card starts.
  `commentAnchorColumnHidden()` (`home.mjs`) now hides that column outright —
  both the wrapper (`hidden`, so the empty flex child costs no gap) and its
  content (the `!focusedHere` branch returns `[]` before ever building the
  rail) — so the drilled anchor becomes the leading column and the layout is
  exactly blokken-index → diff card → Onderliggende code → comments. The
  drilled column's own **`drill-left-hint` chevron** is suppressed for the
  same reason: it hints at the column this one was drilled FROM, and there
  isn't one on screen any more.
  **Gated on `state.focusLevel > 0`**, so stepping the keyboard back OUT with
  `←` still shows the comment's own `commentDetailCard` here instead of an
  empty column.
- **No private diff stand.** This view used to default to **Unified** via its
  own `state.commentAnchorViewMode` field (distinct from the global
  `state.diffViewMode`, reset on every fresh open), which `viewMode`/
  `setViewMode` picked via `isCommentAnchorDrillActive(level)`. That field is
  removed: the anchored column reads and writes `state.diffViewMode` like
  every other column, so the `a` cycle carries over in both directions and a
  stand picked here survives navigating away and back.
  `isCommentAnchorDrillActive` itself stays — it is what
  `commentAnchorColumnHidden`/the chevron gate are built on.

### Only one thing reads as selected at a time

Reviewer request: "als ik navigeer door comments op regels dan wil ik niet dat
er 2 dingen geselecteerd zijn, dus selecteer alleen items in blokken index
totdat ik naar rechts druk" — walking the index with ↑/↓ lit up BOTH the
sidebar row and a line in the column it had just opened. And its follow-up:
"als ik een comment op regel naar rechts druk, dan moet in de blokken index de
selectie op gray selected zijn."

Two halves of one rule — whoever owns the arrows owns the selection. A
follow-up reviewer request split the old single `→` into **two** steps: "als
ik 1 keer naar rechts ga, selecteer code, als ik 2 keer naar rechts ga
selecteer dan eerste openstaande comment" — a bare `→` used to both
un-suppress the highlight AND jump straight into the comments
(`enterCommentsOrRelated`) in one step, which is exactly why it could
intermittently read as "already entered" (highlight showing) while the
sidebar was still just being walked with `↑`/`↓`.

- **Before the first `→`**: `commentAnchorAwaitingEntry(level)` (`home.mjs`,
  `isCommentAnchorDrillActive(level) && !relatedActive() &&
  !state.commentAnchorEntered`) makes the drilled column's `activeGroup` opt
  return `null`, so no unit is highlighted at all. `state.drillCursor` is
  deliberately NOT touched — it still points at the comment's own line, ready
  for the step in, and `commentScope` keeps filtering the thread by it.
- **`state.commentAnchorEntered`** is the one authoritative bit for "has the
  reviewer pressed `→` at least once already" — ephemeral, not URL-bound (like
  `state.indexHandedOff`), reset to `false` whenever a genuinely different
  comment-index item is selected (`closeCommentAnchorDrillIfOwned` and the
  `state.selected` watch's own comment branch, `home.mjs`).
- **The first `→`** (`commentAnchorEntered` still `false`) only flips that
  flag: the diff's active-row highlight appears (mirrors the ordinary "step
  into the diff" stop every other block gets — see the left→right chain in
  `.claude/docs/keyboard-navigation.md`), but the keyboard stays on the
  sidebar list — `↑`/`↓` keep walking the index exactly as before, and the row
  stays the ordinary indigo "selected" look, not yet handed off.
  **That same step now also collapses the blokken-index** — reviewer request:
  "als ik naar rechts ga uit een comment op regel blokken index lijst, dan
  mag je eerste blok wegschuiven net zoals je doet als je een code blok
  selecteert uit de blokken index". `state.commentAnchorEntered` is a fourth
  collapse case in `BlockList.mjs`'s `<aside>` class binding, next to diff
  mode / the methodes-kolom / a PR-wide compose (see
  `.claude/docs/detail-layout.md`), because this view deliberately stays in
  list mode and would otherwise never trigger the diff-mode collapse ordinary
  code navigation gets. `←` flips the flag back and the index returns.
  Accepted consequence (explicit reviewer call): `↑`/`↓` keep walking that
  now zero-width index until the second `→` hands the keyboard on.
  A **mouse** entry gets the same treatment: clicking straight into the
  comment/Claude/Onderliggende-code column never passes through this
  ArrowRight branch, so the `state.indexHandedOff` watch (`home.mjs`) sets
  `commentAnchorEntered` itself whenever that hand-off becomes true — one
  watch instead of per-click-handler wiring, per "a click runs the same
  function a key runs" (`.claude/docs/mouse-navigation.md`). It writes only on
  the real transition (guarded on the current value), since the vendored proxy
  notifies on every assignment (`.claude/rules/arrowjs-pitfalls.md`).
- **The second `→`** (`commentAnchorEntered` already `true`) hands the
  keyboard IN via `enterCommentsOrRelated`, unchanged from before this split.
  Only THEN does the sidebar row switch to a grey, arrow-less "handed off"
  look (`rowHandedOff`, `BlockList.mjs`). Per the colourblind rule the tint is
  not the signal: the `›` cursor marker goes transparent at the same time, so
  the difference is a SHAPE (arrow present or not) with the grey/indigo tint
  only reinforcing it.
- **`isCommentAnchorDrillActive`** identifies "is this drilled column the
  comment-anchor one" via the plain, already-authoritative
  `commentAnchorDrillFor === b.id` bookkeeping var rather than re-deriving the
  anchor block via a fresh `commentAnchorBlock(b.comment)` object-identity
  comparison on every read — the same "snapshot by stable ID, not identity"
  reasoning as `.claude/rules/conventions.md`'s own entry, applied here
  defensively so a later `state.allBlocks`/`state.blocks` reassignment can
  never silently desync the two and let the suppression above miss.
- **The card's own blue border needed the same `commentAnchorAwaitingEntry`
  guard as the active-row highlight, not just `!relatedActive()`.** The
  drilled column's `diffActive` opt (`home.mjs`, feeding `Block.mjs`'s
  `border-indigo-300` outer border) used to be
  `() => state.focusLevel === level && !relatedActive()` — true as soon as
  `openCommentAnchorDrill` sets `state.focusLevel = 1` on selection, i.e.
  before the first `→`. Reviewer report: "als ik een comment selecteer in de
  index, wil ik dat er maar in kolom/blok geselecteerd is (en blauw border
  heeft)" — walking ↑/↓ through the index showed the sidebar row's own indigo
  selection AND the drilled card's blue border at once. Fixed by adding
  `&& !commentAnchorAwaitingEntry(level)`, the same expression `activeGroup`
  already used — so the border only appears from the first `→` onward, same
  as the highlight and the `diffview-fit`/`a`-cycle stand toggle (also gated
  on `diffActive()`, see `Block.mjs`).
- **`←` must undo `commentAnchorEntered` symmetrically with `→`.** Reviewer
  follow-up: "als ik 2 keer naar rechts ga, wil ik ook 2x naar links moeten
  om op dezelfde plek te komen" (comment index → diff-entered → related panel,
  and back). The first `←` out of the related panel is already handled
  generically by `relatedActive()`'s branch in `onKeydown` (`exitRelated`
  undoes the second `→`). Without a fix the SECOND `←` fell through to the
  plain list-mode branch, which unconditionally calls
  `enterDescriptionFromList()` — skipping straight past the "diff entered,
  still on the sidebar" stop instead of first undoing the first `→`. Fixed by
  checking `state.commentAnchorEntered` first in that branch: if true, flip
  it back to `false` and `return` (undoing exactly one `→`); only a further
  `←` reaches `enterDescriptionFromList()`. Test:
  `tests/comment-anchor-expanded-view.spec.mjs` ("only one blue border at a
  time, and 2x ArrowLeft mirrors 2x ArrowRight").

`BlockList` learns this from **`state.indexHandedOff`**, kept by a small
`watch` in `home.mjs` — not a direct `relatedActive()` call, because
`RelatedPanel` already imports `BlockList` (`statusInfo`/`categoryClass`) and
the reverse import would close a cycle. That watch is deliberately narrower
than a bare `relatedActive()`: it also requires
`isCommentAnchorDrillActive(1)`. A bulk action started FROM a standing index
selection ("Comment op deze N regels") also opens a composer, i.e.
`relatedActive()` is true, while its Shift+arrow range must visibly stay
selected — greying it there broke `tests/list-range-select.spec.mjs`. Every
other `→` enters diff mode and hides the index outright. Test:
`tests/comment-anchor-expanded-view.spec.mjs`.

Accepted consequence, not a bug: dropping the forced Unified means the
anchored column is usually **wider** now (`'split'` measures
`min(80, canonical) + canonical` against `'unified'`'s
`max(canonical, other)`, see `.claude/docs/diff-card.md`), wide enough that
`positionMenu` can clamp the `prComment` palette narrower than the column it
is sized against — `tests/comment-anchor-expanded-view.spec.mjs` therefore
asserts the menu width as an upper bound rather than an exact match.

**Stays open until the sidebar selection moves to a DIFFERENT item** — not on
any ←/Escape inside it (explicit reviewer decision: no extra close gesture was
added). A plain, non-reactive `commentAnchorDrillFor` (the open comment-index
**item's** own `.id` — not a single comment's id, since an item can now stand
for a whole line-group, see "Comment-index rows are grouped per source line"
above) tracks whether this ONE feature is the one that opened the current
drill, so `closeCommentAnchorDrillIfOwned()` (shared by both branches of the
`state.selected` watch) only ever closes a drill it opened itself — never an
ordinary, unrelated drill that another code path (`applyNextUnapproved`'s "Ga
door", `drillIntoChild`, `openTask`) is in the middle of setting up via the
very same `state.selected` change (arrow.js's `watch` runs its callback once
the whole synchronous caller has already finished, not before — an
unconditional clear here wiped a "Ga door" landing the instant it opened, see
`tests/drill-mode-flip.spec.mjs`). Test:
`tests/comment-anchor-expanded-view.spec.mjs`.

### An orphaned block comment joins them

`anchorState === 'orphan'` (`isOrphanComment`): a new commit renamed or removed
the symbol it was anchored to, so `recomputeView` can never scope it to a block
again and it would be visible **nowhere at all**. `prWideComments()` and
`recomputeLeftList`/`commentBlockItem` therefore accept
`kind !== '' || anchorState === 'orphan'`, and `recomputeView` excludes it so it
can't also leak into the null-scope list-mode view (which would show it twice).
Deliberately **not** by flipping its `kind` to a PR-wide one — that would change
how its replies mirror to GitHub (`isPRWide`, see
`.claude/docs/workflows-comments.md`); the orphan stays a block-scoped review
comment that merely lost its block. Its fallback label (empty body) names the
block it *used* to hang on, and its kind badge falls back to "Regelcomment".

A **`staleAnchorBadge`** pill (`data-testid=comment-stale-anchor`) marks both
degraded states in the comment card, the compact conversation and the detail
card — "verouderd — code verdwenen" for an orphan, "verouderd — regel gewijzigd"
for an `unpinned` one — so the reviewer can tell the stored snippet is a record
of code that no longer exists in this shape. Per the colorblind rule the **word**
carries the meaning; the amber tint is decoration. Who sets `anchorState` is the
re-anchor pass — see "Comment/approval anchors are RE-ANCHORED on every refresh"
under `pr_status` in `.claude/docs/workflows-trackers.md`. Test:
`tests/comment-orphan-anchor.spec.mjs`.

**`commentRowSet` deliberately has NO bounds check** against the block's row
count. It looks necessary (a stale `rowStart`) but is dead weight: `paneHTML`
(`Block.mjs`) walks the block's own rows and asks `commented.has(i)`, so an
index past the end is structurally unrenderable — and a stale index still *in*
range would mark the wrong row, which no bound can catch, only re-anchoring can.
Same reasoning for `approvedRowSet`.

### A stale (unpinned) comment is always folded behind the ▲ hierboven hint

Reviewer report (screenshot): standing on a diff line that has nothing to do
with any comment still showed two "verouderd — regel gewijzigd" cards plus
their Claude conversation, left over from an earlier unit — "ik sta hier op
een regel zonder comment, laat dan ook niks zien, ook al was ik net wel bij
een nadere line met een comment." The root cause is `commentUnder`'s own
deliberate leniency two sections up ("A comment with an unknown anchor…
always shown within its block"): an **`unpinned`** comment's row is
literally unknown (`rowStart`/`rowEnd` both `-1`, see reanchor.go), so it
matched every unit of its block, not just the one it once hung on.

That leniency is still needed — an unpinned comment must stay reachable
*somewhere* — so the fix does not remove it (it was narrowed later, from
"every unit" to a best-effort line match — see "Best-effort line matching for
an unpinned comment" below). Instead it reuses the **existing**
"cards above the cursor are hidden behind a hint" mechanism
(`hiddenAboveCount`/`moreAboveHint`, "The selected conversation hides the ones
above it" elsewhere in this file) rather than inventing a second UI: a stale
comment is now ALSO always counted as folded, even while nothing in the panel
is focused yet (the diff still owns the keyboard). Reviewer's explicit framing:
"altijd weg, verscholen achter een bestaande label met comments die boven
aanwezig zijn buiten beeld — daar kan je dan wel naartoe navigeren."

- **`isStaleAnchor(c)`** (`RelatedPanel.mjs`) — `c.anchorState === 'unpinned'`.
  Deliberately **not** `orphan` too: an orphan's whole block is gone, so it
  never reaches this block-scoped list at all (`recomputeView`'s own
  `anchored` filter excludes it, see the section above) — this predicate only
  ever needs to matter for a comment that DOES still render here.
- **`hiddenAboveCount()`** grew a second source of folding on top of its
  existing "cards above the EXPANDED one" rule: while nothing is expanded yet
  (`expandedCommentIndex() === -1`), it now also folds a **leading run** of
  `isStaleAnchor` comments in `visibleComments()`. Only a leading run, not an
  arbitrary reorder — a stale comment does not jump ahead of a real one that
  already sorts before it (`cs.list`'s own `created_at` order, unchanged); it
  is simply never the FIRST thing shown while nothing has been entered yet.
  When a unit's only comment(s) are entirely stale, this folds every one of
  them, and the render loop (`InlineComments`) then draws nothing — exactly
  the reported "toon niks" case.
- **`hasVisibleComments()`** changed from `visibleComments().length > 0` to
  `visibleComments().length > hiddenAboveCount()` — "is at least one comment
  reachable AT REST", not merely "does one exist somewhere in scope". This is
  the → gate (`enterCommentsOrRelated`'s outer `if`) and, via
  `claudeChatVisible()`, what makes the embedded Claude column disappear too:
  a unit whose only comment is a folded stale one has nothing to hang a
  conversation on at rest, so → and the Claude column both skip straight past
  it to Underlying code, same as a genuinely comment-less unit.
- **`hasAnyComments()`** is the DELIBERATELY UNCHANGED old question
  (`visibleComments().length > 0`) under a new name, still needed because
  `hasVisibleComments()` above no longer answers it: home.mjs's
  `comment-claude-row` wrapper and `relatedColumnIsEmpty()` (both gate on
  `!claudeChatVisible() && !hasCommentClaudeFooter()`) must NOT also hide the
  whole row while a fold hint is the only thing left to show — that would make
  the hint's own promised navigation route dead. Both call sites grew a third
  `&& !hasAnyComments()` term.
- **`enterCommentsOrRelated`'s existing resolved-skip** (see "→ skips an
  already-resolved default comment" above) grew a second skip condition,
  `isStaleAnchor(list[0])`, checked the exact same way: skip to the first
  comment that is neither resolved nor stale, else to Underlying code, else
  show `list[0]` anyway. Still a real scenario even though a fully-stale unit
  never reaches this far (`hasVisibleComments()` is false for it, see above):
  a unit with BOTH a stale comment (sorted first, per `cs.list`'s
  `created_at` order) and a real one still has `list[0]` pointing at the
  stale one — `hiddenAboveCount()` only changes where the render loop STARTS,
  it never reorders or removes anything from `visibleComments()` itself.
  Reviewer's own words: "als ik naar rechts ga, wil ik niet dat die gelijk
  geselecteerd is, selecteer eerst een comment eronder of een onderliggend
  codeblok."
- **`compactConversation`** reduces to exactly avatar + name +
  `staleAnchorBadge` (the "label") + `commentTitleLine` (the "titel") when
  `isStaleAnchor(c)` — everything else (`commentStatusMark`, `sourceBadge`,
  `aiWarningBadge`, `blockWideBadge`, `sendFailedBadge`, the body preview, the
  `bestand:regel · N reacties · status` meta line) is omitted. Reviewer's own
  words: "laat dan alleen avatar, naam, label en titel zien." This is the one
  place a stale comment still renders as an ordinary (if field-reduced) card
  at rest — only reachable when it sits BELOW a real comment on the same
  unit, since the leading-run fold above never touches anything past the
  first non-stale entry. `expandedConversation` (reached via the hint, or an
  explicit ↑ once inside the panel) is deliberately **untouched** — the full
  thread is exactly as readable as any other comment's once the reviewer
  chooses to open it; only the passive, unopened default view is reduced.
  Each card's `.key()` grew `c.anchorState`, so a live transition into/out of
  `unpinned` (the re-anchor pass landing on an already-mounted card) rebuilds
  it instead of reusing stale bindings (`data-stale-anchor` on the card marks
  the state for tests, per the colorblind rule the word/omission of fields
  still carries the meaning, not a colour).

Test: `tests/comment-stale-anchor-fold.spec.mjs` (fixture PR 970601,
`materializeStaleAnchorWorktrees`/`staleanchor-comments.json` — `anchorState`
is unreachable from the UI, same reasoning as the orphan fixture above, so
this one is seeded too).

### Best-effort line matching for an unpinned comment

The previous section's leniency ("an unpinned comment's row is unknown, so it
matched every unit of its block") turned out too broad on a real PR (13521):
an unpinned comment placed on one line of `ImportSubscriptionStatsFlow::run`
showed its "▲ 1 hierboven" hint on **every** change group of that function,
including ones with nothing to do with it — reported directly from a
screenshot. Reindert's own framing of the fix: "best-effort matchen op regel
157 (ongeveer)" — not "never show an unpinned comment in diff mode" (that
would make it reachable only via `list` mode, a bigger behavior change than
asked for) and not "always show it on the first/coarsest group" either.

- **`commentScope()`** (`home.mjs`) now also forwards `commentTarget()`'s
  `oldStartLine`/`oldEndLine`/`newStartLine`/`newEndLine` — the selected
  unit's own real source line range on **both** sides (see
  `unitBothLineRanges`), alongside the existing `rowStart`/`rowEnd`/`seg`
  triplet. This is the only thing `RelatedPanel` couldn't already derive
  itself: it only ever receives `cs.scope`, not `home.mjs`'s `state`.
- **`commentUnder(c, t)`** (`RelatedPanel.mjs`), for a comment with an
  unknown anchor (`c.rowStart < 0`), **only** narrows to a best-effort line
  match when the comment is specifically `isStaleAnchor(c)`
  (`anchorState === 'unpinned'` — it USED TO have a real row and the
  re-anchor pass lost it). It then falls through to
  **`lineMatchesUnit(c, t)`**, which compares the comment's own recorded
  `line` (the real source line it was placed on — see
  `createComment`/`commentTarget`'s `startLine`, not the aligned-row
  `rowStart` that went stale) against unit `t`'s line range on **either**
  side (`c.line`'s own side isn't recorded, so both `old*`/`new*` are tried),
  within a small `LINE_MATCH_SLACK` (2 lines) — enough to absorb the kind of
  off-by-a-line drift a nearby edit causes since the comment was placed, not
  enough to reattach it to a genuinely different part of the function. A
  `rowStart < 0` comment that is **not** `isStaleAnchor` — never anchored to
  any row to begin with, e.g. a genuinely block-level comment, or a test
  fixture directly seeding a bare `rowStart: -1` — keeps the ORIGINAL
  "shown within every unit of this block" behavior unchanged: it never had a
  specific row to lose, so there's nothing meaningful to best-effort match
  its `line` against (unlike an unpinned comment's `line`, which really was
  once exact).
- **Two escape hatches back to the old "show everywhere" behavior**, both
  matching a case this can't meaningfully scope rather than a regression:
  `t` itself carries no line-range info at all (all four fields `0` — the
  same "block has no navigable unit" fallback `commentTarget` already
  returns for a block with nothing to step through), or `c.line` itself is
  falsy (a genuinely legacy/seeded comment with no source line recorded to
  match against).
- `list` mode is unaffected either way: `recomputeView` already bypasses
  `commentUnder` entirely there (`s.mode !== 'diff'` branch), same as before
  this change.
- Unaffected: what happens once the hint IS visible. ↑ or a click on
  "N hierboven" still expands the comment exactly as before — this only
  changes on which unit(s) the hint appears in the first place.

Test: extended into `tests/comment-stale-anchor-fold.spec.mjs` (same PR
970601 fixture — its seeded unpinned comment's recorded `line` lands on
group `$a`'s own line, so the spec now also asserts it stays OUT of scope
entirely on `$b`/`$c`, not just folded).

### No more explicit Annuleer button

`newCommentComposer`'s composer footer used to show two buttons,
**"Annuleer"** and **"Plaats…"**. The "Annuleer" button is gone (reviewer
request) — `Escape` was already the equivalent exit (`exitRelated()`, same as
leaving any other panel level) and is now the only way to leave a still-open,
not-yet-placed composer without posting it. `exitRelated()` resets
`cs.focus`/`cs.prWideCompose`/`cs.rangeCompose` exactly like the removed
button did, so nothing about navigating out of the composer changed — only
the three things the button did **beyond** that are gone too:

- it no longer explicitly resets `warningOverride` on exit — harmless, because
  `toNew()`/`startComment()`/`convertWarningToComment()` already reset it on
  every fresh open, and it is never read while the composer is closed;
- it no longer explicitly `clearSendFailed`s the composer's failed-send badge
  — a failed placement's badge now simply stays until the next attempt
  succeeds (or the reviewer edits the draft and tries again), same as it
  already does for a comment reply;
- it no longer explicitly deletes the draft (`composeDrafts`) — leaving via
  Escape now behaves exactly like leaving via `ArrowLeft`/navigating away
  always did: the draft is kept for the session and restored the next time the
  composer reopens on the same unit (see "Typed but not yet sent comment text
  survives leaving and returning" below). There is no "cancel and discard"
  action any more — an abandoned draft is never silently deleted.

Test: `tests/comment-draft-persists.spec.mjs`.

### Enter posts directly, Shift+Enter is a newline — a local `@keydown`, not just `home.mjs`'s document-level one

The `comment-compose` textarea used to have **no** `@keydown` of its own —
Enter/Shift+Enter were caught entirely by `home.mjs`'s document-level
`onKeydown` (`isComposeOpen() && composeHasText()`), the same generic handler
that also opens the comment-kind menu for `isConvertingAiWarning()`. That
mechanism worked, but it depended on a SEPARATE flag (the now-removed
`cs.composing`, see "`isComposeOpen()` now reads `cs.focus` directly" below)
staying perfectly in lockstep with `cs.focus` at every one of the half-dozen
places that used to set either — a class of bug this codebase had already hit
once before (see `tests/comment-composer-typing-guard.spec.mjs`'s own doc
comment: "an earlier, buggy bare `cs.composing` toggle that left `cs.focus`
out of sync with real DOM focus").

The textarea now ALSO has its own local `@keydown` (`newCommentComposer`,
mirroring the Claude composer's own local handler in `ClaudeChat.mjs` almost
exactly): a bare `Enter` calls the exact same `openCompose` callback the
"Plaats…" button's own `@click` already calls (so a key runs the same
function a click runs, per `.claude/docs/mouse-navigation.md`) — which already
contains the one exception this composer needs (`isConvertingAiWarning()`
opens the comment-kind menu instead of posting straight away) — and
`Shift+Enter` is left untouched so the browser inserts its own newline, same
as every other composer in this file. `e.stopPropagation()` (only once there
is text to act on) keeps `home.mjs`'s own `isComposeOpen()` branch from also
running for the same keypress right after; that branch stays in place as the
fallback for a still-empty composer (a no-op either way) and for any future
caller of this same textarea this local handler might miss. The `title`
attribute (`"Enter plaatst · Shift+Enter nieuwe regel"`) mirrors the Claude
composer's own tooltip text.

`commentClaudeShortcutHints()` grew a matching `Shift+Enter` → "nieuwe regel"
entry on every `cs.focus` whose own field has DOM focus at rest —
`'comment'`/`'thread'` (`reaction-compose`), `'new'` (`comment-compose`) and
`'claude'` (`claude-chat-compose`) — reviewer request, alongside the key
already working in all three fields.

### `isComposeOpen()` now reads `cs.focus` directly — the removed `cs.composing` flag

`cs.composing` used to be a SEPARATE boolean, set to `true`/`false` by hand
at every `cs.focus` transition into or out of `'new'` (`toNew`,
`convertWarningToComment`, `toComment`, `exitRelated`, `enterRelated`) plus
one more writer, `postThreadReply` (the EXISTING-thread reply path, which
reset it unconditionally on every reply send regardless of whether `'new'`
was even the current focus — a leftover with no purpose of its own, since
`cs.focus` can never actually be `'new'` while a thread reply is in flight).
Six independent writers that all have to agree by hand is exactly the kind of
duplication that drifts — this codebase had already hit that class of bug
once (see the paragraph above) — so `isComposeOpen()` (`RelatedPanel.mjs`,
read by `home.mjs`'s `isComposeOpen() && composeHasText()` gates) now simply
returns `cs.focus === 'new'`: the SAME field `newCommentComposer`'s own
render already keys its visibility off of (via `isNewChatUnanchored()`), so
there is no longer a second value that can fall out of step with it. All six
writers and the field itself are gone; nothing else read `cs.composing`.

### Placing a PR-wide comment yourself (`startPrWideComment`)

Until this existed, PR-wide comments could only ever *arrive* (the GitHub
import), never be *created*: every layer of the write path demanded a
`file:line` anchor — `handleTaskCodeComment` 400'd on `File == ""`,
`createComment` bailed on `!file`, `placeComment` bailed on
`b.kind === 'comment'`, and `newCommentComposer`'s header read the selected
item's `file`/`line`. The `/`-menu's "Comment plaatsen" therefore ran
`startComment` — the ordinary **line**-comment composer — so it either placed a
line comment on whatever unit the cursor happened to sit on, or (with a
comment-index row selected, and those rank first in the sidebar) did nothing at
all while showing `Nieuwe comment · undefined:undefined`.

`startPrWideComment()` (`RelatedPanel.mjs`, wired to `PR_COMMANDS`'
**"Algemene comment plaatsen"**) opens the same composer in a PR-wide mode,
marked by **`cs.prWideCompose`** — one reactive flag that changes exactly four
things and nothing else:

- the composer header/placeholder ("Nieuwe algemene comment · hele PR", no
  `file:line`, no `composeTargetHint` — there is no code to preview), plus its
  own draft identity `PRWIDE_DRAFT_KEY`;
- `placeComment`'s write: a branch **before** the block guards that posts
  `{file:'', line:0, kind:'issue'}` — the same `Kind` an imported general PR
  comment gets, which is precisely what makes it a navigable "PR-comments"
  index row (`prWideComments`/`commentBlockItem`) rather than an invisible line
  comment. `opts.local` still works (generic, shared plumbing — no
  `COMPOSE_COMMANDS` item passes it true anymore, see "The compose
  (comment-kind) menu" in `.claude/docs/command-palette.md`);
- **no Claude column** (`claudeChatVisible()` returns false, and `→` from the
  composer doesn't `enterClaudeChatFromNew`): `ensureClaudeAnchorForNew` would
  lazily create a backing comment **anchored on the current diff unit**, which
  is exactly what a general comment is not;
- **no approval revoke** — `COMPOSE_COMMANDS`' `compose-post` passes a `null`
  revoke target, since a PR-wide comment hangs on no unit (see
  `.claude/docs/approval.md`).

The flag is cleared by every ordinary composer open (`toNew`) and every exit
(`exitRelated`, e.g. Escape — the composer's own "Annuleer" button was removed,
see "No more explicit Annuleer button" below), so it can never leak into the
next line comment.
Ephemeral, not URL-bound, like `cs.focus` itself.

**Landing on the fresh row** (the reported "ik zie hem niet in de index
lijst"): the row is produced by the comment poll, not by `loadBlocks`, so it may
not exist for another tick. `createComment` records the POST's `runId`
(`lastCreatedCommentId`) and `placeComment` hands it to
**`setCommentSelectRequest`** — a downward-injected callback (same shape as
`setReplyPublishMenuOpener`, since `RelatedPanel` never imports `home.mjs`)
that sets `blockRefPending = 'comment:<id>'` and reuses the **existing**
`applyCommentRefRestore` retry the `?sel=comment:<id>` deep link already drives.
No second "wait for that row" mechanism.

Backend: nothing new. `handleTaskCodeComment` merely exempts a PR-wide `Kind`
from the file requirement (`isPRWide`, mirrored client-side by
`PR_WIDE_KINDS`/`isPrWideKind`), and `taskCodeCommentWorkflow`'s "PR-wide,
freshly created" branch — which already existed for
`convertPrWideWarningToComment` — posts it as a top-level issue comment. That
same relaxation also un-breaks `sendConvertedPrWideComment`, which passed the
finding's empty `file` and was silently rejected for it. While composing, the
pr-index and block columns are hidden — see `.claude/docs/detail-layout.md`.
Tests: `prwide_comment_test.go`.

### The synthetic item

`commentBlockItem` (`recomputeLeftList`, `home.mjs`):
`{ id: 'comment:'+c.id, kind: 'comment', label: <short body snippet>,
category: 'COMMENT', status: '', mentioned: <@mentions me>, comment: c }`
(`mentioned`: see "Mentioned" below). `kind` is the marker every
block-assuming code path guards on; `id` is stable across a recompute so
selection survives a comment-list reload; `comment` carries the raw row back for
the detail card/action menu.

A comment item's **leading badge** is the author's avatar instead of a category
pill (`categoryOrAvatar`, `BlockList.mjs`) — with one exception: an automated
`code_warning` finding that is **not on GitHub yet** (`source === 'ai'` **and**
no `githubId`, `isLocalAiWarning`) gets the warning triangle (`aiWarningIcon`,
`data-testid=block-row-ai-warning`) the panels already use for it, because an
"AI" initials circle read like just another person's comment. Both halves of
that condition matter: once the reviewer publishes the finding ("Zet op
GitHub"), it *is* an ordinary comment and the avatar comes back. Per the
colorblind rule the SHAPE plus the `title`/`aria-label` carry the meaning, not
the amber tint. Test: `tests/ai-warning-index-icon.spec.mjs`.

`BlockList.mjs` has a matching `CATEGORY_STYLE.COMMENT` pill colour (`red`, used
by no real block category) and its own **"PR-comments" heading**
(`commentHeading`, `data-testid=comment-heading`) above the first visible comment
item — mirrors `underlyingHeading`, same "own keyed item in one flat array"
shape. `recomputeLeftList`'s `rank()` puts a comment item with **no regel at
all** (PR-wide/orphan feedback) at rank `2.4` — under every real category
(which top out at `2`) and right above the line-anchored "Comments op regels"
section (`2.5`, see below). Reviewer request: "gooi algemene pr comments net
boven Comments op regels" — this section used to rank first (`-1`, ahead of
`ROUTE`) but that pinned it above the tree even for feedback nobody was
waiting on; it now sits directly next to the other comment section instead. A
comment that DOES hang on a real source line sorts the same way, just at
`2.5` — see "Comments op regels" below.

### "Comments op regels": a line-anchored comment sorts under the changed files

Reviewer request ("comments die gekoppeld zijn aan een regel code, moet in de
blokken index onder de aangepaste bestanden staan met een kopje erboven, laat
het by default zien, behalve als je het inklapt"): a comment-index item that
hangs on a real source line — `commentBlockItem`'s **`lineAnchored`** field
(`!c.kind && !isOrphanComment(c)`, the SAME predicate `commentGroupKeyOf`
already used to decide whether a comment is eligible to group at all) — ranks
`2.5` in `recomputeLeftList`'s `rank()`: above every real category (which top
out at `2`) but below `childIds`' `3` ("Onderliggende code"), i.e. it sorts
**after** the changed-files section instead of above everything. This
includes a **mentioned** line-anchored comment — it moves into this section
too rather than staying pinned at the very top just for that (a MENTIONED
item with NO regel, still PR-wide/orphan, is the only kind that still ranks
`-2`/top, see "Mentioned" below).

`BlockList.mjs`'s **`lineCommentHeading`** (`data-testid=line-comment-heading`,
text "Comments op regels") titles the section, mirroring `underlyingHeading`'s
"own keyed item in one flat array" shape — `renderList` checks
`b.kind === 'comment' && b.lineAnchored` **before** the mention/PR-comments/
ignored checks (an ignored line-anchored comment is checked earlier still, so
it still lands under "Verborgen comments", not here — see the ignored-first
reordering in `renderList`'s own doc comment). **Collapsible, shown expanded
by default**: a chevron button inside the heading itself
(`data-testid=line-comment-toggle`) flips `state.lineCommentsCollapsed`
(default `false` — the opposite default of `state.showApproved`, whose
"folded away by default, reveal via a button" shape this deliberately does
NOT mirror). Ephemeral UI state, like `showApproved` — not persisted, not
URL-bound. **Mouse-only for now** — unlike `toggleRow`/`ignoreToggleRow` this
has no dedicated stop in the sidebar's `↑`/`↓` loop; a full keyboard-loop
entry felt like more plumbing than this one request asked for.

`findNextUnapproved`'s forward-only walk (`state.selected + 1` onward,
`home.mjs`) can now genuinely pass over a line-anchored comment item on its
way to a later real block — the "comment items always rank before every real
block" reasoning it used to rely on no longer holds for this kind. Still no
crash/regression: `firstUnapprovedInSubtree`'s own `ensureCode(b)` already
no-ops for `b.kind === 'comment'` (see "Guards on paths that assume a real PR
block" below), and `blockRows`/`navUnitsOf` on a codeless item yield no units
to search, so the walk just reads such an item as "nothing to approve here"
and continues — it was never wired to ALSO consider `blockApproveCount`'s
resolved-status model, so it still can't land on one, just for a different
(now accidental rather than structural) reason. Not treated as a bug to fix
here — the reviewer's request was about where the row SORTS, not about
`findNextUnapproved`'s otherwise-unrelated unit walk.

Items are synthesized fresh from `RelatedPanel.mjs`'s exported
**`indexComments()`** — `prWideComments()` (the `kind !== ''`-filtered,
kilo-review-bot-excluded subset of `cs.list`) **plus** every block-anchored
comment that mentions the local reviewer (see "Mentioned" below) — on every
`recomputeLeftList()` call; a dedicated
`watch(() => indexComments(), () => recomputeLeftList())` re-derives
`state.blocks` whenever that list changes — safe because `indexComments()` only
reads `cs.list`, never a block's `.code`, so it can't trigger the "stuck on
loading" co-subscriber race (`.claude/rules/arrowjs-pitfalls.md`). The watch
deliberately uses the **same** function `recomputeLeftList` does, not the
narrower `prWideComments()`: a newly polled block-anchored comment (or reply)
that mentions me must trigger a recompute too, or its row would only appear on
the next unrelated one. `cs.list` itself is loaded/polled by `syncComments`,
called unconditionally by `InlineComments` — no separate fetch.

### An unanchored item shows the ordinary Claude column, on the right

An unanchored comment-index item — a PR-wide comment, an orphan, an
`ai_warning` that resolves to no block — scopes to `commentScope`'s
`{ none: true, prComment: c }` sentinel, so `cs.view` is empty by design (see
"A `kind:'comment'` sidebar item is itself unanchored" above). `claudeChatVisible()`
read that as "no comment here to hang a chat on" and hid the whole
comments+Claude row; the only way to reach Claude was the "Chat met Claude"
command, which opened a SECOND, embedded copy of the chat stacked inside the
item's own detail card.

Reviewer request: "ik zie hier niet de claude chat. ik wil hetzelfde blokje
zien als normaal rechts. Bij alle algemene comments en ai waarschuwingen."

- **`isPrCommentScope()`** (`RelatedPanel.mjs`) — that sentinel with a real
  comment on it — is now a third reason for `claudeChatVisible()` (it was a
  fourth while a running turn still counted as one; that branch is gone, see
  "The chat column is a function of the selected code" in
  `.claude/docs/claude-chat-panel.md`). The column
  is simply there while such an item is selected, anchored by
  `chatAnchorComment`'s pre-existing `s.none` branch plus
  `syncClaudeAnchorForSelection`; no new writer of `cc`.
- **The comments half no longer stays a bare gap** — see "The comment-detail
  card moved into the merged comment-claude-row" below, which superseded the
  original "hides, thread stays in the block-column" shape this bullet used
  to describe.
- **The embedded copy is gone**, along with the `pcc` reactive, its
  `prCommentClaudeView`/`updatePccThreadPinned`/`jumpToPccThreadBottom`
  helpers, the `pr-comment-claude-section`/`pr-comment-claude-close` markup and
  `closePrCommentChat`. One chat, one surface — don't reintroduce it.
  `startPrCommentChat` (the "Chat met Claude" command) kept its name and now
  only ensures the Execution and focuses the column's composer.

Test: `tests/pr-comment-claude-chat.spec.mjs`.

### The comment-detail card moved into the merged comment-claude-row

Reviewer request: "Pr-comments wil ik graag in 1 blok samen met claude chat."
Until this, an unanchored comment-index item's own `commentDetailCard` (the
thread: body + reactions) rendered in home.mjs's **block-column** — the
column that normally holds a `Block()` diff card — while `InlineComments`
(this module, mounted in `comments-and-related`'s `comment-claude-row`) sat
`hidden` right next to the Claude column, leaving the two as two visually
separate boxes with a real `<main>` `gap-4` between them, not the one merged
card an ordinary block-scoped comment+Claude pair already reads as.

- **`InlineComments` itself now renders the card**, inside a stable
  `<div class="contents">${() => isPrCommentScope() ? commentDetailCard(...) :
  ''}</div>` slot (the documented safe pattern for a toggling template, see
  `.claude/rules/arrowjs-pitfalls.md`) right where the ordinary comment cards
  would otherwise list — so it sits in the SAME shared-border/bg row as the
  Claude column (`comment-claude-row`, home.mjs), merged into one visual card
  exactly like a block-scoped comment+Claude pair already is. The outer
  `inline-comments` wrapper's own `hidden` toggle for this scope is gone —
  there is real content to show now, not a bare gap.
- **`commentDetailCard(c, opts)` grew an `opts.merged` flag**: it drops its
  own fixed `w-[calc(42rem+50px)] shrink-0` width in favor of `w-full`, since
  the parent (`InlineComments`'s own wrapper) already carries
  `commentColumnWidthCls()` — the same half-share width an ordinary block's
  comment column gets, kept exactly in sync with the Claude column next to it
  (see `commentColumnWidthCls`/`claudeColumnWidthCls`'s own doc comment,
  above). Everything else about the card (its own border/rounded-2xl/shadow,
  the author line, the thread, the meta line, the reply box) is unchanged —
  it still reads as its own bordered card, the same way `compactConversation`'s
  bordered pills sit inside the borderless `InlineComments` column for an
  ordinary block-scoped comment.
- **The card gets a fresh `.key(...)` per selected comment** (id + status +
  title-arrived flag) — mirrors the key the block-column's own version used
  before this moved, for the same rekey-on-status/title-change reasoning
  (`.claude/rules/arrowjs-pitfalls.md`'s "a keyed node is reused without
  re-running its bindings").
- **home.mjs's block-column hides entirely** for this case
  (`isPrCommentScope()`, exported from `RelatedPanel.mjs` for exactly this),
  unconditionally — not gated on `state.focusLevel` the way
  `commentAnchorColumnHidden()` is for an ANCHORED comment-index item (a
  wholly separate, untouched flow — see "An anchored 'Start' item instead
  opens its block…" above). There is nothing left to render there: no rail,
  no `commentDetailCard`, since it now lives in the merged row instead.
- **A pre-existing `setCommentScope` bug surfaced by this move, and got
  fixed alongside it.** Every unanchored comment-index item shares the exact
  same bare `'none'` sentinel signature, so `setCommentScope`'s own
  redundant-write guard (`if (sig === cs.scopeSig) return`) used to skip
  reassigning `cs.scope` whenever the reviewer moved from ONE such item
  straight onto ANOTHER, or when a poll merely updated the SAME item's own
  fields (a title arriving) — invisible before, because nothing used to read
  `cs.scope.prComment`'s own identity/content, only the boolean
  `isPrCommentScope()` (which stayed correctly true either way). Fixed by
  never deduping the `'none'` case at all (`recomputeView`'s own `s.none`
  branch is O(1), so there's no real cost) — the redundant-write guard still
  applies to the real (file/label/gran/…) scope join, where it exists
  specifically to skip an expensive `cs.list` re-filter on an unrelated tick.
- **`openPrCommentMenu`** is `InlineComments`'s 5th parameter — the exact
  same `(opts) => openMenu('prComment', opts)` the removed block-column call
  site used to pass, so the card's own menu button/right-click still opens
  `prCommentCommandsFor()`.

Test: the width/merge assertions in `tests/pr-comment-claude-chat.spec.mjs`
and `tests/comment-index-items.spec.mjs`'s ai_warning-item case (which
exercises exactly the "step from one unanchored item to another" gap the
`setCommentScope` fix closes).

### A bare Claude-chat anchor is not a comment and gets no row

A conversation with Claude always hangs on an existing comment (the backend's
`CommentID` constraint), so chatting **before** typing anything lazily creates
one whose body is the literal `CLAUDE_ANCHOR_PLACEHOLDER` string ("(Nog geen
eigen comment getypt — gesprek met Claude gestart.)", see
`ensureClaudeAnchorForNew` in `.claude/docs/claude-chat-panel.md`). Nobody
wrote that text, so it must not read as feedback: reviewer report — "Nog geen
eigen comment... moet niet in de index, moet ook gewoon niet zichtbaar zijn",
about such an anchor sitting in the PR-comments section with an orphan
("verouderd — code verdwenen") badge.

`isChatAnchorPlaceholder(c)` (`RelatedPanel.mjs`, exported) is the predicate;
**`prWideComments()` and `indexComments()` both skip it**, which removes the
sidebar row AND the `commentDetailCard` next to it in one go (that card reads
`prWideComments()`, not `cs.view`).

**Deliberately the index side only** — `recomputeView` still shows the bubble
in the block-scoped thread on the unit it hangs on. That bubble is the running
conversation's origin message, the thing "Comment hiervan maken" edits into a
real comment, and the anchor `chatAnchorComment`/`ensureClaudeAnchorForNew`
resolve against; hiding it there breaks the very first send that created it
(`cc.runId` never populates, so `sendClaudeMessage` silently no-ops — measured,
7 specs). So: an anchor whose block still resolves stays reachable through that
block, and an ORPHANED one — the case in the report — is simply gone, its
conversation with it. Accepted: it had no code left to point at. Test:
`tests/comment-index-items.spec.mjs`.

**And that bubble's own `Enter` menu (`commentCommandsFor`, `home.mjs`) offers
no Resolve/Unresolve item either — reviewer request: "een chat met alleen een
claude gesprek (zonder comment), wil ik niet kunnen resolven, alleen kunnen
verwijderen".** There is no real reviewer comment behind it yet, so "resolving"
it is meaningless; only "Verwijder comment" makes sense, same as the existing
`isAiComment` exception right above it in that same function — `isAiComment(c)
|| isChatAnchorPlaceholder(c)` both skip the resolve/unresolve slot, for two
different reasons but the same visible effect. Once the reviewer actually edits
the root text (`convertClaudeAnchorToComment`, or the plain "Bewerk bericht"
pencil on the origin bubble — the only two things that ever change THIS
comment's own body, see "Overname zonder extra menu-item" below for why an
ordinary REPLY does not), the body stops being the placeholder and the
ordinary Resolve item comes back — this gate reads the comment's own body, not
a sticky flag. `prCommentCommandsFor` (the comment-INDEX menu) needs no
matching change: such an anchor never gets an index row at all (see above), so
that menu is never opened for one.

### A bare Claude-chat anchor reads as a conversation, not as a comment

The section above only hides the anchor from the **index** — the block-scoped
thread bubble on the unit it hangs on was, until this fix, still rendered as
an ordinary compact/expanded comment card: the reviewer's own avatar next to
their own name, with the literal placeholder sentence as the "body" —
reviewer report: "het is leuk dat het bestaat als comment, maar het moet niet
als een comment laten zien… je kan het hernoemen naar 'Claude gesprek'". Two
DISPLAY-time substitutions, both keyed on `isChatAnchorPlaceholder(c)` (never
a stored flag — the same "read the body, not a sticky bit" discipline the
Resolve/Unresolve gate above already uses), applied everywhere the comment
still LIVES in `cs.list`/`cs.view` exactly as before (per "Deliberately the
index side only" above — this section changes nothing about what exists,
only how it's drawn):

- **The author/avatar row** (`compactConversation`'s own
  `data-testid=comment-author-line`, and `viewingBubble`'s
  `data-testid=reaction-author-line` for the thread's ORIGIN message only,
  `r.id === 'origin:'+c.id`) is replaced by **`chatAnchorAuthorLine()`**
  (`RelatedPanel.mjs`) — a small chat-bubble glyph plus the literal, italic
  label **"Claude gesprek"**. No avatar, no reviewer name: nothing here
  suggests Reindert typed this. Per the colourblind rule the word carries the
  meaning; the glyph is decoration. The edit pencil next to the origin
  bubble stays reachable regardless (`isOwnMessage(r) && !status` is
  untouched) — editing it is exactly one of the two ways to turn this into a
  real comment (the other being "Comment hiervan maken", below).
- **The body text** — `commentBody(c, …)`, the single render point every
  comment/reaction body already funnels through (`conventions.md`) — returns
  a fixed, muted, italic **`CHAT_ANCHOR_NOTE_HTML`** ("Nog geen eigen comment
  — bekijk het gesprek hiernaast.") instead of `renderMarkdown`ing the raw
  `CLAUDE_ANCHOR_PLACEHOLDER` sentence, exactly the same DISPLAY-time
  transform `threadStatusSentinel`/`statusLineHTML` already apply to a
  `"/resolve"`/`"/reopen"` reaction body right above it in that same
  function. The **stored** body is untouched (still the literal
  placeholder) — every existing predicate/write path that keys on that exact
  string (`isChatAnchorPlaceholder`, `clearClaudeChat`,
  `claudeAnchorIsPlaceholder`, `convertClaudeAnchorToComment`) needs no
  change.

**A `0/1`-style approval count still counts it** — confirmed explicitly
("0/1-badges wel meetellen hoor, dat is prima"): nothing above touches
`commentRowSet`/`commentActivitySummary`/`blockApproveCount` or any other
counting path, only the two render points listed. A running Claude
conversation with no reviewer text yet is still an open thing to finish, so
it should keep counting as unresolved wherever a real comment already would
— it just must not be mistaken for prose the reviewer wrote. Test:
`tests/claude-chat-panel.spec.mjs`/`tests/claude-empty-composer-menu.spec.mjs`
(both already asserted the raw placeholder sentence; updated to assert
"Claude gesprek" instead — same anchor, same fixture, only the copy changed).

### Overname zonder extra menu-item: typing a first real comment silently takes over the anchor

`placeComment` already had ONE narrow case of this: `claudeAutoAnchor`, an
ephemeral session flag `ensureClaudeAnchorForNew` sets the moment it lazily
creates the anchor, checked by `placeComment` so "Plaats…" on that SAME
composing session posts the typed text as a **reply** on the existing thread
instead of starting a second, unrelated comment (see
"Optimistically visible while composing a brand-new comment" in
`claude-chat-panel.md`). Reviewer request, generalizing this: "als ik eerste
echte comment typ, hoef ik niet een extra menu item om die 'Claude gesprek'
comment ook mee te nemen" — the SAME line, in a LATER, unrelated session (the
reviewer closed the panel, or reloaded, so `claudeAutoAnchor` is long gone),
must behave identically.

**`placeholderAnchorFor(draftKey)`** (`RelatedPanel.mjs`) replaces the
ephemeral-flag check with an **identity** lookup: it finds a
`isChatAnchorPlaceholder` comment in `cs.list` whose own anchor fields
(`file`/`label`/`gran`/`rowStart`/`rowEnd`/`seg`) produce the exact same
`draftKeyFor(...)` string as the unit being composed on right now — reusing
`draftKeyFor` itself rather than duplicating its field list, since a stored
comment carries those same field names. `placeComment` calls this
unconditionally (the ephemeral `claudeAutoAnchor` flag, when it does match,
resolves to the very same comment, so it needed no separate branch any more
— just a reset for hygiene) and, on a match, takes the exact same
reply-Signal path as before: post the reviewer's typed text as a reply,
never rewrite the root body (there is no "edit body" Signal — a comment's
body is fixed at Execution start, see `ensureClaudeAnchorForNew`'s own doc
comment). The reply itself, under the reviewer's own identity, is exactly what
now gets PROMOTED to read as the ordinary root — see "A taken-over Claude-chat
anchor reads as an ordinary comment" below, which superseded an earlier
version of this paragraph that said the origin bubble "keeps reading 'Claude
gesprek' even after this": that was itself the bug a later reviewer report
("het is eigenlijk niet een reactie, het is een eerste comment") asked to fix.
Test: `tests/comment-anchor-takeover.spec.mjs`.

**"Comment hiervan maken" (`convertClaudeAnchorToComment`,
`claudeChatCommandsFor`) stays** — decided, not left as an oversight. It
solves a DIFFERENT problem: a reviewer who never intends to type their own
comment at all, and instead wants a Claude-WRITTEN summary of the
conversation turned into the comment (prefilling the origin bubble's own
editor with a 1-2 sentence summary, see its own doc comment above). The
take-over above only ever fires once the reviewer has ALREADY decided to type
something themselves — it cannot substitute for "let Claude draft this for
me", so removing the menu item would be a regression for that path, not a
simplification.

### A taken-over Claude-chat anchor reads as an ordinary comment, everywhere

The take-over above (typing in "Comment op deze regel") is one of two ways a
bare Claude-chat anchor's placeholder root stops being displayed as
"Claude gesprek". The other, reported separately: a reviewer who instead types
their FIRST reply directly into the existing thread's own reply box
("Beantwoorden") — mechanically the exact same write (`postThreadReply`'s
"reply" Signal posts the typed text as a reaction on the placeholder's thread,
since there is no "edit body" Signal) — kept showing "Claude gesprek · 1
reactie" even though that one reaction WAS the reviewer's real, and only, first
comment. Reviewer's own words: "hier is wel al een eigen comment... het is
eigenlijk niet een reactie, het is een eerste comment (en er was toevallig een
claude gesprek)."

- **`firstReviewerReplyOnPlaceholder(c)`** (`RelatedPanel.mjs`, exported) is
  the one predicate: `isChatAnchorPlaceholder(c)` AND at least one reaction
  that is genuinely the reviewer's own (`isOwnMessage`) and not a
  `/resolve`/`/reopen` status sentinel (`threadStatusSentinel`) — deliberately
  never a Claude/foreign message, confirmed scope: only the reviewer's OWN
  first reply takes an anchor over (a Claude turn lives in the separate chat
  transcript, not in `c.reactions`, anyway).
- **`threadMessages(c)` promotes that reply to the front and drops the
  synthetic placeholder origin** once it exists — the single, root-cause fix
  every consumer (the thread render loop, `reactionCount()`, the ↑/↓ thread
  walk, `editTargetId`) gets for free, with no separate "taken over" branch
  anywhere else. `editTargetId` in particular needed no change: the promoted
  message keeps its OWN real reaction id, so "Bewerk bericht" on the
  now-first bubble already edits the right thing.
- **`commentBody(c, …)`** — the one ROOT-level (as opposed to per-message)
  call site, `compactConversation`'s own preview line — renders the promoted
  reply's body instead of `CHAT_ANCHOR_NOTE_HTML` once taken over. Every
  per-message call (`reactionBubble`'s `commentBody(r, …)`) already read the
  real reply text on its own, since `r.body` was never the placeholder
  sentence to begin with.
- **`compactConversation`'s author-line ternary** only shows
  `chatAnchorAuthorLine()` (the "Claude gesprek" glyph+label) while STILL
  bare (`isChatAnchorPlaceholder(c) && !firstReviewerReplyOnPlaceholder(c)`);
  once taken over it falls through to the ordinary author line, which already
  reads correctly — the placeholder comment's own `source`/`author` is the
  reviewer's, same person as the promoted reply.
- **`commentReactionStatusLine(c)`** subtracts exactly the one promoted
  reaction from `c.reactionCount` once taken over, so "1 reactie" (the
  reported symptom) becomes "0 reacties" — the promoted message is the
  comment now, not a reply counted on top of it.
- **The index label/snippet and the row itself change too** — the "brede
  variant", confirmed explicitly (not just the open-thread display):
  `prWideComments()`/`indexComments()` (`RelatedPanel.mjs`) both skip a bare
  placeholder as before, but fall through to the ordinary
  prWide/inBlock/mentioned checks once taken over; `commentBlockItem`
  (`home.mjs`) reads the promoted reply's own body for its 60-char snippet
  fallback (`commentTitleOf(c)` still wins first, unaffected — a stale title
  generated against the placeholder body is a known, accepted gap, not fixed
  here: `needsTitle`/the backend `comment_titles` workflow are unchanged, so a
  title that already exists keeps describing the placeholder text until the
  reviewer edits the body directly or a fresh title run happens to key off the
  new content).
- **`commentCommandsFor`'s resolve/unresolve gate** (`home.mjs`) drops its
  `isChatAnchorPlaceholder` exclusion once taken over — "een chat met alleen
  een claude gesprek" genuinely has no comment yet and stays delete-only, but
  a taken-over one now IS an ordinary open comment and gets its Resolve item
  back.
- **Deliberately NOT touched**: `claudeAnchorIsPlaceholder()`/"Comment
  hiervan maken" — that gate reads the comment's own STORED body
  (`c.body === CLAUDE_ANCHOR_PLACEHOLDER`) directly, which is still literally
  true underneath (there is no signal to rewrite it) — "Comment hiervan
  maken" solves the unrelated problem of wanting a Claude-WRITTEN summary as
  the root, and stays available exactly as before regardless of any reply
  already on the thread.

Test: `tests/comment-anchor-takeover.spec.mjs`'s final assertions (the reply
that takes the anchor over reads as an ordinary comment, not "Claude
gesprek").

### "Mentioned": an `@`-mention of the local reviewer ranks above everything

A comment whose body — **or any of its replies** (`c.reactions`, where a mention
very often lands) — `@`-mentions the local reviewer gets `mentioned: true` on its
index item (`commentMentionsMe`, `src/mentions.mjs`). **Only while it also has no
regel** (PR-wide/orphan, `!b.lineAnchored` — see "Comments op regels" above) does
that rank it **`-2`**, above every real category AND above the ordinary no-regel
"PR-comments" section (`2.4`), under its own **"Mentioned" heading**
(`mentionHeading`, `data-testid=mention-heading`, `BlockList.mjs`) — someone is
waiting on an answer, so it must not sit below unrelated feedback. This is the
one no-regel comment case deliberately left at the very top when the ordinary
"PR-comments" section moved down to `2.4` (see above). A MENTIONED comment that DOES hang on a real line instead
moves into the "Comments op regels" section like any other line-anchored
comment (reviewer request) — it keeps `mentioned: true` on the item (still
read by `blockApproveCount` etc.), it just no longer gets its own top-of-list
heading for it. Otherwise it is an ordinary comment item: resolving it still
folds it into the same "Toon N goedgekeurde blokken" section, and the "Mentioned"/
"PR-comments" headings are checked only for a no-regel item (`renderList`
branches on `b.lineAnchored` before either), so `commentHeading`'s own
condition (`&& !b.mentioned`) only ever matters within that no-regel set.

**This is the one case where a block-anchored (`kind === ''`) comment gets an
index row.** Deliberate (explicitly decided): a mention must not be able to hide
in a thread on a block you haven't opened yet. Such a comment therefore shows in
**two** places — its block's inline thread *and* the "Mentioned" row. That is two
renderings of one row, not two items: **`indexComments()` dedups on `c.id`**,
which is load-bearing rather than cosmetic — a PR-wide comment that also mentions
me matches both halves of the union, and two items would carry the **same**
`state.blocks` id (`'comment:' + c.id`), exactly the id that
`recomputeLeftList`'s selection-preserving `findIndex` and the
`?sel=comment:<id>` restore (`applyCommentRefRestore`) resolve through. One
comment = exactly one index row, always. Its `blockApproveCount`/kind-badge
paths needed nothing: the former reads `comment.status` (kind-agnostic) and
`COMMENT_KIND_LABEL[c.kind] || … || 'Regelcomment'` already had a fallback for
`kind === ''`. Its fallback label (empty body) names the block it hangs on.

**Who "I" am** is `<dataDir>/settings.json` (`GET /api/settings`, `settings.go`)
first, then the `GET /api/me` login — see "Who am I" in
`.claude/rules/conventions.md` for the precedence and the matched spellings. The
same module also highlights the mention **inside** the body, as the last step of
`renderMarkdown`. Tests: `tests/mention-highlight.spec.mjs` (both surfaces, the
dedup, the `?sel=` restore, and the no-settings no-op) plus `settings_test.go`.

### "Resolved == approved" (0/1 → 1/1)

Mapped into the **existing** generic machinery; `isFullyApproved`
(`BlockList.mjs`) is untouched. A comment item has no changed rows, so
`blockApproveCount` (`home.mjs`) special-cases `b.kind === 'comment'` at its top:
`{done: resolved?1:0, total:1}` (`resolved` = `b.comment.status === 'resolved'`),
and `subtreeApproveCount` short-circuits to that (no `nestedPrBlocks` — a comment
item has no relation children). Both are only called from the existing
`approvalSummaries`/`approvalTotal` watch, which fills
`state.approvalSummaries[b.id]` for **every** `state.blocks` entry, so
`isFullyApproved`/`approvalPill` read that map exactly as before.

Effect: unresolved shows `0/1` inline; once resolved it folds into the same
"Toon N goedgekeurde blocks" section as any fully-approved block (`renderList`'s
existing hide check) and counts toward the PR-wide `X/Y goedgekeurd` header —
see `.claude/docs/approval.md`. This also makes
`applyDefaultUnapprovedSelection` work generically over comment items for free,
which is exactly why the mapping was pushed into `blockApproveCount` instead of a
bespoke `isFullyApproved` branch.

### Guards on paths that assume a real PR block

A comment item lives only in `state.blocks`, never in `state.allBlocks`, so most
code that iterates `allBlocks`/reads `b.code` is unaffected (the "code not loaded
yet" branch already handles a permanently codeless item —
`blockRows`/`relatedChildren`/the footer/`callArrows` watches all tolerate
`b.code == null`). Explicit `b.kind === 'comment'` early-exits were needed in:
`enterDiff` (→/`f` never enters diff mode), `ensureCode` (no `/api/code` fetch —
no `.file`/`.label`), `sameFileNeighbour` (both sides, else two adjacent comment
items match on `undefined === undefined`), `commentTarget`/`placeComment` (a
comment item can't anchor a NEW line comment), and the `DetailPanel`
`pair.forEach` render loop.

`findNextUnapproved` needs no guard even though a line-anchored comment item
no longer always ranks before every real block (see "Comments op regels"
above) — see that section for why its forward-only walk still can't land on
one.

### `?sel=comment:<id>` survives a refresh

The `state.blockRef` mirror watch mirrors a selected comment item's stable `.id`
instead of a `file:line` — the same `?sel=` param, a shape that never collides
(a real file path contains no bare `comment:` prefix). Restoring is more involved
than an ordinary block: comment items are populated by `syncComments`,
independent of `loadBlocks`, so they may not exist yet the one time
`applyBlockRefRestore` runs. `applyCommentRefRestore` is therefore retried from
the `watch(() => prWideComments(), …)` above on every later comment-list update
until found — or never (deleted/expired link), the same silent not-found fallback
as a real block ref. Once found it also forces `state.mode = 'list'` (a stray
restored `?mode=diff` must not leave a comment selected in diff mode) and reveals
the selection if the comment is already resolved and thus hidden
(`revealSelectedIfHidden`, generic over the comment branch above). Test:
`tests/comment-index-url-restore.spec.mjs`.

### The detail card

`commentDetailCard(c, opts)` (`RelatedPanel.mjs`, exported) is the read-only
thread card a comment-index item shows instead of a `Block` diff card.
**Two call sites, two positions:**

- `home.mjs`'s `DetailPanel`'s `pair.forEach` loop still branches at the top
  on `b.kind === 'comment'` and renders it, wrapped in the same
  `data-testid=detail-card` stable-`contents` root as an ordinary card, keyed
  on `'detail:'+role+':comment:'+id+':'+status` (a resolve thus forces a
  fresh node) — but ONLY for an ANCHORED comment-index item (before its own
  drilled column is entered, see "An anchored 'Start' item…" above) or for
  the look-ahead PREVIEW row (`i !== sel`). At its default (no `opts.merged`)
  width: `w-[calc(42rem+50px)]` — 50px wider than the ordinary block card's
  `42rem`, room for the wider footer meta line below.
- For the SELECTED, genuinely UNANCHORED case, `InlineComments`
  (`RelatedPanel.mjs`) renders it instead, with `opts.merged: true` (drops
  the fixed width above for `w-full`, filling the parent's own
  `commentColumnWidthCls()`) — see "The comment-detail card moved into the
  merged comment-claude-row" above. `DetailPanel`'s block-column hides
  entirely for this case (`isPrCommentScope()`), so the two call sites never
  both fire for the same selection at once.

**Mirrors `compactConversation`'s shape (the block-scoped line-comment card),
not a bespoke layout of its own** — reviewer request: "ik wil algemene
comments meer laten lijken op comments op een regel". An earlier version had
its own header (status mark, avatar, name, a kind pill via
`COMMENT_KIND_LABEL`, source/AI-warning badges, a `commentFileChip` pill,
relative time) and then rendered the ORIGIN message a second time through
`reactionBubble` — which repeats the avatar+name inside its own bordered/tinted
bubble, so "AI-controle" (say) showed up twice stacked on top of each other.
Now: the header (`comment-detail-author-line`) only carries status mark,
avatar, name, `sourceBadge`/`aiWarningBadge`/`staleAnchorBadge`/
`sendFailedBadge` and the menu button — the kind pill (`COMMENT_KIND_LABEL`)
is gone outright, since `compactConversation` never showed one either. The
thread container (`comment-detail-thread`, keeps its `ring-2` while
`pct.commentId === c.id`, see below) renders the origin message as **plain
text** via the shared `commentBody` — no bubble chrome — and only a REAL reply
beyond it via `reactionBubble`. A single muted footer line
(`comment-detail-meta`, `truncate`) closes the card: `file:line` (only when
`c.file` is set — a genuine PR-wide `issue`/`review` comment has none) then
**`commentReactionStatusLine(c)`** — extracted out of `compactConversation`'s
own meta line (`N reacties · status` + `lastReplyNote`) so both cards render
that tail identically — then the relative time (room `compactConversation`'s
narrower card doesn't have). `commentFileChip` and the `COMMENT_KIND_LABEL`
map are removed outright, not just unused — nothing else called them.

**Only a row that is actually IN the index gets such a preview card.** The
look-ahead slot resolves through `previewIndexAfter` (the `↓` target, see "The
look-ahead preview is the next VISIBLE row" in
`.claude/docs/detail-layout.md`), so a comment item whose row `renderList`
hides — a RESOLVED one, since a comment scores "resolved == approved"
(`blockApproveCount`), or an ignored one — is never previewed. Before that, a
resolved **orphan** comment (`prWideComments` keeps it as an index item so it
isn't invisible everywhere) showed up as a card under a completely unrelated
block's diff, which read as "this comment belongs to this code".

`preview` (`i !== sel || !focusedHere`) dims the look-ahead card like `Block()`'s
own `preview` prop, and since this card replaces a `Block()` card in the same
slot it gets the same on/off border (`border-slate-300` while `preview`,
`border-indigo-300` otherwise — "Focus highlight per stop" in
`.claude/docs/keyboard-navigation.md`): unlike a real block there's no further
stop to step into, so non-preview here simply *is* the selected/focused state.

**Load-bearing:** the reply-composer state `picm` is a **single, module-level**
reactive shared by every `commentDetailCard` call, so it's scoped by `commentId`
rather than a bare boolean — otherwise opening the reply field on the selected
item would also reveal one on the (different) preview card. The
connector/step-chevron cue between two stacked cards is skipped whenever either
side is a comment item (no `.file` to compare). Reached purely by **selection**,
no hover.

`commentDetailCard`'s own thread (`comment-detail-thread`) keeps its
`max-h-[70vh]` — close to the full viewport, so it wasn't the clipping problem
the inline thread had (see below).

### Enter opens an action menu; → steps into the thread

Deliberately **not** the same action (reversed on explicit request, so → mirrors
→ on an ordinary block: it steps you *into* the item). `selectedComment()`
(`curBlock().kind === 'comment' ? curBlock().comment : null`) gates a branch in
`onKeydown` checked **before** the generic block-palette Enter handling.

**`Enter`** (`ms.mode = 'prComment'`, `prCommentCommandsFor`, `home.mjs`) opens:
**"Sluit menu"** (pinned, per `withClose`) then **"Beantwoorden"** and
**"Resolve comment"** in an order that depends on `isOwnComment(c)` — for the
reviewer's **own** comment (`!c.source || c.source === 'ui'` — an in-app comment
stores no explicit Source at all; or `c.source === 'github'` +
`c.author === meLogin()`) "Resolve comment" comes first and is thus
default-selected (`defaultSel`); otherwise "Beantwoorden" stays first. Both items
are always present, only the order changes — never colliding with "Comment
hiervan maken" below, since an AI finding (`source === 'ai'`) is never "own".
Then optionally **"Comment hiervan maken"** (AI findings only, see below) and
finally **"Ignore"**.

**An AI finding gets no resolve/unresolve item at all** (`isAiComment(c)` —
`source === 'ai'` or `kind === 'ai_warning'`, the same pair `isBatchEligible`
uses): reviewer request, "ai comments wil ik niet resolven, maar wil ik
verwijderen". Both halves go, not just "Resolve comment" — resolving is a
conversation concept that doesn't apply to a `code_warning` finding. So this
menu reads **"Beantwoorden"** then **"Verwijder comment"** there, with
"Beantwoorden" default (an AI finding is never "own", so the ownership
reordering never applied to it anyway). The block-scoped menu drops the same
slot, see below. `isOwnComment`'s github+`meLogin()` branch has no
Playwright coverage — the offline harness has no seed hook for the current user
(`GET /api/me` answers `{ok:false}`), so `meLogin()` is always `''` in tests.

The menu anchors on the already-visible detail card
(`menuAnchor`/`menuRegion`'s `ms.mode === 'prComment'` branches target
`[data-testid=comment-detail-card]`, falling back to
`[data-testid=block-column]`) — "the thread shows above the menu" is a
consequence of that anchoring, not a separate menu variant.

**`→` (`enterPrCommentThread`, `RelatedPanel.mjs`)** steps into the comment's own
thread history, reusing the existing `threadMessages`/`reactionBubble` rendering
the block-scoped thread already uses. The cursor is a **separate, ephemeral,
non-URL-bound** reactive (`pct`, `{commentId, pos}`) rather than the panel's own
`cs.focus`/`cs.threadPos`: those are URL-bound (`rel.foc`/`rel.thr`) for the
block-scoped, diff-mode-only case, and reusing them would restore a stray
`'thread'` focus into list mode on every refresh. `isActive` is an optional
override `reactionBubble` accepts for exactly this — `commentDetailCard` passes
`() => !preview && pct.commentId === c.id && pct.pos === total - i` so the
look-ahead preview card (same component) never lights up too.

`↑` walks up and clamps at the oldest message. `↓` walks toward the newest, but
once already there (`pct.pos === 0`) it **falls through**:
`handlePrCommentThreadKey` exits and returns `false`, and `onKeydown` falls into
the ordinary `stepListSelection(1)` — the same "↓ loopt door" convention as
`advanceFromComment` below, except a comment-index item has no
Onderliggende-code panel, so it falls through to the next **index row**. `←`
(`exitPrCommentThread`) steps back to the index (same row); a `state.selected`
change also resets it, mirroring how the same watch resets
`picm`/`cancelPrCommentReply`. `Enter` still opens the menu regardless.

`→` from that thread steps **one level further, into the Claude chat** column
already standing next to the item (`handlePrCommentThreadKey`'s own
`ArrowRight`: release `pct`, then `enterClaudeChat`) — the mirror of the
block-scoped `'thread'` + `→`, and `←` from the chat comes straight back here
(`handleRelatedKey`'s `isPrCommentScope()` branch, since the `'comment'` level
in between does not exist for such an item). Full walk and the reviewer
request: "Comment-index items" in `.claude/docs/keyboard-navigation.md`.

**Typing a query that matches none of the menu's own labels falls back to
"Chat over deze comment"/"Beantwoorden met deze tekst"** instead of a dead-end
"Geen commando's." — see "A no-match query falls back to Chat/Beantwoorden,
not 'Geen commando's'" in `.claude/docs/command-palette.md`.

### The menu actions

- **"Beantwoorden"** (`startPrCommentReply`) only reveals the reply textarea in
  the detail card (`picm.replying = true` + `picm.commentId = c.id`) and focuses
  it — the reviewer types and sends from there (`Enter` or the send button),
  never from the menu.
- **"Resolve comment"** (absent for an AI finding, see above)
  (`resolvePrCommentItem`) sends the same `"/resolve"`
  sentinel + `done:true` reply Signal as `resolveFocusedComment` — local-only for
  a PR-wide thread, GitHub-resolved for a review-diff thread, see
  `.claude/docs/workflows-comments.md`. Both reply and resolve go through the
  existing `POST /api/workflows/{runId}/signals/reply` — no new write path.
- **"Unresolve comment"** (`unresolvePrCommentItem`) takes that same slot
  instead — never alongside it — once `c.status === 'resolved'`
  (`isResolvedComment`, `home.mjs`; the block-scoped menu does exactly the same
  with `unresolveFocusedComment`). Same Signal, `action:'unresolve'` and no
  body: the workflow flips the status back to `open`, writes the `"/reopen"`
  trace itself and unresolves the GitHub conversation for a review-diff thread.
  A thread resolved before resolve became reversible can no longer be
  signalled, so the command is a silent no-op there — see "Resolve is
  reversible" in `.claude/docs/workflows-comments.md`.
- **"Bewerk bericht"** edits whichever OWN message the keyboard is currently
  on — see "Editing an own message" below.
- **"Chat met Claude"** (`startPrCommentChat`, `RelatedPanel.mjs`) opens the
  embedded Claude conversation directly under this item's own detail card —
  a comment-index item has no diff/`→` chain to reach the block-scoped chat
  through, so this command is its only entry point. See "A PR-wide
  comment-index item can also start a conversation" in
  `.claude/docs/claude-chat-panel.md` for the mechanism (it reuses the SAME
  `claude_chat` conversation/`cc` state as the block-scoped chat — no second
  writer, no new backend endpoint).
- **"Ignore"** (`toggleIgnoreComment`, label flips to "Ignore ongedaan maken"
  once ignored — resolved once by `snapshotCommands` at open time) is a
  **durable** flag (`state.ignoredComments`, a plain `{blockId: true}` map) bound
  to its own Signal: the map is reassigned locally first so the row disappears
  instantly (optimistic), and `persistIgnoredComment` fire-and-forgets to the
  per-PR `ignore_comment` tracker, restored by `loadIgnoredComments` from
  `GET /api/commentignores?pr=N` (see "Ignoring a PR-wide comment" in
  `.claude/docs/workflows-trackers.md`). It was **session-only at first and that
  was reversed** — an ignored comment came back on every refresh; don't
  reintroduce. Offline (no `state.ignoreRunId`) the Signal is a no-op and the
  toggle silently degrades to that session-only behaviour.

  Ignoring is independent of "resolved" and **only affects sidebar visibility**,
  never the approval mapping above. `BlockList.mjs`'s `renderList` hides an
  ignored item by default (checked **before** the approved-hide check, so it
  stays hidden even if unresolved) and, once revealed via its own bottom toggle
  (`ignoreToggleRow`, `data-testid=toggle-ignored`, "Toon/Verberg N verborgen
  comments" — a SEPARATE toggle from `state.showApproved`), shows it under its own
  **"Verborgen comments"** heading (`hiddenCommentHeading`,
  `data-testid=hidden-comment-heading`). `stepVisibleSelected` skips a
  hidden-and-ignored row for `↑`/`↓`, and `ignoreToggleRow` is itself a stop of
  the sidebar's `↑`/`↓` loop (`state.ignoreToggleFocused`, mirroring
  `state.toggleFocused`) — see "The sidebar's `↑`/`↓` cursor forms one circular
  loop" in `.claude/docs/keyboard-navigation.md`.

A comment-index item's thread lives exclusively in its own detail card; it is
never part of the inline comment blocks below (those only ever show
`kind === ''`, via `recomputeView`'s `!c.kind` filter).

## Editing an own message

Any message the reviewer wrote themselves — the thread's root/opening
message, or a later reply — can be edited in place, both in the block-scoped
inline thread (`expandedConversation`) and the comment-index item's detail
card (`commentDetailCard`); both share the same `reactionBubble`/
`threadMessages` rendering, so one mechanism covers both surfaces.

**Reached via the Enter command palette, not primarily a hover affordance**
(deliberate product decision — "I want to do this with Enter"): a **"Bewerk
bericht"** item appears in both `commentCommandsFor()` (block-scoped, `Enter`
on a focused conversation with an empty reply field) and
`prCommentCommandsFor()` (a comment-index row), gated on `isOwnMessage(msg)`
so it's never offered on a foreign or AI (`code_warning`) message. `msg` is
**whichever message the keyboard is currently on**:

- Block-scoped: `focusedThreadMessage()` (`RelatedPanel.mjs`) — the bubble at
  `cs.threadPos` while stepped ↑ into the thread (`cs.focus === 'thread'`), or
  the root/opening message at rest (`cs.focus === 'comment'`, where no single
  bubble is highlighted — same convention "Resolve comment"/"Verwijder
  comment" already use for "the comment" at that position). Reaching a reply
  this way needed widening the Enter gate itself: `isCommentOrThreadFocused()`
  (which also covers `cs.focus === 'thread'`) replaces the narrower
  `isCommentFocused()` the Enter-opens-menu check used before this feature —
  mirrors how the comment-index item's own Enter already opens its menu
  regardless of its own thread-walk position (`pct.pos`, see "Enter still
  opens the menu regardless" above).
- Comment-index item: `focusedPrThreadMessage(c)`, the same index math over
  `pct` instead of `cs.focus`/`cs.threadPos`.

**A click on a bubble's own small edit-pencil button** (`reaction-author-line`,
`data-testid=reaction-edit`, shown only for an own message) runs the exact
same `startEditMessage` the palette item does — click and key do the same
thing, per `.claude/docs/mouse-navigation.md`.

`startEditMessage(c, msg)` opens an inline editor **in place of that one
bubble** (`editingBubble`, swapped in via a stable `contents` root around
`reactionBubble` — the "bare toggling expression" pitfall in
`.claude/rules/arrowjs-pitfalls.md`) prefilled with the message's raw
(pre-Markdown) body via the existing `prefillField` helper — an **uncontrolled**
field, like every other composer textarea in this file, never a reactive
`.value=` binding. `editState` (module-level, `{commentId, targetId, busy}`)
scopes which ONE bubble is currently editing, mirroring `picm`'s
`commentId`-scoping reasoning: several conversations/preview cards can be
mounted at once, so a bare boolean would open an editor on all of them.
`editTargetId(c, msg)` maps a message back to what the backend Signal needs:
the run id itself for the synthetic opening message `threadMessages()` builds
(`'origin:' + c.id`, carries no real reaction id of its own), or the reply's
own real reaction id otherwise.

**`sendMessageEdit(c)`** posts to the exact same endpoint every reply already
uses (`POST /api/workflows/{c.runId}/signals/reply`), only with a different
request shape: `{author:'reviewer', body, action:'edit', targetId}`. No new
write path — see "The `edit` Action" in `.claude/docs/workflows-comments.md`
for what the backend does with it, including the GitHub PATCH mirror.

**`Escape` cancels the edit AND hands the keyboard back to the block/item
itself**, not just to wherever the thread cursor happened to sit — explicit
request ("I want to be able to get out with Escape, landing on the block
itself"). `editingBubble`'s own `@keydown` calls `e.stopPropagation()` so this
is fully self-contained rather than relying on the event bubbling into
`home.mjs`'s `onKeydown` (which, before this, only incidentally worked for the
block-scoped case via `relatedActive()`'s `handleRelatedKey('Escape')` →
`exitRelated()`, and did nothing at all for a comment-index item — `pct`, that
item's own thread cursor, was never released, so a subsequent `↑`/`↓` kept
walking the thread instead of moving the sidebar selection). The handler
branches on which cursor actually owns this comment: `pct.commentId === c.id`
(a comment-index item's own thread, see `pct` above) → `exitPrCommentThread()`;
otherwise, if `cs.focus !== null` (the block-scoped inline thread) →
`exitRelated()`, same as `handleRelatedKey`'s own Escape handling elsewhere.
Neither branch fires when editing was started via a mouse click on a
look-ahead/preview card's own bubble while the keyboard sits elsewhere —
`pct` can never point at a non-selected item (reset by the
`watch(() => state.selected, …)` in `home.mjs`), and the block-scoped edit
pencil only ever renders on the conversation `cs.focus` already owns
(`commentCard`'s `selI() === i && cs.focus is 'comment'/'thread'` gate), so
there is nothing stray to release in that case. The "Annuleer" button keeps
calling the plain `cancelEditMessage()` — a mouse click doesn't carry the same
"get me out of here" intent as Escape.

**Shift+Enter inserts a newline in the edit textarea; a bare Enter saves.**
`editingBubble`'s own `@keydown` only claims `Enter` (no shift, saves via
`sendMessageEdit`) and `Escape` (cancels) — Shift+Enter is deliberately left
alone so the browser's default textarea behavior inserts the newline, same
convention as every other composer here. That fell through to `home.mjs`'s
document-level `onKeydown`, whose `isCommentOrThreadFocused() &&
commentReplyEmpty()` branch (the one that opens the comment action menu on a
bare Enter with an empty reply field) matched on `e.key === 'Enter'` alone,
with no `!e.shiftKey` guard — and `commentReplyEmpty()` reads the THREAD's own
reply field (`reaction-compose`), a different element from
`message-edit-compose`, which stays empty while editing. So every Shift+Enter
typed while editing an own message popped the action menu on top of the
editor instead of adding a line break. Fixed by adding `!e.shiftKey` to that
branch's condition — the same guard `isComposeOpen()`'s own Enter-opens-menu
branch already carried a few lines above it.

## Inline comment blocks

Block-scoped comment threads (`kind === ''`, the `task_code_comment` workflow)
render as their own small stack of inline cards, directly in `<main>`'s column
flow, right above the Onderliggende-code card of the currently focused column
(the same `focusedBlock()` source that card follows). They used to be a fixed,
`Cmd+→`-toggled sidebar with a browsable unscoped index — don't reintroduce
that.

`RelatedPanel.mjs`'s exported `InlineComments(state, commentTarget, openCompose)`
renders exactly the same already-scoped list `cs.view` always was
(`visibleComments()`/`commentUnder`: scoped to the selected block and, in the
diff, to the exact unit under the cursor — call ⊂ line ⊂ group ⊂ block). Only the
presentation changed: that scoped set is now inline and always visible for the
current unit instead of behind a toggle.

**Plus its own START ROW: a comment WIDER than the selected unit still shows
when the unit begins on exactly that comment's first row** (`commentUnder`'s
`c.rowStart === t.rowStart` escape from the containment test). Without it a
comment placed on a whole group — or on a Shift+↑/↓ range of several lines —
was reachable *only* at the granularity it was placed on: narrowing to `line`
made it disappear, while `commentRowSet` kept drawing a 💬 marker on every row
of its range, so the marker promised a comment the panel then refused to show.
Deliberately **not** plain overlap (explicitly chosen): a wide comment surfaces
on its start row, not under every row it happens to span — which would
reintroduce exactly the "one finding leaks into every unrelated selection"
noise the block-wide AI anchor fix removed (see `.claude/docs/workflows-analysis.md`).
A disjoint unit stays hidden either way. Test:
`tests/comment-range-first-row.spec.mjs`.

**The `seg` check only applies when BOTH sides are a call.** `commentUnder`'s
call branch used to read `c.gran === 'call' && c.seg === t.seg` for *every*
comment as soon as the cursor sat on a call segment, which threw away the
containment model one level too far: a comment anchored on the whole LINE (or
group) that the call sits inside is about that line, so `s`/call granularity
hid it even though the cursor had not left its row. Reported bug: standing on
the very `trans(...)` call an AI risk finding was written about made the
finding vanish from the comment column, while its ⚠ badge stayed on the row —
the reviewer saw the marker and had no way to reach the comment ("waar is de ai
waarschuwing comment?"). It now reads `t.gran === 'call' && c.gran === 'call'`:
only ANOTHER call's comment is out of scope on a call segment. Note this is the
one granularity where a comment on the cursor's *own* row could disappear, and
call granularity is exactly where a reviewer stands to approve that call. Test:
`tests/comment-call-gran-scope.spec.mjs`.

### The marker layer and the index must agree about what exists

Two layers answer "is there a comment here": the **markers** (`commentRowSet`'s
💬 per row, `commentActivitySummary`'s avatar/⚠ + N badge, which
`lineChildSummaries` in `home.mjs` puts on a diff row) and the **index**
(`recomputeView`/`commentUnder` → the cards in the comment column). The markers
are deliberately NOT cursor-scoped — they say "somewhere in this block/row",
which is the whole point of a marker — but every other exclusion has to match,
or a row gets an indicator that no cursor position can ever resolve. So both
marker functions skip an **orphan** (`anchorState === 'orphan'`) exactly like
`recomputeView`'s `anchored` filter does: an orphan lost its code and lives on
as its own "Start" index row (`indexComments`), never in the block-scoped
index. Same class of bug as the two paragraphs above; when adding a filter to
one layer, check the other.

### A not-selected card auto-expands its body when there's little else to see

A third card state next to "not selected, collapsed, no input"
(`compactConversation`'s ordinary `line-clamp-3`) and "selected, expanded, with
input" (`expandedConversation`, the full thread + reply field): **not
selected, but fully expanded, no input**. `autoExpandLoneComment()`
(`RelatedPanel.mjs`) lifts the 3-line clamp on `compactConversation`'s body
whenever this unit has only 1 or 2 comments **and** no Onderliggende code at
all (`rc.children.length === 0`, the same source `related-code`'s own "Geen
onderliggende code." reads) — reviewer request: a clamp only earns its keep as
a space-saver when there's something else in the column competing for room; an
AI-risicowaarschuwing sitting alone above an empty Underlying-code card lost
most of its own description behind a click for no reason. Still no thread, no
reply textarea — those only appear once the card is genuinely selected
(`commentCard`'s existing selected/focused branch, unchanged). Tests:
`tests/inline-comments.spec.mjs` ("shows in full when it is the only comment
and there is no underlying code" / "the clamp comes back once a third comment
lands on the same unit").

### A long comment gets a generated title

A comment of more than ~90 characters shows a **heading**: one Dutch sentence of
at most 6 words, above its own body. Reviewer request, from a screenshot of an
AI-controle finding (`code_warning`) whose three sentences filled the whole card:
its first lines read as if they were a title while they were really the middle of
a paragraph, and a column of such cards could not be scanned at all.

- **Where it comes from:** the `comment_titles` workflow (Haiku, batched, one
  Execution per set of untitled comments) writes `title`/`titleStatus`/
  `titleBodyLen` onto the comment itself, so it arrives through the ordinary
  `/api/comments` poll. Mechanism, determinism, the staleness fingerprint and
  the "no backfill" reasoning: "Short titles for review comments" in
  `.claude/docs/workflows-analysis.md`.
- **`commentTitleOf(c)`** (`RelatedPanel.mjs`, exported) is the single place that
  answers "is there a title to show" — `''` when there is none **and** when
  `titleBodyLen` no longer matches the current body (the reviewer edited the
  comment, so the stored title describes text that is gone).
- **Three render points**, all reading that one helper:
  `commentTitleLine(c)` above the body in `compactConversation` and in
  `commentDetailCard` (`data-testid=comment-title`, a `truncate` line), and
  `commentBlockItem`'s index-row `label` (`home.mjs`), which now shows the title
  instead of the first 60 characters of the body. Deliberately **plain text, no
  `renderMarkdown`** — same reasoning as the other `truncate`/`line-clamp` title
  contexts (see `.claude/rules/conventions.md`): a half-rendered `**` in a cut-off
  heading looks worse than none.
- **A title re-imposes the 3-line clamp.** `autoExpandLoneComment`'s
  full-body state (the section above) only applies while there is **no** title:
  once a heading says what the comment is about, the wall of text underneath can
  go back to `line-clamp-3` (explicit reviewer decision). Everything else about
  that third card state is unchanged.
- **Nothing renders while `titleStatus === 'searching'`** — a "titel
  genereren…" placeholder would only add a second layout jump for a heading that
  lands a few seconds later anyway.
- **arrow.js: the card's `.key()` must encode the title.** A title arrives on a
  LATER poll, which replaces `cs.list` with fresh objects, so the mounted card
  keeps reading the old comment object and its bindings never re-run (see
  `.claude/rules/arrowjs-pitfalls.md`, "A keyed node is reused without re-running
  its bindings"). `titleKeyOf(c)` therefore rides along in `commentCard`'s key,
  and the comment-index detail card's own key in `home.mjs`'s `DetailPanel` gains
  the same `t`/`-` suffix. `tests/comment-title.spec.mjs` covers exactly this
  (removing either suffix fails that test).
- Tests: `tests/comment-title.spec.mjs`.

### The focused comment's range gets a bar along the right edge of the diff

Once the keyboard sits **in** a comment, the diff draws a thin vertical bar over
exactly the aligned rows that comment is anchored to (`rowStart..rowEnd`), so
the reviewer can see which lines/selection it was made on — which is precisely
what the start-row rule above made possible: a comment wider than the selected
unit is now visible while the cursor sits on one row of it, and without the bar
its real extent was invisible.

`commentRangeRowSet(b)` (`RelatedPanel.mjs`, exported) is the source: the rows
of **one** comment — `selComment()`, or `chatAnchorComment()` while the keyboard
has stepped on into the embedded Claude column (the same comment whose card
stays expanded there) — and an **empty** set for every other `cs.focus`. Empty
while composing (`'new'`) on purpose: that composer targets the live cursor
unit, which already carries its own left-hand cursor bar. `home.mjs` passes it
as `commentRangeRows` next to the existing `commentedRows`, on the top-level
card and on a drilled column, **not** on a look-ahead/drill preview card (which
never owns the keyboard).

Deliberately distinct from `commentRowSet`'s 💬: that marks the *presence* of
any open comment on every row it covers, permanently; this marks the *extent*
of exactly one comment, only while it is open.

- **Right edge**, because the left edge already carries the active unit's
  cursor bar — position alone tells the two apart, never colour (the
  colourblind rule).
- Rendered per row by `commentRangeBar` (`Block.mjs`) as an absolutely
  positioned span inside the row's own box; adjacent rows touch, so the range
  reads as one continuous line, and the first/last row get a rounded cap. Same
  trick as the approve checkmark on the left — and the same accepted
  consequence: the row's box is the pane's width, so the bar scrolls along when
  a pane is scrolled horizontally. Anchoring it to the viewport would need a
  measuring overlay (`callArrows.mjs`) for a purely decorative cue.
- Threaded down the same chain as `commentedRows`
  (`Block` → `codeDiff` → `codePane` → `paneHTML` → `rowCellHTML`, plus the
  unified stand's `unifiedCodeDiff`/`unifiedHTML`/`unifiedRowHTML`), and only
  the **rightmost** pane gets a non-empty set — in the split stand the old/left
  pane keeps the empty default, since the bar marks the right edge of the diff
  as a whole. In the unified stand **both** lines of a paired row draw it (the
  one exception to "emit a per-row marking once"), or the bar would break into
  a dashed line. A TRANSLATION block has no ordinary code rows and is not
  covered. Test: `tests/comment-range-bar.spec.mjs`.

**`InlineComments`' wrapper carries its own explicit width**,
`commentColumnWidthCls()` (exported from `RelatedPanel.mjs`) — 2/3 of
`related-code`'s own `relatedColumnWidthCls()`, minus the dashed connector to
its right (`comment-claude-connector`), since it now sits beside
`ClaudeChatPanel` (`claudeColumnWidthCls()`, 1/3) in a shared row rather than
stacked full-width above `related-code`; see "The embedded Claude chat column"
in `.claude/docs/detail-layout.md`. Relying on "stretches to the sibling's
width" never held — a flex-column's cross-axis stretch only applies to a child
whose own width is `auto`, and `related-code` sets an explicit width. Left
unbounded, one unwrapped long line (a `composeTargetHint` excerpt, or a fenced
code block in a Markdown body) forced this column and thus `<main>` to
shrink-to-fit around it instead of clipping inside it (`overflow-auto`/
`.markdown-body pre {overflow-x:auto}` only clip once an ancestor has a real
width), pushing the block/drill columns out of view. The explicit clamp width
fixes that, and `commentColumnWidthCls() + connector + claudeColumnWidthCls()`
still sums to exactly `relatedColumnWidthCls()`, so the row lines up with
`related-code` below it.

### Linking a comment card to its diff row: one arrow per comment, reusing the call-arrow overlay

Reviewer report (PR 13392, `ImportSubscriptionStatsFlow::run`, split view):
selecting a line-anchored "Comments op regels" index item shows every comment
on that BLOCK — not just the one on the selected line, see "An anchored 'Start'
item…" above, which is `s.mode !== 'diff'`'s `inBlock` branch before the first
`→` — as a stack of cards, each carrying nothing but a bare `…StatsFlow.php:161`
file:line line. With seven comments spread over four different lines, nothing
on screen said which card belonged to which row; the reviewer had to read the
line number off the card and go hunt for it in the diff by eye.
`commentRangeRowSet`'s right-edge bar (above) doesn't help here either — it
only marks the ONE comment the keyboard has actually stepped **into**
(`cs.focus === 'comment'/'thread'/'claude'`), not the other six merely sitting
in the list.

Rather than inventing a new mechanism, this reuses the existing **call-arrow
overlay** (`src/callArrows.mjs`, see "Call-arrow overlay" in
`underlying-code.md`) — the precedent for "draw a line between the diff and a
card in the column beside it" — as a second, structurally identical arrow
family: one flowing indigo arrow per comment CARD currently rendered in
`InlineComments`, from its own row in the diff to the card itself, drawn
**simultaneously** for every visible card exactly like the call-arrow family
already draws one arrow per visible `method_call` child at once. Per the
colourblind rule the connection itself (a literal line from row to card) is
the signal, not a colour distinction between the two arrow families — they
never need telling apart, since they point at two different panels.

- **`setCommentArrows(pairs)`** (`callArrows.mjs`, exported) is the comment
  counterpart of `setCallArrows`: a second module-level `commentPairs` array,
  same immediate + 250ms-settle redraw schedule. `drawCallArrows`'s per-arrow
  body is factored into a shared `buildArrowPaths(list, idKey, panelSelector,
  idAttr, testid, …)`, called once for the call family
  (`related-code`/`data-child-id`/`call-arrow`) and once for the comment family
  (`comment-claude-row`/`data-comment-id`/`comment-arrow`) — both draw into the
  same overlay `<svg>` in one pass.
- **Pushed from `RelatedPanel.mjs`'s own `recomputeView`**, not from a
  `home.mjs` watch like the call family: `RelatedPanel.mjs` already owns
  `cs.view` (the exact set of comments actually rendered right now, after every
  scope/list filter), so computing the pairs anywhere else risks drifting out
  of sync with what's really on screen. `recomputeView` is the single funnel
  every `cs.view` reassignment already goes through (a scope change from
  `setCommentScope` OR a fresh comment-list poll), so no second watch was
  needed — the arrow list simply always mirrors `cs.view`: `cs.view.filter(c
  => c.rowStart != null && c.rowStart >= 0).map(c => ({ row: c.rowStart,
  commentId: c.id }))`.
- **Not gated on `state.mode === 'diff'`** (unlike `callArrowPairs`) —
  deliberately, since the motivating case is exactly the "as if fully
  expanded" anchored view **before** the first `→`, still in list mode (see
  "An anchored 'Start' item…" above). The diff itself is already visible
  there, so the arrows should be too.
- **Each comment card carries `data-comment-id="<id>"`** on its own root
  (`compactConversation`'s button, `expandedConversation`'s div) — the
  matching id `buildArrowPaths` looks up via `[data-comment-id="…"]`, mirroring
  `relatedCard`'s `data-child-id`.
- A comment with no resolved anchor (`rowStart` unknown/`-1` — an orphan, or a
  legacy/seeded row) simply gets no arrow, same "missing information ⇒ no
  arrow" rule the call family already follows for an `Unchanged` target.
  Several comments sharing one row (two threads on the same line) each still
  get their own arrow, converging on that row — no special-casing, the same
  way two call sites on one line would.

Test: `tests/comment-arrows.spec.mjs`.

### The selected conversation hides the ones above it, behind a clickable "▲ N hierboven"

Reviewer request: "als je een comment selecteert hebt, dan wil ik de
bovenstaande comments hiden, je mag een pijltje (wat je vaker ergens gebruikt
als iets buiten beeld is) gebruiken om aan te geven dat er meer comments boven
staan". With four threads on one line the expanded card — and its reply field —
was pushed below the fold, exactly the state the reviewer screenshotted.

`InlineComments` therefore **does not render** the cards above the expanded one
at all: its `.map()` starts at `hiddenAboveCount()` instead of at 0, and the
slim `▲ N hierboven` header (`moreAboveHint`,
`data-testid=comment-more-above`) is the only trace of them. Per the colourblind
rule the WORD (the count + "hierboven") plus the `▲` SHAPE carry it; there is no
colour involved. Cards BELOW stay visible, untouched.

- **`hiddenAboveCount()` = `max(0, expandedCommentIndex())`** is the single
  source both the card loop and the hint read, so "what is hidden" and "what
  the hint claims" cannot drift apart.
- **`expandedCommentIndex()` mirrors `commentCard`'s own expand predicate**, in
  the same order: `selI()` while `cs.focus` is `'comment'`/`'thread'`, else the
  index of `chatAnchorComment()` while `cs.focus === 'claude'` (looked up by
  **id** — that fallback can point outside the selection index, see its own doc
  comment), else `-1` (nothing hidden: the keyboard is on the diff, on `'code'`,
  or in the new-comment composer). Deliberately keyed on the **expanded card**
  rather than on the cursor (explicit reviewer answer): the card stays expanded
  once `→` moves the keyboard on into the Claude column, and re-showing the
  cards above at that moment would jump the whole column.
- **`hiddenAboveCount()` is read unconditionally at the top of that binding**,
  never inside a `.filter()` callback — an empty list would never call the
  callback, leaving `cs.sel`/`cs.focus` out of the binding's crystallized
  dependency set so it would never re-run on a selection change (measured: the
  first cut did exactly this and hid nothing). Same rule as `watch`'s inline
  deps in `.claude/rules/arrowjs-pitfalls.md`. The loop yields a **shorter
  keyed array**, not a per-item template↔`''` toggle (the "bare toggling
  expression" pitfall in that same file), and `i` stays the comment's REAL index
  in the visible list, so `commentCard`'s `cs.sel = i` click and its
  `selI() === i` check need no change.
- **The hint is a real `<button>`** (`onUp`): hiding removes the only MOUSE
  route to a hidden conversation, so a click selects the last comment above the
  expanded one — the same step `handleRelatedKey`'s ArrowUp takes once it walks
  past a thread's oldest message, per `.claude/docs/mouse-navigation.md`. It
  computes that target from `hiddenAboveCount() - 1` rather than `cs.sel - 1`,
  so it stays right when the expanded card is the Claude anchor instead of the
  cursor.
- **`moreAboveHint` had to move to module scope.** It sat nested inside
  `RelatedCode`'s component body, so `InlineComments`' call site threw
  `moreAboveHint is not defined` on every render — which is why this hint was
  never actually visible in the comment column (it had no test of its own; the
  Onderliggende-code list, its other caller, had already dropped it).
- **Two index-based DOM lookups became id-based**, since DOM position and list
  index now disagree: `scrollCommentIntoView` (`commentItemEl(selComment())`,
  `[data-comment-id]`) and `menuAnchor`'s `'comment'`/`'replyPublish'` branches
  in `home.mjs`, which now call the exported **`focusedCommentEl()`** instead of
  the removed `commentSelIndex()`. Same "snapshot by stable ID, never by raw
  array index" rule as `.claude/rules/conventions.md`.
- **The comment-arrow overlay needs nothing:** `buildArrowPaths` already skips a
  pair whose card element is missing (`src/callArrows.mjs`), so a hidden comment
  simply gets no arrow — the same "missing information ⇒ no arrow" rule it
  applies to a scrolled-out row.

`scrollCommentIntoView` still aligns the expanded card to the top of its
vertical scroller (`alignToTopVertical`); with the cards above gone that is
mostly moot, and the column usually has no scroller of its own anyway (then it
is a no-op). Full mechanism of that alignment: "The selected child is pulled to
the TOP" in `.claude/docs/underlying-code.md`.

Tests: `tests/inline-comments.spec.mjs` (hide + hint + the click back),
`tests/comment-resolved-skip.spec.mjs` and `tests/claude-chat-panel.spec.mjs`
(both reach a later comment and now assert the earlier one is hidden).

### One card per conversation, only the focused (or Claude-anchored) one expands

Multiple threads can hang off one unit; each gets its own card
(`data-testid=comment-item`), but only the one the keyboard owns (`cs.sel` +
`cs.focus` one of `'comment'`/`'thread'`) renders `expandedConversation`: a slim
right-aligned meta line (`comment-meta-line` — source/AI-warning badge + status
mark), every message via `threadMessages`/`reactionBubble`, and a working reply
field. The code-snippet hint itself (`composeTargetHint`) is no longer rendered
per-card — see "the shared `composeTargetHint` header" below. Every other
conversation on that unit stays `compactConversation`: status mark, author +
avatar, a `line-clamp-3` body preview, `data-expanded=false`/`true` on the DOM
node so a test can assert which is open.

That preview was a hard 1-line `truncate`, which cut a multi-sentence AI finding
(`code_warning`, `source:'ai'`) after a few words; `line-clamp-3` keeps the
space-saving design while leaving a typical 2-4 sentence finding readable in
place. The toggle between the two lives in a stable `<div class="contents">` root
per card (`commentCard`) — the outer `.map()` key stays `'comment:' + c.id`
regardless of expand/collapse, only the nested `${() => …}` binding swaps (see
the "bare toggling expression" pitfall in `.claude/rules/arrowjs-pitfalls.md`).

**Also stays expanded once the keyboard moves on into the Claude column**
(`cs.focus === 'claude'`, see "The embedded Claude chat column" below), for
whichever comment that Claude conversation is anchored on
(`chatAnchorComment().id === c.id`, compared by id rather than by
`selI() === i`, since `chatAnchorComment()`'s own fallback can point at a
comment outside the current selection index). The merged comment-claude-row
card shows both halves side by side (see "The embedded Claude chat column"
below and `.claude/docs/detail-layout.md`), so collapsing the comment the
moment `→` moves focus into Claude would hide the very thread the
conversation is about.

### A capped, fading thread — a later, deliberate reversal of the note above

**Superseded.** This section used to say the expanded thread has no height cap
at all — an earlier `max-h-64 overflow-auto no-scrollbar` had silently cut off
the tail behind an invisible scrollbar, which read as a truncated
conversation, so a cap was removed outright rather than fixed. A long
conversation (or a long single reply) then had nowhere to stop: `comment-thread`
grew without bound, `<main>`'s flex row (no `items-start`, so the CSS default
`align-items: stretch` applies) stretched the whole `comments-and-related`
column — and, via that same stretch, the sibling block-diff column too,
showing as a large blank gap under a short diff/test card — and `<main>`'s own
vertical scroll (already `auto`, see `.claude/docs/detail-layout.md`) then
carried the reviewer's focus down far enough to push the diff off the top of
the screen. Reported directly by a reviewer screenshot: a long reply made it
impossible to see the diff and the conversation at the same time.

**The fix this time is different from the earlier, reverted `max-h-64`
attempt** — it deliberately does not repeat either mistake that attempt made:

- **A viewport-relative cap** (`max-h-[38vh]`, matching `related-code`'s own
  `max-h-full` bounded-by-`<main>` approach in `.claude/docs/detail-layout.md`
  and `column-resize.md`), not a small fixed pixel value that clips a
  perfectly ordinary conversation.
- **Superseded again (reviewer request):** a visible native scrollbar used to
  be the discoverability cue here, deliberately without `no-scrollbar` on this
  one container while every other scrollable panel in the app hides its
  scrollbar chrome. That read as visual noise, so it's gone: `comment-thread`
  now carries `no-scrollbar` like everywhere else, and the cap is discoverable
  instead via the same green up/down `scrollHint` chevron pair Block.mjs's
  diff panes use (`data-scroll-body` + `updateScrollHints`,
  `src/scrollFade.mjs` — see "Two different chevrons" in
  `.claude/docs/keyboard-navigation.md`). `claude-chat-thread`
  (`ClaudeChat.mjs`) mirrors this exactly, and so do two more containers that
  used to have the same visible-scrollbar treatment: `comment-detail-thread`
  (the PR-comment-index detail card's own thread, `RelatedPanel.mjs`) and the
  standalone code-preview `pane()` (`CodePreview.mjs`).
- **The newest message still stays in view by default**, mirroring how the
  Claude column already behaved: `scrollCommentThreadToBottom()`
  (`RelatedPanel.mjs`, an exact mirror of `scrollClaudeThreadToBottom`) sets
  `comment-thread`'s own `scrollTop = scrollHeight` whenever `cs.threadPos ===
  0` — called from `toComment()` and from `loadComments()` after a poll brings
  in a new reply on the currently-open thread. A no-op while walking older
  messages via `↑` (`cs.threadPos !== 0`) — that must never be yanked back
  down.
- **A chevron, not a hard clip or a fade, as the "there's more above/below"
  cue** (`src/scrollFade.mjs`'s `updateScrollHints`, positioning + toggling the
  opacity of the two `scrollHint('up')`/`scrollHint('down')` nodes) — bound
  via `@scroll` on the container, plus called directly after every
  programmatic `scrollTop` write (a JS-driven scrollTop assignment isn't
  guaranteed to fire a native `'scroll'` event in every browser), and swept
  for every scroll-hint host (`refreshScrollHints()`) after a fresh render
  that nothing else scrolls (a newly selected row, a fresh set of
  code-preview cards). Deliberately **not** permanently shown in either
  direction: it only toggles on once there's genuinely something out of view
  (`scrollTop > 4` resp. `scrollTop + clientHeight < scrollHeight - 4`), so a
  short conversation that fits entirely inside the cap never shows either
  chevron — the earlier `no-scrollbar`-with-no-cue mistake hid the fact that
  there was more to see at all; a chevron only ever appears when that is
  actually true. This module used to toggle a CSS top-fade
  (`.scroll-fade-top`) instead — replaced because that approach only ever
  covered "more above"; "more below" used to rely on the native scrollbar
  itself being visible, which is exactly the thing this reviewer request
  removed.
- **Both containers carry a 2px `p-0.5`, and it is not decoration.** The
  selected bubble's highlight is a Tailwind **`ring-2`** (`reactionBubble`
  here, `claudeBubble` in `ClaudeChat.mjs`), and a ring paints **outside** the
  border box — so `overflow-y-auto` clipped it flush against the container's
  edges. On the newest message that read as *"I can't see the bottom border of
  the last message"* (Reindert, screenshot), and scrolling did not help,
  because those 2px were never part of the scrollable area to begin with. The
  padding gives the ring its room back on all four sides. Keep the two
  containers in sync: they mirror each other in every other respect too.
  Regression test: `tests/claude-chat-ring-clipped.spec.mjs`, which asserts
  the **geometry** (selected bubble's rect + 2px fits inside the thread's
  client rect), not the class — so dropping the padding while keeping the ring
  fails again.
- **No new `overflow-hidden` anywhere in the ancestor chain** — only the two
  innermost message-list containers (`comment-thread`,
  `claude-chat-thread`) got the cap; `comment-claude-row`/
  `comment-claude-columns` themselves are untouched, so the documented
  `overflow-hidden` + `justify-end` 0px-collapse trap (see
  "`comment-claude-row` deliberately carries NO `overflow-hidden`" in
  `.claude/docs/detail-layout.md`) can't recur.

#### A manual scroll-up must not get yanked back down — `threadPinned`/`claudePinned` and the "scroll to recent" button

Reported bug: scrolling a long thread up by hand (the native scrollbar/wheel,
not `↑`, which walks the separate `cs.threadPos`/`cs.claudePos` KEYBOARD
cursor) got silently snapped back to the newest message a few seconds later,
the moment the comment poll (`loadComments`, every 5s) or a Claude
progress/transcript event called `scrollCommentThreadToBottom`/
`scrollClaudeThreadToBottom` — both only ever checked
`cs.threadPos === 0`/`cs.claudePos === 0` (the keyboard rest position), never
whether the reviewer's own scroll had since moved the pane itself away from
the bottom.

**`cs.threadPinned`/`cs.claudePinned`** (`RelatedPanel.mjs`, default `true`)
track exactly that, independent of the `*Pos` cursor — updated live by each
pane's own `@scroll` handler (`updateCommentThreadPinned`/
`updateClaudeThreadPinned`, alongside the existing `updateScrollFade` call:
`pinned = scrollTop + clientHeight >= scrollHeight - PINNED_EDGE_PX`, an 8px
slack for sub-pixel rounding) and reset to `true` at every "the thread is
(re)entered at rest" call site (`toComment`, `enterClaudeChat`,
`enterClaudeChatFromNew`, `clearClaudeChat`, and whenever the visible
conversation's anchor itself changes in `syncClaudeAnchorForSelection`/
`ensureAndLoadChat`) — a different conversation always starts pinned to its
own bottom, never inheriting the previous one's scroll state.
`scrollCommentThreadToBottom`/`scrollClaudeThreadToBottom` gained a second
guard, `&& cs.threadPinned`/`&& cs.claudePinned`, alongside the pre-existing
`*Pos === 0` check — so a poll/progress event landing while the reviewer has
scrolled away is now a no-op there too, exactly like walking older messages
via `↑` already was.

**Both scroll-to-bottom functions also resync the pinned flag directly**,
right next to their existing direct `updateScrollFade` call, for the identical
reason documented there: a JS-driven `scrollTop` write isn't guaranteed to
fire a native `'scroll'` event in every browser, and without this a stale
`pinned = false` — e.g. left over from a transient scroll event during layout/
focus — would have nothing to ever flip back to `true`, permanently
suppressing the very function that's supposed to keep the thread pinned.

**The button** (`data-testid=scroll-to-bottom-comments`/`scroll-to-bottom-claude`,
`scrollToRecentButton` in `RelatedPanel.mjs` and its ClaudeChat.mjs-local twin
`claudeScrollToRecentButton` — duplicated rather than shared, since
`ClaudeChat.mjs` never imports `RelatedPanel.mjs` back, see "pure template,
fed getters" below) is the small round emerald pill with a chevron-down —
visually identical to `Block.mjs`'s `scrollHint`, deliberately: same shape,
same "the shape carries the meaning" colorblind-rule reasoning, so **no text
label**, only a `title`/`aria-label` ("Naar recente berichten"). Shown while
`*Pos === 0 && !*Pinned` — i.e. exactly when a poll/progress event's own
auto-scroll would otherwise have fired but didn't — absolutely positioned
(`bottom-2 right-2`) inside a `relative` wrapper now added around each pane.
Its own click handler (`jumpToCommentThreadBottom`/`jumpToClaudeThreadBottom`)
re-pins (`*Pinned = true`) and then calls the ordinary scroll-to-bottom
function, which is no longer a no-op once re-pinned.

**Historical:** a comment-index item used to have its OWN embedded chat inside
`commentDetailCard` (the `pcc` reactive), a second `claude-chat-thread` DOM
instance with its own `pcc.pinned` field plus
`updatePccThreadPinned`/`jumpToPccThreadBottom` wired through the
`onThreadScroll`/`onJumpToBottom` callbacks, precisely so the pinned STATE
could not leak between the two. That whole copy is gone — such an item now
shows the ordinary right-hand column, see "An unanchored item shows the
ordinary Claude column, on the right" above — so `cs.claudePinned` is again
the only pinned flag for a Claude thread.

Toggling this slot uses the same stable `<div class="contents">` wrapper as
every other bare template↔`''` toggle in this file — see the "bare toggling
expression" pitfall in `.claude/rules/arrowjs-pitfalls.md`. Tests:
`tests/scroll-to-recent-button.spec.mjs` (the comment-thread case drives the
real 5s poll end to end; the Claude-thread case only checks the button's own
wiring, since the underlying pinned/no-op mechanism is structurally identical).

The comment/Claude-column menu anchors (`menuAnchor`'s `'comment'`/`'claude'`/
`'replyPublish'` branches in `home.mjs`) target `comment-item`/
`claude-chat-card` — the OUTER card, not the now-scrollable inner thread div —
so an open menu's position is unaffected by this change.

**`expandedConversation` has no author+avatar header** — that duplicated the
opening bubble `threadMessages()` already renders (the comment's own body as the
first message). Only the source/AI-warning badge + status mark remain,
right-aligned in the slim `comment-meta-line`. `compactConversation` keeps its
own author+avatar line (it never shows the thread body).

**`compactConversation`'s avatar becomes an overlapping stack once more than
one person has spoken** (`authorAvatarStack`, right next to `threadMessages`):
`threadParticipants(c)` dedupes every message's author (root + replies) by
display name, root first. A solo author keeps the existing bare `avatarHTML`
call (no visual change, the overwhelmingly common case); two or more render as
a small stack — each avatar after the first gets `-ml-2` (overlap) plus a
`ring-2 ring-white`/`dark:ring-zinc-900` (shape/border keeps each circle
visually distinct from its neighbour, never color-only, per the colorblind
rule in `.claude/rules/conventions.md`). Capped at `AVATAR_STACK_MAX` (3); any
remainder collapses into a trailing `+N` circle, same shape as the other
avatars, `data-testid=comment-author-stack-extra`. The name text next to the
stack still shows only the root author (`who.name`) — `lastReplyNote` already
covers "who spoke last" in the meta line below, so the stack alone answers
"how many/who are in this thread", not the whole roster in text. The `+N`
slot is a `${() => …}` function binding, not a bare ternary, per the
"statically interpolated template↔string slot" pitfall in
`.claude/rules/arrowjs-pitfalls.md` — its `${}` shares chunk-caching with
every other `authorAvatarStack` call site.

**`compactConversation`'s meta line also names who sent the LAST message**
(`lastReplyNote`, next to `threadMessages`): a collapsed thread with several
reactions otherwise gave no clue whose turn it is. It looks at the last entry of
`threadMessages(c)` and appends `" · <author> reageerde"` to the `comment-meta`
text — empty while there's nothing beyond the opening message, and empty once the
reviewer's OWN reply is last (`author === 'reviewer'`, the in-app sentinel).
Plain text, not colour.

### The shared `composeTargetHint` header, spanning comment + Claude

`composeTargetHint` used to render inline in two places, both confined to
`InlineComments`' own (half-width) column: inside `newCommentComposer` while
composing, and inside `expandedConversation` for whichever comment is open.
Both call sites are gone. `activeComposeTargetHint(commentTarget)`
(`RelatedPanel.mjs`) resolves the SAME target either way — the open
new-comment composer's target (`warningOverride` or the live cursor) while
`cs.focus === 'new'`, else the currently expanded conversation's own anchor
(`selComment()`, while `cs.focus` is `'comment'`/`'thread'` and it carries
`c.code`), else `null` — and `home.mjs` renders `composeTargetHint(...)` from
it **once**, in a `px-3 pt-3` wrapper directly inside `comment-claude-row`,
above the `flex items-stretch` row of the two columns. So the code preview
now spans the full merged card's width, not just the comment column's own
half — the anchor it shows is shared by both the comment thread and the
Claude conversation hanging off it, so confining the preview to one side was
never quite right. The wrapper's visibility is gated on the exact same
`activeComposeTargetHint(commentTarget)` call (mirroring `claudeChatVisible()`
gating `comment-claude-connector`), so no empty padded strip shows when
there's nothing to preview.

`composeTargetHint` also shows the target's own **`file:line`** — a `<p>`
right below the `gran · label` line, shown only when `target.file` is set
(the new-comment composer's live cursor/`warningOverride` anchor always has
one; an expanded existing conversation's anchor, built as just
`{gran,label,code}`, doesn't, so that case simply shows no path line). This
used to live in `newCommentComposer`'s own heading (`"Nieuwe comment ·
modules/…/File.php:65"`) — moved here (reviewer request) so the path sits
once, at the top of the whole merged card, instead of duplicated per
composer state.

### No per-side focus border any more

`expandedConversation`, `newCommentComposer`'s card and `claudeChatColumn`'s
card (`ClaudeChat.mjs`) — every card inside `comment-claude-row` — used to
each carry their own indigo focus border keyed on `cs.focus`
(`expandedConversation`/`claudeChatColumn`: indigo while that side actually
had the keyboard, `border-transparent` otherwise; `newCommentComposer`'s
`isNewChatUnanchored()` variant: unconditionally indigo, a pre-existing
inconsistency). See "The focus border follows the keyboard…" in
`.claude/docs/claude-chat-panel.md` for that earlier fix's full history and
its reasoning ("helemaal geen rand op de niet-gefocuste kant").

**Removed entirely** (explicit reviewer request, deliberately reversing that
earlier decision — "nooit meer een losse rand om de comment- of
Claude-kaart, ook niet bij focus"): now that both halves already sit inside
one shared bordered `comment-claude-row` card (see above), a per-side focus
border read as a doubled/duplicate border rather than a useful cue — most
visible in the "chatting on a brand-new, not-yet-anchored unit" state, where
the comment side's unconditional border and the Claude side's conditional
one showed at the same time. None of these three cards takes a
`border`/focus-border class any more, regardless of `cs.focus`. The
`tests/claude-chat-panel.spec.mjs` case asserting the border swaps sides was
removed along with it. `compactConversation`'s/`commentDetailCard`'s own
*neutral*, non-focus-driven `border-slate-300 dark:border-zinc-700` is
untouched — that border was never about `cs.focus`.

### Status mark and the resolved style

`commentStatusMark(c, extraCls)` (`RelatedPanel.mjs`) replaced the former
colour-only `CSTATUS_DOT` (amber/emerald circle): it renders **nothing** for
`open` (the neutral default — "dots may go away" was explicit colorblind
feedback) and a plain `✓` for `resolved`, the same bare-glyph convention as the
approval pills (`BlockList.mjs`) and `translationDiff.mjs`'s per-key ✓. The
emerald tint decorates a shape that already carries the meaning. Used via a
`${() => …}` function binding (never a static interpolation, see
`.claude/rules/arrowjs-pitfalls.md`) in
`compactConversation`/`expandedConversation`/`commentDetailCard`.

Once `c.status === 'resolved'` those same three cards swap their background from
`bg-white`/`bg-zinc-900` to the muted `bg-slate-50/60 dark:bg-zinc-800/40` the
Underlying-code card already uses for an unselected item — a resolved
conversation is done and should recede like already-reviewed reference code.
`compactConversation`/`commentDetailCard` keep their neutral
`border-slate-300 dark:border-zinc-700` border in both states;
`expandedConversation` carries no border of its own any more at all (see "No
per-side focus border any more" above).

### A state-change message renders as a status line, not as a chat bubble

The resolve and unresolve actions each store their command-like body as an
ordinary reaction (`"/resolve"`, `"/reopen"` — `resolveSentinel`/
`reopenSentinel`, `workflows.go`), so the conversation records **when** the
thread changed state and **by whom**. Showing that raw was ugly: a bubble
reading `/resolve`.

`threadStatusSentinel(body)` (`RelatedPanel.mjs`) maps such a body onto
`{icon, text}` — `✓ Thread opgelost` / `↩ Thread heropend` — on an exact,
trimmed, lowercased match, so a real reply merely mentioning `/resolve` in a
sentence stays ordinary text. `commentBody` (the single render point for every
comment/reaction body, see `conventions.md`) returns that status line instead of
`renderMarkdown`'s output, and `viewingBubble` drops the bubble chrome for it
(no border/tint, small italic) plus the edit pencil — there is no wording to
edit. The author line above it stays.

This is a **display-time** transform, exactly like `identityOf`: the stored body
keeps the literal command, because the GitHub-side resolve detection
(`modules/github`) and the workflow's "never mirror this as text" guard both key
on it — and every `"/resolve"` reaction stored before this existed renders as a
proper status line too, with no backfill. Per the colorblind rule the meaning is
in the **word**; the glyph is a second cue and colour carries nothing.
Test: `tests/comment-unresolve.spec.mjs`.

### The menu button (`reaction-status`) and the shared comment/Claude footer

It used to fire `sendReaction(true)` directly (a resolve shortcut) — gone.
Resolving now happens exclusively via the comment-scoped command menu's "Resolve
comment" (`resolveFocusedComment`, always the fixed `/resolve` sentinel — see
`.claude/docs/command-palette.md`), which this button **opens** on click
(`openCommentMenu`, threaded from `home.mjs`'s `openMenu('comment')` through
`InlineComments`/`commentCard`/`expandedConversation`, mirroring how the
composer's "Plaats…" button opens `openMenu('compose')`). That click path is what
keeps resolve/delete reachable **with the mouse alone**. Deliberately more
permissive than the keyboard gate (`commentReplyEmpty()`): a click always opens
the menu, since a click is unambiguous (unlike `Enter`, which is overloaded with
"send the typed reply").

`reaction-status` used to double as a send-status indicator of its own
(`sendStatusIcon`: pencil/spinner/circle-check). That moved out to
**`CommentClaudeFooter`** (`RelatedPanel.mjs`), one shared status line below
**both** the comment and Claude columns (`comment-claude-row` in `home.mjs`,
after the `flex items-stretch` row of the two columns) — see
"Claude" doc-comment-panel.md's own section on it. `reaction-status` itself now
always shows the same neutral three-dot ("more options") glyph
(`data-testid=reaction-status-icon`), regardless of `cs.busy`/`cs.replySent`.
`commentFooterText()` reads `cs.busy` (any in-flight comment action — reply,
place, resolve, delete — worded generically as "Bezig…", since it is not
specific to sending) and `cs.replySent` (the 1.2s "Verstuurd" flash after a
reply, unchanged from before) for the comment-side half
(`data-testid=comment-claude-footer-comment`); the Claude-side half
(`data-testid=comment-claude-footer-claude`, still carrying
`data-testid=claude-chat-status` on the text itself) reuses
`claudeStatusText`/`view.busy()`/`view.progress()`/`view.elapsed()` — see
"Live progress" in `.claude/docs/claude-chat-panel.md`. Either half renders
independently; the whole footer renders **nothing** (not even an empty bar)
when neither side has anything to report.

`commentDetailCard` (a PR-comment-index item's own small card, see "The
comment-detail card moved into the merged comment-claude-row" below) also
calls `CommentClaudeFooter(c.id, { batchOnly: true })` for its own
`comment_batch` progress line — `batchOnly` drops the "Selected: …"/live-turn/
"Ook bezig elders" sections from that second call, since those describe the
globally anchored conversation and already render once in the wide
`comment-claude-row` footer above (`CommentClaudeFooter()`, no `commentId`);
without the flag they rendered byte-for-byte a second time inside the small
card. Reported bug: "status van draaiende chat vraag moet onderin de blok
staan, niet onderin de comment blokje".

Both buttons (`reaction-send`/`reaction-status`) are disabled while `cs.busy` via
a plain `disabled="${() => cs.busy}"` — **not** `?disabled=`/`.disabled=`,
neither of which works in this vendored arrow.js (see
`.claude/rules/arrowjs-pitfalls.md`). The composer's "Plaats…" button and the
PR-wide reply's "Stuur" button keep their own `sendStatusIcon` treatment
(draft/sending only, untouched by this change); the PR-wide reply has its own
`picm.sending` flag. Test: `tests/reaction-status-icon.spec.mjs`.

### A reply no longer auto-opens the comment's own menu

This used to open the comment's own action menu (`commentCommandsFor`)
immediately after a reply landed, on an earlier reviewer request: "als ik een
reactie plaats op een comment, wil ik niet daarna gelijk naar de diff, ik wil
het menu zien waar ik kan bijvoorbeeld resolven." **Reversed again** on a
later, more specific report — the reply/comment appearing immediately is
wanted, but the menu popping up uninvited on top of it is not: "als ik een
comment plaat, komt het direct erop (goed), maar ik zie dan ook gelijk een
menu, dat wil ik niet."

`postThreadReply` (block-scoped thread) and `postPrCommentReply`
(comment-index item) both dropped their `commentMenuOpener()`/
`prCommentMenuOpener()` call. `cs.focus` still stays put (never reset to
`null` the way `exitRelated()` would) — the field is cleared/blurred
(`el.value=''`, `releaseFocus()`) and the thread stays expanded
(`data-expanded="true"`), but no menu overlays it anymore. The reviewer can
still open the same menu themselves — `Enter` on the now-empty reply field
(`commentReplyEmpty`, `home.mjs`'s `onKeydown`) — exactly as before this
whole back-and-forth started. The cross-module opener plumbing
(`setCommentMenuOpener`/`commentMenuOpener`,
`setPrCommentMenuOpener`/`prCommentMenuOpener`) stays registered (still used
by that manual `Enter` path) — only the automatic call after a send is gone.

- **A failed send still restores the draft directly into the still-visible
  field** (`postThreadReply`'s `else` branch does `el.value = body;
  autoGrowTextarea(el)`) — the field no longer unmounts/remounts on a reply,
  so nothing else would pick the draft back up from `replyDrafts` on reopen;
  `postPrCommentReply`'s field still does unmount on every send (unaffected),
  so it still recovers the draft via `prReplyDrafts` on the next
  "Beantwoorden" open, unchanged.
- **This also applies after a publish-choice flow completes** — reaching
  `postThreadReply`/`postPrCommentReply` via `sendPendingReply` (the reviewer
  picked a GitHub destination in the SEPARATE `'replyPublish'` menu) no
  longer opens a second menu right after that one closes.

Test: `tests/reaction-status-icon.spec.mjs`, `tests/comment-delete.spec.mjs`,
`tests/comment-send-failed-badge.spec.mjs` (draft recovery on both paths), and
`tests/reply-publish-local-thread.spec.mjs` — all updated to assert the menu
does NOT reopen after a send.

### Deleting a comment hands the keyboard back to its diff row

`deleteCommentAndSelectRow` (`home.mjs`) wraps `deleteFocusedComment`, which only
sends the `delete` Signal and reloads the list. Without the wrapper `cs.focus`
stayed stuck on `'comment'`/`'thread'` pointing at nothing, so `relatedActive()`
kept routing every arrow key into the now-empty panel — the keyboard looked dead
right after a delete.

The wrapper snapshots the deleted comment's anchor (`c.gran`/`c.rowStart`, from
`focusedComment()`) and the focused column (`focusedBlock()`) **before** the
`await` (the reload can itself touch `cs.focus`/`cs.sel` via its shrinking-list
clamp; this landing must win), re-anchors the diff cursor onto the unit covering
that row — `state.gran`/`state.change` at `focusLevel === 0`, else the focused
column's own `state.drillCursor` entry — and calls `leaveRelated()` (the exported
`exitRelated`) to release `cs.focus`. An unpinned/never-anchored comment
(`rowStart < 0`) falls back to row 0, the same fallback `openTask` uses. The
target block is always the already-focused one (the panel only ever shows
comments anchored on it), so no cross-block jump is needed. Test:
`tests/comment-delete-selects-row.spec.mjs`.

### Converting an AI-controle finding into a real comment

An AI finding (`code_warning`, `source:'ai'`, `Local:true` — see "AI risk check
of the whole PR" in `.claude/docs/workflows-analysis.md`) is a full
`task_code_comment` Execution, so it can be resolved/deleted like any comment —
but a reviewer who agrees often wants their OWN, editable, non-local comment
instead of the AI's wording.

**Block-scoped (`convertWarningToComment`, `RelatedPanel.mjs`):**
`commentCommandsFor`'s menu gains **"Comment hiervan maken"** after
"Verwijder comment" (not the default), shown only when
`source === 'ai'` — which is also exactly when that menu has NO
"Resolve comment"/"Unresolve comment" item (`isAiComment`, see above), so
"Verwijder comment" is the default-selected item on such a finding and one
`Enter` deletes it outright, with no confirm step (deliberate). It opens the block's own composer (`newCommentComposer`)
prefilled with the finding's body and — load-bearing — anchored on the
**finding's own** `file`/`label`/`gran`/`rowStart`/`rowEnd`/`code`, not whatever
the live cursor sits on: a module-level `warningOverride` (`{original, target}`)
is set by `convertWarningToComment(c)` and consumed by `placeComment` (both the
composer header/`composeTargetHint` and the eventual `createComment` prefer it
over `commentTarget()`). Every ordinary composer-open entry point
(`toNew`/`startComment`/leaving via Escape) clears it first, so a stale override can't
leak into an unrelated comment. `isConvertingAiWarning()` (`!!warningOverride`)
is exactly what keeps `Enter`/the composer's "Plaats…" button routed through
the comment-kind menu here (`COMPOSE_COMMANDS`,
`.claude/docs/command-palette.md`) instead of posting straight away — the one
case that still gets that extra step, reviewer request: converting an AI
finding into a public comment deserves one more look, an ordinary new comment
does not (see "The compose (comment-kind) menu" there). The reviewer edits
freely, then picks "Plaats comment". **Only once the
replacement is confirmed placed** (`createComment` returns `res.ok`) does
`placeComment` delete the original via the same `delete` Signal
(`deleteComment(c)`, factored out to target a specific comment) — a failed
placement leaves the finding standing.

**PR-wide (`kind:'ai_warning'`, no anchor):** `prCommentCommandsFor` gets the
same item (again gated on `source === 'ai'`, after "Verwijder comment") wired to
`convertPrWideWarningToComment`, which repurposes the item's own "Beantwoorden"
field (`picm` gained a `mode`: `'reply'` default or `'convert'`) instead of
opening a second composer. `startPrCommentConvert` reveals that field prefilled;
sending in `'convert'` mode (`sendConvertedPrWideComment`) posts a **brand-new**,
unanchored PR-wide comment (`createComment({..., kind:'issue'})` — the same
`Kind` an imported general PR comment gets, so it shows as an ordinary navigable
"Start" row, not still badged as an AI finding) rather than a reply, then deletes
the original once placement is confirmed. `createComment`'s `kind` parameter is
what makes this possible; the backend's initial-post branch needed a matching
addition (a PR-wide comment posts as a new issue comment) — see
`.claude/docs/workflows-comments.md`.

**A line-anchored finding reaching the SAME sidebar menu still goes through
the block-scoped path above, not `convertPrWideWarningToComment`.** A
line-anchored finding (`!c.kind`, `commentBlockItem`'s `b.lineAnchored` — see
"Sort a line-anchored comment under the changed files" above) also gets its
own "Comments op regels" sidebar row, and selecting that row opens this exact
same menu (`b.kind === 'comment'` → `openMenu('prComment')` regardless of
`c.kind`) — but its OWN detail view still drills into the real block behind
it (`home.mjs`'s `DetailPanel` renders that block's ordinary
`Block()`/`InlineComments`, not `commentDetailCard`), so the block's own "+
Nieuwe comment" composer is already mounted right there. `prCommentCommandsFor`
therefore dispatches "Comment hiervan maken" itself, by `c.kind`: a genuinely
PR-wide `c` still calls `convertPrWideWarningToComment`; a line-anchored `c`
instead calls `convertWarningToComment` directly (the exact same function
`commentCommandsFor`'s own item above uses) — which keeps the full anchor
(`warningOverride`) instead of downgrading it into an unanchored `'issue'`
comment, and needs no change to `sendConvertedPrWideComment`/`picm` at all.

`placeComment` itself needed one more adjustment for this to actually place
anything: `state.selected` (`home.mjs`) stays on the comment-index item the
whole time — the underlying block is only ever reached via drilling behind
that sidebar row (see `.claude/docs/drilling.md`), never via an ordinary
selection change — so `state.blocks[state.selected]` (`placeComment`'s `b`)
is still the synthetic `kind:'comment'` item, not a real block, when "Plaats
comment" runs. `placeComment`'s own guard against exactly that shape
(`!b || b.kind === 'comment'`) therefore bailed here too, silently. The fix
carves out the one legitimate exception: a `warningOverride` already carries
its own complete, independent anchor (`file`/`label`/`gran`/`rowStart`/
`rowEnd`/`code`), so `b` isn't needed for anchoring in that case —
`placeComment` now only bails when there is NEITHER a real block NOR an
override (`if (!warningOverride && (!b || b.kind === 'comment')) return`).

**Don't reintroduce — this was a bug in TWO layers, and fixing only one still
leaves it broken:**
1. The menu item is offered for every `source === 'ai'` sidebar row
   regardless of `kind`, but it used to unconditionally call
   `convertPrWideWarningToComment`, whose guard requires `c.kind` (rejecting a
   line-anchored finding) — since a line-anchored finding has always reached
   this same menu (only `commentBlockItem`'s ranking, not its existence,
   changed in "Sort a line-anchored comment..." above), that guard silently
   no-opped "Comment hiervan maken" for it: filled reply field, menu, then
   nothing at all — no request, no error, and no visible field either (a
   `commentDetailCard`'s `comment-detail-reply`, which `startPrCommentConvert`
   targets, isn't even mounted for this drilled-block detail view).
2. Dispatching to `convertWarningToComment` alone (fixing only #1) opens the
   composer correctly — prefilled, focused, visibly on screen — but sending
   still silently did nothing: `placeComment`'s `!b || b.kind === 'comment'`
   guard bailed on the very same "`state.selected` is still the comment-index
   item" fact, with no error and no created/deleted comment either.
Both are fixed together. Test: `tests/convert-line-anchored-warning.spec.mjs`.

### Publishing a local thread to GitHub

A thread with no GitHub root of its own — a private note (e.g. the
auto-created Claude-chat anchor comment, `ensureClaudeAnchorForNew`, always
`local:true`), or an AI finding (always `Local:true`) — used to be a one-way
street: every
reply on it stayed local forever. Sending a reply on such a thread now **holds
the send and asks first**.

- **Gate:** `needsPublishChoice(c)` = `!c.githubId` and `c.source !== 'github'`
  (a github-sourced thread was written there in the first place). `c.githubId`
  is the ONLY state involved — the backend sets it the moment the thread lands
  on GitHub (see `.claude/docs/workflows-comments.md`), so "once it's a GitHub
  chat, the next messages go there too" needs no extra flag: the question simply
  stops being asked and every following reply mirrors through the existing path.
- **Both reply fields** route through it: `sendReaction` (`reaction-compose`,
  the block-scoped conversation) and `sendPrCommentReply` (`comment-detail-reply`
  on a comment-index item, `'reply'` mode only — `'convert'` is its own flow
  above). Each splits into a thin gate + a `postThreadReply`/`postPrCommentReply`
  write half, so the menu re-runs the very same send.
- **The held send** lives in a plain module-level `pendingPublish`
  (`{kind, commentId, body}`), read once by the menu via `pendingPublishInfo()`
  (which adds the thread's `source` and `localReplyCount(c)` for the labels) and
  consumed by `sendPendingReply(publish, withHistory)` before its first await.
- **The menu** is a command-palette mode `'replyPublish'`
  (`replyPublishCommandsFor`, `home.mjs` — see
  `.claude/docs/command-palette.md`): its own local-reply item has since been
  removed (same request as the compose menu's own removed local item), so
  "Alleen mijn antwoord op GitHub" is now the default; the two GitHub items
  grow a with/without-the-earlier-messages submenu only when there actually
  are earlier local replies.
- **`openPublishMenu` defers the open by one frame.** Both fields open it from
  their own `Enter` handler, and that keydown keeps bubbling to home.mjs's
  document-level handler; opening synchronously made that same keystroke
  immediately run the menu's default item, so the reviewer never saw the
  question. A frame later the keydown is over and the global handler has already
  seen a closed menu + a non-empty reply field (a no-op there).

**Without typing anything:** `Enter` on an EMPTY reply field already opens the
comment menu (`isCommentOrThreadFocused()` + `commentReplyEmpty()`), so moving an
existing local conversation over needs no new key or nav stop — it is just an
extra item there, **"Zet op GitHub"** (`publishThreadCommand`, in both
`commentCommandsFor` and `prCommentCommandsFor`, gated on the same
`needsPublishChoice`). Resolve stays the default, so it never fires on that
first keypress. It calls `publishThreadOnly(c, withHistory)` — the `publish`
Action of the same `reply` Signal, which stores no message — with a
with/without-the-earlier-messages submenu when, and only when, there are earlier
local replies.

**After it publishes, the keyboard leaves the thread** — reviewer request:
"na ai warning, zet op github, laat mij verder navigeren door code (volgens
mij doe je dat ook al voor andere keren dat we op github het gooien)",
confirmed to apply to every local thread's own "Zet op GitHub", not just an
AI finding. This **reverses an earlier, explicitly documented decision**
("publishThreadOnly never closes the thread") — `publishThreadCommand` now
takes a `doPublish(withHistory)` callback that wraps `publishThreadOnly` and
decides where to land next, since a block-scoped thread and a PR-wide
comment-index item have different rest positions:

- **Block-scoped** (`commentCommandsFor`) → `publishThreadAndSelectRow(c,
  withHistory)` (`home.mjs`) — same shape as `deleteCommentAndSelectRow`:
  snapshots `focusedBlock()` before the await (the reload inside
  `publishThreadOnly` can itself touch `cs.focus`/`cs.sel`), then resolves the
  thread's own anchor (`c.gran`/`c.rowStart`) to a `{gran, change}` unit on
  that block, sets it as the top-level or drilled cursor, and calls
  `leaveRelated()` + `scrollChangeIntoView()`.
- **PR-wide comment-index item** (`prCommentCommandsFor`) →
  `publishPrCommentAndExit(c, withHistory)` — there is no diff row to land on
  for such an item (same reasoning as `deletePrCommentItem`'s own doc
  comment), so it just calls `exitPrCommentThread()`, mirroring
  `postPrCommentReply`'s own optimistic exit.

RelatedPanel never imports from `home.mjs`, so the opener is handed down:
`setReplyPublishMenuOpener(() => openMenu('replyPublish'))`, called once at
`home.mjs` module scope — the same direction as `InlineComments`' existing
`openCommentMenu` parameter.

Accepted rough edge: the workflow records `github_id` asynchronously, so a reply
sent within the same second as the publish can still see `githubId === 0` and be
asked again. Choosing a GitHub option twice is harmless (the workflow ignores a
`Publish` once the thread has a root, so it degrades into an ordinary reply).

### The "+ Nieuwe comment" trigger row is gone

`newCommentComposer` used to render a permanently visible "+ Nieuwe comment"
button (`data-testid=new-comment`) plus its own `↑`/`↓` nav stop
(`cs.focus === 'trigger'`, `enterTrigger`/`isTriggerFocused`). Both are
**removed** — a comment can already be started from the palette's "Comment op
deze regel" (`startComment`), so a dedicated affordance + nav stop was
redundant. `newCommentComposer` now renders **nothing** while
`cs.focus !== 'new'` (still inside the same stable `<div class="contents">`
root); once opened (via `startComment`/the palette, or
`convertWarningToComment`) it renders exactly as before.

Consequence for the chain: `↑` on the first comment conversation and `↑` on
Onderliggende code's first child (when the unit has no comments) both simply exit
straight to the diff. `→` from the diff is unaffected.

### Drafts survive leaving mid-type

`composeDrafts`/`replyDrafts` (`RelatedPanel.mjs`). Both fields
(`comment-compose`/`reaction-compose`) are uncontrolled DOM elements, so closing
the composer/thread (e.g. `←` at caret position 0 — see
`editableCaretCanMoveLeft` in `.claude/docs/keyboard-navigation.md`) unmounts
the node and would lose the text.

`composeDrafts` is a `Map` keyed by the same anchor identity
`commentTarget()`/`commentPath` use (file + label + gran + row-range + seg, via
`draftKeyFor`); `replyDrafts` is keyed by the placed comment's own id. Both are
plain, non-reactive, session-only caches. An `@input` handler keeps the map in
sync per keystroke; `toNew`/`startComment`/`convertWarningToComment` (composer)
and `toComment` (reply field) restore via the existing `prefillField` helper as
soon as the field reopens on the SAME anchor.

**Deliberately not a reactive `.value="${...}"` binding** — no such binding
exists anywhere in this codebase (every text field is read/written imperatively),
and a reactive read of a plain `Map` registers no dependency anyway, so a
one-shot imperative set is simpler and can't have an unrelated rerender clobber
live typing/caret. A draft is deleted once consumed: on successful placement
(`placeComment`) or on send (`sendReaction`). There is no explicit "cancel and
discard" action any more (see "No more explicit Annuleer button" below) — an
abandoned draft (including one left via Escape) just stays for the session. Test:
`tests/comment-draft-persists.spec.mjs`.

### `Shift+Enter` newline + auto-grow height on every composer field

All four text-composing fields in this file (`comment-compose`,
`reaction-compose`, `comment-detail-reply`) plus the Claude chat composer
(`ClaudeChat.mjs`) behave identically: plain `Enter` sends/opens the follow-up
menu, `Shift+Enter` inserts a newline, and the field grows taller as it fills
up (capped, then scrolls internally) via the shared
`autoGrowTextarea`/`resetTextareaHeight` in `src/textareaAutoGrow.mjs`. Full
mechanism, including why `comment-compose` alone has no *local* `@keydown`
(that Enter/Shift+Enter split already lived in `home.mjs`'s document-level
`isComposeOpen()` handler): "Auto-grow composer textareas" in
`.claude/docs/claude-chat-panel.md`.

`reaction-compose` used to be a plain single-line `<input>` — converted to a
`<textarea rows="1">` for this, so its own `@keydown` now mirrors
`comment-detail-reply`'s (Enter sends via `sendReaction()`, Shift+Enter falls
through to the browser's own newline). Tests:
`tests/reaction-status-icon.spec.mjs` (reaction-compose),
`tests/comment-composer-typing-guard.spec.mjs` (comment-compose),
`tests/claude-chat-panel.spec.mjs` (the Claude composer).

### Keyboard: reachable only when the unit has a comment

`hasVisibleComments()` (exported, `visibleComments().length > 0`) gates every
entry:

- **`→` from the diff:** ≥1 comment → the **first** conversation
  (`enterCommentsHead()`, `cs.sel=0` + `toComment()`, which also focuses the
  reply field); no comment but an earlier Claude conversation on this unit → the
  **embedded Claude chat** (`enterClaudeChat()`, stop 5b); with neither →
  straight to the Onderliggende-code card (`enterRelated()`). Nothing creates a
  comment on the way — see `.claude/docs/claude-chat-panel.md`.
- **`↓`** on a conversation (`cs.focus==='comment'`) or at the bottom of an open
  thread (`cs.focus==='thread' && threadPos===0`) advances to the next
  conversation on the same unit; if there isn't one it **falls through** to
  `enterRelated()` instead of clamping (`advanceFromComment()`, internal to
  `RelatedPanel.mjs`).
- **`↑`** on a conversation (`cs.focus==='comment'`) steps into its own thread
  history FIRST, landing on the newest bubble (`cs.focus='thread'`,
  `threadPos=1` — a conversation always has at least its own opening message);
  `↑` there keeps walking older messages. Only once `↑` is pressed again at the
  OLDEST message (`threadPos===reactionCount()`) does it move to the
  **previous** conversation — or, on the very first conversation, exit
  straight to the diff (`exitRelated()`). This is a deliberate behaviour
  change (TODO 2 in `todo-claude-chat-blok.md`): `↑` used to mean "previous
  conversation" directly; `'thread'` is not reachable via `→` any more, so
  walking a conversation's own messages had to move onto `↑` instead. On the
  Onderliggende-code card's **first** child, `↑` steps back onto the **last**
  conversation if one exists (`enterCommentsTail()`, highlight-only — no
  reply-field focus steal, and no thread-walk either — landing on a
  conversation this way starts fresh), else also exits to the diff. **`←` on
  the Onderliggende-code card always exits straight to the diff, at ANY child
  position** — unconditionally `exitRelated()`, never `enterCommentsTail()`,
  even when the unit has visible comments (explicit request: `←` means "go to
  the code to the left", not "walk back through the previous stop") — mirrors
  `Escape`, which already skipped the comments detour here. `↑` on the first
  child is the one place that still detours through the last conversation, as
  above.
- **`→`** on a conversation (`cs.focus==='comment'` OR `'thread'`) steps
  straight into the embedded Claude conversation hanging off that same
  comment (`enterClaudeChat`, `cs.focus==='claude'`, stop 5b) — one press from
  either level, `'thread'` is never a stop in between. Its `←`
  (`toComment()`) comes straight back to `'comment'`, resetting `threadPos` to
  0 — so a fresh `↑` from there always restarts the walk at the newest
  message rather than continuing from wherever it was left.

### Deferred focus must never land after the keyboard moved on

`focusToken`/`releaseFocus` (`RelatedPanel.mjs`). Every landing helper that drops
the caret into a text field (`toNew`, `toComment`, `focusThread`) does so a frame
later via `focusEl`/`requestAnimationFrame` — the reactive re-render has to swap
the pane in first. So anything the reviewer does in between runs first; the
classic case is a click on a conversation (which focuses its reply field)
followed immediately by `←`: `exitRelated` blurs and hands the keyboard back, and
then the pending rAF pulled DOM focus back into the still-mounted textarea, after
which every key was swallowed by `isEditableFocused()`. Each transition therefore
bumps a module-level `focusToken`, and a deferred focus only lands while the
token still matches. Test: `tests/place-comment-return-focus.spec.mjs`.

**The flip side: that deferred focus waits across a few frames
(`FOCUS_FRAMES`, 10) instead of giving up after one**, because the element it
targets is mounted BY the very state change that requested the focus
(`reaction-compose` only renders inside `expandedConversation`, i.e. only once
`cs.focus === 'comment'` flipped). One frame is normally enough (arrow.js's
update is a microtask) but not guaranteed — a nested reactive slot can need
another pass. The old single attempt then dropped the focus silently and
permanently, worst on the refresh-restore path where `applyRelRestore` runs at
most once by design. The bounded retry re-checks `focusToken` before **every**
attempt, so it weakens nothing: it only means "wait for the render this
transition caused". `prefillField` does the same, so a missed prefill can't leave
the composer open but empty.

**The same `focusToken` also guards `createComment`'s own async tail** (the
`cs.sel = …` landing on the freshly-placed comment, once the POST + comments
reload settles) — `COMPOSE_COMMANDS`' `run()` is fired without being awaited
(`runCommand`), so the reviewer has the keyboard back well before that
round-trip settles and can open a different comment/composer/panel, possibly
on a different block — `cs` is a module-level singleton. `createComment`
snapshots `focusToken` before its `await` and only applies `cs.sel = …` if
it's still unchanged. Consequence: every function that sets
`cs.focus` directly — `enterRelated`, `toComment`,
`enterClaudeChat`, and the two direct branches in `applyRelRestore` — must
also call `releaseFocus()` (directly, or via `focusThread`/`toComment`, which
do it themselves), so a genuine navigation-away is visible to that guard.
`handleRelatedKey`'s 'comment'+ArrowUp branch (entering `'thread'`) and
`'thread'`+ArrowUp's fall-through to the previous conversation rely on this
the same way — they set `cs.focus`/`cs.threadPos` then call `focusThread()`/
`toComment()`, never bypassing it. Test: `tests/comment-nav-race.spec.mjs`.

`placeComment`/`postThreadReply`/`postPrCommentReply` themselves no longer
need this guard for their OWN exit — see the next section, "optimistic exit"
now happens synchronously, before the token could ever change.

### Placing a comment or sending a reply hands the keyboard back OPTIMISTICALLY — before the save is even confirmed

Explicit product decision (Reindert): "als ik een comment plaats, dan wil ik
naar de code diff — direct, al voordat het echt is opgeslagen", later
extended to cover a reply too, on both surfaces. Three write paths in
`RelatedPanel.mjs` all follow the same shape now:

- **`placeComment`** (called by `COMPOSE_COMMANDS`' "Plaats comment") calls
  `exitRelated()` **immediately** — before `createComment`'s POST + GET
  round-trip even starts, not after it succeeds. Focus returns to the diff of
  the block/column the comment was attached to (`commentTarget()` follows
  `focusedBlock()`, so also a drilled column). `home.mjs`'s `compose-post`
  `run` function then calls `scrollFocusIntoView()` to re-align `<main>`. So
  "type, Enter, Enter" leaves the reviewer ready to continue with
  `↑`/`↓`/`f`/`d`/`s` immediately. Test:
  `tests/place-comment-return-focus.spec.mjs`.
- **`postThreadReply`** (`sendReaction`'s write half, the block-scoped inline
  thread) now **also** closes the thread immediately on every reply —
  `exitRelated()` runs before the reply Signal even fires. This **reverses an
  earlier, deliberate choice** ("this thread stays open after a reply, the one
  place `cs.replySent`'s flash is actually visible") — explicitly confirmed to
  be overridden: a reply now behaves exactly like placing a brand-new comment.
  The `cs.replySent`/`cs.busy` flash still shows in the shared
  `comment-claude-footer` (`commentFooterText()` reads them independent of
  `cs.focus`), just not inside the (already-collapsed) thread card itself.
  Test: `tests/reaction-status-icon.spec.mjs`.
- **`postPrCommentReply`** (`sendPrCommentReply`'s write half, a comment-index
  "Start" row's own reply field) closes back to the item's **rest position**
  immediately — `cancelPrCommentReply()` (hides the field) +
  `exitPrCommentThread()` (releases `pct`). Not "back to a diff": a
  comment-index item structurally has none (see the guards under "Guards on
  paths that assume a real PR block" above) — the item itself stays selected,
  only the reply UI closes.

**Load-bearing `e.stopPropagation()` in the Enter handler of `reaction-compose`
and `comment-detail-reply`** (only when there's actually text to send — an
EMPTY field must keep bubbling, since that's what opens the
publish-choice/action menu): `sendReaction()`/`sendPrCommentReply()` now blur
the very field the keydown originated on, SYNCHRONOUSLY, as part of the same
call stack the local `@keydown` handler runs in (fired-and-forgotten, but the
synchronous portion up to the first `await` still runs before that handler
returns). Without `stopPropagation()`, the same still-bubbling keydown event
would reach `home.mjs`'s document-level handler AFTER the field was already
blurred, which would misread "was I just typing in a field?" as false and
reinterpret the same Enter as an unrelated action (e.g. opening the block's
own command palette) — the keydown analogue of the "nested `@click`: call
`stopPropagation()` FIRST" pitfall in `.claude/rules/arrowjs-pitfalls.md`. A
plain **click** on `reaction-send`/`comment-detail-send` needs no such guard —
a mouse click was never going to be reinterpreted by a keydown handler.

**A failed save must not vanish silently** now that the reviewer may already
be looking at something else by the time it resolves. `cs.sendFailed` (a
plain, session-only `{key: true}` map, reassigned wholesale like
`state.ignoredComments`) marks it — key `'reply:'+commentId` for a reply,
`'new:'+draftKey` (the same `draftKeyFor` identity `composeDrafts` uses) for a
not-yet-created comment — and `sendFailedBadge(key, label)` renders a small
text/glyph pill (`data-testid=comment-send-failed`, never colour-only, same
shape as `staleAnchorBadge`) wherever that draft resurfaces:
`compactConversation`/`expandedConversation` (block-scoped), `commentDetailCard`
(comment-index item), and `newCommentComposer` (a not-yet-placed comment, next
to its "Nieuwe comment · …" header). The typed text itself is never lost
either: `composeDrafts`/`replyDrafts` are unchanged (already only deleted on
success), and a new, exactly analogous `prReplyDrafts` map was added for
`comment-detail-reply` (which had no draft persistence at all before this).
`createComment` additionally wraps its own `fetch` in a `try/catch` (a network
throw used to propagate as an unhandled rejection with no boolean result at
all). Test: `tests/comment-send-failed-badge.spec.mjs`.

Placing a comment **never touches the approval of the unit it hangs on** — see
`.claude/docs/approval.md`.

**If a Claude message already lazily created this exact draft's backing
comment** (`ensureClaudeAnchorForNew`, see "Optimistically visible while
composing a brand-new comment" in `.claude/docs/claude-chat-panel.md`),
`placeComment` does not call `createComment` at all — it posts the typed text
as a **reply** on that already-existing thread instead (also optimistic-exit,
also `cs.sendFailed`-tracked under the same `'reply:'+commentId` key), so
exactly one comment ever exists for that draft.

### A selection that vanished while deep in the tree falls back to the first row, not an arbitrary one

Reviewer request: "als ik in een tree ben en ik ga naar blokken index, en ik
heb dan niks geselecteerd omdat er iets weg is (omdat ik aan het kijken was
dieper in de code, maar comment is goedgekeurd ofzo), dan wil ik niet niks
selecteren in de blokken index, selecteer dan de eerste in de blokken index".

`recomputeLeftList` (`home.mjs`) preserves the current selection across a
reindex by matching the previously-selected block/comment's stable **id**
(`selId`), the same "snapshot by identity, not index" reasoning as
`.claude/rules/conventions.md`'s own entry. That id can genuinely disappear —
most commonly a selected block-anchored comment being resolved while the
reviewer is drilled several levels deep into its own anchor (or into anything
else): a resolved block-anchored comment drops out of `indexComments()`
entirely (see that function's own doc comment, `RelatedPanel.mjs`), and the
comment poll (every 5s) can pick that change up on its own, with no reload.

The not-found fallback used to be `Math.min(state.selected, blocks.length -
1)` — the stale **raw index** clamped into the new, shorter list. That lands
on whatever now happens to sit at that position: an arbitrary leftover, often
scrolled out of view, which is exactly what read as "nothing selected" even
though some row was technically highlighted. Fixed to reset to the first row
(`state.selected = 0`) instead — mirroring `setSearch`'s own `state.selected =
0` after a filter change, the other place "the old selection no longer
applies" already resets to the top rather than clamping a stale index. Test:
`tests/selection-lost-falls-back-to-first.spec.mjs`.

### Read-only, not a rail: below 1920px, the unfocused half of `comment-claude-row` shrinks to 1/3 but keeps showing its content

Reviewer request, evolving twice: first "als ik in de selectie zit van een
comment, laat dan de claude chat vertical inklappen en andersom" (read at the
time as the project's existing "collapse to a rail" idiom, `collapsedColumnHTML`
in `home.mjs` — see `.claude/docs/drilling.md`), then a follow-up explicitly
REVERSING that idiom for this one pair: *"dat inklappen, wil je dat toch niet
zo doen? Ik wil het wel zien wat er is verteld, maar nog zonder input en
knoppen. en dan 1/3 vergeleken met de andere comment/chat in die blok (voor
laptop zoals het nu is)"*. **Do not re-introduce the rail for this pair** — the
unfocused half now stays fully visible (every message, scrollable) at 1/3 of
the row's width, with the focused half at 2/3; only its CONTROLS disappear.
This is a genuinely different idiom from the rail, not a variant of it.

**What "read-only" means exactly, per the reviewer's own two answers to the
open questions this raised:**

- **(a) Nothing in it is clickable, only reading.** Gone entirely: the reply/
  chat composer, "Stuur", the comment side's kebab menu
  (`reaction-status`)/Claude's own `claudeMenuButton`, Claude's
  `claude-question-option` choice buttons and `claude-retry` button, and the
  edit pencil (`reaction-edit`) on every bubble. Also inert: any in-body
  clickable thing INSIDE a message — a Markdown link, a mention, an image,
  a code-fence trigger (`pointer-events:none` on the message body's own
  `.innerHTML`-bound element, see reactionBubble/claudeBubble below). The
  read-only status/warning badges (`sourceBadge`/`aiWarningBadge`/
  `staleAnchorBadge`) stay, exactly as before — they were never interactive.
- **(b) Click anywhere + free scroll.** A click ANYWHERE on the read-only
  card hands the keyboard back (the one exception to "nothing clickable" —
  mirrors the click a rail used to offer). Scrolling the thread does NOT
  count as entering it and never steals focus — a reviewer can read older
  messages without switching columns. `←`/`→` stay the PRIMARY way to
  switch; a click is the secondary, mouse-only shortcut.

**Still gated on the exact same screen width as before**
(`state.commentClaudeNarrow`/`COMMENT_CLAUDE_WIDE_BREAKPOINT_PX = 1920`,
`home.mjs` — see that field's own doc comment for why it stays a
DELIBERATELY separate, wider cutoff than Tailwind's app-wide `narrow:`
1399px screen, which keeps governing everything else, e.g. diff-card
widths). At/above 1920px nothing shrinks or goes read-only at all — both
halves render at the same `COMMENT_CLAUDE_WIDE_SCALE` (see below), exactly
as before this whole feature existed ("voor laptop zoals het nu is" — the
reviewer's own framing: this behavior is scoped to the laptop case only).

**The predicates** (`RelatedPanel.mjs`) — same trigger condition as the
superseded rail cut, renamed to match what they now cause:

- `commentSideFocused()` — `cs.focus === 'comment' || 'thread' || 'new'`.
  `'new'` counts too: the still-open, not-yet-placed "Comment op deze regel"
  composer makes Claude read-only just like an existing thread would.
- `isClaudeChatFocused()` (pre-existing) — `cs.focus === 'claude'`.
- `claudeColumnReadOnly(state)` = `state.commentClaudeNarrow &&
  commentSideFocused()`; `commentColumnReadOnly(state)` =
  `state.commentClaudeNarrow && isClaudeChatFocused()`. Neither side ever
  goes read-only while `cs.focus` is `null` (nothing in this row focused,
  "zoals nu") nor on a wide screen.

**Width — the row's TOTAL stays exactly as wide as the rest state, and this
needed NO extra correction term (unlike the superseded rail cut).**
`columnPairScale(state, thisSideFocused, siblingFocused)` (`RelatedPanel.mjs`)
now returns `2/3` for the focused half, `1/3` for the read-only one, `1/2`
for both at rest, `COMMENT_CLAUDE_WIDE_SCALE` for both on a wide screen. Both
halves are STILL rendered through the SAME `relatedWidthCls()` clamp at
whatever scale — no fixed-width element (like the old rail) sits outside that
formula any more — and `relatedWidthCls(chars,a,d1) + relatedWidthCls(chars,b,d2)
=== relatedWidthCls(chars,a+b,d1+d2)` exactly, for ANY `a+b=1` (clamp scales
homogeneously and shifts additively, `relatedWidthCls`'s own doc comment).
Since `2/3+1/3=1`, just like `1/2+1/2=1` (rest), the SAME
connector-subtraction convention that already existed
(`COMMENT_CLAUDE_CONNECTOR_REM` always comes off the comment side's own
call, never Claude's) keeps the row's total pinned to
`relatedColumnWidthCls()` automatically for those two cases — verified both
algebraically and numerically (several `chars` values, both split
directions) with no rail correction term needed at all. **The wide-screen
case is the one deliberate exception**: each half's OWN scale is
`COMMENT_CLAUDE_WIDE_SCALE` regardless of the sibling (not summed against
it), so the row's total there is
`2 * COMMENT_CLAUDE_WIDE_SCALE * relatedColumnWidthCls()` — wider than
`relatedColumnWidthCls()` itself by design, ever since this pair started
doubling on a wide screen at all ("maak de chat blokken 2x zo breed").

**`COMMENT_CLAUDE_WIDE_SCALE`, the wide-screen scale, was lowered from `1` to
`0.75`** (reviewer report, 2026-08-22, screenshot: "voor een groot scherm heb
je nu een ander formaat chat, dat mag ~25% kleiner" — confirmed to mean
exactly this ≥1920px doubling, for both halves, with nothing changing below
the breakpoint). `0.75` is 25% less than the previous `1`, so each half is
now `1.5x` (not `2x`) the sub-breakpoint rest-state's `0.5` share — still
wider than the narrow-screen split, just less extreme than before.

**What happened to the rail machinery.** `src/collapsedRail.mjs`
(`railButtonHTML`) and `home.mjs`'s `collapsedColumnHTML` (the drilled/
top-level column's own non-focused rail) are **completely unchanged** —
that idiom is still exactly what it was, just no longer used for THIS pair.
Removed, because they only ever existed to compensate for a fixed-width rail
sitting outside the clamp formula: `RAIL_WIDTH_REM` and
`railReclaimSubtractRem` (`RelatedPanel.mjs`), plus the two
`railButtonHTML({...})` call sites in `ClaudeChatPanel`/`InlineComments` and
the `claudeColumnCollapsedToRail`/`commentColumnCollapsedToRail` predicates
(renamed to `claudeColumnReadOnly`/`commentColumnReadOnly`, same trigger
condition, different consequence).

**Rendering**: no more rail↔full toggle at the OUTER component level —
`ClaudeChatPanel`/`InlineComments` always render their full component now;
`InlineComments` is back to a thin pass-through (`syncComments` + delegate to
`inlineCommentsCardHTML`), since there is no longer a top-level shape to
toggle there at all. The read-only behavior instead lives in NESTED
`${() => ...}` toggles inside the components that were already there:

- **Comment side**: `expandedConversation(c, openCommentMenu, readOnly)` — a
  new `readOnly` param, threaded down from `commentCard` (which already
  decides "stay expanded while `cs.focus==='claude'` and this is Claude's own
  anchor" — that existing branch is EXACTLY when `readOnly` is now also
  true, gated additionally on `state.commentClaudeNarrow`). Drops its bottom
  composer row entirely (a nested `${() => readOnly ? '' : composerRow}`
  toggle, the documented safe pattern for a slot whose shape changes,
  `.claude/rules/arrowjs-pitfalls.md`) and its `@contextmenu`; the whole card
  gets a `@click` that hands focus back
  (`cc.commentId == null ? toNewFocus() : toComment()`) exactly when
  `readOnly`, a no-op otherwise. `reactionBubble`/`viewingBubble` grew the
  same `readOnly` param: drops the edit pencil and sets
  `style="pointer-events:none"` on the message body's own `.innerHTML`-bound
  div, so a link/mention/image/code-fence trigger inside it is inert — the
  click still reaches the CARD's own handler instead, because an ancestor
  hit-tests through an element with `pointer-events:none`.
- **Claude side**: `claudeChatColumn(view, callbacks, readOnly,
  onEnterReadOnly)` (`ClaudeChat.mjs`) mirrors this exactly — drops the
  composer row and `claudeMenuButton`, suppresses `@contextmenu`, adds the
  same whole-card `@click`, and `claudeBubble(..., readOnly)` drops
  `claude-question-option`/`claude-retry` and disables the message body's own
  pointer events. `onEnterReadOnly` is `ClaudeChatPanel`'s own
  `enterFromReadOnly` — `cs.focus === 'new' ? enterClaudeChatFromNew() :
  enterClaudeChat(state.pr)`, the same → hand-off the keyboard already uses.
- **The unanchored/PR-wide-comment variant** (`commentDetailCard`, used via
  `isPrCommentScope()`) gets the identical treatment through a new
  `opts.readOnly` — the SAME `commentColumnReadOnly(state)` value, passed
  only from `InlineComments`' merged call site (the sidebar's own unmerged
  use of this card, `home.mjs`, never passes it and is unaffected).

Every one of these read-only toggles rides inside an already-existing
(or newly matching) `.key(...)` that folds the read-only/interactive state
into its string — a composer appearing/disappearing is a real shape change,
so a keyed node must not silently be reused across that flip (the "keyed
node reused without re-running its bindings" pitfall,
`.claude/rules/arrowjs-pitfalls.md`).

Tests: `tests/comment-claude-column-widths.spec.mjs` covers the same three
widths as before (1690px — the reviewer's own MacBook viewport, 1919px,
1920px), now asserting the 1/3↔2/3 split and read-only content instead of a
rail. The specs that were adjusted for the rail in earlier commits
(`claude-chat-panel.spec.mjs` and its wide-viewport siblings,
`claude-chat-parallel.spec.mjs`, `command-menu.spec.mjs`,
`pr-comment-claude-chat.spec.mjs`) were only re-touched where they actually
broke, not preemptively — removing the rail means content is never fully
hidden behind it any more, so several of their "click the rail open first"
workarounds became unnecessary.
