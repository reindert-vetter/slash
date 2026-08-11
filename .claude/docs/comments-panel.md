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
  comment. `opts.local` ("Alleen voor mijzelf") still works;
- **no Claude column** (`claudeChatVisible()` returns false, and `→` from the
  composer doesn't `enterClaudeChatFromNew`): `ensureClaudeAnchorForNew` would
  lazily create a backing comment **anchored on the current diff unit**, which
  is exactly what a general comment is not;
- **no approval revoke** — `COMPOSE_COMMANDS`' `compose-post`/`compose-self`
  pass a `null` revoke target, since a PR-wide comment hangs on no unit (see
  `.claude/docs/approval.md`).

The flag is cleared by every ordinary composer open (`toNew`) and every exit
(`exitRelated`, "Annuleer"), so it can never leak into the next line comment.
Ephemeral, not URL-bound, like `cs.composing` itself.

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
shape. `recomputeLeftList`'s `rank()` puts comment items **first** (rank `-1`,
ahead of `ROUTE`): PR-wide feedback usually wants attention before diving into
the tree.

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

### "Mentioned": an `@`-mention of the local reviewer ranks above everything

A comment whose body — **or any of its replies** (`c.reactions`, where a mention
very often lands) — `@`-mentions the local reviewer gets `mentioned: true` on its
index item (`commentMentionsMe`, `src/mentions.mjs`) and ranks **`-2`**, above
the other comment items (`-1`), under its own **"Mentioned" heading**
(`mentionHeading`, `data-testid=mention-heading`, `BlockList.mjs`) — someone is
waiting on an answer, so it must not sit below unrelated feedback. Otherwise it
is an ordinary comment item: resolving it still folds it into the same
"Toon N goedgekeurde blokken" section, and the heading is gated on
`!isIgnoredComment` for the same reason `commentHeading` is (a revealed ignored
comment belongs under "Verborgen comments"). `commentHeading`'s own condition
gained `&& !b.mentioned`, so "PR-comments" starts at the first non-mentioned
item.

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

### The selected conversation is pulled to the top, with a "hierboven" hint

Stacked comment cards follow the Onderliggende-code column exactly:
`scrollCommentIntoView` aligns the selected card to the top of its vertical
scroller (`alignToTopVertical`) and a slim `▲ N hierboven` header
(`moreAboveHint`, `data-testid=comment-more-above`) appears while `cs.focus` is
`'comment'`/`'thread'` and `selI() > 0`. Full mechanism, and why the count comes
from the cursor index rather than a scroll measurement: "The selected child is
pulled to the TOP" in `.claude/docs/underlying-code.md`. Note the column itself
usually doesn't scroll (it has no scroller of its own), in which case
`alignToTopVertical` finds no vertical scroller and is a no-op — the hint still
tells the reviewer there is something above.

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
- **A VISIBLE native scrollbar** — `overflow-y-auto`, deliberately without
  `no-scrollbar` on this one container (every other scrollable panel in this
  app hides its scrollbar chrome) — so the cap is discoverable instead of an
  invisible truncation. `claude-chat-thread` (`ClaudeChat.mjs`) got the exact
  same treatment (its own `no-scrollbar` was removed), for the identical
  reason — a long Claude conversation stretched the row the same way.
- **The newest message still stays in view by default**, mirroring how the
  Claude column already behaved: `scrollCommentThreadToBottom()`
  (`RelatedPanel.mjs`, an exact mirror of `scrollClaudeThreadToBottom`) sets
  `comment-thread`'s own `scrollTop = scrollHeight` whenever `cs.threadPos ===
  0` — called from `toComment()` and from `loadComments()` after a poll brings
  in a new reply on the currently-open thread. A no-op while walking older
  messages via `↑` (`cs.threadPos !== 0`) — that must never be yanked back
  down.
- **A top fade, not a hard clip, as the "there's more above" cue**
  (`src/scrollFade.mjs`'s `updateScrollFade`, toggling the `.scroll-fade-top`
  mask-image class defined in `index.html`) — bound via `@scroll` on the
  container, plus called directly after every programmatic `scrollTop` write
  (a JS-driven scrollTop assignment isn't guaranteed to fire a native
  `'scroll'` event in every browser). Deliberately **not** a permanently
  applied fade: it only toggles on once `scrollTop > 4`, so a short
  conversation that fits entirely inside the cap never shows it — the
  earlier `no-scrollbar` mistake hid the fact that there was more to see at
  all; this fade only ever appears when that is actually true.
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
`cs.focus`/`cs.composing` directly — `enterRelated`, `toComment`,
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

- **`placeComment`** (called by both `COMPOSE_COMMANDS` items, "Place
  comment"/"Only for myself") calls `exitRelated()` **immediately** — before
  `createComment`'s POST + GET round-trip even starts, not after it succeeds.
  Focus returns to the diff of the block/column the comment was attached to
  (`commentTarget()` follows `focusedBlock()`, so also a drilled column).
  `home.mjs`'s `compose-post`/`compose-self` `run` functions then call
  `scrollFocusIntoView()` to re-align `<main>`. So "type, Enter, Enter" leaves
  the reviewer ready to continue with `↑`/`↓`/`f`/`d`/`s` immediately. Test:
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
