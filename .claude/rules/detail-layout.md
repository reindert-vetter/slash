# Detail layout & related panel (placeholder)

To the right of the sidebar sits the `DetailPanel` (`home.mjs`): a `<main>` as a
**flex-row** that packs its columns **from the left** (`justify-start`, no
stretching) and scrolls horizontally (`overflow-x-auto no-scrollbar`) as soon as
together they're wider than the screen — the `no-scrollbar` utility (`index.html`)
hides the scrollbar chrome, the scrolling itself keeps working (both
programmatically and via trackpad/mouse). **The resting position is always
flush-left:** a `resetMainScroll()` helper (`home.mjs`, next to
`scrollFocusIntoView`) forcibly resets `<main>.scrollLeft` to `0` on every
transition *to* the resting position — `enterDiff`/`openTask` (list → diff,
`focusLevel===0 && drill.length===0`), `applyNextUnapproved` for an empty `path`
(no drill), and the two `←` paths in `onKeydown` that respectively pop
**fully** out of a drilled column back to `focusLevel===0` and that leave the
whole diff session (`state.mode='list'`). This covers a stray manual horizontal
scroll (trackpad/scrollbar-drag) that would otherwise keep hanging around until
the next drill-focus switch. **This deliberately does not fight back
during/after the drilling itself** — as long as `focusLevel > 0` remains (drilled,
even after a partial `←` pop) the existing, intentional scroll-to-the-right of
`scrollFocusIntoView` takes precedence (see "Unfocused columns collapse into a
narrow rail" further down): that deliberately lets earlier columns disappear
off-screen to the left, with the ‹ chevron hint. Regression test:
`tests/main-scroll-rest-left.spec.mjs`.

**PR-info column, stop 1 of the nav chain, hidden by default, physically to the
left of the pr-index** (`data-testid=pr-info-column`, `w-[39rem]` — 1.5x the
original `26rem`, widened so title/summary/description/Jira box truncate less
quickly —, rendered by `prInfoCard(state)` inside its own `PrInfoPanel(state)`
component in `home.mjs`). This column is the leftmost stop of the left→right
navigation chain described in `.claude/rules/keyboard-navigation.md`, and is also
**visually** the leftmost spot on the screen — not as the first child of `<main>`
(that was the case earlier, but then it only appeared *after* the pr-index
instead of before it), but as its **own `position:fixed` panel**, a sibling of
`<aside>` (the pr-index, `BlockList.mjs`) and `<main>`, mounted before both in
`home.mjs`. Reason: `<aside>` is itself `position:fixed` and thus sits
**outside** `<main>`'s flex-flow — to actually get the PR-info column visually
before it (instead of after, as a flex-child of `<main>` would do) it must sit
at the same level and take over the pr-index's fixed `left-6` spot, while the
pr-index itself shifts to the right.

`state.showDescription` (default `false`) determines whether the column exists
— closed, it takes up **no space** at all (the entire
`${() => state.showDescription ? html\`…\` : ''}` block drops away, as before).
Open (only possible in `state.mode==='list'`, see below) makes two things
happen at once, both driven by the same `state.showDescription` flag, so always
in lockstep:
- `PrInfoPanel` appears at `left-6` (the spot where `<aside>` normally sits).
- `<aside>` (the pr-index) shifts itself `40.5rem` to the right
  (`translate-x-[40.5rem]` instead of `translate-x-0`, in `BlockList.mjs`'s own
  class ternary — before the existing `mode==='diff'` check, which takes
  precedence: in diff mode the pr-index still shifts entirely away, regardless
  of `showDescription`). 40.5rem = the width of the PR-info column (39rem) plus
  the 1.5rem gap between them, so both columns sit snugly against each other —
  the same gap as between the pr-index and `<main>` normally.
- `<main>` (`DetailPanel`) in turn **also** shifts 40.5rem to the right
  (`left-[69.5rem]` instead of the usual `left-[29rem]`, in the same class
  ternary as the existing `mode==='diff' → left-6` branch), so the block column
  doesn't end up underneath the shifted pr-index. This is **decoupled from**
  `<aside>`'s own transition but uses the same 40.5rem distance, so both move
  in the same 200ms CSS transition in sync.

Reached from the pr-index (stop 2, `state.mode==='list'`) with `←`; `→` closes
it again. While it's open, `onKeydown` ignores `↑`/`↓` (no internal cursor).
Both this card and the pr-index `<aside>` show the **same** on/off indigo
focus border as the block-diff card while they hold the keyboard — see
"Focus highlight per stop" in `.claude/rules/keyboard-navigation.md` for the
full pattern. A white card with title + Jira badge, a meta line (author,
`+add −del`, file count, branch, "on GitHub ›"), a **Summary** section
(Claude text), a **Description** section (PR body + optionally a Jira box),
and review/CI pills at the bottom.
**Description truncation (`state.descriptionExpanded`, ephemeral):** a **long**
PR body (> `DESC_TRUNCATE_AT` = 280 characters) is truncated by default with a
clickable fade affordance at the bottom (`data-testid=pr-info-body-toggle`,
"more…") that expands the body fully; once open it becomes a plain "Collapse"
link. `DESC_TRUNCATE_AT` only gates whether that affordance **exists** at all
— a **short** body always renders in full (no misleading toggle). The
collapsed **height** itself, however, is deliberately **not** a fixed pixel
value (it used to be `max-h-40`, 160px) — `pr-info-body` becomes a
`flex flex-col` box that turns `flex-1` exactly while collapsing something
(long body, not expanded), so it fills whatever room is actually left in the
column above the status pills instead of a fixed cap that, on a typical PR
with a short title/meta/no Jira box, left a large unused gap there (the
reported bug). The wrap itself (`pr-info-body-wrap`) mirrors that
`flex-1`/natural-size split, with a `min-h-[4rem]` floor so an oversized Jira
description below it (`shrink-0`, unbounded) can never squeeze it away
entirely; its inner `.markdown-body` swaps `h-full overflow-hidden` for no
height constraint at all once expanded (the card itself scrolls then, as
before). **Deliberate choice:** this still needs no DOM measurement —
`DESC_TRUNCATE_AT`'s character count remains the sole, deterministic decision
for "does the affordance exist", while the browser's own flex layout (not a
`scrollHeight`/`ResizeObserver` read) decides how tall the collapsed box
actually is. Consequence: in the rare case where a body just over 280
characters happens to fully fit within the (now much roomier, layout-
dependent) collapsed height, the "meer…" toggle can still appear without
there being anything left to reveal — an edge case that already existed with
the old fixed 160px cap and isn't made worse by this change, deliberately
accepted over adding real overflow detection for a marginal gain. The same
flag is also toggled by the PR menu item **"Show full description" /
"Collapse description"** (`PR_COMMANDS`, `/` menu, see
`.claude/rules/keyboard-navigation.md`), so the in-card click and the menu
stay in lockstep. `state.descriptionExpanded` (default `false`) lives
**outside the URL** (ephemeral, just like `showDescription`). The class
strings of the body + toggle (and of `pr-info-body`/`pr-info-body-wrap`) are
**whole-value** function bindings (no partial interpolation — arrow.js
pitfall in `conventions.md`). Test: `tests/pr-description-expand.spec.mjs`
(also asserts the collapsed wrap's bounding-box height, as a regression
guard against reverting to a fixed pixel cap). The review/CI pills are
styled like the dark-zinc pills in
`overview.mjs` but in the light card theme (`bg-emerald-50`/`bg-rose-50`/
`bg-amber-50` instead of `bg-emerald-500/15` etc.). The card reads
**exclusively** `state.prMeta`/`state.pr`/`state.prUrl`/`state.jiraKey` —
never `b.code` — so it never becomes a co-subscriber with the diff render (see
the "stuck on loading" pitfall in `conventions.md`).
**Progressive loading:** `state.prMeta` (empty object at start) is
**wholesale reassigned** by `pollPRMeta` in `home.mjs` on every poll of
`GET /api/pr?pr=N` (every 1.5s, until the statuses are there or after a max of
20 polls) — the `pr_status` workflow fills the `prmeta` read-model in **3
stages** (basics → Claude `summary` → review/checks statuses), so each section
appears as soon as its stage is done (placeholder ("generating summary…", a
pulsing skeleton pill) until then). `loadPRMeta` fires the
`POST /api/workflows/pr_status` **fire-and-forget** (not awaited) and then
immediately starts the poll loop. The endpoint itself no longer blocks until
all 3 stages are done either: `ensurePRStatus` starts pr_status with
`StartWorkflowDeferLow`, so the POST returns as soon as **stage 1 (basics)** is
recorded and the `PriorityLow` `generatePRSummary` (+ the statuses after it)
drain in the background — the client polls for those anyway. See "Recovery
priority" in `.claude/rules/tembed-workflows.md`.
All of this loads/polls regardless of whether the column is currently visible
— `state.showDescription` only determines whether it's rendered, not whether
the data exists by the time you open it.

**PR-wide comments are no longer a separate card — they're navigable
"Start"-index items.** GitHub-imported issue/review(-summary) comments and
`code_warning` findings without a block anchor (`kind !== ''`) used to live in
their own `PrWideComments` card under `prInfoCard` in the `pr-info-column`;
that card and its own keyboard cursor (`pw`/`handlePrWideKey`/
`isPrWideFocused`) have been removed entirely. Instead, `home.mjs`'s
`recomputeLeftList` turns each one into a **synthetic `state.blocks` item**
(`commentBlockItem`, `kind:'comment'`, id `'comment:'+c.id`) that sits right
alongside the ordinary PR blocks in the sidebar (`BlockList.mjs`) — see
"Comment-index items" further below for the full mechanism (the 0/1 approval
mapping, the detail card that replaces a `Block` diff card in the column to
the right of the index, and the action menu). `prInfoCard` itself is
therefore the **only** card in the `pr-info-column` now and simply takes the
full column height (`flex-1`, no ratio logic against a second card).

Next comes the **block column** (`data-testid=block-column`,
**`shrink-0`** — not `flex-1`, so at its **natural diff width**
(`w-[70rem] 2xl:w-[82rem]` for a two-sided `modified` block; a **one-sided
added/removed block** shows only one pane (`singleSide` in `Block.mjs`) and
therefore gets **the same narrow 60% width** `w-[42rem] 2xl:w-[49.2rem]` as the
`a` toggle — one-sided is always narrow, regardless of `a`, since there's
nothing to show next to it) instead of filling the remaining space) with the
card of the selected block plus the look-ahead preview of the next block
(dashed connector if they come from the same file). **Directly next to** that
column (not at the right edge of the screen) the **Underlying code** card
(`RelatedPanel.mjs`'s default export, `data-testid=related-code`, `shrink-0`
with a **reactive, dynamically growing** width (`relatedColumnWidthCls`, see
the "Underlying code" section further down) — the **default/floor** is still
`w-[42rem] 2xl:w-[49.2rem]`, the same fixed width as a one-sided/`a`-narrowed
block (see above), so "Underlying code" is **always** as wide as the column
next to it for short code excerpts instead of narrower (was
`w-[34rem] 2xl:w-[41rem]`, deliberately half of one pane of the side-by-side
diff — that gave a one-sided/narrowed block two visibly unequal column widths
side by side, see the screenshot issue that led to this change); a genuinely
wide, non-wrapping code body in one of the visible children has since let the
column grow **beyond** that floor, with a ceiling that deliberately stays
**below** the full block column (`w-[56rem] 2xl:w-[65rem]`, instead of the
`w-[70rem] 2xl:w-[82rem]` of the block column itself — an earlier, equally
tall ceiling let this card take up half the screen width on one incidental
long line, which was reported as a bug) — that symmetry with the neighboring
column is thus deliberately **no longer guaranteed** once something wide
appears in it) — stop 5 of the nav chain, unchanged, inline in `<main>`'s
horizontally scrolling column flow (see "Underlying code" further down).
Comments and Tasks are **no longer** part of this column flow — see the
"Comments/tasks sidebar" section below.

## Comment-index items (PR-wide comments as navigable "Start" rows)

A PR-wide comment (`kind !== ''` — GitHub-imported issue/review(-summary)
comments, plus a `code_warning` finding that couldn't be pinned to a block,
`kind:'ai_warning'`) has no `file:line` to anchor it to a real block, so it
never shows in the block-scoped comments index (`RelatedPanel.mjs`'s
`recomputeView` still excludes `kind !== ''` there). Instead of its own card
(the removed `PrWideComments`), `home.mjs` turns each one into a **synthetic,
fully navigable item in the "Start" sidebar itself** — the reviewer selects it
with `↑`/`↓`/click exactly like an ordinary PR block, and the block column to
the right of the index shows its thread instead of a diff.

- **The synthetic item (`commentBlockItem`, `recomputeLeftList`,
  `home.mjs`):** `{ id: 'comment:'+c.id, kind: 'comment', label: <a short
  body snippet>, category: 'COMMENT', status: '', comment: c }` — `kind` is
  the marker every block-assuming code path guards on (see below); `id` is
  stable across a recompute so selection survives a reload of the comments
  list; `comment` carries the raw row back for the detail card/action menu.
  `BlockList.mjs` gets a matching `CATEGORY_STYLE.COMMENT` pill colour
  (`red`, not used by any real block category) and its own **"PR-comments"
  heading** (`commentHeading`, `data-testid=comment-heading`) above the first
  visible comment item — mirrors `underlyingHeading`'s role for relation
  children, same "own keyed item in one flat array" shape (no single↔array
  pitfall). `recomputeLeftList`'s `rank()` puts comment items **first**
  (rank `-1`, ahead of `ROUTE`) — they're PR-wide feedback that usually wants
  attention before diving into the tree. Comment items are synthesized fresh
  from `RelatedPanel.mjs`'s exported `prWideComments()` (the same `kind !==
  ''`-filtered, kilo-review-bot-excluded subset of `cs.list` the old card
  used) on every `recomputeLeftList()` call; a dedicated `watch(() =>
  prWideComments(), () => recomputeLeftList())` re-derives `state.blocks`
  whenever that list changes (initial load, a poll pickup, a resolve) — safe
  because `prWideComments()` only reads `cs.list` (no block's own `.code`),
  so it can't trigger the "stuck on loading" co-subscriber race (see
  conventions.md). `cs.list` itself keeps being loaded/polled by
  `syncComments`, called unconditionally by `InlineComments` (see "Inline
  comment blocks" below) — no separate fetch needed.
- **"Resolved == approved" (0/1 → 1/1), mapped into the EXISTING generic
  machinery — `isFullyApproved` (`BlockList.mjs`) itself is untouched.** A
  comment item has no changed rows to approve, so `blockApproveCount`
  (`home.mjs`) special-cases `b.kind === 'comment'` right at its top: `{done:
  resolved?1:0, total:1}` (`resolved` = `b.comment.status === 'resolved'`),
  and `subtreeApproveCount` short-circuits to that (no `nestedPrBlocks` call —
  a comment item has no relation children). Both are only ever called from
  the existing `approvalSummaries`/`approvalTotal` watch, which fills
  `state.approvalSummaries[b.id]` for **every** `state.blocks` entry
  (comment items included) — `isFullyApproved`/`approvalPill` then read that
  map exactly as they always did, no branch needed there. The practical
  effect: not-yet-resolved shows `0/1` inline in "Start"; once resolved it
  folds into the same "Toon N goedgekeurde blocks" section as any other
  fully-approved block (`renderList`'s existing `!state.showApproved &&
  isFullyApproved(...)` hide check, unchanged) and counts toward the PR-wide
  `X/Y goedgekeurd` header. This also makes `applyDefaultUnapprovedSelection`
  (a fresh, no-`?sel=` open lands on the first not-fully-approved item, see
  keyboard-navigation.md) work generically across comment items for free —
  the very reason the mapping was pushed down into `blockApproveCount`
  instead of a bespoke `isFullyApproved` branch.
- **Guards on every path that assumes a real PR block.** A comment item
  lives only in `state.blocks` (synthesized), never in `state.allBlocks`, so
  most code that iterates `allBlocks`/reads `b.code` is naturally unaffected
  (the "code not loaded yet" branch already present everywhere handles a
  permanently-codeless item for free — `blockRows`/`relatedChildren`/the
  footer/`callArrows` watches all already tolerate `b.code == null`). The
  handful of spots that needed an explicit `b.kind === 'comment'` early-exit:
  `enterDiff` (→/`f` on a comment item never enters diff mode — see below for
  what → does instead), `ensureCode` (no `/api/code` fetch — a comment item
  has no `.file`/`.label`), `sameFileNeighbour` (both sides guarded — two
  adjacent comment items would otherwise coincidentally match on
  `undefined === undefined`), `commentTarget`/`placeComment` (a comment item
  can't anchor a NEW line comment — both return/no-op rather than post one
  with `file:undefined`), and the `DetailPanel` `pair.forEach` render loop
  (see next bullet). `findNextUnapproved` needs no explicit guard: its
  forward-only walk starts at `state.selected + 1`, and since comment items
  always rank before every real block, a real block's own index is never
  followed by a comment item's — the "Continue to next unapproved"
  postApprove flow can therefore never land on one structurally.
- **`?sel=comment:<id>` — a comment selection survives a refresh too.** The
  `state.blockRef` mirror watch (`home.mjs`) mirrors a selected comment
  item's own stable `.id` (`comment:<id>`) instead of a `file:line` — the
  same `?sel=` param a real block already uses, just a different shape that
  never collides with `file:line` (a real file path never contains a bare
  `comment:` prefix). Restoring it back is more involved than an ordinary
  block: comment items are populated by `RelatedPanel`'s own comment poll
  (`syncComments`), independent of `loadBlocks`, so they may well not exist
  in `state.blocks` yet the one time `applyBlockRefRestore` itself runs.
  `applyCommentRefRestore` is therefore retried from the existing
  `watch(() => prWideComments(), …)` (see `recomputeLeftList` above) on
  every later comment-list update, until the target is found — or never is
  (a deleted/expired link), the same silent not-found fallback as a real
  block ref. Once found, it also forces `state.mode = 'list'` (a stray
  restored `?mode=diff` must not leave the app in diff mode with a comment
  selected — comment items have no diff) and reveals the selection if the
  comment happens to already be resolved (thus hidden by default, exactly
  like a fully-approved block — `revealSelectedIfHidden`, generic over
  `isFullyApproved`/`blockApproveCount`'s comment branch above). Test:
  `tests/comment-index-url-restore.spec.mjs`.
- **The detail card, in place of a `Block` diff card.** `DetailPanel`'s
  `pair.forEach` loop (`home.mjs`, the same loop that builds the selected +
  look-ahead-preview cards for the block column) branches at the very top on
  `b.kind === 'comment'`: instead of `ensureCode(b)` + `Block(b, {...})` it
  renders `commentDetailCard(b.comment, { preview })` (`RelatedPanel.mjs`,
  exported) — a read-only thread (status dot, kind badge, source/AI-warning
  badge, relative time, markdown body via the shared `commentBody`, then
  every reaction via the shared `threadMessages`/`reactionBubble`) wrapped in
  the same `data-testid=detail-card` stable-`contents` root as an ordinary
  card, keyed on `'detail:'+role+':comment:'+id+':'+status` (a resolve thus
  forces a fresh node, same rekey-on-status-change reasoning as the ordinary
  block-card key). `preview` (`i !== sel || !focusedHere`) dims the
  look-ahead card exactly like `Block()`'s own `preview` prop — **load-bearing
  distinction:** the reply-composer state `picm` (below) is a **single,
  module-level** reactive object shared by every `commentDetailCard` call, so
  it's scoped by `commentId`, not just a bare boolean — otherwise opening the
  reply field on the selected item would also reveal one on the (different!)
  preview card. The connector/step-chevron cue between two stacked cards
  (dashed line for same-file blocks) is skipped whenever either side is a
  comment item (no `.file` to compare). This card is the "blok rechts van de
  index" the reviewer asked for — reached purely by **selection**, no hover.
- **Enter opens a small action menu (`ms.mode = 'prComment'`,
  `prCommentCommandsFor`, `home.mjs`); → instead steps into the item's own
  thread (deliberately NOT the same action anymore — reversed on explicit
  request, so → on a comment item mirrors → on an ordinary block: it steps
  you "into" it rather than opening a menu).** `selectedComment()`
  (`curBlock().kind === 'comment' ? curBlock().comment : null`) gates a
  dedicated branch in `onKeydown`, checked **before** the generic
  block-palette Enter handling — a comment item has no diff, so Enter should
  never reach the block `COMMANDS`. Enter opens: **"Sluit menu"**
  (pinned, per the `withClose` convention) then **"Beantwoorden"** (the
  first real item, thus default-selected via `defaultSel`) then **"Resolve
  comment"** then **"Ignore"**. Because selection alone already shows the detail card/thread
  in the block column (previous bullet), "the menu appears with the thread
  above it" is simply a consequence of anchoring the menu there
  (`menuAnchor`/`menuRegion`'s new `ms.mode === 'prComment'` branches target
  `[data-testid=comment-detail-card]`, falling back to
  `[data-testid=block-column]`) rather than a distinct "with/without thread"
  menu variant. **→ (`enterPrCommentThread`, `RelatedPanel.mjs`)** steps the
  keyboard into the comment's own thread history instead — reusing the
  existing `threadMessages`/`reactionBubble` rendering that the block-scoped
  inline-comment thread (`cs.focus === 'thread'`, see the "Real comments"
  section further below) already uses for exactly this "walk the messages
  with ↑/↓" shape, rather than a second, parallel implementation. The
  cursor itself, however, is a **separate, ephemeral, non-URL-bound**
  reactive (`pct`, `{commentId, pos}` — `RelatedPanel.mjs`) instead of that
  same panel's own `cs.focus`/`cs.threadPos`: those are bound to the URL
  (`rel.foc`/`rel.thr`) for the block-scoped, diff-mode-only case, and
  reusing them here would restore a stray `'thread'` focus into list mode on
  every refresh, before any comment item is even selected. `isActive` is an
  optional override `reactionBubble` now accepts for exactly this reason —
  `commentDetailCard` passes `() => !preview && pct.commentId === c.id &&
  pct.pos === total - i` so the look-ahead preview card (which renders
  through the very same `commentDetailCard`, see the previous bullet) never
  also lights up. `↑` walks up the thread and clamps at the oldest message
  (no fall-through — mirrors the block-scoped case's own clamp there). `↓`
  walks down towards the newest message, but once already there
  (`pct.pos === 0`) it FALLS THROUGH instead of clamping:
  `handlePrCommentThreadKey` exits the thread itself and returns `false`,
  and `onKeydown` (`home.mjs`) falls into the ordinary `stepListSelection(1)`
  right after — advancing the sidebar cursor to the next comment/block, the
  same "↓ loopt door" convention the block-scoped panel's own
  `advanceFromComment` already applies (see "Inline comment blocks" further
  below) — a comment-index item has no Onderliggende-code panel of its own,
  so here it falls through straight to the next **index row** instead. `←`
  (`exitPrCommentThread`) steps back out to the index (the same row, not the
  next one); a `state.selected`
  change (a different row, or navigating away) also resets it, mirroring how
  the same watch already resets `picm`/`cancelPrCommentReply`. `Enter` keeps
  opening the menu regardless of whether the thread is currently focused.
  **"Beantwoorden"**
  (`startPrCommentReply(selectedComment())`) only reveals the reply textarea
  in the detail card (`picm.replying = true` + `picm.commentId = c.id`) and
  focuses it — the reviewer types and sends from there (`Enter` in the field,
  or the send button), never from the menu itself; this mirrors the
  "Beantwoorden pas zichtbaar na Enter op het item" requirement literally.
  **"Resolve comment"** (`resolvePrCommentItem`) sends the same "/resolve"
  sentinel + `done:true` reply Signal as the block-scoped
  `resolveFocusedComment` — local-only for a PR-wide thread, GitHub-resolved
  for a review-diff thread (unchanged backend behaviour, see
  `.claude/rules/tembed-workflows.md`). Both the reply and the resolve action
  go through the **existing** `POST /api/workflows/{runId}/signals/reply`
  Signal — no new write path.
  **"Ignore"** (`toggleIgnoreComment`, label a function that flips to "Ignore
  ongedaan maken" once already ignored — resolved once by `snapshotCommands`
  at open time, same pattern as the approve label) is a **separate,
  ephemeral, purely client-side** flag (`state.ignoredComments`, a plain
  `{blockId: true}` map, mirrors `state.showApproved`/`pinnedApprovedId`/
  `toggleFocused` — deliberately **not bound to a workflow/Signal**, unlike
  reply/resolve/delete: the ask was a sidebar grouping/toggle, not a
  persisted reviewer decision, so a refresh always starts with nothing
  ignored). It's independent of "resolved" — a comment can be ignored
  without being resolved and vice versa; being ignored **only affects
  sidebar visibility**, not the `blockApproveCount`/`isFullyApproved`
  approval mapping described above. `BlockList.mjs`'s `renderList` hides an
  ignored comment item by default (checked **before** the approved-hide
  check, so it stays hidden even if not resolved) and, once revealed via
  its own bottom toggle (`ignoreToggleRow`, `data-testid=toggle-ignored`,
  "Toon/Verberg N verborgen comments" — a SEPARATE toggle from
  `state.showApproved`'s "Toon N goedgekeurde blocks"), shows it under its
  own **"Verborgen comments"** heading (`hiddenCommentHeading`,
  `data-testid=hidden-comment-heading`) — distinct from the ordinary
  "PR-comments" heading above it, mirroring how `underlyingHeading` gets its
  own heading. `stepVisibleSelected` (`home.mjs`) skips a hidden-and-ignored
  row for `↑`/`↓`, same reasoning as it already does for a hidden approved
  block. `ignoreToggleRow` **is** a stop of the sidebar's `↑`/`↓` loop, just
  like `toggleRow` (`state.ignoreToggleFocused`, mirroring
  `state.toggleFocused`) — see "The sidebar's `↑`/`↓` cursor forms one
  circular loop" in `.claude/rules/keyboard-navigation.md` for the full
  mechanism (both toggle rows, plus the search box, chained into one loop).
- **Not part of the inline comment blocks** (see below) — those only ever
  show block-scoped comments (`kind === ''`) even before this change
  (`recomputeView`'s `!c.kind` filter); a comment-index item's thread lives
  exclusively in its own detail card now.

## Inline comment blocks

Block-scoped comment threads (`kind === ''`, the `task_code_comment`
workflow) are **no longer a fixed, Cmd+→-toggled sidebar with a browsable,
unscoped index** — they render as their own small stack of inline cards,
directly in `<main>`'s column flow, right above the Onderliggende-code card
of the currently focused column (top-level, or a drilled column — the same
`focusedBlock()` source the Underlying-code card already follows).
`RelatedPanel.mjs`'s exported `InlineComments(state, commentTarget,
openCompose)` renders exactly the same, already-scoped list `cs.view` always
was (`visibleComments()`/`commentUnder` — unchanged: scoped to the selected
block and, in the diff, to the exact unit under the cursor, call ⊂ line ⊂
group ⊂ block); the only thing that changed is that this scoped set now
renders **inline and always visible for the current unit** — "alleen en
direct zichtbaar als de bijbehorende groep/line/call geselecteerd is" —
instead of behind a separate toggle.

**`InlineComments`' own wrapper carries the SAME explicit width as
`related-code` right below it (`relatedColumnWidthCls()`, exported from
`RelatedPanel.mjs`, reused as-is — no separate calculation).** Without an
explicit width of its own, this section used to rely on "stretches to the
sibling's width" — which never actually held, since a flex-column's
cross-axis stretch only applies to a child whose own width is `auto`, and
`related-code` already sets an explicit width. Left unbounded, one unwrapped
long line inside a comment — `composeTargetHint`'s code excerpt, or a fenced
code block in a Markdown comment body (`commentBody`/`renderMarkdown`) —
forced this whole column, and thus `<main>`, to shrink-to-fit around that one
line instead of clipping/scrolling inside it (`overflow-auto`/
`.markdown-body pre {overflow-x:auto}` only actually clip once their
ancestor has a real, non-auto width to clip against) — which pushed the
block/drill columns to its left out of view ("comment section heel breed").
Giving it the identical clamp width as `related-code` fixes that and keeps
both stacked sections visually the same width.

**One card per conversation, only the focused one expands.** Multiple
threads can hang off the same unit; each gets its own card
(`data-testid=comment-item`), but only the one the keyboard currently owns
(`cs.sel` + `cs.focus` one of `'comment'`/`'thread'`) renders its full thread
(`expandedConversation`: a slim, right-aligned meta line (`comment-meta-line`
— source/AI-warning badge + the status mark, see below), `composeTargetHint`
if the comment carries a code snippet, every message via the unchanged
`threadMessages`/`reactionBubble`, and a working reply field) — every other
conversation on that same unit stays a compact one-line summary
(`compactConversation`: status mark, author + avatar, a truncated body
preview, `data-expanded=false` vs. `data-expanded=true` on the DOM node so a
test can assert which one is open). The toggle between the two lives in a
stable `<div class="contents">` root per card (`commentCard`) — not a bare
toggling expression — per the "bare toggling expression" pitfall in
`conventions.md`: the outer `.map()` key stays `'comment:' + c.id` regardless
of expand/collapse, only the nested `${() => …}` binding swaps.

**Status mark is a colorblind-friendly ✓, not a color-only dot — and a
resolved card is muted to the "Onderliggende code" style so it recedes.**
`commentStatusMark(c, extraCls)` (`RelatedPanel.mjs`) replaces the former
`CSTATUS_DOT` (`open` amber / `resolved` emerald circle, meaning carried
purely by color): it renders nothing for `open` (the neutral/default state —
"dots may go away" was explicit feedback from a colorblind reviewer) and a
plain `✓` glyph for `resolved`, the same bare-character convention as the
done/undone ✓ elsewhere (`BlockList.mjs`'s approval pills,
`translationDiff.mjs`'s per-key ✓) — the emerald tint on that glyph is
decoration on top of a shape that already carries the meaning, never the
sole carrier. Used, via a `${() => …}` function binding (never a static
interpolation — the "leaks the template function as text" pitfall in
`conventions.md`), in `compactConversation`/`expandedConversation` and in
`commentDetailCard` (the PR-wide comment-index detail card, see
"Comment-index items" below) — the same three spots `CSTATUS_DOT` used to
live. Once `c.status === 'resolved'`, the same three cards also swap their
background from `bg-white`/`bg-zinc-900` to the muted
`bg-slate-50/60 dark:bg-zinc-800/40` the Underlying-code card
(`relatedCard`) already uses for an unselected item — a resolved
conversation is done, so it should recede visually like already-reviewed
reference code instead of continuing to stand out as an active card; the
border stays the same neutral `border-slate-200 dark:border-zinc-800` in
both states (only `expandedConversation`'s indigo focus border is
untouched, since expanded always implies the keyboard is on it — that's an
orthogonal focus cue, not a status color).

**The button right of "Stuur" (`reaction-status`) is a send-status
indicator, not a resolve shortcut anymore.** It used to fire
`sendReaction(true)` directly (posting whatever was typed, or the `/resolve`
sentinel if empty) — that's gone; resolving a comment now happens
exclusively through the comment-scoped command menu's "Resolve comment"
item (`resolveFocusedComment`, always the fixed `/resolve` sentinel — see
"Enter — command palette" in `.claude/rules/keyboard-navigation.md`), which
this button now simply **opens** on click (`openCommentMenu`, threaded down
from `home.mjs`'s `openMenu('comment')` through
`InlineComments`/`commentCard`/`expandedConversation` — mirrors how the
composer's own "Plaats…" button already opens `openMenu('compose')` via a
click callback). This keeps resolve/delete reachable **with the mouse
alone**: before this change there was no click path into `openMenu('comment')`
at all (only the keydown `Enter` branch in `home.mjs`), so removing the old
direct-resolve click without adding this would have silently broken
mouse-only resolving. Deliberately more permissive than the keyboard
gate (`commentReplyEmpty()`) — a direct click always opens the menu,
regardless of whether the reply field is empty, since a click is an
unambiguous request (unlike `Enter`, which is overloaded with "send the
typed reply" when the field isn't empty).
`sendStatusIcon(status)` (`RelatedPanel.mjs`) renders the icon: a pencil
("draft" — covers both "nothing typed" and "typed but not sent", since only
3 states were asked for) by default, a spinning arc while `cs.busy`, and an
SVG circle-check briefly (`cs.replySent`, a 1.2s flash, mirrors
`overview.mjs`'s `ui.copiedFor`) right after a reply is actually sent — the
one send-status spot where "sent" is visible at all, since the composer and
the PR-wide reply (below) both close their input on success. **Deliberately
a different shape/rendering technique than `commentStatusMark`'s bare "✓"
text glyph above** — that glyph is a *persistent* property of the thread
itself (resolved or not); this is a *transient* status of the send control.
Both buttons (`reaction-send`/`reaction-status`) are also disabled while
`cs.busy` — via a plain, undecorated `disabled="${() => cs.busy}"` attribute
binding, **not** `?disabled=`/`.disabled=`, neither of which actually works
in this vendored arrow.js for a boolean attribute like `disabled` (see the
pitfall in `.claude/rules/conventions.md`). The composer's "Plaats…" button
and the PR-wide reply's "Stuur" button (`commentDetailCard`) get the same
icon treatment (draft/sending only — never "sent", for the reason above) as
long as that stays small; the PR-wide reply gets its own `picm.sending` flag
(it has no busy tracking of its own before this). Test:
`tests/reaction-status-icon.spec.mjs`.

**`expandedConversation` no longer has its own author+avatar header** — that
duplicated the opening bubble `threadMessages()` already renders (the
comment's own body as the first message, see `threadMessages`'s own doc
comment): expanded, a conversation showed "author + avatar" once in a header
row and again, directly below it, as the first chat bubble. Only the bits the
bubbles don't carry — the source/AI-warning badge and the status dot — remain,
now right-aligned in one slim `comment-meta-line` row instead of the previous
`justify-between` row (which, once its emptied-out left side/avatar was gone,
read as an almost-empty bar). `compactConversation`'s own one-line summary is
unaffected — it never shows the thread body, so it still needs its own
author+avatar line. The status dot (`CSTATUS_DOT`) stays color-only for now —
a separate, dedicated task will replace it (here and at its other two call
sites, `compactConversation`/`commentDetailCard`) with a colorblind-friendly
checkmark/glyph.

**`compactConversation`'s meta line also names who sent the LAST message,
not just the root author (`lastReplyNote`, next to `threadMessages`).**
Neither the author+avatar line nor the reaction count changes once someone
replies, so a collapsed thread with several reactions gave no clue whether
the reviewer's own reply is the newest one or someone else's — the reviewer
had to expand every thread to find out who's turn it is. `lastReplyNote(c)`
looks at the last entry of `threadMessages(c)` and appends
`" · <author> reageerde"` to the existing `comment-meta` text — empty as
long as there's nothing beyond the opening message (the author line already
covers that) and empty once the reviewer's OWN reply is the last one
(`author === 'reviewer'`, the current in-app-reply sentinel — see the
`github_id`/avatar datamodel note above). Plain text, not color, so it also
carries meaning for a colorblind reviewer — unlike the still-color-only
`CSTATUS_DOT` above.

**The expanded thread has no height cap/internal scroll of its own.**
`expandedConversation`'s message list (`data-testid=comment-thread`) grows
with the conversation instead of clipping it — an earlier `max-h-64
overflow-auto no-scrollbar` silently cut off the tail of a longer thread
behind a scrollbar hidden by `no-scrollbar` (`overflow-auto` + no visible
scrollbar chrome), which read as a cut-off conversation rather than "scroll
for more". `commentDetailCard`'s own thread (`comment-detail-thread`, the
PR-wide comment-index detail card, see "Comment-index items" below) is a
separate component and deliberately keeps its existing `max-h-[70vh]` —
that's already close to the full viewport height, so it wasn't the cause of
the reported clipping.

**Always-present "+ Nieuwe comment" trigger, deliberately OUTSIDE the
arrow-key traversal.** `newCommentComposer` renders a "+ Nieuwe comment"
button (`data-testid=new-comment`) for every unit, whether or not it already
has comments — a click (or `Enter`/the command palette's "Comment op deze
regel", `startComment`) opens the composer in that same slot
(`data-testid=comment-composer` while open). This is a deliberate,
self-contained design choice (not itself part of Reindert's ↓/→ rule): the
rule governs how the reviewer walks through *existing* conversations with
the keyboard, not where the "start a new one" affordance lives, so keeping
it always clickable/`Enter`-reachable doesn't contradict it.

**Keyboard: the comment block is only a REACHABLE stop in the ←/→ chain when
the unit actually has a comment; ↓ falls through instead of clamping.**
`hasVisibleComments()` (exported, `visibleComments().length > 0`) gates
every entry into it:

- `→` from the diff (`home.mjs`'s `onKeydown`, diff-mode `ArrowRight`): if
  the selected unit has ≥1 comment, lands on the **first** conversation
  (`enterCommentsHead()`, `cs.sel=0` + `toComment()`, which also focuses the
  reply field); otherwise it goes straight on to the Onderliggende-code card
  (`enterRelated()`), exactly as before this change.
- `↓` on a conversation (`cs.focus==='comment'`) or at the bottom of an open
  thread (`cs.focus==='thread' && threadPos===0`) advances to the **next**
  conversation on the same unit if there is one; if there isn't, it falls
  through to the Onderliggende-code card (`enterRelated()`) instead of
  clamping (`advanceFromComment()`, internal to `RelatedPanel.mjs`) — "↓
  loopt door naar het onderliggende-code-blok".
- `↑` on the **first** conversation exits to the diff; on the Onderliggende
  code card's **first** child, `↑` (and `←`, both mirror the same rule)
  steps back onto the **last** conversation of the unit if one exists
  (`enterCommentsTail()`, highlight-only — no reply-field focus-steal,
  mirroring every other "step back into a populated stop" landing), else
  straight to the diff.
- `→` on a conversation steps into its thread (`enterThread`, unchanged);
  `↑`/`↓` there walk the message history (`threadPos`, unchanged); `←` from
  the thread steps back **one stop** to the conversation level (not all the
  way to the diff) — mirrors the drill-hint chip path's "← climbs one level"
  precedent in this same file; `←` from the conversation level exits to the
  diff.

**A DEFERRED focus must never land after the keyboard has moved on
(`focusToken`/`releaseFocus` in `RelatedPanel.mjs`).** Every landing helper
that drops the caret into a text field (`toNew`, `toComment`, `focusThread`)
does so a frame later via `focusEl`/its own `requestAnimationFrame` — the
reactive re-render has to swap the matching pane in first. So anything the
reviewer does *in between* runs first, and the classic case is a click on a
comment conversation (which focuses its reply field) followed straight away
by `←`: `exitRelated` blurs and hands the keyboard back to the diff, and then
the pending rAF fired anyway and silently pulled DOM focus back into the
still-mounted textarea, after which every subsequent key press was swallowed
by `home.mjs`'s `isEditableFocused()` guard. Each of those transitions
therefore bumps a module-level `focusToken`, and a deferred focus only lands
while the token still matches the value captured when it was requested. Test:
`tests/place-comment-return-focus.spec.mjs`.

**A placed comment immediately gives the keyboard back to the code it's
attached to.** `placeComment` (`RelatedPanel.mjs`) — called by both
`COMPOSE_COMMANDS` items in `home.mjs` ("Place comment" and "Only for
myself") — after a successful `createComment` calls `exitRelated()`: keyboard
focus goes back to the diff of the block/column the comment was attached to
(`commentTarget()` follows `focusedBlock()`, so also a drilled column).
`home.mjs`'s `compose-post`/`compose-self` `run` functions then call
`scrollFocusIntoView()` to re-align `<main>` on that column. This lets the
reviewer continue with `↑`/`↓`/`f`/`d`/`s` through the diff right after
"type, Enter, Enter", without navigating back themselves. Test:
`tests/place-comment-return-focus.spec.mjs`.

## Tasks: a block under the PR-description column

Tasks (workflow runs of the current PR) used to live in the fixed
comments/tasks sidebar removed above; they now sit in a **shrink-0** block
(`TasksPanel(state, openTask)`, `<section data-testid=workflows-panel>`,
title **"Taken"**) stacked directly **below** `prInfoCard` inside
`PrInfoPanel`'s own fixed column (stop 1 of the nav chain — see
`.claude/rules/keyboard-navigation.md`) — only visible while
`state.showDescription` is true, exactly like the description card itself.
This is a plain sibling in that column's existing `flex-col gap-3`
container, so `prInfoCard`'s own `flex-1` simply shares the column's height
with this `shrink-0 max-h-[16rem]` block, the same stacking ratio the old
sidebar already used between its comments/tasks halves.

**Filtered to what actually needs attention — no more Active/Recent split.**
`visibleWorkflowRuns(state)` (exported from `RelatedPanel.mjs`) shows a run
only while it's genuinely **`running`**, or once it hasn't been updated in
over **5 minutes** (`TASK_STALE_MS`) — deliberately not `waiting` too:
several long-lived per-PR trackers (`build_relations`, `approve`,
`pr_status`) sit in `waiting` indefinitely once their initial run is done,
without being busy (see `.claude/rules/tembed-workflows.md`). Practical
effect: a run that just started (or just finished) stays out of view for a
few minutes — nothing to act on yet — and only resurfaces once it's either
actively running or has been sitting idle long enough to be worth a look
(e.g. a stuck/long-`waiting` tracker). Running-first, then most-recently-
updated. Test: `tests/workflows-panel-notes.spec.mjs`.

**Click-only — no keyboard cursor.** Stop 1 (the PR-description column)
already suppresses `↑`/`↓` (see the left→right nav chain in
`.claude/rules/keyboard-navigation.md`), so a Taken row (`workflowRow`) has
no focus ring/keyboard cursor of its own anymore — only a click on a
`comment`-bearing row calls `openTask(run)` (`home.mjs`), which looks up the
block by `comment.file`+`comment.label`, steps the diff to the stored
granularity/row range (`unitsFor`+`unitAtRow`, the same walk as `setGran`),
and selects the comment itself via `selectComment(runId)` (exported from
`RelatedPanel.mjs`) once the comment-scope watch has caught up (a couple of
`await Promise.resolve()` ticks — see the watch-timing note in
`conventions.md`). A run without a `comment` ref is purely informational.

Each row still shows, below the label + status badge, the same short
**description** (`data-testid=workflow-note`, gray, `line-clamp-2`,
`workflowNote` in `RelatedPanel.mjs`): for a `task_code_comment` run the rich
`class::method · line N · "snippet"` from the run's supplied `comment` ref
(`WorkflowRunView.comment`, see `.claude/rules/tembed-workflows.md`); for
every other type a short sentence explaining *why* the run is in that status
(`WORKFLOW_STATUS_NOTE`, a `${workflow}:${status}` map), with the bare status
as fallback. **The text must never suggest active work while the badge shows
"waiting"** — `build_relations` runs its build Activity once synchronously
at start and then waits indefinitely for a `rebuild` Signal, so `waiting`
there always means "already built, idle until the next rebuild", never
"busy"; `workflowNote` replaces the generic text for that combination with a
concrete summary of what has already been built (`buildRelationsSummary`,
read from `state.relations`/`state.callResolve`/`state.testCovers`).
Below the description sits a second, even smaller line
(`data-testid=workflow-updated`, `relTime(run.updatedAt)`) with a relative
time indication ("just now" / "4 min ago" / …). The row key encodes **runId
+ status** so a status change forces a fresh node instead of reusing a keyed
node without re-evaluating its static classes (the block-card-key
convention, see `conventions.md`); the empty state wraps in an array of one
(`.key('no-workflows')`), per the "no comments" pitfall in that same rule.

## Drilling: Underlying code as its own column (`state.drill`)

`Enter` on a **resolved** child in the Underlying-code card (a relation
child or a resolved method call — see `isCodeFocused`/`focusedRelatedChild`
in `RelatedPanel.mjs`) **or a mouse click on that child** (`@click` on
`data-testid=related-item`, via the `drill` callback that `home.mjs` passes
as an option to `RelatedPanel`) opens that child as a full-fledged diff
column to the right of the existing columns (between the diff and
`RelatedPanel`), instead of only showing the flat code excerpt. Click and
Enter both go through the same `drillIntoChild(child)`. `home.mjs` keeps a
**stack** for this, `state.drill`: every `drillIntoChild(child)` (called from
the `Enter` branch in `onKeydown` — Enter on a focused child drills,
unresolved calls search automatically without Enter — or from the click
callback) pushes one entry onto it **plus** a corresponding cursor entry onto
`state.drillCursor` (`{change:0}`), and sets `state.focusLevel` to that fresh
(deepest) level. Unlike before, nothing of this closes automatically anymore:
every drilled column stays open for as long as the diff session lasts (see
"Column navigation" below for how you leave it again).

A drill entry is **one of two forms**:
- **A real PR block** — if the child is already in `state.allBlocks` (a
  relation child, or the definition of a resolved method call that itself
  changes in this PR), then that existing block object is reused (no copy):
  it already carries `code`/`approvedRows`/etc., and
  `relatedChildren`/`resolvedCallChildren`/`callRows` work generically on any
  block id — so this child gets **out of the box** its own full, navigable
  Underlying-code panel (recursion works for free).
- **A synthetic frame** — a resolved method call to a file the PR doesn't
  change (no PR block, so nothing to reuse): a minimal object
  (`{ id, label, file, class, name, status:'unchanged', code:null,
  synthetic:true }` — `unchanged`, because the PR doesn't touch this file, so
  old === new and the diff is entirely equal; a `modified` badge would be
  misleading here, class/name split from `child.label` on `::`), for which
  `ensureCode` fetches the old/new source just like for any other block. This
  level shows **only** its diff — no Underlying-code card of its own (no
  caller scan is ever run for a synthetic frame). Since it has zero changed
  rows, its card also shows **no approve checkbox** at all (`Block.mjs`
  hides the checkbox entirely for `b.status === 'unchanged'` — there's
  nothing to approve, so a permanently empty, unclickable-in-any-meaningful-
  way toggle would only confuse).

**A drilled column survives a refresh** — `state.drill`/`drillCursor` do not
themselves live in the URL (too large/not directly serializable, the same
reason as `state.blocks`), but `home.mjs` mirrors them in three plain
URL-facing fields, exactly like `blockRef` mirrors `state.selected` (see the
URL-state section in `CLAUDE.md`): `state.drillRef` (each entry's stable
`.id` — a real block id, or a synthetic call frame's caller-scoped
`b.id + '::' + callKey` — joined with `>`, which occurs in no id) →
`?drill=`, and `state.drillGran`/`drillChange` (only of the **deepest,
focused** column — `state.drillCursor`'s last entry; every ancestor column
collapses to a rail anyway, so its own cursor is never visible) →
`?dgran=`/`?dchg=`. Restore follows the same
snapshot-before-the-clobbering-watch pattern as `blockRefPending`:
`drillRefPending` (the path, split on `>`) and `drillCursorPending`
(`{gran, change}`) are captured right after `bindUrlState`, and are only
applied by **`applyDrillRefRestore`** once `loadBlocks` has loaded the
blocks/relations **and** callresolve/testcovers (those latter two are
normally fire-and-forget — only if there's a `drillRef` to restore do we
still await them, so that a method-call/covers child is already findable via
`relatedChildren`). The walk traverses the path starting from `curBlock()`,
looking at each level for the child in `relatedChildren(parent)` whose
`(c.blockId || c.id)` matches, and reuses **`drillIntoChild`** itself (so
every side effect — `ensureCode`, `focusLevel`, scroll, the entrance
animation — is identical to a real Enter/click drill). Not found (deleted
relation, resolver rerun, expired link) → stops silently, just like
`applyBlockRefRestore`'s own not-found fallback: whatever has been drilled up
to that point stays as is. The deepest cursor is only applied once its rows
are actually known (`applyDrillCursorRestore`, with a `b.synthetic || b.code`
guard) — for a synthetic frame that's synchronous, for a real PR block only
once `ensureCode`'s `/api/code` fetch completes (the same "drilled column's
code arrived" branch that already existed, see below). Requires an active
diff session (`state.mode==='diff'`) — drilling has no meaning outside diff
mode. The same three fields also travel along in the `/pr-overview`
round-trip (`overviewExitUrl()`/`treeUrl()`, see "`?sel=` travels along…" in
`.claude/rules/pages-and-routing.md`), so `←` to the PR inbox and back via
"Open review tree" also lands in the same drilled column again.

## Column navigation: `state.focusLevel` (every drilled column is a full-fledged diff)

Unlike the earlier "always the deepest level" model, **every** column — the
original top-level block card and every drilled column — is a full-fledged,
navigable diff with its **own** change-group cursor. `state.focusLevel`
points to which column currently owns the arrow keys: `0` is the top-level
selected block (which keeps using `state.change`/`state.gran`, as always),
`1..state.drill.length` indexes `state.drill[level-1]` with its own cursor in
`state.drillCursor[level-1]` (`{change, gran}`, a mirror of
`state.change`/`state.gran`). A drilled column thus **does** zoom with
`f`/`d`/`s` (group → line → call, exactly the same `setGran` logic as the
top-level block, but as `setDrillGran(level, delta)` on its own
`drillCursor` entry). Unlike a same-file neighbor block at level 0
(`sameFileNeighbour`/`stepBlock`, only for the top-level cursor), a drilled
column has no "next block" to walk through — but it does have a **sibling**:
if `↓`/`f` (at `call`) goes past the **last** unit of the column (or `↑`/`d`
past the **first**), navigation steps **sideways** to the next/previous child
in the Underlying-code list of the **parent** column, instead of clamping —
this lets the reviewer walk through a block's entire underlying-code tree
top-to-bottom without having to press `←` every time to reach a next sibling.
This **replaces the drilled column at the same level**
(`drillToSibling`: pop the current `state.drill`/`drillCursor` entry, then
`drillIntoChild(sibling)`, which immediately puts a fresh entry back at the
same depth) — it never stacks deeper. `drillSiblingContext` determines the
parent (`curBlock()` at level 1, otherwise `state.drill[level-2]` — so it
works at any drill depth) and its sibling list: exactly
`relatedChildren(parent)` (the same list/order the panel shows if the parent
were focused), minus the non-drillable `tests_group` toggle bar; the current
column is found within it via `blockId`-or-`id` (the same pattern
`drillIntoChild` itself uses to resolve a descriptor to a real block or
synthetic frame). **No wrap-around**: on the last/first sibling, navigation
still simply clamps, as before. Sideways-forward (`↓`) lands on the new
column's **first** `group` unit (the normal `drillIntoChild` default);
sideways-back (`↑`) lands on its **last** `group` unit — mirroring the
existing `stepBlock` convention ("stepping up lands on the last change") —
best-effort synchronous: if the sibling's code hasn't loaded yet, it falls
back to the first unit instead of waiting (no `pendingLast`-like deferral,
deliberately kept simple). `dKey`'s `call`-level guard (`cur.change > 0`) is
extended with `hasPrevDrillSibling()` so `d` on the very first call segment
also already steps back to the previous sibling, mirroring the top-level
`dKey`'s `sameFileNeighbour(-1)` check. `fKey`/`dKey`/`sKey` in `home.mjs`
branch on `state.focusLevel`: `> 0` operates on the drillCursor entry of that
level (and thus, at the edges, the sibling walk above), `0` operates as
always on `state.gran`/`state.change`. See `tests/drill-sibling-walk.spec.mjs`.

**The `Enter` command-palette approve action follows that same `focusLevel`
pattern** (`approveContext()` in `home.mjs`): without that function,
"Approve …" would invisibly approve the TOP-LEVEL block/cursor while a
drilled column held the keyboard — the reviewer would see nothing happen in
the drilled column (the reported "I can't approve anything in underlying
code"). See the "Enter — command palette" section in
`.claude/rules/keyboard-navigation.md` and `tests/drill-approve.spec.mjs`.

- **Right after drilling, focus is on the diff of the new column** — not on
  its Underlying-code panel. `drillIntoChild` calls `leaveRelated()` (the
  exported `exitRelated` from `RelatedPanel.mjs`) for this instead of the
  earlier `enterRelated()`: the reviewer lands on the first change group of
  the new column and walks through it with `↑`/`↓`
  (`drillNextChange`/`drillPrevChange` in `home.mjs`).
- **The drilled column reuses exactly the same diff render as the top-level
  block card** — both call the same `Block(b, {...})` from `Block.mjs`
  (red/green, char diff, filler alignment are thus identical). What was
  missing was **scrolling to the active change**: on a large function the
  reviewer landed at the top of the function body, with the actual (correctly
  colored) diff hunk scrolled out of view — which looks like "no diff
  formatting" while the formatting is actually there, just not visible.
  `drillIntoChild` therefore also calls `scrollChangeIntoView(false)` after
  pushing the column (for the cached case — a synthetic frame or a child
  whose code was already loaded earlier for the Underlying-code panel);
  `ensureCode` does the same as soon as the code of a **not-previously-loaded**
  drilled/focused child arrives (mirroring the existing top-level branch:
  `state.drill[state.focusLevel - 1] === b`). See
  `.claude/rules/keyboard-navigation.md` for `scrollChangeIntoView`.
- **`←` closes the focused drilled column** and moves focus back to the diff
  of the **parent column** — the previous drilled column, or (from level 1)
  the original top-level block. The closed child then automatically
  reappears in the Underlying-code list of that parent column (that list is
  driven by `focusedBlock()` via the `setRelated` watch, so this restores
  itself without extra code once `focusLevel` drops). Repeated `←` thus peels
  back level by level until you're back on the top-level block.
- **Only once you're already at level `0` (the top-level block) does `←`
  close the entire diff session** — the existing diff→list transition
  (`state.mode='list'`) — and only then are `state.drill`/`state.drillCursor`
  also cleared: drilled columns only have meaning within *this* diff
  session.
- **Nothing else may flip `state.mode` to `'list'` while there's drilling.**
  `ensureCode`'s "block with no navigable changes → back to list" fallback
  (meant for a restored `?mode=diff` URL) is therefore gated to the resting
  position (`state.focusLevel === 0 && state.drill.length === 0`): after a
  postApprove "Continue" that selects a **new root** and drills into its
  child, the (deduped, still in-flight) code fetch of that root can only land
  *after* the drilling — if that root has 0 of its own groups (only its
  underlying code is reviewable), the ungated fallback flipped to list mode
  while the drill stack was still standing, causing `←` to miss the peel
  branch ("← goes to the block index"). Test: `tests/drill-mode-flip.spec.mjs`.
- **`→` still opens the Underlying-code panel** of the column that currently
  has focus (`enterRelated()`, unchanged) — that's still the only way to
  drill **deeper** (Enter/click on a child within it).
- From within the panel (`relatedActive()`), `←`/`Escape` at the first
  position gives focus back to the diff of **that same** column
  (`handleRelatedKey`'s `exitRelated`) — that no longer closes a column; the
  column-by-column navigation above is a separate step that only follows
  once `relatedActive()` is `false` again.

**No flicker on a gran/change step within a focused drilled column:**
the outer `${() => state.drill.map(...)}` binding that builds the columns
deliberately does **not** subscribe to `state.drillCursor` (only to
`state.codeVersion` and `state.focusLevel`, which flip a column's `.key(...)`
— see below). If that outer closure also read `drillCursor`, every
`f`/`d`/`s`/`↑`/`↓` step would rebuild **all** open drilled columns (every
`Block()` call again, so Prism highlighting again across every column) —
exactly the same pitfall as `canStep()` for the top-level card (see
`stepChevronSlot` in `home.mjs` and the conventions.md note about it). The
`state.drillCursor[i]` read that actually matters lives in the
`activeGroup`/`hintsEnabled`/`diffActive` functions passed to
`Block(b, {...})`: those are themselves already reactive arrow.js bindings
(they're only invoked from within `Block`'s own `${…}` slots), so they
re-evaluate on their own dependency without rebuilding the column — exactly
as `state.change`/`state.gran` already did for the top-level card.

**Small opening animation on an actual "open" of a column, never on
navigation within it (`drillOpenMarker` in `home.mjs` + `.drill-enter` in
`index.html`):** a fresh `drillIntoChild` call (a real drill, or
`drillToSibling`'s sibling replacement) sets a module-level, **non-reactive**
marker `drillOpenMarker = { level, id }`. The `state.drill.map(...)` render
reads it once per column and **consumes** it right away (`if (justOpened)
drillOpenMarker = null`) — before the class string for that column is built
(a plain, non-reactive string interpolation, **not** a `${() => …}` binding:
there's nothing here to track reactively, so the "whole-value-in-one-binding"
rule doesn't apply). Only on a match does the column wrapper get the class
`drill-enter` (a short fade+slide `@keyframes` in `index.html`, with a
`prefers-reduced-motion` guard). This **must never** become a
reactive/permanent class binding: the column `.key(...)` (see above,
`foc`/`unfoc` + `codeState`) also flips on a mere focus switch
(`←`/rail click) or as soon as code comes in — neither is an "open" in the
sense of `drill-enter`, so neither should replay this animation (see below
for the mirrored animation that a focus switch *does* get). The
consume-once pattern solves this:
- If a column's `.key(...)` stays the same across a navigation step
  (`f`/`d`/`s`/`↑`/`↓` within the same column, which only touches
  `drillCursor`, not the key) — then arrow.js reuses/patches the existing DOM
  node. The class string is a static value only set on node **creation**, so
  that node never gets a new animation trigger, regardless of whether
  `drill-enter` happens to still be in its classList (a CSS animation doesn't
  repeat by itself without `iteration-count:infinite`).
- If the key does flip (code arrives, foc/unfoc) — then the marker is already
  consumed (`null`) after the first render, so that fresh node gets no
  `drill-enter` class, and thus no replay.
Test: `tests/drill-open-animation.spec.mjs` (the class is present right after
drilling; an `ArrowDown` navigation step afterwards proves via an ad-hoc
marker attribute that the DOM node is **not** remounted).

**Mirrored return animation when leaving a drilled column
(`drillReturnMarker`/`markDrillReturn` in `home.mjs` + `.drill-return` in
`index.html`):** the exact mirror image of the opening animation above, for
the reverse direction — the column that **regains** keyboard focus once a
drilled column closes. Three call sites set the marker, each right after
lowering `state.focusLevel`:
- `onKeydown`'s `←` branch (peeling back one level),
- `expandColumn` (a click on a collapsed rail, can jump back multiple levels
  in one go),
- `applyNextUnapproved`, but **only** when the common-prefix trimming
  (`common`) already covers the full target
  (`common === target.path.length`, so no further `drillIntoChild` call
  follows) — **and** only as long as the root doesn't change (`sameRoot`):
  landing on a brand-new top-level block is a fresh selection, not a
  "return" to something already open.
`markDrillReturn(level)` itself determines which column that is (`{level,
id}`, `level 0` = the top-level block via `curBlock()`, otherwise
`state.drill[level - 1]`) and sets `drillReturnMarker`. Two render passes
consume it once each, exactly the `justOpened` pattern from above:
- The drilled-columns list (`state.drill.map(...)`): next to the existing
  `justOpened` check, a `justReturned` check on the same `{level, id}` shape;
  `drillColumnCls` gets `drill-enter` *or* `drill-return` (never both — the
  two markers are set by disjoint actions).
- The top-level block-column closure: here there was no stable wrapper root
  yet to attach a non-reactive, one-time class to (`Block(b, {...})` was
  pushed directly). `inner = Block(b, {...})` is therefore wrapped in a
  `<div class="contents ..." data-testid="detail-card">` — a static,
  non-reactive class string per `.map()` iteration, exactly the pattern of
  `drillColumnCls`/the "stable element root" pitfall in `conventions.md`
  (`display:contents` removes the wrapper from layout, so no `flex` gap
  artifact) — and the existing `.key(...)` moves from `Block(...)` to this
  wrapper (the key belongs on the outermost pushed item). `justReturned` is
  only checked for `i === sel` (only the selected card can ever be the
  level-0 return target, never the look-ahead preview card).
`.drill-return` (`index.html`) is the mirror image of `.drill-enter`: the
same fade + 180ms ease-out, but `translateX(-6px)→0` (sliding in from the
left) instead of from the right — so open/return feel visually different,
within the same `prefers-reduced-motion` guard. Test:
`tests/drill-return-animation.spec.mjs` (`←` peels back and animates the
top-level card; a rail click via `expandColumn` does the same; an
`ArrowDown` navigation step afterwards proves via the same node marker
attribute that the card is not remounted).

`focusedBlock()` (the Underlying-code panel + tasks/chat) now follows
`state.focusLevel` instead of always the deepest level: `state.focusLevel ===
0 ? curBlock() : state.drill[state.focusLevel - 1]`. Stepping a column back
with `←`, the panel thus moves along with it to that column. There is still
exactly one `RelatedPanel` instance (`cs`/`rc` remain singletons).

The column `.key` encodes (besides position in the stack + code status
`load`/`code`/`err`) also whether the column **currently has focus**
(`foc`/`unfoc`) — just like the existing `sel`/`prev` key on the top-level
card — so that a focus switch always forces a fresh card (fresh `${…}`
bindings) instead of arrow.js reusing the existing node (see the pitfall in
`.claude/rules/conventions.md`). A new column scrolls itself into view
(`scrollFocusIntoView`, `<main>` scrolls horizontally) — always aligned to
the **left** (`inline:'start'`, for a drilled column too, not just the
top-level card), so the columns you came from disappear off-screen to the
left instead of cramming the new column onto the right; the same function
also scrolls the now-focused column into view on the left when stepping back,
and when leaving the `RelatedPanel` back to the diff (`onKeydown`'s
`relatedActive()` branch in `home.mjs` calls it as soon as
`handleRelatedKey` has released panel focus) — panel navigation scrolls
`<main>` horizontally sideways (`scrollIntoView` in `toTask`/`toComment`
etc.), and without this re-alignment the diff card stayed cut off off-screen
to the left after `→…→` then `←…←`. Every **focused** drilled column
(`state.focusLevel > 0`) additionally shows a small gray **‹ chevron on its
left edge** (`data-testid=drill-left-hint`, outside the card, vertically
centered) as a visual hint that there are columns off-screen to the left —
purely a cue, no click action of its own (`←` does the actual stepping
back). The chevron is baked into the column `.key` via the existing
`foc`/`unfoc` component, so it appears/disappears along with a fresh card
instead of a reused node.

**The chevron itself sits outside the `drill-column` box (`absolute
-left-3`), so `scrollFocusIntoView`'s `scrollIntoView({inline:'start'})`
would, without a countermeasure, clip most of it off behind `<main>`'s own
left edge** — that aligns the **own box** of the focused `drill-column` div
flush against `<main>`'s inner edge, so anything 12px beyond that box falls
outside the visible (`overflow-x-auto`-clipped) scrollport.
`drillColumnCls` therefore carries a static `scroll-ml-4` (1rem/16px left
scroll margin) — a CSS property that `Element.scrollIntoView()` respects
(CSSOM View spec), so no change to `scrollFocusIntoView` itself is needed.
The margin is unconditional on this class (no `${() => …}` binding needed):
this div with testid `drill-column` only renders **at all** when the column
is focused (the non-focused branch returns a `drill-collapsed` rail early),
so the scroll margin is always relevant once this element exists — no
arrow.js pitfall, `drillColumnCls` was already a plain, non-reactive string
per `.map()` iteration (the same precedent as the `drill-enter` animation
class above). Test: `tests/drill-left-hint-visible.spec.mjs` — note: a bare
`getBoundingClientRect().left >= 0` check on the chevron would **not** catch
this, because that coordinate is relative to the entire browser viewport, and
even a chevron fully hidden behind `<main>`'s own clip edge still sits a few
pixels into positive territory (the `scroll-ml-4` reservation keeps it just
inside `<main>`'s own scrollport, regardless of whether `<main>` itself
starts at the viewport edge — `left-0` in diff mode — or further in — the
list-mode `left-[29rem]`): a coordinate check alone can't distinguish
"visible" from "clipped by an ancestor's `overflow`"; the test therefore
uses an `IntersectionObserver` ratio (which does account for that clipping).

**Look-ahead preview of the next sibling (`drillPreviewColumns`,
`data-testid=drill-preview-column`):** **below** the card of the focused
(always rightmost) drilled column — not next to it — shows a dimmed preview
card of the sibling `↓` would step to at the end
(`drillNextChange`→`drillToSibling`), before the reviewer actually navigates
there. Mirrors the top-level look-ahead preview of the next sidebar block:
only the **next** sibling (never the previous one), always visible as soon
as one exists (not only on the last change unit), connected with the same
vertical dotted `connector()` that top-level preview uses (no separate
horizontal variant — drilled columns stack their preview vertically, just
like the top-level `block-column`'s next-block card).
`resolveChildBlock` (extracted from `drillIntoChild`) resolves the sibling
descriptor to the same block-like object a real drill would push, so the
preview card shows identical, already-loaded code once promoted (via `↓`).
`drillPreviewColumns()` is called from a **nested**, array-returning
`${() => drillPreviewColumns()}` slot *inside* the focused column's own
per-item template (next to the real `Block(b, …)` card, in the same
`flex-col` wrapper) — not as a separate top-level item in
`state.drill.map(...)`'s array. That isolation is doubly load-bearing: (1)
`drillPreviewColumns()` only reads the cheap, **identity-guarded** field
`state.drillPreviewChild` — never directly `drillSiblingContext`/
`relatedChildren` (those read much broader state,
`b.approvedRows`/`state.callResolve`/`testCovers`/`relations`, and would, if
called directly within the columns closure, rebuild every open `Block()`
card on an unrelated approval/poll — the pitfall in `conventions.md`); that
calculation lives in the existing `setRelated` watch (which already runs
`relatedChildren()` anyway), and only writes to the field on a genuinely
different next-sibling id. (2) Because the slot is nested instead of a
top-level array item, a preview switch never forces a rebuild of the outer
`state.drill.map(...)` closure (and thus never of the real `Block(b)` card
above it) — an earlier version pushed the preview items as top-level array
items with a **constant** key, which did not reliably re-render on a
changing sibling target (the same "arrow.js reuses a keyed node without
re-running the bindings" pitfall, but this time colliding with an earlier
render of itself rather than a different role). Test:
`tests/drill-preview.spec.mjs`.

**Unfocused columns collapse into a narrow rail** — as soon as
`state.focusLevel` is on a drilled column (i.e. `state.drill.length > 0`),
every column that doesn't have that focus (the top-level block card when
`focusLevel > 0`, and every drilled column before the focused one — never
after, since `focusLevel` is always `state.drill.length`, so the focused
column is always the rightmost one) no longer makes sense at full diff
width: there's nothing to review in a column that doesn't own the arrow
keys, and the space can go to the column that does.
`collapsedColumnHTML(b, level, testid, drillIdx)` (`home.mjs`) then renders
that column as a narrow button (`w-14`, full height via `<main>`'s existing
flex-stretch, no separate CSS needed) with an arrow icon + a vertically
truncated label (the last `::` segment of `b.label`, i.e. the
method/class name) — style borrowed from `RelatedPanel.mjs`'s
`sidebarHintRail`. Testids: `data-testid=block-collapsed` (top-level) resp.
`data-testid=drill-collapsed` + `data-drill-idx` (drilled column, mirroring
the existing `drill-column`/`data-drill-idx`). Clicking calls
**`expandColumn(level)`**: functionally identical to pressing `←` repeatedly
until you're at that level — `state.drill`/`state.drillCursor` are truncated
to `level` and `state.focusLevel = level`, so anything drilled deeper than
the clicked level is discarded (deliberately the same semantics as the
existing `←` pop, not a "leave the child open but hide it" variant — that
would break this section's single-focus-owner model). Both render spots
branch on this with **ordinary JS ifs within their existing,
already-`focusLevel`-subscribed bindings** (the top-level `${() =>
{...}}` slot in `block-column`, and the per-item `.map()` callback in the
drilled-columns list) — no new nested reactive slot, so no new keyed-node
pitfall: the top-level slot still returns an array
(`[collapsedColumnHTML(...).key(...)]`, never a bare element — the
single↔array pitfall in `conventions.md`), and the drilled-columns list
rebuilds anyway on every `focusLevel` switch (the existing `foc`/`unfoc`
key), so the rail-vs-card choice there needs no own key trigger.
See `tests/drill-collapse.spec.mjs` (one and two levels deep).

The block-card `.key(...)` encodes **role** (`sel`/`prev`) **and** code
status (`load`/`code`/`err`), so arrow.js builds a **fresh** card as soon as
a block moves from preview→selected (↓/↑ on an already-previewed block) or
its code arrives. Without those two key components, arrow.js reuses the
keyed node (move+patch) *without* re-running the `${…}` bindings: the
`activeGroup` highlight + scroll then stayed frozen on the previous
selection, and the `null→loaded` diff render dropped out intermittently
(card stayed stuck on "loading"). The "code arrived" signal runs through
`state.codeVersion` (bumped in `ensureCode`), which **the DetailPanel
binding** subscribes to so it re-runs and flips the key (fresh diff
binding). The `setCommentScope`/`setRelated` watches still read
`curBlock().code` (needed to follow the cursor) — it's precisely their
co-subscription to `b.code` that's why the diff binding can miss the update,
so we rebuild via the key rather than adding yet another `b.code` reader.
See the arrow.js pitfalls in `.claude/rules/conventions.md`.

**An ordinary `state.change` step within the same block must not flip this
card key** (otherwise it would force a fresh `Block()` call — and thus a
visible flicker over the whole card — on every ↑/↓). The gray step chevron
(`stepChevronSlot`/`canStep`, further down) itself reads `state.change`, but
therefore lives in its **own** nested `${() => …}` slot instead of directly
in the outer array-building closure of `DetailPanel` — otherwise that read
leaks into the whole closure and every step rebuilds all `Block()` cards
with fresh `activeGroup`/`hintsEnabled`/etc. closures. See the related
arrow.js pitfall in `.claude/rules/conventions.md`. That nested slot also
sits in a **stable element root** (a `<div>` with a static `contents`
class) — not as a bare keyed `${…}` wrapper: that let the chunk `ref` go
stale as soon as the chevron toggled and corrupted the keyed reconcile of
the block column (the look-ahead preview disappeared and the tab froze on
repeated ↓/↑ through same-file blocks) — see the "bare toggling
expression" pitfall in `.claude/rules/conventions.md` and
`tests/step-preview-stability.spec.mjs`.

`RelatedPanel` is **purely a placeholder with dummy data** — no `/api`
coupling yet. Two side-by-side cards (Underlying code on the left, comment
block on the right — see the layout paragraph above):

- **Underlying code** (above, `data-testid=related-code`): the **child
  blocks** of the selected block — the blocks it's linked to (right now: the
  `Listener::handle` of an event it dispatches). Each as a small
  Prism-highlighted PHP excerpt (`data-testid=related-item`). A listener
  child carries a `listener` kind badge; a **method call** has no word badge
  but a **diff stat** (`data-testid=related-diffstat`): `+A −R` (green/red,
  the number of added/removed lines of the called definition, counted with
  `diffStat` in `Block.mjs`, git-`--stat` style), or a gray **`Unchanged`**
  badge if the call points to a file the PR doesn't change (no diff → `r.diff`
  is `null`). Such an unchanged child also gets a **gray** ring instead of
  the indigo ring when selected — there's nothing to review.
  Fed from the relations read-model via `GET /api/relations?pr=N`;
  `home.mjs` (`childrenOf`/`relatedChildren`) pulls the children from
  `state.allBlocks` and lazily loads their code. A **relation child** stays
  in the left list as a fully navigable row (own diff, selection, `?sel=`
  restore) but sorts to the very bottom, under an **"Onderliggende code"
  heading** (`data-testid=underlying-heading`, `BlockList.mjs`) — marked via
  `state.underlyingIds` (a plain `{blockId: true}` map, reassigned wholesale
  alongside `state.blocks`). The PR-wide approval header skips those
  underlying rows when summing `state.approvalTotal` (they're already
  counted inside their parent's subtree). `recomputeLeftList` in `home.mjs`
  determines the left list: `state.blocks` = `allBlocks` minus any **PR
  block that is the definition of a resolved/found method call**
  (`resolvedCallTargetIds`, including a relation child that is also such a
  target) — so a function that appears as "Underlying code" under a parent
  (e.g. `ProcessCartAction::buildShippingAddressAttributes` called on a
  changed line) doesn't *also* show up separately in the left list. It runs on
  `loadBlocks` and again after every `loadCallResolve` (initial + the poll
  after a search action), and preserves selection by **block id** so a
  callResolve reload doesn't shift the cursor.
  See `.claude/rules/tembed-workflows.md` (section "Relations between
  blocks").
  **"loading code…" vs. "no code found":** every child descriptor carries a
  `loading` flag (set in `home.mjs`, i.e. in the `setRelated` watch chain —
  never by `RelatedPanel` itself reading `b.code`): for a **lazy** PR-block
  child (relation child/`covered_by`) that's `!kid.code` — `ensureCode`
  always sets `kid.code` to an object as soon as the `/api/code` fetch
  completes, even on an error (`{error}`) — for an **embedded**-code child
  (`method_call`/`covers`, code sits synchronously in the
  callresolve/testcovers row) hard `false`. `relatedCard` renders three-way
  based on that: code → excerpt; empty + `loading` → "loading code…"; empty +
  not loading (a completed load that turned out empty/error, or an empty
  embedded `childCode`) → the end state **"no code found"**
  (`data-testid=related-empty`, same gray style). The item key encodes that
  state too (`related:<id>:code|load|empty`) — the block-card precedent from
  `conventions.md`, otherwise the loading→code/empty transition can freeze
  on a reused keyed node. Regression test:
  `tests/related-empty-code.spec.mjs` (PR 96, embedded empty; PR 90, lazy
  load that completes empty).
  The card is a **navigable list**: `→` from the diff (or `↓` falling
  through the last inline comment conversation, see "Inline comment blocks"
  above) selects the **first** item (`cs.codeSel=0`); `↓`/`↑` then move
  through the items (clamps at last — `↑` on the first item steps back onto
  the last inline comment conversation if the unit has one, else out to the
  diff, see `hasVisibleComments`/`enterCommentsTail`), `←` steps from any
  item back the same way (see `.claude/rules/keyboard-navigation.md`). The
  selected item gets an indigo ring (`data-active=true`). All items stack
  **vertically** at full width.
  The card has **no fixed height cap**: it grows with its content up to the
  full available height of the block column and then scrolls internally
  (`min-h-0`, body `flex-1 overflow-auto`). The code excerpts **wrap** (no
  horizontal scroll: `whitespace-pre-wrap break-words`) — but the
  **column** itself has since grown along whenever that wrapping would
  otherwise turn out ugly for a genuinely wide code body:
  `relatedColumnWidthCls` (`RelatedPanel.mjs`) makes the width of the
  **entire** Underlying-code column (not per card) a reactive `${() =>
  …}` class binding on the `<section data-testid=related-code>` instead of
  the previous static `w-[42rem] 2xl:w-[49.2rem]` string: it takes a
  **representative non-comment** code line across all currently shown
  top-level cards (`rc.children`, excluding the `tests_group` bar — nested
  chips and the drill-preview column remain unaffected on their own fixed
  `w-72`) and turns that character count into a CSS
  `clamp(min, calc(Nch + 2rem), max)` width: the `ch` unit is the exact
  glyph width of a monospace character, so this is **purely a calculation
  on an already-known character count** — no live DOM measurement
  (`scrollWidth`/`getBoundingClientRect`) that could race with a
  render/layout pass. `min` is the existing default floor
  (`42rem`/`49.2rem`), `max` is a ceiling that deliberately stays **below**
  the full block column (`56rem`/`65rem`, instead of its
  `70rem`/`82rem` — a long single word/line otherwise let it grow to "half
  the screen width", which was reported as a bug) — `clamp()` catches
  both "no code" and "everything is shorter than the floor" for free (the
  `calc()` outcome then simply falls below the floor). **Comment lines
  deliberately don't count** (`codeGrowthChars`, a regex/state-machine scan
  that skips a leading PHPDoc block, `//`/`#` lines and intervening `*`
  continuation lines), and **it's not the longest line that counts, but the
  75th percentile** of the remaining line lengths (nearest-rank): a single
  extremely long outlier line (e.g. one long `Cache::remember(...)` call in
  an otherwise normal method) must not single-handedly push the column to
  the ceiling — that line just wraps then
  (`whitespace-pre-wrap break-words`, see above). The plain median turned
  out too aggressive the other way in practice: in a method of only 3-4
  real content lines, the loose `{`/`}` lines pull the median down to
  almost 0, even if the method itself is quite wide. The 75th percentile is
  the middle ground: it still reflects the wider half of a method's actual
  content, without being held hostage by the one longest line. A long,
  prose-like comment line wraps neatly and must never widen the column,
  only real code lines (long method chains, wide return types, …) do that.
  Only reacts to `rc.children` — the same plain snapshot `kids()` already
  reads — so this introduces no new co-subscription on the selected
  block's own `b.code` (see the stuck-on-loading pitfall in
  `conventions.md`). The symmetry with the neighboring column (see above)
  thus only holds as a **default** now, not as a guarantee. Test:
  `tests/related-code-grow.spec.mjs`.
  Any child that is itself a PR block (relation child or a method call
  whose definition changes in the PR) carries an **approval badge**
  (`data-testid=related-approval`, `done/total`, green + ✓ when fully
  approved), and the card header shows a **rollup** over the shown children
  (`data-testid=related-approval-total`, "… · X/Y approved"). A call to an
  unchanged file has no approval concept and thus no badge. The counts come
  along in the child descriptor (`approve`, filled by
  `relatedChildren`/`resolvedCallChildren` in `home.mjs` via
  `blockApproveCount`); the same rollup appears as a combined pill on the
  sidebar row — see the combined-approval explanation in
  `.claude/rules/blocks-and-ingest.md`.
  **Drill hint chips (dash to the right, recursive mini-tree growing
  RIGHTWARD):** any child whose block **itself** still has changed
  underlying code shows a short **dotted dash** to the right of its card
  toward a chip column (`data-testid=related-nested`, `w-72` — doubled from
  the original `w-36` so longer `class::method` labels fit better): one chip
  per changed (grand)child (`data-testid=related-nested-chip`) with the
  **full `class::method` label** — **wraps, is never truncated**
  (`whitespace-normal break-words`, no `truncate`; bare name if there's no
  class — the shared `blockLabel` helper in `Block.mjs`, "class::method
  everywhere"), its own **diff stat `+A −B`** (green/red, `data-testid=
  related-nested-diffstat`, `diffStat` over the lazily-`ensureCode`d kid; a
  gray **`…`** placeholder while that code is still loading — never
  "Unchanged", every chip target is by definition a changed PR block) and
  the **approval `done/total`** (`data-testid=related-nested-approval`,
  `blockApproveCount` of the block itself — deliberately not subtree;
  ✓ prefix when fully approved; hidden when `total 0`). No file line in the
  chip (the full `label · file` sits in `title`).
  **Recursive, and RIGHTWARD (not indented below):** each chip is a flex
  row (`nestedChip`, `RelatedPanel.mjs`) — the chip button itself, followed
  by, if the child itself has further changed children, its **own** chip
  column next to it via `nestedChipColumn` — the same function that renders
  the top-level column next to the card, now the **only** recursive
  building block at any depth (there's no separate "indented-below"
  `nestedSubChips` anymore). The depth cap of **2 chip levels** below the
  card remains (`NESTED_DEPTH`, `home.mjs` — every level multiplies
  `ensureCode` fetches, and looking deeper is what drilling is for); per
  level capped at **3 chips + "+N more"** (`data-testid=related-nested-more`,
  never reachable via keyboard — see below), cycle-safe via a shared `seen`
  set (the `nestedPrBlocks` pattern). Because each row can now be wider than
  its own `w-72` column (card-wide row contains a column per depth), the
  card's existing `overflow-auto` body also scrolls **horizontally** when
  needed — no separate CSS change, just a consequence of the
  rightward-growing layout. The data comes from
  `nestedChangedKids(prBlock, parentId, seen, depth)` in `home.mjs` (plain
  descriptors on `r.nested` + a recursive key signature `r.nestedSig` via
  `nestedSigOf`, built in the same descriptor builders/`setRelated` watch as
  the rest — never in a render binding, so no `b.code` race):
  `directChildBlocks` by definition only yields **PR blocks**, so an
  `Unchanged`/synthetic call target never gets a chip (a call child without
  a `prBlock` explicitly gets `nested: []`). Chips ride along on the
  descriptor, so they appear at every granularity where the child itself is
  visible (also `line`/`call`). A **click on a chip at depth d drills d+1
  levels at once** (the card child, then every ancestor chip, then the chip
  itself — sequential `drillIntoChild` steps via the same `drill` callback,
  with `stopPropagation` so the card click doesn't also drill one level
  beyond); `Enter` on the card remains the normal single-level drill.

  **Keyboard through the chip tree (`cs.chipPath`, `RelatedPanel.mjs`):** a
  second, nested cursor next to `cs.codeSel` — empty (`[]`) means the
  keyboard is on the card itself, `[i]` the i-th top-level chip, `[i,j]` its
  j-th subchip, and so on (one index per depth, mirroring the recursive
  `nested` shape of the data). Only meaningful within `cs.focus==='code'`
  (`handleRelatedKey`), spatially consistent with the rightward-growing
  chips: **`→`** descends into whatever's currently focused (card or chip)
  toward its own first nested chip (no-op without nested); **`←`** climbs
  one level back (only when `chipPath` is empty does it fall through to the
  existing "leave the panel" behavior — this is a **deliberate behavior
  change**: `←` used to *always* close the panel, regardless of chip
  focus); **`↓`/`↑`** walk through the **siblings at the current depth**
  (`chipListAt`, clamped at start/end — no flow into another level) as
  long as `chipPath` isn't empty, otherwise the existing `cs.codeSel`
  behavior over the cards; **`Enter`** drills the whole chain via
  `focusedChipChain()` (ancestors + focused chip, mirroring the click
  handler). `chipPath` resets to `[]` as soon as `codeSel` changes and on
  every `setRelated` push (the tree can rebuild, so an old depth index
  isn't trustworthy). The focus ring (`data-active` on the chip) is
  **also** scoped on `cs.codeSel` — not only on `chipPath` — because two
  different cards can happen to have the same chip tree shape (and thus the
  same path); without that extra check the "focused" chip would light up on
  **every** card with that shape at the same time (regression test: the
  last test in `tests/related-nested-chip.spec.mjs` drills three levels
  deep and verifies at each step that only the card at `codeSel` shows an
  active ring).

  arrow.js details: the card root of `relatedCard` is a flex row (card
  `min-w-0 flex-1`); the approval count is a **precomputed string**
  (`approveText`) in an always-present element, and every conditional
  sub-template (chip column, diff stat) runs through a **`${() => …}`
  function binding** — never a static template↔string ternary, which
  leaked arrow's template function (`i=>je(n,i)`) as text on chunk reuse,
  see the "static template↔string slot" pitfall in
  `.claude/rules/conventions.md`. The card `.key` in `fullCard` carries
  `r.nestedSig` so every tree change (set/approval/diff loaded) builds a
  fresh node; chip keys are the **id path** (the same id can hang under two
  parents). `data-child-id` stays on the innermost card, so the call-arrow
  overlay (which targets the **left** edge of the card) isn't affected by
  the chips on the right. The `tests_group` bar (see below) gets no chips.
  The collapsed column rails (`collapsedColumnHTML`, `home.mjs`) show, since
  this change, also the full `class::method` label via the same
  `blockLabel` helper. See `tests/related-nested-chip.spec.mjs`.
  Next to the listener children, the same card also shows the **method
  calls** the block makes, linked to their **definition** — even from
  unchanged files (`kind=method_call`, from `GET /api/callresolve`, code +
  descriptor sit in the row, so no extra code fetch). Only calls on
  **lines the PR changed** get such a row (the resolver only scans the
  changed lines, see `.claude/rules/tembed-workflows.md`); **enum cases**
  (`AddressType::BILLING`) also resolve — to their enum declaration.
  A **third** child source links a PHPUnit test to the method it tests, in
  **both directions**: `kind=covers` (a test block shows the tested method
  — diff stat/`Unchanged` badge just like `method_call`) and
  `kind=covered_by` (a tested production method shows "covered by
  TestX::testY" — the test itself, reused as an existing PR block). From
  `GET /api/testcovers`; both are **block-level** (like the listener
  children) and thus also drop out at `gran==='line'`/`'call'` (see the
  scoping/reordering paragraph below). If a test lacks a usable coverage
  annotation, the card header shows a **warning** instead of a child
  (`data-testid=related-covers-warning`, custom inline SVG + explanation —
  never an AI guess). See `.claude/rules/tembed-workflows.md` (section
  "Linking test coverage").
  **Grouping covering tests into a horizontal bar** (`groupTestChildren` in
  `home.mjs` + `testsBar` in `RelatedPanel.mjs`): as soon as a block shows,
  besides its `covered_by` children (the covering tests), **other**
  (non-test) children too, those tests collapse together into one
  horizontal row (`data-testid=related-tests-bar`: chevron + "N tests" pill
  + one compact chip per test method, `data-testid=related-tests-chip`) at
  the spot where the first test was in the ordering — so they don't push
  the actual underlying code down. Click or `Enter` on the bar **toggles**
  the expansion (`state.testsExpanded`, ephemeral — not in the URL, resets
  to closed on a block switch via `lastRelatedBlockId` in the `setRelated`
  watch callback; `state.testsExpanded` is an inline dep in that watch
  getter): expanded, the tests appear as **ordinary child cards directly
  below the bar** (the bar stays as a collapse toggle). If there are **no**
  other children (or no tests), this is a no-op — the tests render as
  ordinary cards, as before. The group item rides along **within** the
  child list itself (a synthetic `kind:'tests_group'` descriptor), so the
  panel cursor (`cs.codeSel` indexes `rc.children` 1-to-1) needs no
  separate case: `Enter`/click lands in `drillIntoChild`, which branches on
  the child (toggle instead of drilling); `orderedChildBlocks` filters it
  out — just like `covered_by`. The bar's `.key` encodes open/closed + the
  test ids (fresh node per toggle, per the keyed-node pitfall in
  `conventions.md`). Test: `tests/related-tests-group.spec.mjs` (fixture PR
  99, `testsgroup-*.json` + `materializeTestsGroupWorktrees`).
  **Call-arrow overlay (`src/callArrows.mjs`):** a **smooth indigo bezier
  arrow** runs from the changed call site in the **active navigation unit**
  (right edge of the new pane, at the height of the call-site row) to the
  corresponding **changed** child card in this card — exclusively for a
  `method_call` child whose definition is itself a PR block (an
  `Unchanged` target never gets an arrow), one arrow per matching child,
  only in diff mode and only for **the column that currently holds the
  keyboard** — the top-level selected block (`focusLevel === 0`,
  `state.gran`/`state.change`) **or** the focused drilled column
  (`focusLevel > 0`, its **own** `state.drillCursor[focusLevel-1]`
  cursor) — exactly the `approveContext()` idiom (`callArrowPairs(b)`
  guards on `b === focusedBlock()` instead of always requiring
  `curBlock()`/`focusLevel === 0`). Every drilled column is after all a
  full-fledged, navigable diff with its own change-group cursor (see
  "Column navigation" above) — so there's no reason for the arrow to go
  away as soon as the reviewer drills. The DOM side
  (`callArrows.mjs`'s `main.querySelector('[data-pane="new"]')`/
  `panel.querySelector('[data-child-id]')`) needed **no** change: a
  non-focused column (top-level or drilled) always collapses to a rail
  without `[data-pane]`, so that query automatically finds the one
  remaining `[data-pane]` block — that of the column holding the keyboard,
  at any depth.
  The scope mirrors the panel's **visibility** exactly
  (`resolvedCallChildren`'s `hideOutOfScope`), not merely
  `callScopeMethods`' bare unit-range check at every granularity: at
  `call`/`line` the panel really **hides** a child outside the active unit
  (see below), so there the arrow only points to the one active
  segment/row. At **`group` the panel hides nothing** — every
  changed-target call child stays visible, only reordered (`groupTier`) —
  so there `callArrowPairs` points to **every** such child, not only the
  children whose call site happens to fall within the active group: first
  a site within the active unit (keeps the arrow close to the cursor when
  possible), otherwise the first known call site of that child anywhere in
  the block, so a groupTier-1 card (outside the active group, but shown by
  the panel anyway) still gets an arrow. Without this fallback a visible
  card sometimes ended up without an arrow when the active group didn't
  contain the call site. **Deliberately an imperative drawing layer**, not
  a reactive template (the `updateHints`/`positionMenu` model):
  `callArrowPairs` in `home.mjs` computes the pairs in the **callback** of
  the existing `setRelated` watch (untracked — no new reactive `b.code`
  reader, so no stuck-on-loading race) and pushes them via `setCallArrows`
  to `callArrows.mjs`, which purely reads the DOM (`getBoundingClientRect`
  on the `data-row` row in `paneHTML` resp. the `data-child-id` card on
  `relatedCard` — two static attributes) and imperatively redraws one
  **statically mounted** `position:fixed` `<svg data-testid=call-arrows>`
  (top-level next to `MenuHost`, `z-[15]`: above `<main>`'s z-10, below the
  sidebar's z-20 and the command menu; `pointer-events:none`) (path
  `data-testid=call-arrow`, stroke `#6366f1` at 0.45 opacity + arrowhead
  marker). The svg is laid exactly over `<main>`'s rect on each draw and
  clips itself — arrows never draw over the pr-index/PR-info/sidebar/footer.
  Redrawing: rAF-coalesced on the watch itself, `resize`, capture
  `scroll` (including inner scrollers — the `repositionMenu` precedent) and
  a 250ms settle after every push (the 200ms width transitions, à la
  `openMenu`).
  **The `a` toggle (`state.diffViewMode`, see below) is such a width
  transition but touches none of the `setRelated` watch's dependencies
  (`state.selected`/`mode`/`gran`/`change`/…) — so the watch doesn't fire and
  `setCallArrows` isn't called again, while every card's width changes
  anyway (a fixed 60% for `'new'`, a content-based width for `'fit'`, see
  below).** Without a countermeasure, the arrow stayed drawn at the
  pre-toggle (wide) coordinates, disconnected from the now-narrower pane
  edge. `toggleDiffView` (`home.mjs`) therefore explicitly calls
  `resettleCallArrows()` (`callArrows.mjs`): the same immediate + 250ms
  settle redraw schedule as `setCallArrows`, but without changing the pairs
  themselves (they stay identical — only the geometry changes).
  A call-site row scrolled out of the diff viewport loses its arrow (the
  same visibility rule as `updateHints`); a child card scrolled out
  internally keeps an arrow **clamped** to the panel edge. Test:
  `tests/call-arrows.spec.mjs` (fixture PR 100, `arrow-*.json` +
  `materializeArrowWorktrees` in `tests/_setup.mjs`).
  The card **follows the cursor**: `home.mjs`
  (`callScopeMethods`/`findCallSites`) links every resolved call to the
  diff segment it's on. At the finest level (`gran==='call'`) the card
  shows **exactly the method of that one call** — land on `->billingAddress`
  and you see `Order::billingAddress`; a segment without a resolved call
  gives an empty card. At `gran==='line'` it scopes to the **lines of the
  selected unit**: only the calls whose call site falls within
  `[unit.start, unit.end]`. At **`line`/`call` this is a hard filter
  (hiding)** — you never see a call, listener, `covers`-/`covered_by`
  child of a line you did *not* select (`relatedChildren`'s `scoped` flag
  in `home.mjs`, exactly what "if I select a line/call I want only the
  underlying code of that line/call" asks for). Only in **list mode** (no
  diff) does it show **all** resolved calls of the block.
  **At `gran==='group'`, nothing is hidden but reordered:** a group often
  spans multiple lines/calls, so a relation/`covers`/`method_call` child
  that isn't exactly on the selected line(s) doesn't disappear — it only
  sinks below the children that are. Every relation/annotation for this
  purpose carries an **absolute source line** (recorded server-side by the
  detector that found it — `relations.Relation.Line` resp.
  `testcovers.Entry.Line`, see `.claude/rules/tembed-workflows.md`);
  `groupLineRange(b, rows)` in `home.mjs` converts the selected group unit
  to that same absolute line range (`unitLineRange`, reused unchanged) and
  `relatedChildren` sorts first on that **`groupTier`** (0 = within the
  group, 1 = outside it) before the existing `prio`/`size` sort — so within
  each tier the ordering below still applies as usual. A `covered_by` child
  (the test covering a production method) has **no** anchor point within
  the viewed block — the annotation lives in the test file, not the
  production code — and thus always sits in tier 1; its own `prio 0` still
  keeps it above a `prio 2` (unchanged) call within that tier: "at the
  bottom, but above unchanged". An LLM `found` `covers` row that escalated
  from a class-only annotation also carries no `Line` for the same reason
  (`resolve_test_covers.go` deliberately doesn't thread it through) and thus
  degrades to that same tier 1. Outside `gran==='group'` (list mode, or at
  line/call where the filter already only leaves in-scope items),
  `groupTier` is `0` everywhere — a no-op, the ordering is then exactly as
  before this reordering.
  The shown calls are (within their tier) **ordered**: first a call whose
  definition itself changes in this PR (a real child block, `prio 0`), then
  calls on a recently changed line (`prio 1`), then the rest (`prio 2`).
  **Within the same prio** the **largest** child wins (most non-empty
  lines, `codeSize` on the child source — `childCode` for a call, loaded
  `code` for a listener): so the substantial changed code sits on top and
  trivial one-liners sink below. That's load-bearing because relation
  accessors (e.g. Eloquent `Order::billingAddress`, a 3-line `MorphOne`)
  are **also** `added` PR blocks and thus also `prio 0` — they'd otherwise
  land before a genuinely changed method purely on source order. A child
  whose code hasn't arrived yet counts as `size 0` and sinks until it
  loads; equal prio+size keeps source order (stable sort). The listener
  children (block-level) drop out at `line`/`call` level. In the card
  header the **title (`class::method`) is always visible** (gets the
  first line, only truncates at extreme length); the **file path** sits
  below it on its own line and truncates if it doesn't fit.
  **Reactivity:** the list is **not** computed in `RelatedPanel`'s render
  binding but in a `watch` in `home.mjs` and pushed into the panel via
  `setRelated` — the same decoupling as `setCommentScope`. That is
  **load-bearing**: if the render binding itself read the `b.code` of the
  selected block (via `blockRows`), that would race with `home.mjs`'s diff
  render over the same `b.code` and the diff would stay stuck on
  "loading". **Equally load-bearing: the watch getter must enumerate the
  navigation state _inline_** (`state.selected`, `mode`, `change`, `gran`,
  the block lists, `callResolve`, `relations`, `curBlock().code`) — exactly
  like the `setCommentScope` watch. Only compute the children in the
  _callback_ (`() => setRelated(relatedChildren(),
  unresolvedCalls())`). Compute them in the getter itself, and all reactive
  reads are hidden inside `relatedChildren`/`unresolvedCalls`, and due to
  their early returns (empty block at load, `resolved.length === 0`,
  scope shortcuts) the crystallized run drops `state.selected` from its
  dependency set: the `watch` no longer re-subscribes and the panel
  **freezes** on the block that was selected at load time — it no longer
  follows the cursor to a different block.
  **Refresh restore of the panel cursor:** `cs.focus`/`codeSel`/`sel`/
  `threadPos` live in the URL under their own `rel` namespace
  (`bindUrlState(cs, …, { ns:'rel' })` in `RelatedPanel.mjs`), so a refresh
  puts you back on the same Underlying-code child resp. the same comment
  thread. Because the data pushes (`setRelated`/`loadComments`) clamp `cs`
  while loading — and the mirror `watch` would immediately reflect that
  into the URL — `RelatedPanel` snapshots the restored values in
  `restorePending` and reapplies them, clamped, exactly once via
  **`applyRelRestore`** once the children/comments are in (only focus if
  its target exists, then clear so later navigation stays free). See skill
  `url-state` and the URL-state section in `CLAUDE.md`.
  Calls the Go resolver couldn't pin down **automatically** start the LLM
  search — **no button anymore**: `home.mjs` calls
  `startCallSearch(focusedBlock())` in the `setRelated` watch as soon as the
  panel shows a block with `unresolved` calls (`POST
  /api/workflows/resolve_call`, deduped per caller+callKey in
  `searchRequested` so it fires once). It resolves the **entire**
  unresolved set of the block (not scoped to the selected unit), so you
  never need to navigate anywhere. While searching, the card shows
  "searching…" (`data-testid=related-searching`, also as long as there's
  still `unresolved` in the queue). A child found by an LLM carries a
  **`source: haiku/sonnet`** badge (`source`); Go-resolved children show no
  source. See `.claude/rules/tembed-workflows.md` (section "Resolving
  called … methods").
- **Tasks** — this was once a placeholder column with a dummy task list +
  chat (`ui.task`, `data-testid=task-list`/`chat`/`chat-bubble`/`new-task`).
  That placeholder no longer exists: the "Tasks" card is now the real,
  working `workflows-panel` described above (`data-testid=
  workflows-panel`, fed by `GET /api/workflows?pr=N`) — no chat, no
  `ui.task`. See also the keyboard binding further down in this section and
  `.claude/rules/keyboard-navigation.md`.

The block card keeps its fixed `w-[70rem] 2xl:w-[82rem]` width (no more
`flex-1`, and regardless of whether the block is one- or two-sided), so the
diff doesn't stretch and the panel sits snugly next to it. In `'list'` mode
`<main>` starts at `left-[29rem]` (next to the sidebar), in `'diff'` mode at
`left-0` (flush with the viewport edge — no sidebar to clear there, so no
reason to reserve a margin); in both cases the columns keep packing from the
left. `<main>`'s right edge is `right-0` in every mode, **deliberately
asymmetric** with every other panel (sidebar/footer/PrInfoPanel keep their
own 1.5rem edge): the far edge is exactly where a wide last column's own
content used to get clipped (hidden behind the `no-scrollbar` convention)
before it was scrolled fully into view, so the margin there was traded for
extra usable/scrollable width instead.

**Exception: the `a` toggle (`state.diffViewMode`, see
`.claude/rules/keyboard-navigation.md`) shrinks EVERY visible card to 60%
width, regardless of whether it actually restructures a pane.** With
`viewMode==='unified'`, a card shrinks to `w-[42rem] 2xl:w-[49.2rem]` (60% of
`w-[70rem] 2xl:w-[82rem]`) — for a two-sided (`modified`) block that then
also restructures into one "old above new" column
(`unifiedCodeDiff`), but **equally so** for an already one-sided
`added`/`removed` block that has nothing to restructure. This was earlier
restricted to the two-sided case (the deliberate width stability for
one-sided blocks won out then); that's been deliberately abandoned: the
reviewer wants `a` to make **everything currently visible** equally narrow,
so the layout doesn't differ per block type as long as the toggle is on.
Two separate, decoupled conditions in `Block.mjs`: `codeDiff`'s own
`viewMode() === 'unified'` check (after `effectiveOnly`, so it never fires
for an already one-sided block) determines **which pane structure**
`codeDiff` shows (only relevant for a genuinely two-sided block — a
one-sided block already showed only one side anyway); the separate, simpler
`narrowed(viewMode)` (just `viewMode()==='unified'`, no `singleSide` check)
determines the **width** in `Block()`'s own card `class` binding. Applies
automatically to **every** visible card (top-level selected/preview and
every drilled column), since they all share the same `Block()` component
and the same `viewMode` opt (`() => state.diffViewMode`).

**`unifiedCodeDiff` restructures a paired changed row into two stacked
lines instead of hiding one of them.** For a real del+ins pair (or a
whitespace-only re-alignment, see `wsOnly`), the OLD line (`-`, rose) renders
directly above the NEW line (`+`, emerald) in the SAME single column —
mirroring the `-`/`+` gutter convention `Footer.mjs`'s own inline-diff
preview already used. A context row or an already one-sided row still
renders as a single line. Exactly one of a pair's two lines carries the
row's metadata (`data-row`/the change-active anchor/the checkmark/the
comment marker — `rowCellHTML`'s `opts.emitMeta`), so a `callArrows.mjs`/
`updateHints` query for a row index never finds the purely decorative OLD
half of a pair.

**`a` cycles through a THIRD stand, `'fit'`, between `'unified'` and back
to `'split'`** (`DIFF_VIEW_CYCLE` in `home.mjs`): unlike `'unified'` (which
still shows old code, just stacked instead of side-by-side), `'fit'` **never
shows old code at all** — on explicit reviewer request, a genuinely
two-sided (`modified`) block collapses to just its new/right pane, exactly
like an already one-sided ADDED block (`fitOnly(b)` in `Block.mjs`, folded
into `codeDiff`'s `effectiveOnly` right next to `singleSide(b)`). **The one
deliberate exception:** a REMOVED block has no new side to prefer, so it
keeps showing its old/left pane in `'fit'` too — that's the only code it
has, hiding it would leave nothing to review. This keeps the three stands
functionally distinct: `'unified'` is the only stand that still shows old
code; `'fit'` is the only stand with a content-driven width (below).

The card's width changes — **differently for a PHP file than for anything
else** (`isPhpFile(b)` in `Block.mjs`, a plain `.php` extension check on
`b.file`; `widthCls(b, viewMode)` routes on it for `'fit'` only):

- **A `.php` file** gets a **content-based**, uncapped width instead of the
  fixed `70rem`/`82rem`: `widthCls` delegates to `fitWidthCls(b)`. Floored
  at the existing 60% width (never narrower than `'unified'`) but **deliberately
  uncapped upward** — on explicit reviewer request, `'fit'` guarantees that
  the single widest non-comment PHP code line of the block is always fully
  visible, never cut off behind an invisible horizontal scroll (which is
  exactly what a percentile-based width plus a ceiling used to allow: a
  genuinely long line — e.g. a 168-character `throw new
  RuntimeException(...)`, PR 13042 — was clipped identically in `'fit'` and
  `'split'`, defeating `'fit'`'s whole "width follows the code" premise).
  `fitWidthCls` uses `codeMaxLineChars` (the TRUE longest non-comment line,
  not a percentile) via a CSS `max(floor, calc(...))` — no ceiling
  `clamp(...)`. `codeGrowthChars` (the 75th-percentile, non-ballooning
  technique) stays exactly as it was and is still used by
  `RelatedPanel.mjs`'s `relatedColumnWidthCls`. Always a **single-pane**
  calculation now, based on whichever side `fitOnly(b)` actually renders
  (the new/right text for an added/modified block, the old/left text for a
  removed block) — there is no more two-pane/doubled-width branch, since
  old is never shown next to new in this stand any more. Purely a
  character-count calculation on the already-loaded source text — no live
  DOM measurement (`scrollWidth`/`getBoundingClientRect`), per the existing
  approach.
- **Any other file** (markdown, JSON, config, …) gets the **same narrow
  60% width** a one-sided added/removed block already uses in every other
  stand (`boundedWrapWidthCls()` — not content-based, and since `'fit'`
  only ever renders one pane now, no longer a two-way branch either), and
  its rows **wrap** (`whitespace-pre-wrap break-words` instead of
  `whitespace-pre`) within that width rather than growing the card, reusing
  the ordinary single-pane `codePane`/`paneHTML` with a `wrap` flag. The
  PHP-only uncapped guarantee above backfired for prose/config text: an
  isolated long markdown bullet (336 characters, no natural break point for
  a PHP-style width formula) grew a card to ~6800px — prose reads perfectly
  fine wrapped, unlike a PHP statement, so there is no reason to balloon the
  card for it. Since `'fit'` no longer ever shows two panes side by side,
  the earlier `wrappedCodeDiff`/`pairedRowHTML` (a shared
  `<div class="flex items-stretch">` row-wrapper that kept a modified
  block's old/new cells the same height once wrapping made row heights
  variable — flexbox's `align-items: stretch` stretching the shorter cell
  to match) became unreachable and was removed as dead code, rather than
  left behind with a doc comment describing behavior that no longer exists.

See `.claude/rules/keyboard-navigation.md` ("`a` — cycling the diff view")
for the full mechanism. Test: `tests/diffview.spec.mjs`.

**A look-ahead preview must never be WIDER than the active block next to it
(`activeSingleSided`, both preview spots).** Without a countermeasure, every
card determines its width/pane choice purely from its **own** `status`
(`singleSide(b)`, now exported from `Block.mjs`) plus the **global**
`state.diffViewMode` — so a one-sided (`added`/`removed`, narrow + one pane)
active block could sit next to a **two-sided** (`modified`) preview block
that, without the `a` toggle, simply showed its full width + both panes side
by side: wider than what the reviewer is currently reviewing. Both
look-ahead preview spots — the top-level `pair.forEach` in `DetailPanel`
(`home.mjs`) and `drillPreviewColumns()` — therefore compute
`const activeSingleSided = !!singleSide(<the active block>)` (top-level:
`state.blocks[sel]`; drilled-column sibling: `focusedBlock()`, the block
of the card this preview hangs directly beneath) and give **only the
preview card** an override `viewMode`:
`() => (i !== sel && activeSingleSided) ? 'unified' : state.diffViewMode`
resp. `() => (activeSingleSided ? 'unified' : state.diffViewMode)`. Since
`narrowed` already reacts purely to `viewMode()==='unified'` (see above),
this override suffices to make the preview narrow — exactly the same lever
as the `a` toggle, only applied per-render conditionally instead of solely
on the global state.

**This override no longer guarantees the preview shows nothing the active
card doesn't have — that guarantee was deliberately dropped.** Before the
`a`-cycle's 2nd stand was reworked from "hide the old pane" into "unified:
stack old (-) above new (+) in one column", forcing a two-sided preview
into that stand also hid its old/removed content entirely, so "never
wider" and "never richer" held together for free. Now a two-sided preview
forced into `'unified'` still shows its own removed (-) line — narrow and
stacked, but not narrower in *content* than what it would show in
`'split'`. The reviewer explicitly accepted this: the WIDTH guarantee is
what actually matters for the layout (a preview that suddenly widens the
column next to the active card), not whether it happens to reveal a
removed line. **A one-way rule, deliberately:** this never widens a
one-sided preview back to two-sided if the active block itself is
two-sided — the preview may then simply stay narrower than active, that's
not a violation. Two edge cases remain deliberately untouched: an
already-one-sided preview (its own `singleSide(b)` always wins in
`codeDiff`'s `effectiveOnly`) just shows its own side, regardless of the
override (there's only one side to show anyway); and a one-sided preview
next to a two-sided active block simply stays narrower (no forced
widening). The active card itself never gets this override — only its own
`singleSide(b)` + the global `state.diffViewMode` determine its own
display, unchanged. **The override always forces `'unified'`, never
`'fit'`** — even if the global stand is `'fit'`: forcing the narrower,
fixed-width `'unified'` here is what guarantees the "never wider than
active" rule holds deterministically; `'fit'`'s content-based width could
in principle exceed the active card's width even for a one-sided active
block, which would defeat the whole point of this override. Test:
`tests/preview-matches-active-width.spec.mjs`.
