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
- **"Bewerk bericht"** edits whichever OWN message the keyboard is currently
  on — see "Editing an own message" below.
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

Both buttons (`reaction-send`/`reaction-status`) are disabled while `cs.busy` via
a plain `disabled="${() => cs.busy}"` — **not** `?disabled=`/`.disabled=`,
neither of which works in this vendored arrow.js (see
`.claude/rules/arrowjs-pitfalls.md`). The composer's "Plaats…" button and the
PR-wide reply's "Stuur" button keep their own `sendStatusIcon` treatment
(draft/sending only, untouched by this change); the PR-wide reply has its own
`picm.sending` flag. Test: `tests/reaction-status-icon.spec.mjs`.

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

### Publishing a local thread to GitHub

A thread with no GitHub root of its own — a private "Alleen voor mijzelf" note,
or an AI finding (always `Local:true`) — used to be a one-way street: every
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
  `.claude/docs/command-palette.md`): local is the default item, the two GitHub
  items grow a with/without-the-earlier-messages submenu only when there
  actually are earlier local replies.
- **`openPublishMenu` defers the open by one frame.** Both fields open it from
  their own `Enter` handler, and that keydown keeps bubbling to home.mjs's
  document-level handler; opening synchronously made that same keystroke
  immediately run the menu's default item, so the reviewer never saw the
  question. A frame later the keydown is over and the global handler has already
  seen a closed menu + a non-empty reply field (a no-op there).

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
(`placeComment`), on send (`sendReaction`), and on an explicit "Annuleer". An
abandoned draft just stays for the session. Test:
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
  the Onderliggende-code card keeps its own unconditional behaviour at ANY
  child position** — `hasVisibleComments() ? enterCommentsTail() :
  exitRelated()` — so one `←` always fully leaves the panel when there are no
  comments.
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

**The same `focusToken` also guards `placeComment`'s/`createComment`'s async
tail** (POST + comments reload), not just a deferred DOM focus.
`COMPOSE_COMMANDS`' `run()` is fired without being awaited (`runCommand`), so the
reviewer has the keyboard back well before the round-trip settles and can open a
different comment/composer/panel, possibly on a different block — `cs` is a
module-level singleton. Without a guard the stale tail's unconditional
`cs.sel = …` (`createComment`) and `exitRelated()` (`placeComment`) would clobber
that. Both snapshot `focusToken` before their `await` and only apply their
follow-up if it's unchanged. Consequence: every function that sets
`cs.focus`/`cs.composing` directly — `enterRelated`, `toComment`,
`enterClaudeChat`, and the two direct branches in `applyRelRestore` — must
also call `releaseFocus()` (directly, or via `focusThread`/`toComment`, which
do it themselves), so a genuine navigation-away is visible to that guard.
`handleRelatedKey`'s 'comment'+ArrowUp branch (entering `'thread'`) and
`'thread'`+ArrowUp's fall-through to the previous conversation rely on this
the same way — they set `cs.focus`/`cs.threadPos` then call `focusThread()`/
`toComment()`, never bypassing it. Test: `tests/comment-nav-race.spec.mjs`.

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

**If a Claude message already lazily created this exact draft's backing
comment** (`ensureClaudeAnchorForNew`, see "Optimistically visible while
composing a brand-new comment" in `.claude/docs/claude-chat-panel.md`),
`placeComment` does not call `createComment` at all — it posts the typed text
as a **reply** on that already-existing thread instead, so exactly one comment
ever exists for that draft.
