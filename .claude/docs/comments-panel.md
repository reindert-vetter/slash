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
like an ordinary PR block, and the block column to the right of the index shows
its thread instead of a diff. (This replaced the removed `PrWideComments` card,
see `.claude/docs/detail-layout.md`.)

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

### The synthetic item

`commentBlockItem` (`recomputeLeftList`, `home.mjs`):
`{ id: 'comment:'+c.id, kind: 'comment', label: <short body snippet>,
category: 'COMMENT', status: '', comment: c }`. `kind` is the marker every
block-assuming code path guards on; `id` is stable across a recompute so
selection survives a comment-list reload; `comment` carries the raw row back for
the detail card/action menu.

`BlockList.mjs` has a matching `CATEGORY_STYLE.COMMENT` pill colour (`red`, used
by no real block category) and its own **"PR-comments" heading**
(`commentHeading`, `data-testid=comment-heading`) above the first visible comment
item — mirrors `underlyingHeading`, same "own keyed item in one flat array"
shape. `recomputeLeftList`'s `rank()` puts comment items **first** (rank `-1`,
ahead of `ROUTE`): PR-wide feedback usually wants attention before diving into
the tree.

Items are synthesized fresh from `RelatedPanel.mjs`'s exported
`prWideComments()` (the `kind !== ''`-filtered, kilo-review-bot-excluded subset
of `cs.list`) on every `recomputeLeftList()` call; a dedicated
`watch(() => prWideComments(), () => recomputeLeftList())` re-derives
`state.blocks` whenever that list changes — safe because `prWideComments()` only
reads `cs.list`, never a block's `.code`, so it can't trigger the "stuck on
loading" co-subscriber race (`.claude/rules/arrowjs-pitfalls.md`). `cs.list`
itself is loaded/polled by `syncComments`, called unconditionally by
`InlineComments` — no separate fetch.

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

`findNextUnapproved` needs no guard: its forward-only walk starts at
`state.selected + 1` and comment items always rank before every real block, so
the postApprove "Continue" flow can never land on one structurally.

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

### The detail card, in place of a `Block` diff card

`DetailPanel`'s `pair.forEach` loop branches at the top on
`b.kind === 'comment'`: instead of `ensureCode(b)` + `Block(b, {...})` it renders
`commentDetailCard(b.comment, { preview })` (`RelatedPanel.mjs`, exported) — a
read-only thread (status mark, kind badge, source/AI-warning badge, relative
time, markdown body via the shared `commentBody`, every reaction via the shared
`threadMessages`/`reactionBubble`) wrapped in the same
`data-testid=detail-card` stable-`contents` root as an ordinary card, keyed on
`'detail:'+role+':comment:'+id+':'+status` (a resolve thus forces a fresh node).

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
finally **"Ignore"**. `isOwnComment`'s github+`meLogin()` branch has no
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

### The menu actions

- **"Beantwoorden"** (`startPrCommentReply`) only reveals the reply textarea in
  the detail card (`picm.replying = true` + `picm.commentId = c.id`) and focuses
  it — the reviewer types and sends from there (`Enter` or the send button),
  never from the menu.
- **"Resolve comment"** (`resolvePrCommentItem`) sends the same `"/resolve"`
  sentinel + `done:true` reply Signal as `resolveFocusedComment` — local-only for
  a PR-wide thread, GitHub-resolved for a review-diff thread, see
  `.claude/docs/workflows-comments.md`. Both reply and resolve go through the
  existing `POST /api/workflows/{runId}/signals/reply` — no new write path.
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

**`InlineComments`' wrapper carries the SAME explicit width as `related-code`
below it** (`relatedColumnWidthCls()`, exported from `RelatedPanel.mjs`, reused
as-is). Relying on "stretches to the sibling's width" never held — a
flex-column's cross-axis stretch only applies to a child whose own width is
`auto`, and `related-code` sets an explicit width. Left unbounded, one unwrapped
long line (a `composeTargetHint` excerpt, or a fenced code block in a Markdown
body) forced this column and thus `<main>` to shrink-to-fit around it instead of
clipping inside it (`overflow-auto`/`.markdown-body pre {overflow-x:auto}` only
clip once an ancestor has a real width), pushing the block/drill columns out of
view. The identical clamp width fixes that and keeps both sections the same
width.

### One card per conversation, only the focused one expands

Multiple threads can hang off one unit; each gets its own card
(`data-testid=comment-item`), but only the one the keyboard owns (`cs.sel` +
`cs.focus` one of `'comment'`/`'thread'`) renders `expandedConversation`: a slim
right-aligned meta line (`comment-meta-line` — source/AI-warning badge + status
mark), `composeTargetHint` if the comment carries a code snippet, every message
via `threadMessages`/`reactionBubble`, and a working reply field. Every other
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

**The expanded thread has no height cap/internal scroll** — its message list
(`data-testid=comment-thread`) grows with the conversation. An earlier
`max-h-64 overflow-auto no-scrollbar` silently cut off the tail behind an
invisible scrollbar, which read as a truncated conversation; don't reintroduce.

**`expandedConversation` has no author+avatar header** — that duplicated the
opening bubble `threadMessages()` already renders (the comment's own body as the
first message). Only the source/AI-warning badge + status mark remain,
right-aligned in the slim `comment-meta-line`. `compactConversation` keeps its
own author+avatar line (it never shows the thread body).

**`compactConversation`'s meta line also names who sent the LAST message**
(`lastReplyNote`, next to `threadMessages`): a collapsed thread with several
reactions otherwise gave no clue whose turn it is. It looks at the last entry of
`threadMessages(c)` and appends `" · <author> reageerde"` to the `comment-meta`
text — empty while there's nothing beyond the opening message, and empty once the
reviewer's OWN reply is last (`author === 'reviewer'`, the in-app sentinel).
Plain text, not colour.

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
conversation is done and should recede like already-reviewed reference code. The
border stays the neutral `border-slate-300 dark:border-zinc-700` in both states;
`expandedConversation`'s indigo focus border is untouched (an orthogonal focus
cue, not a status colour).

### The send-status button (`reaction-status`)

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

`sendStatusIcon(status)` renders the icon: a pencil ("draft" — covers both
"nothing typed" and "typed but not sent") by default, a spinning arc while
`cs.busy`, and an SVG circle-check briefly (`cs.replySent`, a 1.2s flash) right
after a reply is sent — the one spot where "sent" is visible at all, since the
composer and the PR-wide reply both close their input on success. Deliberately a
different shape/technique than `commentStatusMark`'s text glyph: that is a
*persistent* property of the thread, this a *transient* status of the control.

Both buttons (`reaction-send`/`reaction-status`) are disabled while `cs.busy` via
a plain `disabled="${() => cs.busy}"` — **not** `?disabled=`/`.disabled=`,
neither of which works in this vendored arrow.js (see
`.claude/rules/arrowjs-pitfalls.md`). The composer's "Plaats…" button and the
PR-wide reply's "Stuur" button get the same icon treatment (draft/sending only);
the PR-wide reply has its own `picm.sending` flag. Test:
`tests/reaction-status-icon.spec.mjs`.

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
`commentCommandsFor`'s menu gains **"Comment hiervan maken"** after "Resolve
comment"/"Verwijder comment" (not the default), shown only when
`source === 'ai'`. It opens the block's own composer (`newCommentComposer`)
prefilled with the finding's body and — load-bearing — anchored on the
**finding's own** `file`/`label`/`gran`/`rowStart`/`rowEnd`/`code`, not whatever
the live cursor sits on: a module-level `warningOverride` (`{original, target}`)
is set by `convertWarningToComment(c)` and consumed by `placeComment` (both the
composer header/`composeTargetHint` and the eventual `createComment` prefer it
over `commentTarget()`). Every ordinary composer-open entry point
(`toNew`/`startComment`/"Annuleer") clears it first, so a stale override can't
leak into an unrelated comment. The reviewer edits freely, then picks "Plaats
comment"/"Alleen voor mijzelf" from the usual comment-kind menu
(`COMPOSE_COMMANDS`, `.claude/docs/command-palette.md`). **Only once the
replacement is confirmed placed** (`createComment` returns `res.ok`) does
`placeComment` delete the original via the same `delete` Signal
(`deleteComment(c)`, factored out to target a specific comment) — a failed
placement leaves the finding standing.

**PR-wide (`kind:'ai_warning'`, no anchor):** `prCommentCommandsFor` gets the
same item (again gated on `source === 'ai'`, after "Resolve comment") wired to
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
(`placeComment`), on send (`sendReaction`), and on an explicit "Annuleer". An
abandoned draft just stays for the session. Test:
`tests/comment-draft-persists.spec.mjs`.

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
- **`↑`** on the **first** conversation exits straight to the diff
  (`exitRelated()`). On the Onderliggende-code card's **first** child, `↑` steps
  back onto the **last** conversation if one exists (`enterCommentsTail()`,
  highlight-only — no reply-field focus steal), else also exits to the diff.
  **`←` on the Onderliggende-code card keeps its own unconditional behaviour at
  ANY child position** — `hasVisibleComments() ? enterCommentsTail() :
  exitRelated()` — so one `←` always fully leaves the panel when there are no
  comments.
- **`→`** on a conversation steps into its thread (`enterThread`); `↑`/`↓` there
  walk the history (`threadPos`); `←` from the thread steps back **one stop** to
  the conversation level, `←` from there exits to the diff. A further **`→`**
  from the thread steps one stop deeper still, into the embedded Claude
  conversation hanging off that same comment (`cs.focus==='claude'`, stop 5b);
  its `←` comes straight back here.

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

**The same `focusToken` also guards `placeComment`'s/`createComment`'s async
tail** (POST + comments reload), not just a deferred DOM focus.
`COMPOSE_COMMANDS`' `run()` is fired without being awaited (`runCommand`), so the
reviewer has the keyboard back well before the round-trip settles and can open a
different comment/composer/panel, possibly on a different block — `cs` is a
module-level singleton. Without a guard the stale tail's unconditional
`cs.sel = …` (`createComment`) and `exitRelated()` (`placeComment`) would clobber
that. Both snapshot `focusToken` before their `await` and only apply their
follow-up if it's unchanged. Consequence: every function that sets
`cs.focus`/`cs.composing` directly — `enterRelated`, `enterThread`,
`startComment`, and the two direct branches in `applyRelRestore` — must also call
`releaseFocus()`, so a genuine navigation-away is visible to that guard. Test:
`tests/comment-nav-race.spec.mjs`.

### A placed comment gives the keyboard back to its code

`placeComment` (`RelatedPanel.mjs`), called by both `COMPOSE_COMMANDS` items
("Place comment"/"Only for myself"), calls `exitRelated()` after a successful
`createComment`: focus returns to the diff of the block/column the comment was
attached to (`commentTarget()` follows `focusedBlock()`, so also a drilled
column). `home.mjs`'s `compose-post`/`compose-self` `run` functions then call
`scrollFocusIntoView()` to re-align `<main>`. So "type, Enter, Enter" leaves the
reviewer ready to continue with `↑`/`↓`/`f`/`d`/`s`. Test:
`tests/place-comment-return-focus.spec.mjs`.

Placing a comment also **retracts the approval of the unit it hangs on** — see
`.claude/docs/approval.md`.
