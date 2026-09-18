# Embedded Claude chat panel (frontend)

The frontend half of the embedded, multi-turn Claude conversation next to a
comment thread — the `claude_chat` workflow (backend: `modules/claude`'s
`RunChat`, `modules/chat`, `chat_workflow.go`) is documented in
`.claude/docs/tembed-workflows.md`/`workflows-comments.md`; this file covers
the review-tree panel that talks to it: `src/ClaudeChat.mjs` (pure template)
and the "Embedded Claude conversation" section of `src/RelatedPanel.mjs`
(state machine, the SSE subscriptions, focusToken discipline).

## Product decision: the chat exists only where there is something to hang it on

A Claude conversation always hangs off an existing comment thread (the
backend's own constraint — `CommentID` must name an existing comment of the
PR). The column is therefore **conditional**, and the `→` chain of a
commented unit is

```
comment (↑ walks its own thread bubbles) → claude → (↓, nothing left) → next visible block's diff
```

`'thread'` is **not** a horizontal `→` stop between `'comment'` and `'claude'`
— it's a vertical cursor reached only via `↑` from `'comment'` (see "The
chain, key by key" below). `→` from the diff enters the first comment
conversation when
`hasVisibleComments()` is true; with no comment **and** no earlier
conversation it goes **straight to the Onderliggende-code panel**, exactly as
it did before this panel existed.

**The auto-created placeholder comment is gone and must not come back.** An
earlier version made the panel unconditionally reachable via `→` by silently
creating an empty, private comment with the body
`(Aangemaakt voor een Claude-gesprek.)` to hang the conversation on. That put
a comment the reviewer never wrote in the thread of every unit they once
walked past with `→`. Removed: `enterClaudeChat` is a plain **no-op** when
there is nothing to hang a conversation on (not an error state — nothing is
wrong, there is simply nothing to chat about), and it takes the focus only
once an anchor is known. Comments already stored with that body stay put as
ordinary private notes; they are deleted by hand via the existing comment
Delete menu, deliberately not by a migration.

**Why a chat still needs a comment at all:** it is the anchor that gives a
conversation its place in the review tree (a unit, a file:line, a thread the
conversation can reply into — see `applyChatCommentAction`). The requirement
"a chat only where there already is a comment, or where a conversation
already happened" is exactly `claudeChatVisible()` below.

**Superseded: "a conversation that already happened never becomes unreachable".**
An earlier version kept the column visible via `cc.conversations` (the ids of
this PR's conversations that actually have turns, from `GET /api/chat?pr=N`)
even once its comment fell out of the visible index (an orphan or PR-wide
comment, which `recomputeView` filters out, or one filtered out by the current
granularity scope). **Explicitly replaced** by a stricter invariant (Reindert's
own words: *"claude blok moet altijd alleen zichtbaar zijn als er ook een
comment blok zichtbaar is (en andersom)"*) — see `claudeChatVisible()` below.
A conversation whose comment isn't currently visible is therefore no longer
reachable through ordinary navigation; `chatAnchorComment()` (which still
falls back to searching `cc.conversations` for such a comment) is now only
used internally to resolve an anchor, never to decide visibility. A genuinely
**deleted** comment remains the one irreducible case: without a row there is
no file:line, so its conversation has no unit to appear under any more.

### Optimistically visible while composing a brand-new comment

`claudeChatVisible()` also returns `true` while `cs.focus === 'new'` — the
composer for a brand-new "Comment op deze regel" (`toNew`/`startComment`) is
itself already shown before anything is persisted (an uncontrolled `<textarea>`
backed only by `composeDrafts`, see above); the Claude column now mirrors that
same "shows before it's real" idea instead of staying invisible until the
reviewer's own comment is placed. **This is deliberately a different trigger
than the removed placeholder above, not a reintroduction of it**: the
placeholder fired on bare `→` **navigation**, with zero reviewer input; this
one only creates anything once the reviewer takes a genuinely explicit action
— typing into the Claude composer and clicking "Stuur" — exactly the same
weight "Plaats…" already has.

- **`ensureClaudeAnchorForNew(state, commentTarget)`** (`RelatedPanel.mjs`) is
  the lazy-creation step, called from `sendClaudeMessageFromNew` (which
  `claudeChatCallbacks`' `onSend` uses instead of calling `sendClaudeMessage`
  directly). A no-op — returning `null`, changing
  nothing — unless `cs.focus === 'new'` **and** no anchor exists yet
  (`chatAnchorComment()`); once an anchor exists (including the one it just
  created) every later send is the ordinary, already-anchored path.
- It creates the ONE backing comment via the same `createComment(...)` the
  composer's own `placeComment` uses, anchored on the same `commentTarget()`
  unit, always **`local: true`** (never posted to GitHub — the reviewer
  hasn't confirmed any public-facing text by merely chatting with Claude) and
  with a body of **whatever is already typed** in the "Comment op deze
  regel" field, or `CLAUDE_ANCHOR_PLACEHOLDER`
  (`'(Nog geen eigen comment getypt — gesprek met Claude gestart.)'`) if that
  field is still empty. `createComment` itself already lands `cs.sel` on the
  fresh comment, so `chatAnchorComment()`/`selComment()` resolve to it
  immediately — no separate wiring needed for the panel to pick it up.
- **`toNew` resets the visible chat state** (`cc.commentId`/`messages`/`runId`/
  `status`/`progress`) whenever there is no existing anchor for the unit being
  composed on — without this, opening a brand-new composer right after
  viewing a DIFFERENT unit's conversation would keep showing that stale
  transcript (and, worse, let a later send act on its stale `runId`).
  An existing conversation on the exact unit being composed on
  (`chatAnchorComment()` already resolves it) is left alone.
- **`placeComment` never creates a SECOND comment once this anchor exists.**
  `claudeAutoAnchor` (`{draftKey}`, keyed the same way `composeDraftKey`/
  `composeDrafts` are) lets it recognize "this exact draft already has a real
  comment behind it" and, since there is no "edit body" Signal (a comment's
  body is fixed at Execution start), "updating" it means posting the
  reviewer's typed text as a **reply** on that same thread (the same Signal
  `sendReaction` uses) instead of starting a new Execution. The anchor's own
  local-ness (always `true`, fixed at creation) wins over `opts.local` here —
  chatting with Claude first already made this thread private, and there is
  no Signal to flip a comment from private to public after the fact.
  `claudeAutoAnchor` is cleared on every fresh `toNew` (a stale pointer from a
  different unit's draft must never be reused; `draftKeyFor`'s own
  unit-scoped compare in `placeComment` is a second safety net on top of
  that). **This take-over is no longer limited to the SAME session** —
  `placeComment` now looks the anchor up by IDENTITY
  (`placeholderAnchorFor(draftKey)`) rather than only trusting this ephemeral
  flag, so typing a first real comment on the same line in a LATER session
  (panel closed and reopened, or a fresh page load) takes over the existing
  placeholder too, instead of creating a second, unrelated comment right next
  to it. See "Overname zonder extra menu-item" in `comments-panel.md` for the
  full mechanism and why "Comment hiervan maken" still exists alongside it.

### `→` reaches the Claude composer directly from the still-open `'new'` field

Explicit reviewer request: typing "Comment op deze regel", reaching the end
of that field (caret has nowhere further right — `editableCaretCanMoveRight()`
in `home.mjs`) and pressing `→` should let the reviewer keep typing straight
into Claude, without first placing the comment. Before this,
`handleRelatedKey`'s `'new'`/`'comment'` `ArrowRight` case only handled
`cs.focus === 'comment'` — a bare `→` on the still-open composer was a no-op.

**`enterClaudeChatFromNew()`** (`RelatedPanel.mjs`) is the `'new'`-specific
counterpart of `enterClaudeChat`, called from that same `ArrowRight` case: it
sets `cs.focus = 'claude'` + `cs.claudePos = 0` and focuses the Claude
composer, same as `enterClaudeChat`, but **needs no anchor comment to already
exist** — unlike `enterClaudeChat`, it is never a no-op. `cc` is already
blank/idle (reset by `toNew`) and no fetch/SSE re-subscribe is needed
(`ClaudeChatPanel` already called `ensureChatEvents` on mount, while the
composer itself opened). Sending from there goes through the exact same
lazy-anchor path as "Bewerk code"/any other send from `'new'`
(`ensureClaudeAnchorForNew` above) — nothing new is created until the reviewer
actually sends a Claude message, not on this mere navigation step (same "must
not come back" guarantee as the removed placeholder, see "Product decision"
above).

**`claudeChatVisible()` needed a third branch for this to work at all.** The
moment `cs.focus` flips from `'new'` to `'claude'`, the existing
`cs.focus === 'new'` check no longer holds — and `hasVisibleComments()` is
still `false` (there genuinely is no comment yet) — so without a fix the whole
column, *including the very composer the keyboard just landed in*, vanished
one keypress after entering it (caught by this feature's own regression test,
not a hypothetical). `claudeChatVisible()` therefore ALSO returns `true` for
`cs.focus === 'claude' && cc.commentId == null` — the same "no anchor yet"
signal `toNewFocus`'s callers use below. An already-anchored conversation
(reached via the ordinary `enterClaudeChat`) always has `cc.commentId` set, so
this third branch can never keep a genuinely gone conversation visible.

**`isNewChatUnanchored()`** (`RelatedPanel.mjs`, private) names this exact
"`'new'`, or `'claude'` with no anchor yet" condition once, since four call
sites need it identically: `claudeChatVisible()` above,
`newCommentComposer`'s own visibility toggle, `ensureClaudeAnchorForNew`'s
guard (both below), and `activeComposeTargetHint`'s first branch (see "The
code card above the comment/Claude row" below) — see "Two bugs the → path
never actually exercised" for why letting these drift apart is exactly what
broke.

**Getting back out, with the draft intact.** `newCommentComposer`'s own
contents-root now toggles on `isNewChatUnanchored()`, not a bare
`cs.focus === 'new'` — so the composer stays **mounted and visible** the whole
time the reviewer is in the Claude composer with no anchor yet (see "Two bugs"
below; it used to unmount there). `composeDrafts` is still the source of
truth for the typed text (`@input` keeps it in sync), so **`toNewFocus()`**
(`RelatedPanel.mjs`) — the mirror of `toComment()`, back to `'new'` — still
re-prefills `comment-compose` from `composeDrafts.get(composeDraftKey)` as a
harmless belt-and-braces (the field never actually lost its value now that it
stays mounted), but does NOT touch `cc`/`warningOverride`/`claudeAutoAnchor`
(nothing about the anchor changed while the reviewer was in Claude, only the
DOM focus did). Reached from `handleRelatedKey`'s `cs.focus === 'claude'`
branch: **both `ArrowLeft` and `Escape`** check `cc.commentId == null` — the
signal that this conversation was entered via `enterClaudeChatFromNew` and has
no anchor yet (an already-anchored conversation always has `cc.commentId` set
synchronously by `ensureAndLoadChat`, before any keypress could follow) — and
call `toNewFocus()` instead of the ordinary `toComment()`/`exitRelated()`,
since there is no comment to land `'comment'` on.

### Two bugs the → path never actually exercised

Both found via a reviewer bug report with screenshots, not a hypothetical:
typing "Comment op deze regel", pressing `→` into Claude, showed a blank left
column, and sending from there did nothing at all.

1. **The comment column went blank the moment the keyboard reached
   Claude.** `newCommentComposer`'s contents-root toggled on a bare
   `cs.focus === 'new'`, so the composer unmounted as soon as
   `enterClaudeChatFromNew` flipped `cs.focus` to `'claude'` — even though
   `claudeChatVisible()`'s own third branch already keeps the *Claude* column
   showing in exactly that state. Fixed by toggling on the shared
   `isNewChatUnanchored()` predicate instead (see above), so the still-unplaced
   comment composer and the Claude column now appear/disappear together, as
   the reviewer expects from one merged card.
2. **A send FROM the Claude composer in that same state silently did
   nothing.** `ensureClaudeAnchorForNew`'s own guard was also a bare
   `cs.focus !== 'new'` — by the time the reviewer actually clicks "Stuur",
   `cs.focus` is already `'claude'` (that's the whole point of
   `enterClaudeChatFromNew`), so the guard always failed, the lazy anchor
   comment was never created, `cc.runId` stayed empty, and
   `sendClaudeMessage`'s own `if (!cc.runId) return` swallowed the click with
   no feedback. Fixed by using `isNewChatUnanchored()` here too.

Both existing regression tests for this flow only drove the composer via
Playwright's own `.fill()`/`.press('Enter')` directly on
`claude-chat-compose` **without** first navigating there via `→` (so
`cs.focus` stayed `'new'`, masking bug 2), or navigated via `→` but never sent
a message from there at all (only asserting navigation, masking both bugs).
Test: `tests/claude-chat-panel.spec.mjs`'s `"Chat over deze regel"` case below
covers both — it enters via the command below, asserts the comment composer
stays visible, then sends and asserts the anchor comment + reply both land.

### `Enter` → "Chat over deze regel" (`COMMANDS`, `home.mjs`)

A second entry point into the same unanchored state above, reviewer request:
chat with Claude about a line right away, without writing/placing a comment
first. **`startClaudeChat(commentTargetFn)`** (`RelatedPanel.mjs`, exported)
is the command's `run`: it calls `toNew(commentTargetFn)` (the exact same
setup `startComment` uses — resets `cs.focus` to `'new'`, the draft state, and
`cc` to blank/idle) and then immediately `enterClaudeChatFromNew()`, landing in
the identical state a `→` from the still-open field would — so every
behaviour documented on this page for that state (comment column staying
expanded, `←`/`Escape` via `toNewFocus()`, `↓` advancing to the next block, the
lazy anchor on first send) applies unchanged; nothing here is a separate code
path. Sits in `COMMANDS` directly after `"Comment op deze regel"`, see
"`Enter` — the block palette" in `.claude/docs/command-palette.md`.

**`↓` at `claudePos === 0` is deliberately UNCHANGED**, even reached this way:
it still releases the panel and advances to the next visible block's diff
(`advanceToNextBlockFromClaudeChat`, see "The chain, key by key" below) —
explicit reviewer answer, not the no-op an earlier draft of this feature
proposed. The still-unplaced draft is not lost by that: `composeDrafts` is
untouched by `exitRelated()`, so it is restored the next time "Comment op deze
regel" reopens on the same unit, exactly like leaving mid-type any other way.

Test: the "→ from the still-open new-comment composer reaches Claude directly"
case in `tests/claude-chat-panel.spec.mjs`.

### The chain, key by key

Before this section's redesign (see `todo/todo-claude-chat-blok.md` TODO 2),
`'thread'` was a horizontal `→` stop of its own — comment → thread → claude
took **two** `→` presses, and back took two `←`. `'thread'` is now a
**vertical** cursor reached only via `↑` from `'comment'`, exactly like
`'claude'`'s own `cs.claudePos` cursor — so one `→` reaches the chat directly
from either `'comment'` or `'thread'`, and one `←` returns directly to
`'comment'`.

- **`→` from the diff**: `hasVisibleComments() ? enterCommentsHead() :
  claudeChatVisible() ? enterClaudeChat(state.pr) : enterRelated()`
  (`home.mjs`'s `onKeydown`) — the middle branch only fires for the
  conversation-without-visible-comment case above.
- **`→` on `cs.focus === 'comment'` or `'thread'`**: both call
  `enterClaudeChat(cs.pr)` directly — a focused comment/thread always has its
  own comment, so this can never hit the no-op (`RelatedPanel.mjs`'s
  `handleRelatedKey`).
- **`→` on `cs.focus === 'new'`** (only once the caret is at the end of the
  still-open composer, see `editableCaretCanMoveRight()`): calls
  `enterClaudeChatFromNew()` instead — no anchor comment is required, see
  "`→` reaches the Claude composer directly from the still-open `'new'`
  field" above.
- **`↑` on `cs.focus === 'comment'`**: steps into `'thread'` at the newest
  bubble (`cs.threadPos = 1` — a conversation always has at least its own
  opening message) instead of moving to the previous conversation. **`↑` on
  `cs.focus === 'thread'`** keeps walking older messages
  (`cs.threadPos += 1`, clamped implicitly by the branch below) until the
  oldest message (`cs.threadPos === reactionCount()`); a further `↑` from
  there steps to the **previous** conversation (or exits to the diff, on the
  first one) instead of clamping — this is the one deliberate BEHAVIOUR
  CHANGE of TODO 2: `↑` in a conversation used to mean "previous
  conversation" and now means "older message in this conversation first,
  previous conversation only once you're past the oldest".
- **`↑`/`↓` on `cs.focus === 'claude'`**: walk the transcript exactly like
  `'thread'` walks reactions, via its own `cs.claudePos` cursor (mirrors
  `cs.threadPos`, 0 = composer, 1..n = the n-th turn from the bottom).
- **`↓` at `cs.claudePos === 0`** steps into the "Andere chats in deze PR" rung
  first (`cs.claudeTasksPos`, see the reorder note below), then the chat's
  **own code blocks** (`cs.previewPos`, see "`↓` walks the chat's own code
  blocks" below) — only once both are walked through (or when there is
  neither) does the "advance to the next block" behaviour below take over.
- **`↓` past the last code block** (nothing further to walk at all):
  **explicit request, deliberately NOT** the "↓ loopt door" convention
  `advanceFromComment` uses at the bottom of a comment thread — falling into
  the Onderliggende-code panel read as an unwanted extra "menu" in the way of
  continuing the review. `handleRelatedKey` instead calls `exitRelated()`
  (fully releases the panel focus, same as `Escape`) and returns the
  `'advance'` sentinel; `home.mjs`'s `onKeydown` then calls
  `advanceToNextBlockFromClaudeChat()`, which moves `state.selected` to the
  next VISIBLE block (`stepVisibleSelected(1)`, the same walker the sidebar's
  own `↓` uses — a no-op at the last block) and calls `enterDiff()` on it
  (resets drill/gran/change and re-aligns `<main>`'s scroll on its own). Since
  `cs.focus` is now `null`, `claudeChatVisible()`'s strict invariant (see
  above) means the just-left unit's Claude AND comment blocks disappear
  together the moment the keyboard sits on the new unit — there is no window
  where one lingers without the other. Test:
  `tests/claude-chat-panel.spec.mjs`'s "↓ at the bottom of the Claude chat
  advances to the next block…" case.
- **`←`/`Escape` on `cs.focus === 'claude'`**: step back directly to
  `cs.focus === 'comment'` (`toComment()`, which also resets `cs.threadPos` —
  `'thread'` is never visited on the way back) — unless this conversation has
  no anchor yet (`cc.commentId == null`, i.e. reached via
  `enterClaudeChatFromNew`), in which case they go to `toNewFocus()` instead,
  back to the still-open composer with its draft intact (see "`→` reaches the
  Claude composer directly from the still-open `'new'` field" above). Every
  OTHER way of reaching `'claude'` (`enterClaudeChat`) guarantees a comment
  already exists, so `cc.commentId` is never `null` there.

No new stop exists between `'code'` and `'claude'` — `→` has no meaning past
`'claude'` (nothing deeper); `↓` from there skips Onderliggende code entirely
and advances to the next block (see above). A dashed connector
(`data-testid=comment-claude-connector`,
the same look as the Onderliggende-code chip connector, `RelatedPanel.mjs`'s
`nestedChipColumn`) renders between the comment block and the Claude column
whenever `claudeChatVisible()` (`home.mjs`, next to the `ClaudeChatPanel(...)`
call) — built here rather than waiting for TODO 3 (the column-width pass),
which reuses it once the two columns sit side by side at their final widths.

### The code card above the comment/Claude row must follow the anchor into `'claude'` too

`activeComposeTargetHint` (`RelatedPanel.mjs`, feeds `composeTargetHint` — see
"The embedded Claude chat column" in `.claude/docs/detail-layout.md` for where
it renders, spanning the full width of `comment-claude-row`) used to only
check `cs.focus === 'new'` or `'comment'`/`'thread'`, so the code card
disappeared the moment `→` moved the keyboard from the comment/thread into its
own Claude conversation, even though nothing about the anchor changed (`→`
into an already-anchored `'claude'` never touches `cs.sel`, so
`selComment()`/`chatAnchorComment()` still resolve to the same comment).
Reported bug, not a hypothetical: reviewer screenshot showed the card
rendering above the comment column but vanishing the instant Claude got focus.

Fixed by widening both branches: the first now checks `isNewChatUnanchored()`
(its FOURTH call site, see above) instead of a bare `cs.focus === 'new'`, so
an unanchored `'claude'` (reached via `enterClaudeChatFromNew`/"Chat over deze
regel") still shows the live cursor's target exactly like the still-open `'new'`
composer does; the second now also matches `cs.focus === 'claude'` alongside
`'comment'`/`'thread'`, so an already-anchored conversation keeps its code card
visible the whole time it owns the keyboard. Test: the "code card above the
comment/Claude row stays visible after → into an anchored Claude conversation"
case in `tests/claude-chat-panel.spec.mjs`.

### The Claude column must follow the browsed comment, not just the last-entered one

`claudeChatVisible()` shows the column for **any** visible comment, regardless
of `cs.focus` — browsing with the keyboard still on the diff or on `'code'`
shows it too, not only `'comment'`/`'thread'`/`'claude'`. But until this fix
nothing ever refreshed `cc` when the reviewer merely moved `cs.sel` to a
DIFFERENT comment without explicitly entering `'claude'` (the only paths that
ever wrote `cc` were `enterClaudeChat`, `applyRelRestore`'s `'claude'` branch,
and `ensureClaudeAnchorForNew`) — so the column kept showing whichever
conversation was last entered, unrelated to whatever comment the reviewer had
since selected. Reported bug: selecting a second comment (an AI-controle
warning that never had a Claude conversation) while a DIFFERENT comment's
conversation was still loaded in `cc` kept showing that other, unrelated
transcript instead of the empty state the newly selected comment deserves.

**`syncClaudeAnchorForSelection()`** (`RelatedPanel.mjs`, module-level
`watch(() => [cs.sel, cs.focus, cs.list, cs.scopeSig],
syncClaudeAnchorForSelection)`, deps listed inline per the arrow.js `watch`
pitfall) keeps `cc` matched to `chatAnchorComment()` passively:

- **Skips entirely while `cs.focus === 'claude'` or `'new'`** — those two
  already own `cc` completely (`enterClaudeChat`/`applyRelRestore`/
  `ensureClaudeAnchorForNew`, resp. `toNew`) and this passive sync must never
  race or fight with them. Every other focus (`null`, `'code'`,
  `'comment'`, `'thread'`) falls through to the sync.
- **No-ops when the resolved anchor's id already matches `cc.commentId`** —
  so stepping `←`/`Escape` out of an anchored `'claude'` conversation back to
  `'comment'` (unchanged `cs.sel`) costs nothing extra.
- **Never calls `ensureAndLoadChat`** (the idempotent-but-CREATING
  `POST /api/workflows/claude_chat`) — merely browsing the comment list must
  not spin up a `claude_chat` Execution for a comment nobody has chatted
  about yet, the same "nothing auto-creates a conversation" invariant as the
  removed placeholder comment (see "Product decision" above). It always does
  a plain read-only `GET` instead (`loadChatMessages`/`loadChatProgress`) and
  lets the response decide: `GET /api/chat?commentId=` is safe and
  side-effect-free even for a comment that never had a conversation at all
  (`tasks_api.go`'s `handleChat` just returns an empty `messages` array), so
  there is no need to gate this on `cc.conversations` first. That set is only
  refreshed on the comment poll's own cadence (`loadChatConversations`) and
  can lag behind a conversation the reviewer just started in THIS tab — an
  earlier version of this fix gated on it and briefly treated a real,
  just-created conversation as nonexistent when switching straight back to it.
- **Calls `loadChatMessages(nextId, false)`** — the `applyDrafts = false` arg
  skips `applyPendingDraftReplies` for this preload specifically. Without it,
  a comment whose conversation already carries an unread `chat.KindDraftReply`
  turn (see "A `reply` directive only drafts, never posts" above) would have
  Claude's drafted text silently written into `reaction-compose` the instant
  the reviewer merely SELECTS the comment — before they've had any chance to
  type (or decide not to type) their own reply — breaking rule 3's "an
  already-typed reviewer draft is never overwritten" ordering the moment the
  reviewer's own keystrokes land after that eager write. Every explicit
  "the reviewer is actually looking at/using this conversation" caller
  (`ensureAndLoadChat`, `applyRelRestore`, the `chat.message` SSE handler, the
  resync) keeps the default `applyDrafts = true` — the merge still happens the
  moment `'claude'` is actually entered, same as before this fix.
- **`cs.scopeSig`** (not `cs.scope` itself, a fresh object every
  `setCommentScope` call) is in the dependency list so a bare block switch —
  which changes which comment is "current" via `recomputeView`'s
  reassignment of `cs.view`, without necessarily touching `cs.sel`/`cs.list`
  — also re-fires this sync; `cs.list` alone is not enough for that case.

Test: the "the Claude column blanks when browsing to a comment with no
conversation, and loads read-only for one that has one" case in
`tests/claude-chat-panel.spec.mjs`.

### A genuine block switch must also release a `cs.focus === 'claude'` panel

`syncClaudeAnchorForSelection` above deliberately skips its own re-sync while
`cs.focus === 'claude'` (so it never fights with an active conversation) —
but that guard is exactly why a SECOND gap survived that fix: chatting with
Claude on block A's comment (`cs.focus === 'claude'`) and then landing on a
completely different block B via a plain mouse click on the sidebar — not one
of the dedicated exits that already release the panel (`→`/`←`/`Escape`, `↓`
at the bottom of the Claude chat, see "The chain, key by key" above) — left
`cs.focus` stuck at `'claude'`. Block B's Claude column then kept showing
block A's stale transcript (or, if B had its own conversation, never picked
it up) instead of B's own state. Reported bug, distinct from the one above:
that one was about switching COMMENTS within the same block/scope; this one
is about switching BLOCKS while the keyboard was still inside the panel.

Fixed in `home.mjs`, not `RelatedPanel.mjs`: the existing `watch(() =>
state.selected, …)` (which already resets `cancelPrCommentReply`/
`exitPrCommentThread` on every selection change, and —
scoped to a comment-index item only — `leaveRelated()`, see "Fix Enter being
swallowed in the PR-comment Claude composer") now ALSO calls `leaveRelated()`
on a genuine switch to a different ORDINARY block. Once `cs.focus` is back to
`null`, `syncClaudeAnchorForSelection`'s existing guard no longer blocks it,
and the passive sync picks up block B's own anchor (or empty state) exactly
like the comment-switch case above.

**Identity-based, not index-based** — the same reason the comment-index
branch stays scoped to that one kind (see its own doc comment in `home.mjs`):
`recomputeLeftList` can legitimately reindex the CURRENT, still-logically-
unchanged block out from under a background reload (a landed comment
shifting every row by one — see conventions.md's "Snapshot a selection by
stable ID, never by raw array index"), and a bare index compare would
misread that reindex as a real navigation move — this exact failure mode is
what `tests/comment-nav-race.spec.mjs` guards against, and a first attempt at
a blanket `state.selected` reset broke it. `lastSelectedBlockRef` (plain
module state in `home.mjs`, not reactive) tracks the previously-selected
block's own stable `file:line`/`.id` (mirroring `state.blockRef`'s own
computation, kept separate so this doesn't depend on cross-watch ordering)
and only calls `leaveRelated()` when that identity actually changes.

**The very first real block observed is a baseline, never a "change"** —
this watch's callback can run more than once while `state.blocks` is still
loading (`state.selected` itself moving before blocks arrive), every time
with no block yet; recording a baseline THEN would make the tick that
finally sees a real block look like a change and fire `leaveRelated()`,
clobbering a `cs.focus` that `bindUrlState`/`applyRelRestore` already
restored from the URL (`rel.foc=new`/`code`/…) around that same moment —
regression caught by `tests/urlstate.spec.mjs`'s `rel.foc` round-trip tests
and `tests/inline-comments.spec.mjs`'s fresh-composer test. So the baseline
is only recorded once a real block (`b` truthy) is actually seen; every tick
before that is a no-op.

Test: the "a mouse click straight onto a different block releases a stale
claude-focused panel, not just the dedicated exits" case in
`tests/claude-chat-panel.spec.mjs`.

**Third reported bug in the same family: RETURNING to the exact same
ordinary block after a comment-index item's own chat left `cs.focus` stuck
too.** `lastSelectedBlockRef` is deliberately never touched while a
comment/comment_group item is selected (see "identity-based" above — that
branch is scoped to itself on purpose), so block A → a PR-wide comment
elsewhere → chat with ITS conversation → back to block A read as
`ref === lastSelectedBlockRef` (unchanged) and skipped `leaveRelated()`
entirely, even though the comment's own chat had since moved `cs.focus` to
`'claude'`. A real reviewer only hits this returning to the IDENTICAL block
visited right before the comment — any other block already worked, since its
`ref` differs. `visitedCommentSinceOrdinary` (plain module state next to
`lastSelectedBlockRef`) is set whenever the comment branch runs and cleared
once the ordinary branch runs again; the ordinary branch's condition widened
from `ref !== lastSelectedBlockRef` to
`ref !== lastSelectedBlockRef || visitedCommentSinceOrdinary`, so a comment
visit in between always forces `leaveRelated()` on the next ordinary
selection, unchanged ref or not — the `lastSelectedBlockRef !== undefined`
"no baseline yet" guard itself is untouched. Test:
`tests/related-panel-stale-claude-after-comment.spec.mjs`.

### The chat column is a function of the selected code (this REPLACED "stay open while a turn is running")

**Read this before "fixing" a running turn that disappears from view — that is
the intended behaviour, not a bug.**

There used to be a rule that the fully opened-out conversation stayed visible
for as long as a turn was running for it, even after navigating to a different
block/comment or explicitly closing the panel: `hasActiveClaudeTurn()` was a
third, standalone `||` branch of `claudeChatVisible()`, and
`syncClaudeAnchorForSelection` skipped its own re-sync while it was true.

The reviewer reversed that, in his own words: *"een comment is gekoppeld aan
code, chat aan comment, zo is een chat altijd gekoppeld aan code. laat het
alleen in beeld als code is geselecteerd waar die chat over gaat. als ik
navigeer naar andere code, haal het dan helemaal weg alsof er nog geen chat is
(als daar nog niks aan is gekoppeld)."*

So the column is **purely a function of the selected code**:

- `claudeChatVisible()` is back to `hasVisibleComments() || isPrCommentScope()
  || isNewChatUnanchored()` — a running turn is **not** a reason to render it.
  Navigate to code with nothing hanging on it and the whole
  `comment-claude-row` folds away exactly as if no conversation existed.
- `syncClaudeAnchorForSelection` no longer skips while a turn runs, so walking
  back onto that code re-anchors `cc` to its own conversation (and its answer)
  the ordinary passive way. It still skips for `cs.focus === 'claude'/'new'`,
  which own `cc` themselves.

That reversal is only affordable because the turn itself no longer lives on
`cc`: it is tracked per conversation (see "Parallel conversations" below), so
hiding the column costs nothing, and a turn running on code the reviewer is
**not** looking at reports itself on that code's own index row
(`claudeChatPill`). Before, hiding the column really did lose the turn, which
is what the old rule was working around.

Test: the "the Claude column is a function of the selected code: navigating
away hides it, the index row keeps reporting the running turn" case in
`tests/claude-chat-panel.spec.mjs` — the inverted successor of the old
"stays open" test, same fixture and same mocked frames.

#### One narrow exception: the re-anchor pass orphaning the OPEN conversation's own anchor, without any navigation

`claudeChatVisible()` (`RelatedPanel.mjs`) got a fourth `||` branch,
`isActiveAnchorGoneFromView()` — read that function's own doc comment for the
mechanism and the live PR (13451) it was diagnosed against. Short version:
`hasVisibleComments()` reads `cs.view`, which `recomputeView` unconditionally
drops an ORPHANED comment from (`isOrphanComment` — `reanchor.go`'s re-anchor
pass couldn't re-find the code a comment's row anchor was placed on, e.g. a
commit elsewhere renamed the method). While the reviewer was mid-conversation
(`cs.focus === 'claude'`) on the exact SAME unit the whole time — no
navigation, no `←`/click elsewhere — that reclassification landing via the
ordinary comment poll made the entire `comment-claude-row` (with a half-typed,
unsent message in it) vanish a few seconds after entering it, replaced by the
Underlying-code panel. That does NOT fall under "navigate to code with
nothing hanging on it, hide it": `cs.focus` only ever leaves `'claude'` via an
explicit `leaveRelated()`/block switch (`lastSelectedBlockRef`, `home.mjs`),
so `cs.focus === 'claude'` already proves the reviewer never left. The new
branch keeps the column visible for exactly this case — `cs.focus ===
'claude'` and the anchor still resolves through the UNFILTERED `cs.list` (via
`ccAnchorComment()`, which already exists for the analogous "don't trust the
possibly-stale filtered index while `cc.focus` is `'claude'`" reason) — and
for nothing else: navigating away still clears `cs.focus`, so the reversal
above still holds for every ordinary case.

## Parallel conversations: a second chat while the first is still answering

Reviewer report: *"ik wil kunnen chatten en terwijl ik op antwoord wacht, een
andere chat (op een andere selectie) kunnen starten, nu raak ik die chat weer
kwijt."*

The backend was never the limitation — every conversation is its own Execution
with its own Run ID (`chat-<commentID>`) and tembed locks **per run**, each has
its own shadow worktree, and `chat_progress.go` keys its snapshot per
conversation. It was entirely this panel: `cc.busy` and `cc.progress` were a
**single slot** for whichever conversation happened to be in view, which broke
two different ways at once.

- **`cc.busy` gated the composer of a DIFFERENT conversation.**
  `queueClaudeMessage` reads "is a turn running", so the very first message of
  conversation B was appended to `cc.queued` (the "doorpraten" queue, meant for
  one conversation) and only left the browser once A's turn returned. You could
  not start a second chat at all — you could only pre-type into it.
- **A non-anchored conversation's events were dropped on the floor.** Both SSE
  handlers began with `if (ev.key !== cc.commentId) return`, so A's live
  status, its streamed answer and its "the transcript changed" event produced
  nothing anywhere once the panel had moved on.

### `src/claudeTurns.mjs` — one shared, per-conversation registry

A small shared store in the mould of `commentBatch.mjs` (one `reactive()`
object plus its own read-only fetch, imports no component — which is also what
keeps `BlockList.mjs` from having to import `RelatedPanel.mjs` back, a cycle,
since that file already imports `BlockList.mjs`). Per conversation id it holds

- **`progress`** — the volatile snapshot pushed over `chat.progress`, for
  **every** conversation of this PR, not just the one on screen,
- **`busy`** — a Signal POST for that conversation is in flight,
- **`answered`** — a turn FINISHED while the reviewer was looking at other
  code, so there is something new to go read (a property of this tab, never of
  the server),
- **`sendError`** — the reviewer-facing sentence for that conversation's LAST
  rejected/failed Signal POST, `''` once accepted — added in a follow-up (see
  "A rejected send must survive navigating away" below); not part of the
  original `db0e5f7` registry,
- plus **`scopes`**: conversation id → the `file|label` of the code its comment
  hangs on, handed over by `loadComments` on the comment poll's own cadence
  (`RelatedPanel.mjs` owns the comment list, this store owns the turns).

An entry with nothing left to say is deleted, so the map stays the size of
"what is happening now". `setTurnProgress` also stamps a non-reactive
`progressAt` per conversation, which is what lets a resync read yield to a
newer pushed event (`lastTurnProgressAt`, see below) — the same rule
`loadChatProgress` already followed, now shared by both readers.

In `RelatedPanel.mjs` every former `cc.busy`/`cc.progress`/`cc.sendError` read
goes through **`ccBusy()`/`ccProgress()`/`ccSendError()`** — the registry
narrowed to `cc.commentId` — so the panel keeps behaving exactly as before
*for the conversation it shows*,
and `hasActiveClaudeTurn()` is now strictly about that one conversation (its
remaining job is the footer status line). `drainClaudeQueue` drains **the
oldest entry of every conversation that has nothing in flight**, so two
conversations queue independently while each stays FIFO in itself; entries
already carried their own `runId`/`commentId`.

Both SSE handlers now accept every key. `chat.progress` for a foreign
conversation is stored (that is the pill's data); its `running:false` frame
clears the snapshot immediately — there is no bubble to protect — and marks the
conversation **answered**. `chat.message` still only ever refetches the
transcript of the conversation in view (the rule "an event is never the source
of truth" is unchanged); for a foreign one it only marks `answered`, and only
when we already knew a turn was happening there, so an unrelated transcript
write can't raise a pill out of nowhere. Anchoring a conversation
(`syncClaudeAnchorForSelection`/`ensureAndLoadChat`) clears its `answered`
mark: looking at it counts as seeing it.

**`GET /api/chat/progress?pr=N`** is the PR-wide resync read
(`runningChatProgressForPR`, `chat_progress.go` — the snapshot now carries its
own repo/pr in two unexported fields purely so it can be filtered; the pushed
frame's shape is unchanged). The per-conversation read only covers the
conversation in view, so without this a refresh or an SSE reconnect mid-turn
would silently drop the pill of a turn running on other code. Same in-memory,
outside-the-write-boundary carve-out as the rest of `chat_progress.go`; it
yields to newer pushed events per conversation, which matters because a
reconnecting stream resyncs every few hundred ms (that exact interaction made
`claude-chat-progress.spec.mjs` flicker until the guard was added).

### Where a turn on OTHER code is visible: the index row, not the footer

`claudeChatPill` (`BlockList.mjs`, `data-testid=block-row-claude-chat`) sits in
the right-hand zone of the index row, next to `batchPill`/
`commentActivityPill`/`approvalPill` — explicitly where the reviewer asked for
it ("In de rechterkant van code, naast avatar en 1/2 approved enzo"), not as an
extra footer line. Two states, both in **words** with a differing shape (a
pulsing dot while busy, a ✓ once answered) and colour only as decoration, per
the colourblind rule: **"Claude bezig"** (a turn is running for a conversation
on this row's code) and **"✓ Claude antwoordde"** (a turn finished while the
reviewer was elsewhere). It matches a comment-index row on its own comment id
and an ordinary code row through `scopes`' `file|label`, and it reads the
reactive store straight from its own nested slot — no `state.*` rollup and no
watch of its own, exactly like `batchPill`.

### "Selected: …" plus a navigable list of other running conversations, in the footer

`claudeChatPill` above answers "is a turn running on THIS row's code"; it does
not say WHICH conversation is currently open, nor let the reviewer reach
another running one directly from inside the chat they're already in.
Reviewer request: a line naming the conversation currently in view, plus,
"als er andere claude dingen bezig zijn", their titles — navigable, Enter to
jump to one.

Both live in `CommentClaudeFooter` (`RelatedPanel.mjs`), the same shared
status bar `claude-chat-status` already sits in. The title source went
through a second iteration: the FIRST cut used the underlying comment
thread's own last message (`chatTaskTitle(c)`), which read as unusable the
moment the anchor was still the auto-created placeholder — "Selected: (Nog
geen eigen comment getypt — gesprek met Claude gestart." (a real reviewer
screenshot/report). Replaced by **the reviewer's own last message in the
Claude conversation itself, one sentence**:

- **`firstSentence(text)`** — a small heuristic, not a real tokenizer: trims,
  collapses whitespace/newlines, and cuts at the first `.`/`!`/`?` followed by
  whitespace or the string's end; an 80-char cap is the fallback for a
  sentence with no punctuation at all.
- **`ownMessageTitle(messages, c)`** — the newest entry of `messages` with
  `role === 'user'` (never Claude's own answer), `firstSentence`'d. Falls back
  to the anchor comment's own text (also `firstSentence`'d) when nothing has
  been typed into Claude yet but the comment itself is real, i.e. NOT the
  auto-created anchor placeholder (`isChatAnchorPlaceholder`) — that
  placeholder sentence is exactly the unusable text from the report above, so
  it is never shown. Returns `''` when there is genuinely nothing of the
  reviewer's own to show yet; every caller decides for itself what "nothing"
  means for that context (see the two bullets right below).
- **The "Selected: …" line** (`data-testid=claude-selected-line`) is
  `ownMessageTitle(cc.messages, ccAnchorComment())` — `cc.messages` is
  already loaded for whichever ONE conversation is currently anchored/shown
  here, regardless of `cs.focus` (so it also shows while the diff still owns
  the keyboard and a turn is merely running in the background). **Renders
  nothing at all** (not the placeholder, not a "nieuw gesprek" filler — an
  explicit reviewer answer) when `ownMessageTitle` comes back empty; the rest
  of the footer (the status line, the task list) stays visible regardless.
- **`otherClaudeChats()`** is **every OTHER chat of this PR**, not only the
  ones with a turn running right now. Reviewer report on the earlier,
  running-only behaviour: *"ik zie maar 1 andere chat, maar er zijn veel meer
  chats bezig op dat moment ... laat een hele lijst zien van alle chats"*,
  answered with *"alle chats van deze pr en chats die ik nog niet x seconden
  heb bekeken (ik denk 5 seconden)"*. So the sources are, in this order:
  `runningTurnIds(excludeId)` (a turn running right now, PR-wide),
  `recentlyFinishedTurnIds(excludeId)` (one that just stopped — both of these
  first so a turn is never missed while `cc.conversations` is still catching
  up on the comment poll's own cadence), then **every conversation of this
  PR**: `cc.conversations` (the durable "here a Claude conversation really
  happened" set, `ConversationsWithMessages`) plus this PR's own
  `isGeneralChatAnchor` — exactly the source `openChatComments`' index section
  already uses. Each id is resolved against `cs.list` into a real comment
  object; an id whose comment hasn't loaded yet is simply skipped, never shown
  as a blank row. The anchored conversation (the "Selected: …" line) is
  excluded. It is also the ONE trigger point for `ensureOtherTaskTitle` below
  — it already runs on every render that needs the list, and that call is
  self-deduping, so no separate watch/poller exists just to kick fetches off.
- **`chatStateOf(c)` is both the row's own word and the list's sort order**:
  `'busy'` (a Signal POST in flight, or `progress.running`) → `'done'` (inside
  `isTurnRecentlyFinished`'s 2-minute window) → `'unread'` (there is an answer
  the reviewer has NOT dwelt on for the full 5s yet, `isChatUnread`) →
  `'seen'`. `CHAT_STATE_RANK` sorts by exactly that (a stable sort, so a row
  only moves when its own state really changes). **This is what implements the
  "nog niet x seconden bekeken" criterion**: the 5s dwell
  (`scheduleChatSeenDwell` → the durable `seen_at`, see "Marking it read")
  is what sinks a chat to the bottom as `'bekeken'`; anything with an unseen
  answer stays up top as `'nieuw'`. It also REPLACED the old hard 2-minute
  linger as the *inclusion* rule — a finished chat no longer vanishes from the
  list at all, it only changes its word (see "A finished task lingers for 2
  minutes" below, which now only owns the `'done'` word).
- **`MAX_CHAT_ROWS` (12) caps the rendered rows**, with the remainder as one
  plain, non-navigable "+n meer" line (`claudeMoreChatsNote`,
  `data-testid=claude-more-chats`) — the cap is applied AFTER the sort, so a
  chat with an unseen answer can rise into view, and
  `ensureOtherTaskTitle`/the unread state are therefore ensured for the WHOLE
  list, not only the visible slice. A PR-wide list has no natural bound any
  more now that it isn't limited to running turns, and both the footer height
  and the ↓/↑ rung walking these rows have to stay usable.
- **The unread flag rides along on the title fetch, not a second GET**:
  `ensureOtherTaskTitle`'s own `GET /api/chat?commentId=` payload already
  carries `messages` + `seenAt`, so it calls `setChatUnread(c.id,
  unreadFromTranscript(json))` from the same response instead of letting
  `ensureChatUnread` (`chatUnread.mjs`) fetch the identical transcript again.
  Same cache, same invalidation: the `chat.message` SSE handler already drops
  both entries together.
- **One extra resync so a chat busy in ANOTHER tab shows up**:
  `loadRunningTurns(pr)` used to run only on SSE (re)connect, so a turn
  started elsewhere (or one whose `chat.progress` frame this tab missed) stayed
  invisible until the next reconnect — part of the same "er zijn veel meer
  chats bezig dan ik zie" report. It now also rides along with `loadComments`'
  own 5s poll, next to `loadChatConversations(pr)`: one extra read-only,
  in-memory-backed GET per poll (see `.claude/docs/server-events.md`).
- **`ccAnchorComment()` (`RelatedPanel.mjs`), not a bare `chatAnchorComment()`,
  is what both of the above resolve the excluded/"Selected" id through** —
  fixed after a reported bug: a running conversation's OWN title/status
  appeared a second time under "Andere chats in deze PR", right next to
  the identical "Selected: …" line, with a Jump link that (harmlessly)
  navigated right back to the same conversation. `chatAnchorComment()`
  resolves via `selComment()` = `visibleComments()[cs.sel]` — `cs.sel` is a
  raw **index** into the (block-scoped) comment list (see conventions.md's
  "Snapshot a selection by stable ID, never by raw array index"), and
  `syncClaudeAnchorForSelection` deliberately does **not** resync `cc` while
  `cs.focus === 'claude'` (it must not fight an active conversation — see
  "Parallel conversations" above). So a comment-poll reorder while the
  reviewer is mid-chat (a new comment on the same block landing ahead of the
  one selected, shifting every index) can leave `cs.sel` pointing at a
  DIFFERENT comment than the one `cc` is still anchored to, without moving
  `cc` at all — and excluding by that stale, index-derived id failed to
  exclude the real, still-open conversation. `ccAnchorComment()` instead
  resolves the comment for the STABLE `cc.commentId` (falling back to
  `chatAnchorComment()` only while nothing is anchored yet, i.e.
  `cc.commentId == null` — the ordinary browsing state, where the two
  reliably agree anyway). Test:
  `tests/claude-other-tasks-reorder.spec.mjs`.
- **Visibility widened accordingly**: `hasCommentClaudeFooter()` now also
  returns `true` whenever `otherClaudeChats().length > 0` — "zodra er
  iets elders loopt, ook als de huidige conversatie zelf niets aan het doen
  is" (explicit reviewer answer) — so the footer (and the whole
  `comment-claude-row` card around it) can show even when the conversation on
  screen is completely idle.
- **The list itself** (`data-testid=claude-other-tasks`, header *"Andere chats
  in deze PR (n):"*, rows `data-testid=claude-task-row` carrying
  `data-state`) renders each chat's title (see `otherTaskTitleFor` below) plus
  its own state as a WORD — the live `claudeStatusText(turnProgress(c.id), 0)`
  for `'busy'`, otherwise "Klaar"/"nieuw"/"bekeken" — each with its own glyph
  (a pulsing dot, ✓, !, ○), per the colourblind rule.
- **Layout, reported bug**: the state text used to be `shrink-0` while the
  title could shrink, so a long status ("Claude leest &lt;full worktree
  path&gt;") pushed the title to zero width and the row read as a bare path
  with no idea which chat it was. The title now takes the flexible half
  (`min-w-0 flex-1 truncate`) and the state text is the one that truncates,
  capped at `max-w-[45%]`.

**The task-list title needs a DIFFERENT conversation's `role: 'user'`
message, which `cc.messages` never holds — the panel only ever keeps ONE
transcript loaded at a time** (see "Parallel conversations" below). Explicit
reviewer decision, cost accepted: fetch each running task's own transcript,
cached and invalidated as cheaply as reasonable, no new heavyweight
mechanism:

- **`otherTaskTitles`** (`reactive({ byId: {} })`) is a per-conversation
  title cache, reassigned as a whole object on every update — mirrors
  `claudeTurns.mjs`'s own `turns.byId` pattern. `undefined` = never fetched;
  an explicit `''` is itself a valid "fetched, nothing of the reviewer's own"
  result, told apart from "never fetched" in `ensureOtherTaskTitle`'s own
  guard.
- **`ensureOtherTaskTitle(c)`** — a plain (non-reactive) `Set`
  (`otherTaskTitlesFetching`) de-dupes a repeated call for the same id (which
  happens on every render, since `otherClaudeChats()` calls it
  unconditionally); the actual fetch is the same read-only
  `GET /api/chat?commentId=` `loadChatMessages` already uses, reduced through
  `ownMessageTitle`.
- **Invalidation reuses the existing `chat.message` SSE handler**
  (`ensureChatEvents`, the branch for a conversation that is NOT the one in
  view): alongside its existing `markTurnAnswered`, it now also drops
  `otherTaskTitles.byId[ev.key]` — the next render's `ensureOtherTaskTitle`
  then refetches on demand. "Alleen opnieuw ophalen als er iets veranderd
  is" holds without a poller of its own, since `chat.message` fires exactly
  when that conversation's transcript actually changed.
- **`otherTaskTitleFor(c)`** — `claudeTaskRow`'s own title getter:
  `otherTaskTitles.byId[c.id] || chatTaskTitle(c)`. The empty-string case
  falls through to `chatTaskTitle(c)` (the OLD thread-based title) on
  purpose — the same as "not fetched yet". This is the **one deliberate
  asymmetry** with the "Selected: …" line above (which hides entirely on
  nothing-sensible instead, an explicit reviewer answer): a list row
  represents a conversation that is genuinely running right now and must
  always show SOMETHING, unlike a label that can simply not exist.

**Keyboard: a nested rung right below the composer, walked BEFORE the
code-preview cards** (originally landed as "a new nested rung at the END of
the existing `'claude'` chain", per the reviewer's own answer at the time:
"een nieuwe geneste stop in de nav-keten, die je bereikt na de laatste
bestaande stap; daar doen ↑/↓ + Enter hun gewone werk" — since **reordered**
on a follow-up reviewer report, see the paragraph right below), not a new key
or a parallel mode. `cs.claudeTasksPos` (0 = not there, 1..n = the n-th other
task, top to bottom — mirrors `cs.previewPos`'s own counting) is reached by
`↓` at the rest position **first**, before `cs.previewPos` starts walking the
code-preview cards; `↑` from `claudeTasksPos === 1` walks back onto the
composer (or, if `cs.previewPos` is itself mid-walk, that continues first —
see the reorder note below). `↓` past the last task moves onto the first
code-preview card (or, with none, falls through to the pre-existing
`exitRelated()`/`'advance'` exit) — nothing about "↓ never dead-ends into
Onderliggende code" (see "the chain, key by key" above) changes, only the
relative order of these two rungs. Highlight mirrors `claudeQuestionOptions`'
own convention exactly: a ring **plus** a leading `› ` glyph, never colour
alone.

**Reordered: "Andere chats in deze PR" now comes BEFORE the code-preview cards, not
after.** Originally landed the other way around (`cs.previewPos` walked
first, `cs.claudeTasksPos` only reachable once every code-preview card had
been walked past) — reviewer report: *"ook elders bezig kan ik pas selecteren
nadat ik gegenereerde codeblokken (van chat) naar beneden heb gedrukt. ik wil
dat na de chat het [Andere chats in deze PR] geselecteerd [wordt], en pas als ik
daarna naar beneden ga, het de gegenereerde codeblokken selecteert (en
daarna onderliggende blokken)"* — i.e. the reachable order must match the
on-screen order, where "Andere chats in deze PR" renders **above** the code-preview
cards (see `CommentClaudeFooter`/`claude-other-tasks` above them in the DOM).
Fixed by swapping the two `if` branches in `handleRelatedKey`'s `'claude'`
case for both `ArrowDown` (walk `cs.claudeTasksPos` to completion before
`cs.previewPos` starts) and, mirrored, `ArrowUp` (walk `cs.previewPos` back
down to 0 before `cs.claudeTasksPos` starts unwinding — whichever rung `↓`
visits LAST is the one `↑` leaves FIRST), plus `advanceFromComment`'s own
entry point (↓ from the bottom of the last comment thread now also checks
`otherClaudeChats().length > 0` before `codePreviewCount() > 0`).

**A latent "two things active at once" bug surfaced by this reorder, fixed in
the same change:** neither cursor was ever reset to 0 when the walk crossed
from one rung into the other — each card's/row's own `data-active` binding
(`CodePreviewPanel`'s `cs.previewPos === i + 1`, `claudeTaskRow`'s
`cs.claudeTasksPos === i + 1`) only checks its OWN cursor, so a stale
non-zero leftover on the rung just left kept its last item marked active
too, alongside the newly active item in the other rung. Unnoticed before
because no existing test combined "a unit with its own code-preview card"
AND "another conversation running elsewhere in the same PR" in the same walk
— see `tests/claude-other-tasks-before-codeblocks.spec.mjs`. Fix:
`cs.claudeTasksPos` is explicitly zeroed the moment `cs.previewPos` starts
moving (`ArrowDown`), and `cs.claudeTasksPos` is explicitly restored to
`otherClaudeChats().length` (not read from a stale leftover) when
`cs.previewPos` unwinds back past its first card (`ArrowUp`) — mirrors
`codeFromClaudeTailPreviewPos`'s own "capture/restore explicitly, never trust
a value you didn't just set" reasoning above.
`selectHighlightedClaudeTask()`/`activateClaudeTask(c)` are Enter's/a click's
shared action (`home.mjs`'s `onKeydown` calls the former right next to
`selectHighlightedClaudeOption`, mirroring its own shape) — mouse-
navigation.md's rule that a click runs the same function a key runs.

**The actual jump needs `state` (block selection) and `jumpToCommentRow`
(comment-index rows can still be a poll tick away) — both belong to
`home.mjs`, which `RelatedPanel.mjs` never imports state from.**
`setClaudeTaskJump(fn)` registers `home.mjs`'s `jumpToClaudeConversation(c)`
once at module load (the same one-shot wiring shape as `setPrRepo`), so
`activateClaudeTask` can call it without a new import cycle. The general chat
(`isGeneralChatAnchor`) is checked FIRST — see "Two more origins the jump used
to silently drop" below. A comment carrying its own `kind` **or** an ORPHAN
comment (`isOrphanComment(c)` — its block was renamed/removed since,
reanchor.go's `AnchorOrphan`; see "A third dead end" below) is a PR-wide/
comment-index row, landed via `jumpToCommentRow`; anything else is an ordinary
inline comment anchored to a real block, landed via `openTask`'s own
file/label lookup (test_class rows, and — see below — a block reachable only
as an Onderliggende-code child, included) — then `enterClaudeChat` takes the
keyboard the rest of the way in both cases. Best-effort throughout, like
`openTask` itself: a stale/racy jump (the row/comment gone by the time an
`await` resolves) simply does nothing further.

### Two more origins the jump used to silently drop

A reviewer-driven audit of every place a chat can be started from ("test dat
onderwerp goed door") found two dead ends in `jumpToClaudeConversation` — the
row rendered, was clickable, and did nothing.

- **The general chat.** Its anchor comment carries a truthy `kind` ('issue',
  the plain PR-wide comment shape — see `isGeneralChatAnchor`/
  `openChatComments` above), which used to route it into the ordinary
  `jumpToCommentRow('comment:' + id)` branch. But a general-chat anchor is
  deliberately EXCLUDED from `indexComments`/`commentBlockItem`
  (`isChatAnchorPlaceholder`, see "Product decision" above) — it only ever
  gets a `'chat:'`-prefixed row (`chatBlockItem`, "Openstaande chats" below),
  never a `'comment:'`-prefixed one, so that ref could never resolve.
  `jumpToClaudeConversation` now checks `isGeneralChatAnchor(c)` FIRST and
  calls `openGeneralChat()` — the same one entry point the `/`-menu item and
  the "Openstaande chats" row's own `→` already use — instead of falling
  through to the ordinary branch.
- **A comment anchored to a real, changed PR block that has no place of its
  own in `state.blocks`** — a resolved-method-call target or a covering test,
  reachable only by drilling into Onderliggende code from some ancestor (see
  `jumpToBlockOwnPlace`'s own doc comment in `drilling.md` for "no own
  place"). `openTask` only ever searched `state.blocks`/a `test_class` row's
  methods, so it silently gave up (`idx < 0 → return`) for exactly this case.
  **`openTaskDrilledAnchor(c, runId)`** (`home.mjs`) is `openTask`'s fallback
  for that dead end: it resolves the anchor via `commentAnchorBlock(c)`
  (`state.allBlocks`, not `state.blocks`) and, once found, applies the exact
  same drilled-anchor trick `openCommentAnchorDrill` already uses for a
  comment-index item anchored to such a block — `state.drill = [anchor]`,
  a cursor from `commentAnchorCursor`, `state.focusLevel = 1` — minus that
  function's own "leave `state.selected` on the comment row" trick: there is
  no comment-index row here, this is reached directly from a "Taken" row or
  an "Andere chats" jump. **`otherPlaceAnchorId`** (a plain, non-reactive id,
  declared next to `commentAnchorDrillFor` in `home.mjs` — before the
  `state.selected` watch, which reads/clears it on its own first, immediate,
  synchronous run; declaring it further down hits the exact TDZ crash
  `commentAnchorDrillFor` already had to avoid) takes over
  `commentAnchorColumnHidden`'s job of hiding the otherwise-unrelated top
  rail (whatever block happened to be selected before the jump) for this
  case too — `commentAnchorColumnHidden` now also checks
  `isOtherPlaceAnchorActive(1)` alongside `isCommentAnchorDrillActive(1)`.
  Cleared by the very next genuine `state.selected` change (the jump itself
  never touches `state.selected`). Deliberately does **not** resolve a
  "synthetic frame" (a call into a file this PR doesn't touch,
  `resolveChildBlock`'s `synthetic: true` branch, `drilling.md`) — such a
  frame was never ingested as a real PR block, so `commentAnchorBlock`
  returns `null` for it too, the same already-accepted limitation
  `openCommentAnchorDrill` has. Test:
  `tests/claude-other-tasks-jump-origins.spec.mjs`.

### A third dead end: an ORPHAN comment's own conversation

Reviewer report: clicking a row of "Andere chats in deze PR" whose comment had
gone `anchorState === 'orphan'` (its test method/block was renamed or removed
since the comment was written) looked like nothing happened but the row's own
highlight ring — "hier op drukken kan niet ... alleen de deselectie". It
wasn't inert: `activateClaudeTask` DID run and DID call
`jumpToClaudeConversation`, which — before this fix — fell into the `else`
branch (`openTask`) for an orphan comment, same as any ordinary block-anchored
one. `openTask` searches `state.blocks`/every `test_class` row's own
`methods` for `c.file`+`c.label` — for an orphan comment that search always
misses (that's what "orphan" means), so it fell through to
`openTaskDrilledAnchor`, whose own `commentAnchorBlock(c)` lookup (against
`state.allBlocks`) equally comes up empty → silent `return`. The only visible
effects were then the CALLER's own `cs.claudeTasksPos = 0` (the ring
disappearing) and `jumpToClaudeConversation`'s own **unconditional** trailing
`enterClaudeChat` re-focusing whatever conversation was ALREADY open —
reading exactly like "pressing it does nothing at all".

Fix: an orphan comment now takes the SAME branch as a `c.kind` comment
(`if (c.kind || isOrphanComment(c))`) instead of `openTask`'s block lookup. An
orphan comment keeps its own `'comment:'`-prefixed index row unconditionally
(`commentBlockItem`'s `commentCandidates` filter,
`c.kind || isOrphanComment(c) || …`, `home.mjs`), so `jumpToCommentRow` finds
it the same way a PR-wide comment's row is found; `commentScope()` recognizes
that synthetic row (`b.kind === 'comment'`) and returns
`{ none: true, prComment: b.comment }`, so `chatAnchorComment()` resolves to
THIS comment and `syncClaudeAnchorForSelection` anchors `cc` on it — the
trailing `enterClaudeChat` then opens THIS conversation's real transcript,
not whatever was open before. Product decision (reviewer): "verweesde chat
rij mag voor een periode blijven bestaan. als je het opent dan wil de chat
zien, maar met ergens de duidelijkheid dat gerelateerde code niet meer
aanwezig is" — the row is deliberately NOT filtered out of
`otherClaudeChatsAll()` for being orphaned (nothing there reads
`anchorState` at all), and the already-existing `staleAnchorBadge`
("verouderd — code verdwenen", a word, never colour-only — see
`comments-panel.md`) is reused right next to `CommentClaudeFooter`'s own
"Selected: …" line (via `ccAnchorComment()`, not a bare `c`) so the reviewer
sees that the code is gone in the SAME full-width bar the opened chat sits
in, regardless of whether the comment-thread column itself is scrolled into
view. Test: `tests/claude-other-tasks-orphan-jump.spec.mjs`.

**Follow-up report: the fix above still didn't cover every orphan row on a
real PR.** "ik kan hier niet klikken op de chats waarvan het niet meer
gekoppeld is aan code. dan opent het gewoon niet." Root cause, found by
reproducing live: every orphan comment on that PR was ALSO a bare,
never-taken-over Claude-chat anchor — `isChatAnchorPlaceholder(c)` with no
`firstReviewerReplyOnPlaceholder(c)` ("Chat over deze regel" and nothing else
ever typed). Such a comment is EXCLUDED from `indexComments`/
`commentBlockItem` for that reason alone (same carve-out the general chat
needed, see "Two more origins…" above) — so `commentBlockItem`'s own orphan
bypass never even ran for it; it fell to `chatItems` (the "Openstaande
chats" section, `recomputeLeftList`, `home.mjs`) instead, and THAT filter had
no orphan bypass of its own:

```js
const chatItems = openChatComments()
  .filter((c) => isGeneralChatAnchor(c) || anchoredBlocks.has(c.file + '|' + c.label))
  .map(chatBlockItem)
```

`anchoredBlocks.has(...)` requires the comment's `file`+`label` to still be a
real block — exactly what an orphan by definition no longer has. Result: a
TRUE dead end, no row anywhere (not `'comment:'`, not `'chat:'`) — worse than
the first fix's own case, which at least always kept a `'comment:'` row.
`jumpToCommentRow`/`applyCommentRefRestore` (still building a `'comment:'+id`
ref) then had nothing to find at all, and the same unconditional
`enterClaudeChat` masked it as "nothing happened".

**Fix, three pieces:**

1. `chatItems`' own filter gets the identical `isOrphanComment(c)` bypass
   `commentCandidates` already has, so such a comment gets a
   `'chat:'`-prefixed row (`chatBlockItem`) instead.
2. `jumpToCommentRow`/`applyCommentRefRestore`/`resolveRefToIndex` (the
   Cmd+`[`/`]` stack, `home.mjs`) all now resolve a `'comment:'`/`'chat:'`
   ref by the underlying comment's own id (`b.comment.id`), via one shared
   `commentOrChatRefCommentId(ref)` helper, instead of string-matching the
   row's own `b.id` — a `chatBlockItem` row keeps `kind: 'comment'` but
   overrides `id` to the `'chat:'` prefix, so the old `b.id === ref` check
   could never match it. `applyBlockRefRestore` routes a `'chat:'` ref to
   `applyCommentRefRestore` the same way it already routes `'comment:'`.
   This ALSO fixes a second, independently-discovered gap: a *manually*
   selected "Openstaande chats" row (writing `?sel=chat:<id>` via
   `state.blockRef`, since a chatOnly row's `kind` is `'comment'`) lost its
   selection on every refresh, because `applyBlockRefRestore` only ever
   routed `'comment:'`/`'testclass:'`. Test:
   `tests/claude-other-tasks-orphan-jump.spec.mjs` ("survives a refresh").
3. **"Opgeruimd zodra bekeken en zonder vervolg"** — reviewer's own product
   decision, a middle ground between "always show" and "never show" a
   verweesde (orphaned) chat-only row: reuse the SAME rule
   `otherClaudeChatsAll()` already applies to every other chat instead of a
   second mechanism. That rule (`chatStateOf(c) === 'seen' &&
   otherTaskAnswered.byId[c.id]`) is now its own exported helper,
   `isChatSeenAndAnswered(c)` (`RelatedPanel.mjs`, right next to
   `chatStateOf`) — `otherClaudeChatsAll`'s own filter calls it unchanged,
   and `chatItems`' new orphan bypass ALSO requires `!isChatSeenAndAnswered(c)`.
   So such a row disappears from BOTH "Openstaande chats" and "Andere chats
   in deze PR" the moment it has settled (seen, answered, nothing left to
   expect) — the exact same moment an ordinary chat already drops out of
   "Andere chats". A non-orphan chatOnly row is NOT subject to this: its
   code still exists, so there's no reason to fold it away just because it
   was seen and answered. Test:
   `tests/claude-other-tasks-orphan-jump.spec.mjs` ("dropped once it is seen
   and answered").

Own fixture, PR 970602 (`tests/fixtures/orphan-chatanchor-blocks.json`/
`orphan-chatanchor-comments.json`) — this exact combination (orphan AND
chat-only) isn't covered by the PR 970600 fixture above (its own orphan
comment has a real, written body, so it never took the `chatItems` path at
all).

**"A triple-nested toggle can wedge the innermost keyed list empty" — found
while writing that test, NOT a bug in the fix above.** Building the general
chat's row through several chained LIVE UI actions (post a comment through
the composer, open/close the general-chat overlay, enter Claude) —
`comment-claude-footer`'s own visibility toggle, `claude-other-tasks`' own
toggle nested inside it, and the row-list `${() => otherClaudeChats().map(...)}`
nested inside THAT — made the innermost list render permanently empty even
though the exact same reactive expression, logged in place, kept computing a
correct length-1 array on every subsequent tick (confirmed by temporary
instrumentation, since reverted). Matches the LOCAL PATCH 2b family of
symptoms (arrowjs-pitfalls.md) — a nested reconciler surviving several ancestor
toggle flips in quick succession appears to be able to end up wedged, mounting
into a detached fragment forever after — but this was not chased down to a
root cause in `vendor/arrow.js` itself; treat it as a reproducible SYMPTOM, not
a proven mechanism. **Workaround, not a fix**: seed both conversations through
the workflow API directly and settle in ONE `page.goto` (the same shape every
other passing "Andere chats" test already uses), so the toggle only ever makes
one clean 0→1 transition. If a future test needs to chain several live state
changes in front of this list and hits the same "row list stays empty despite
a non-empty computed value", re-open this investigation instead of assuming a
new, unrelated bug.

**Reachable with NO anchor at all, not just as a nested rung of `'claude'`.**
Reviewer report: with no comment on the current unit (so `'claude'` cannot
even be entered — `enterClaudeChat` is a no-op without an anchor, see
"Product decision" above), the footer-only card still renders whenever
`otherClaudeChats().length > 0` (`hasCommentClaudeFooter()`), but `↑`
from the top of Onderliggende code used to leave the panel immediately —
there was no way to reach this list at all. Two more panel-top boundaries now
check `otherClaudeChats().length > 0` before falling through to their
existing `exitRelated()`: `'code'`'s own `↑` at `codeSel === 0` (its
existing fallback chain — `codeFromClaudeTail` → `hasVisibleComments()` →
exit — gets this as its new last resort) and `'thread'`'s own `↑` past the
oldest message of the FIRST conversation. Both call **`enterFooterTasks(fromFocus)`**
(`RelatedPanel.mjs`), a NEW `cs.focus` value, `'tasks'` — deliberately not a
bare `cs.focus = 'claude'` with no anchor: `claudeChatVisible()`'s own third
branch would then wrongly render an empty composer/chat column for a unit
that genuinely has no comment. `enterFooterTasks` lands on the LAST row
(closest to the boundary just crossed, mirroring `codeFromClaudeTail`'s own
"land at the tail" convention) and remembers which boundary it came from
(`tasksFromFocus`, a plain module variable, exactly like
`codeFromClaudeTail`) so stepping back out (`exitFooterTasks` — `↓` past the
last task, or `←`) lands exactly where the reviewer left: `'code'` (the
common case) or `'thread'` at its own oldest message again. `↑` past the
FIRST task, or `Escape` (handled generically at the top of
`handleRelatedKey`, unconditionally `exitRelated()`), leaves the panel
entirely. `selectHighlightedClaudeTask()`'s guard widened from a bare
`cs.focus === 'claude'` to `cs.focus === 'claude' || cs.focus === 'tasks'`,
and so did home.mjs's own Enter check (`isClaudeChatFocused() ||
isFooterTasksFocused()`, a new exported predicate mirroring
`isClaudeChatFocused`) — both the `'claude'`-nested and the anchor-less path
share the exact same Enter action. `applyRelRestore` (the `?rel.foc=` refresh
restore) gained a matching `'tasks'` branch, landing back on `'code'` on
restore — `cs.claudeTasksPos` itself was already, deliberately, never bound
to the URL (see its own doc comment: other people's live, constantly
changing turns aren't worth restoring), so which row was highlighted is not
preserved either, same as the `'claude'`-nested version of this rung.

### A finished task lingers for 2 minutes, clearly marked done

Reviewer request: a task should not vanish from "Andere chats in deze PR" the
INSTANT it finishes — it should stay long enough to actually notice and jump
to it, marked as done rather than looking like it's still running.

`claudeTurns.mjs` gained a third, non-reactive bookkeeping structure next to
`turns.byId`/`progressAt`: **`finishedAt`** (a plain `Map`, id → timestamp),
stamped by **`markFinishedIfJustStopped(id, wasActive, isActiveNow)`** —
called from both `setTurnBusy` and `setTurnProgress` (the two writers of "is
this conversation doing something right now") — the instant a conversation
goes from busy/running to neither, and CLEARED the instant it becomes
active again (a fresh turn on the same conversation must not inherit an old
"klaar" mark). **`recentlyFinishedTurnIds(excludeId)`** is `runningTurnIds`'s
own sibling: every id whose `finishedAt` is less than `FINISHED_LINGER_MS`
(2 minutes) old and not currently running/busy again (the garbage collection
of an expired stamp now sits in `isTurnRecentlyFinished` itself, which walks
past it anyway). **Since the list became "every chat of this PR" (see
`otherClaudeChats` above), this window no longer decides whether a row EXISTS
— only what it SAYS** (`chatStateOf`'s `'done'`). `recentlyFinishedTurnIds` is
still a list source, for one narrow reason: the list resolves its ids through
`cc.conversations`, which is only refreshed on the comment poll's cadence, so
a just-finished chat would otherwise enter the list up to a poll late — long
after the reviewer's eyes (and the ↓/↑ cursor) went looking for it.
`claudeTaskRow` tells the two apart via **`isTurnRecentlyFinished(id)`**
(exported, the exact same predicate `recentlyFinishedTurnIds` filters
with) — a done row swaps the pulsing indigo dot for a static check-mark glyph
in a small emerald circle, and its status word for **"Klaar"** — words plus a
differing shape, never colour alone (colourblind rule), same convention as
`claudeChatPill`'s own "✓ Claude antwoordde".

**Deliberately a per-tab heuristic, not a read model**: the server keeps no
history of when a turn finished (`chat_progress.go` only ever answers "is one
running right now"), so a conversation that finished while this tab was
closed or got refreshed never gets a "recently finished" window after the
fact — only one this tab actually observed finishing live. Accepted per the
reviewer's own "als dat mogelijk is" — no backend change, no new endpoint.

**Keeping the row alive to actually expire on screen**: `otherClaudeChats()`
reads `cc.tick` purely to force a re-evaluation every second while something
is lingering (the same "read purely to force a re-run" trick the elapsed-
seconds counter already relies on), and `syncChatTicker`'s own 1s-heartbeat
condition widened from `anyTurnRunning()` to `anyTurnRunning() ||
anyRecentlyFinishedTurn()` (a new exported claudeTurns.mjs predicate) — so a
finished-but-lingering row still ticks down and disappears roughly on time,
not only on the next unrelated render. `sendClaudeMessage`'s own Signal
round-trip now also calls `syncChatTicker()` right after `setTurnBusy(...,
false)` in its `finally` block — a turn that ends via this path (rather than
an SSE `chat.progress` frame) still needs that nudge.

Test: `tests/claude-chat-other-tasks.spec.mjs` — two cases. The first (two
PR-wide conversations, the first one's Signal POST held open — same trick as
`claude-chat-parallel.spec.mjs`) asserts the second one's footer names itself,
lists the first by `ownMessageTitle`'s own fallback (its real comment text,
since neither has an own Claude message yet) plus a status word, and that
↓ + Enter jumps back onto it. The second sends a REAL message against the
offline `claude` stub (a held Signal never reaches the real backend, so it
can't exercise the genuine fetch path) and keeps that conversation "running"
purely via a mocked `chat.progress` SSE frame — independent of the real
turn's own (fast, canned) lifecycle — asserting the OTHER conversation's row
fetches and shows the first sentence of the real message actually sent, not
the old fallback.

## "Openstaande chats": a comment index row for a chat that has no comment row of its own — and the durable "unseen answer" signal

Reviewer request: *"ik wil in de blokken index net als 'Comments op regels'
een nieuwe category: openstaande chats. maar alleen als het niet verwijderd
is natuurlijk. Zet er een blauw oogje als ik het laatste antwoord van claude
nog niet heb gezien."*

**The gap this closes:** a Claude conversation always hangs off a comment
(see "Product decision" above), but that comment does not always get its own
sidebar row — a **bare** "Chat over deze regel" anchor
(`isChatAnchorPlaceholder`, never taken over by the reviewer's own reply) is
deliberately excluded from `indexComments()` (comments-panel.md), and an
ordinary line comment that later gets **resolved** drops out of
`indexComments()` too. Either way the conversation itself can still be very
much alive — turns exist, an answer is sitting there — with no way back to
it from the sidebar once the reviewer navigates away, other than happening to
reopen the exact same code by hand.

### Two hard exclusions: an auto-started chat, and one already answered-and-viewed

Two more reviewer requests on this same list, both a straight EXCLUSION
rather than a change to `chatStateOf`'s ranking:

- **"ik wil hier niet de chats zien die automatisch zijn gestart"** — a
  conversation `autoStartKiloCheck` (`workflows.go`) opens right after
  importing a kilo-code review comment, never something the reviewer typed.
  Its very first message carries `chat.KindAutoCheck`/`kind: 'auto_check'`
  (`chatActionAutoCheck`, `chat_workflow.go`) forever, even if the reviewer
  later replies inside it — so the check is "does `messages[0]` (the first
  `role: 'user'` entry) carry `kind === 'auto_check'`", not "has the reviewer
  ever engaged with it". Excluded unconditionally, regardless of its
  busy/done/unread/seen state.
- **"ik wil daar ook niet chats zien die antwoord hebben gegeven en die ik
  bekeken heb"** — `chatStateOf(c) === 'seen'` alone is NOT enough: a chat
  nobody has replied to yet also falls into `'seen'` by that function's own
  fallback, and must stay visible (there's nothing to have "viewed" there).
  So this only excludes `chatStateOf(c) === 'seen'` **combined with** having
  a real answer (`lastAssistantMessageAt(messages)` non-empty).

Both facts (`otherTaskAutoStarted`/`otherTaskAnswered`, `RelatedPanel.mjs`)
are read off the SAME `/api/chat?commentId=…` fetch `ensureOtherTaskTitle`
already makes for the row's title — no extra request — and cached the same
way: `undefined` until that fetch resolves, so a row is never hidden
speculatively before its own fetch actually confirms it qualifies (it can
flash briefly on a fresh render, same as the title/unread caches already do).
Applied in `otherClaudeChatsAll()` as a `.filter(...)` right before the
existing rank sort, so `claudeMoreChatsNote`'s "+n meer" count (which reads
the same, now-filtered, uncapped list) is correct too.

### `openChatComments()` (`RelatedPanel.mjs`)

(The PR's one **general chat** lands in this same section — with one carve-out,
since it must get its row before it has any turns. See "The general chat"
below.)

Every comment with an EXISTING conversation (`cc.conversations` — "here a
Claude conversation really happened", see `ConversationsWithMessages` in
`modules/chat`) whose own comment doesn't already get a row anywhere else —
`indexComments()`'s own output is the exclusion set, dedup on `c.id` — so a
still-open line comment (already under "Comments op regels") or a PR-wide one
never gets a SECOND row here. A genuinely **deleted** comment needs no
explicit check: `comments.Module.Delete` removes the row outright, so `cs.list`
simply stops carrying it and it can never surface here either — this is what
"maar alleen als het niet verwijderd is" already gets for free. `chatConversationIds()`
is a plain, unconditional re-export of `cc.conversations` for `home.mjs`'s own
`watch` to depend on (the arrow.js `watch` pitfall: `openChatComments()`
itself has an early `if (!cc.conversations.length) return []`, which is fine
for the actual filtering call but would make an unreliable, inconsistently-
shaped watch dependency — see `.claude/rules/arrowjs-pitfalls.md`).

### `chatBlockItem`/rank (`home.mjs`)

`chatBlockItem(c)` reuses `commentBlockItem([c])` (the exact same
label/`mentioned` computation, a "group" of one) and marks the result
**`chatOnly: true`** — the one flag that routes it into its own section.
`recomputeLeftList`'s `rank()` checks `b.chatOnly` **before** `b.lineAnchored`
(a chat-only item is always also block-anchored — it needs a real code anchor
to drill into, exactly like a line comment does — so `lineAnchored` is `true`
for it too, and the check order matters): rank **2.55**, directly under
"Comments op regels" (2.5) and still above "Onderliggende code" (3). Same
dead-end-avoidance guard as `commentCandidates`: only a comment whose
`file`+`label` resolves to a real block still in this tree (`anchoredBlocks`)
gets a row — a chat with no code left to drill into would be a dead end just
like an orphaned line comment.

`BlockList.mjs`'s **`openChatsHeading`** (`data-testid=open-chats-heading`)
titles the section, checked in `renderList` **before** the `b.lineAnchored`
branch for the same reason as the rank ordering above. No collapse toggle
(unlike `lineCommentHeading`) — not asked for.

### 2x ArrowRight always lands directly in the chat, never in a comment step

Since `chatBlockItem` reuses `commentBlockItem`'s whole shape (`kind:'comment'`,
`comment`, `comments`), it gets `openCommentAnchorDrill`/
`isCommentAnchorDrillActive`/`commentAnchorEntered`'s existing two-step `→`
mechanism (see "An anchored 'Start' item…" and "Only one thing reads as
selected at a time" in comments-panel.md) entirely for free — including the
`onlyIds` scoping from that same section, so a bare placeholder anchor never
shows some OTHER unrelated comment thread next to it either. The one thing
that differs: `onKeydown`'s second-`→` branch checks `curBlock().chatOnly`
and calls **`enterClaudeChat(state.pr)`** directly instead of
`enterCommentsOrRelated(state.pr)` — reviewer request: *"als ik vanuit de
blokken index 2x naar rechts ga, en er is geen comment, dan wil ik gelijk in
de chat belanden"* — even though the anchor comment technically exists (it
has to, to be an anchor at all), it is either a bare placeholder or a
resolved/uninteresting thread, so there is no comment-thread step worth
showing on the way in. `enterClaudeChat` resolves the target via
`chatAnchorComment()` → `selComment()` = `visibleComments()[cs.sel]`, which
`onlyIds` has already narrowed to exactly this one comment, so no extra
`cs.sel` bookkeeping is needed before calling it. "Zonder andere chats" (no
OTHER conversation shown alongside it) is already the existing invariant —
the panel only ever loads ONE conversation's transcript into `cc` at a time
(see "Parallel conversations" above) — and "lopende chats mag je laten staan"
(a genuinely running OTHER conversation still shows in the footer's "Ook
bezig elders" list) is unchanged, since that list is driven entirely by
`claudeTurns.mjs`, untouched by this feature.

### The blue-eye unread indicator: `src/chatUnread.mjs` + the durable `seen_at` column

Reviewer: *"Zet er een blauw oogje als ik het laatste antwoord van claude nog
niet heb gezien (dat is iets nieuws en moet je bouwen)."* The existing
`claudeTurns.mjs` `answered` flag already answers a similar-sounding question,
but it is **session-only** (cleared on refresh, never written anywhere
durable) — explicitly not enough here, confirmed with the reviewer before
building: *"BACKEND, niet localStorage. Het moet dus persistent server-side."*

**Backend (`modules/chat/chat.go`):** a new `seen_at TEXT NOT NULL DEFAULT ''`
column on `chat_conversations`. `MarkSeen(ctx, conversationID)` stamps it to
now; `SeenAt`/`SeenAtForPR` are the read side. Compared against the
conversation's own **last ASSISTANT message's `created_at`** (never a message
count — a count would also have to track deletions to stay meaningful, per
the reviewer's own instruction: *"seen_at vergelijken met de laatste message
date"*).

**The write goes through the existing `claude_chat` Workflow Execution, not a
new one** (`.claude/rules/workflows-write-boundary.md`): a new
`chatActionSeen = "seen"` `ChatMessageSignal.Action` value
(`chat_workflow.go`), handled by a new branch in the workflow's `WaitSignal`
loop — no Claude call, no user/assistant turn, just
`w.ExecuteActivity("markChatSeen", ...)` → `chat.Module.MarkSeen` — exactly
the same shape as the existing `chatActionClear`/`Commit`/`Cleanup` branches.
`tasks_api.go`'s `SignalMessage` handler validates it needs no body, like
those three. The Run ID is the same deterministic `chatConversationRunID`
(`"chat-" + commentID`) every other Signal to this conversation already uses,
so the frontend needs no lookup — `markChatSeenOnServer(commentId)`
(`chatUnread.mjs`) posts straight to
`/api/workflows/chat-<commentId>/signals/message`.

**`GET /api/chat`** grew a `seenAt` field on both branches: the `?pr=N` form
(`ConversationsWithMessages`'s sibling call) returns a `seenAt` MAP keyed by
conversation id (only entries that HAVE been marked — a caller treats a
missing id as "never seen"), and the `?commentId=` form returns the single
value alongside `messages`, so a caller that already fetches the transcript
(`loadChatMessages`, `ensureOtherTaskTitle`'s own fetch shape) gets it for
free without a second request. Both reads are best-effort: a failed
`SeenAtForPR`/`SeenAt` degrades to an empty map/`''` rather than a 500 — this
is cosmetic bookkeeping, not the source of truth about anything the rest of
the app depends on.

**`src/chatUnread.mjs`** — a standalone shared module (like `claudeTurns.mjs`/
`commentBatch.mjs`), not part of `RelatedPanel.mjs`, for the exact same
reason `claudeTurns.mjs` is standalone: `BlockList.mjs`'s own row
(`chatUnreadIcon`) needs to read it, and `RelatedPanel.mjs` already imports
`BlockList.mjs` — a reverse import would close a cycle.

- **`ensureChatUnread(c)`** — lazily fetches `c`'s own transcript+`seenAt`
  (the same read-only `GET /api/chat?commentId=` `loadChatMessages`/
  `ensureOtherTaskTitle` already use), exactly once per id until invalidated —
  same dedupe-Set/cache-object shape as `ensureOtherTaskTitle`. Called
  unconditionally on every render of a `chatOnly` row
  (`BlockList.mjs`'s `chatUnreadIcon`), same "costs nothing beyond the first
  render" pattern.
- **`isChatUnread(c)`** — the cached boolean; `undefined` (never fetched yet)
  reads as "not unread" so a row shows no icon until the fetch resolves,
  rather than flashing one speculatively.
- **Marking it read requires a 5-second dwell, not a bare open.** Reviewer
  report: flicking through comments with ↑/↓ marked each conversation's
  answer as seen the instant its transcript loaded, even though nothing was
  actually read. `RelatedPanel.mjs`'s `loadChatMessages` now only CACHES the
  response's own `seenAt` (`chatSeenAtCache`, keyed by conversation id,
  refreshed on every load regardless of `applyDrafts`) instead of marking
  anything read itself. The actual marking is `scheduleChatSeenDwell`, armed
  by `watch(() => [cs.focus, cc.commentId], scheduleChatSeenDwell)`: any real
  change of focus or conversation clears a pending timer and — only while
  `cs.focus === 'claude'` and `cc.commentId` is set — arms a fresh 5s
  (`CHAT_SEEN_DWELL_MS`) one for that exact pair. When it fires it re-checks
  the reviewer is STILL on that same conversation (otherwise a no-op), then
  compares the transcript's last assistant message against the cached
  `seenAt` and calls `markChatSeenOnServer` only when there is actually
  something newer (avoiding a Signal on every ordinary re-open), and calls
  **`setChatUnread(commentId, false)`** so the icon clears — but only after
  the dwell, never immediately on open.
- **Invalidation**: the existing `chat.message` SSE handler
  (`ensureChatEvents`) drops a FOREIGN conversation's cached entry
  (`dropChatUnreadCache`) the same way it already drops `otherTaskTitles`' —
  its transcript just changed, so the next render re-derives unread-ness
  against the fresh last-message time.

Per the colourblind rule the eye **glyph** plus the `title`/`aria-label`
carry the meaning (`data-testid=chat-unread-icon`); the blue tint is
decoration only.

**Test coverage split deliberately across layers** (per the "prefer a quick,
targeted test over a slow e2e one" rule for novel/regression-sensitive
signals): the actual `seen_at` round trip through the workflow is a Go test
(`chat_workflow_test.go`'s `TestClaudeChatSeenSignalStampsSeenAt` — signals
`chatActionSeen`, asserts `chat.Module.SeenAt` gets stamped and NO extra
Claude turn/RunChat call happens), plus the plain module round trip
(`modules/chat/chat_test.go`'s `TestSeenAt`). The one frontend-wiring spec,
`tests/open-chats-index.spec.mjs`, is fully mocked (same shape as
`comment-anchor-expanded-view.spec.mjs`'s `mockAnchoredComment` — a bare
`seededPr` PR has no real ingested blocks at all, so `commentAnchorBlock`
can never resolve one; this needs the real anchor PR 12903's own ingested
tree) and checks the row appears, 2x `→` lands straight in the chat, and the
icon disappears after the mocked "seen" Signal round-trips.

## The general chat: one PR-wide, code-less conversation in an overlay

Reviewer request, from the `/`-menu screenshot where a typed "fix tests in pr"
collapsed to "Geen commando's.": *"hier wil ik een algemene chat kunnen
starten, net zo werken als chat op regel. het moet dan ook los in de blokken
index komen zonder dat het gekoppeld is aan code"* — and, on the follow-up
questions: **one per PR, reused**; `/` always shows the general menu; the chat
itself *"een overlay over alles heen, rechts daarvan mag je gegeneerde blokken
uit de chat tonen. esc moet alles weer hidden"*.

Nothing about the conversation itself is new: it is an ordinary `claude_chat`
Execution with the same rights/werkmap choice as any other. Only three things
are: WHAT it hangs on, WHERE it shows, and HOW it is reached.

### The anchor: a PR-wide comment nobody ever sees as a comment

A conversation still needs a comment (the backend's own constraint, see
"Product decision" above). A general chat reuses the **PR-wide** comment shape
`startPrWideComment`/`placeComment` already write — `kind: 'issue'`, no
`file`/`line` — with the existing `CLAUDE_ANCHOR_PLACEHOLDER` body and always
`local: true`.

That combination is the whole trick, and it is deliberate: because
`isChatAnchorPlaceholder(c)` already holds for it, every existing exclusion
applies unchanged — `indexComments()` gives it no row, "Zet op GitHub" never
offers it, no title fallback ever prints its body — so the anchor is invisible
AS A COMMENT and nothing is ever posted to GitHub. `isGeneralChatAnchor(c)`
(`!!c.kind && isChatAnchorPlaceholder(c)`) names exactly this comment;
`generalChatAnchor()` is the "does this PR already have one" lookup that makes
`startPrGeneralChat` reuse rather than create a second.

`startPrGeneralChat(state, text)` (`RelatedPanel.mjs`) creates-or-reuses it,
sets `cs.focus = 'claude'`, loads the Execution (`ensureAndLoadChat`, the same
idempotent call `enterClaudeChat`/`startPrCommentChat` make), focuses the
composer and — when `text` is given — sends it straight away through the
ordinary `sendClaudeChatText`. **`cs.focus = 'claude'` is load-bearing, not
cosmetic:** `syncClaudeAnchorForSelection` returns early on that focus, so a
comment poll can never re-anchor `cc` out from under an open overlay.

### The index row

The anchor gets its row from **"Openstaande chats"** (`openChatComments` +
`chatBlockItem`, rank 2.55) — the section that already exists for "a chat with
no comment row of its own". Two small widenings were needed:

- `openChatComments()` includes a general-chat anchor **even with no turns
  yet**, unlike every other entry (which must appear in `cc.conversations`,
  i.e. must already have messages). This section is the general chat's ONLY
  way back, and the row has to exist from the moment the chat does.
- `recomputeLeftList`'s chat filter exempts it from "must resolve to a real
  block in this tree" (`isGeneralChatAnchor(c) || anchoredBlocks.has(...)`) —
  the same `c.kind ||` carve-out `commentCandidates` already makes. That guard
  exists to avoid dead-end rows; this row is not a dead end, it opens the
  overlay instead of drilling into code.

`chatBlockItem` labels it **"Algemene chat"** and marks it `generalChat: true`
(the placeholder sentence would be a nonsense label). A single `→` on it opens
the overlay directly — there is no anchor block to drill into and no comment
thread worth a step, so the two-step `→` an ordinary chat row has does not
apply.

### The overlay

`src/generalChatOverlay.mjs`, mounted top-level next to `MenuHost`/the werkmap
overlay. Its keyboard rules, the capture-phase Escape and why the tree's own
Claude/preview columns are not rendered while it is open: "The general-chat
overlay" in `.claude/docs/command-palette.md`. The card itself is
`GeneralChatCard(state)` (`RelatedPanel.mjs`) — `claudeChatColumn` with the
exact same view/callbacks the tree's column uses, minus `ClaudeChatPanel`'s
`claudeColumnVisible()`/width/resize wrapper, because inside the overlay the
column IS the surface and there is no neighbouring column to resize against.
To its right sits the unchanged `CodePreviewPanel`, so the code blocks Claude
produces show full size ("rechts daarvan mag je gegeneerde blokken uit de chat
tonen") with no second implementation. `GeneralChatCard` passes
`claudeChatColumn`'s 5th argument, `{ inOverlay: true }` — the tree column's
own `max-h-[38vh]` cap on the message thread (see the doc comment above
`claudeChatColumn`, `ClaudeChat.mjs`) doesn't apply here: the overlay already
has a real, viewport-bounded height (`items-stretch` inside `fixed inset-0`),
so the thread should fill exactly that instead of stopping short and leaving
a dead gap above the composer. The `inOverlay` variant sizes the thread as
`absolute inset-0` of its own `relative` parent (the same trick the
`scrollHint` chevrons already use against that parent) so it fills the
available height and only grows a scrollbar once content actually overflows.
The tree's own call site is untouched.

Below the scrollable card (a sibling, outside the `overflow-y-auto` wrapper —
same placement `home.mjs`'s own `comment-claude-row` uses) sits the same
shared `CommentClaudeFooter()` (`RelatedPanel.mjs`) the per-line chat renders:
the live "Claude denkt na…/leest/schrijft… · Xs" status, the Stop button, and
"Andere chats in deze PR". This used to be missing entirely — a running
turn in the overlay showed the sent message and then nothing until the answer
landed, unlike the per-line chat, which always shows progress underneath.
Called with no `commentId`/`opts`, exactly like `home.mjs`'s own call, since
`CommentClaudeFooter` already reads the globally anchored `cc` state, which
`startPrGeneralChat` points at this conversation while the overlay is open.

Test: `tests/general-chat.spec.mjs` (real writes against the per-worker
server/DB, like `prwide-comment.spec.mjs`: it pins the anchor's PR-wide/local
shape, the overlay, the sent first turn, Escape, the index row, `→` back in,
and that a second start reuses the same one; a second test mocks a running
turn's SSE progress the same way `tests/claude-chat-progress.spec.mjs` does,
to pin that the shared status line/Stop button render inside the overlay).

### "Wis Claude-gesprek" from the empty composer, inside the overlay: verwijderen met schone lei

Reviewer request: *"als ik in de algemene chat op een leeg input veld enter
druk, wil ik algemene chat kunnen verwijderen (en anders leeg maken), nieuwe
chat moet met schone lei beginnen"*. The mechanism already existed — the
empty-composer `Enter` above opens the exact same `claude` mode menu
(`claudeChatCommandsFor()`, "'Comment hiervan maken' on an empty Claude
input"), whose **first, default item is "Wis Claude-gesprek"**
(`clearClaudeChat`, see "'Wis Claude-gesprek' — clearing a conversation"
above) — it already deletes the backing comment outright once it is still
exactly `CLAUDE_ANCHOR_PLACEHOLDER` (always true for the general chat, unless
it was ever converted via "Comment hiervan maken" — see below), with the
SAME confirm-submenu gate for real, unsaved agentic-edit work in the shadow
worktree. Nothing about the write path needed to change: it is a workflow
Signal (`chatActionClear`) plus a workflow-based comment delete either way,
both already inside the write boundary.

Two gaps stopped this from actually working from inside the overlay, both
fixed alongside `tests/general-chat.spec.mjs`'s own "empty Enter…" test:

1. **The menu opened, but was inert.** `home.mjs`'s document-level
   `onKeydown` checked `isGeneralChatOverlayOpen()` BEFORE `menu.open` and
   returned unconditionally either way — see "The general-chat overlay" in
   `.claude/docs/command-palette.md` for why that guard exists at all
   (swallow nothing but Escape). The composer's own `onEmptyEnter`
   (`ClaudeChat.mjs`'s `@keydown`, which `stopPropagation()`s before opening
   the menu — see above) still opened it fine, and moved DOM focus to
   `command-input`, but every SUBSEQUENT `↑`/`↓`/`Enter` aimed at that menu
   still bubbles to the same document listener, which kept swallowing it
   before `if (menu.open)` was ever reached. The menu rendered, visibly, and
   did nothing. Fix: `isGeneralChatOverlayOpen() && !menu.open` — once a menu
   is open, it owns the keyboard even from inside this overlay. Escape's own
   absolute "esc moet alles weer hidden" rule is untouched (a separate,
   CAPTURE-phase listener in `generalChatOverlay.mjs`, which runs before this
   bubble-phase check regardless) — so Escape still closes the whole overlay,
   menu included, exactly as before; that is a deliberate, pre-existing
   product decision, not something this fix touches.
2. **After clearing, the still-open composer pointed at nothing.**
   `clearClaudeChat`'s placeholder-anchor branch always finished with
   `exitRelated()` — written for the per-line/per-comment Claude column,
   where "nothing left to focus" means step OUT of the panel entirely. The
   general chat's own composer, though, stays visible the whole time (the
   overlay only ever closes on Escape) — so `exitRelated()` there left a
   perfectly normal-looking, focused composer silently wired to a
   conversation id that no longer existed: typing a new message and pressing
   Enter did nothing at all, not even a failed request.
   Fix: `clearClaudeChat` now checks `cs.generalOverlay && isGeneralChatAnchor(anchor)`
   right before deleting — `cs.generalOverlay` is the existing flag
   `setGeneralChatOverlayVisible` (`generalChatOverlay.mjs` → `RelatedPanel.mjs`)
   already keeps in sync, so this needed no new cross-module import (the
   overlay module already imports FROM `RelatedPanel.mjs`, never the other
   way — same import-cycle avoidance as `setReplyPublishMenuOpener`/
   `setClaudeMenuOpener`). When true, instead of `exitRelated()` it calls
   `startPrGeneralChat({ pr: cs.pr })` again — the SAME lazy create-or-reuse
   `startPrGeneralChat` already uses for a first-time reviewer, just handed a
   minimal `{ pr }` rather than the real `home.mjs` state object (the
   function only ever reads `state.pr`). That creates a brand-new anchor
   comment, with a brand-new id, and re-anchors `cc` onto it — a real "schone
   lei": the still-open composer is now backed by a genuinely new,
   never-had-messages conversation, ready for the very next Enter, with no
   second menu round trip needed.

**The one case this correctly leaves as "leegmaken" instead of "verwijderen":**
if the reviewer had, at some earlier point, used "Comment hiervan maken" on
the general chat's own placeholder anchor, it is no longer
`CLAUDE_ANCHOR_PLACEHOLDER` — a real, reviewer-authored comment now. Clearing
then only wipes the transcript and steps onto that comment (`toComment()`,
the ordinary non-general-chat branch); no recreate runs, and the next
`startPrGeneralChat` (the anchor no longer matches `isGeneralChatAnchor`)
creates a genuinely separate, brand-new general chat, leaving the
now-converted one behind as an ordinary comment in the index. Not something
this change had to special-case — it falls out of the existing placeholder
check unchanged.

Test: the "empty Enter in the general-chat composer…" case in
`tests/general-chat.spec.mjs` — the menu opens from inside the overlay and
`↑`/`↓`/`Enter` genuinely move/run it, the old conversation and its message
are gone, the composer accepts a brand-new message in the SAME still-open
overlay, and the index still shows exactly one "Algemene chat" row.

### Cmd+C on a selected bubble copies that turn's own text

Reviewer request: with a keyboard-selected turn (`cs.claudePos >= 1`, walked
there with `↑`, see above) there is nothing to select, so a plain Cmd+C did
nothing — no DOM text selection exists for the browser's native copy to act
on. `onKeydown` (`home.mjs`) now handles `Cmd/Ctrl+C` explicitly while
`isClaudeChatFocused()`: it reads the active turn's raw text via
`activeClaudeMessageBody()` (`RelatedPanel.mjs`, mirrors
`activeClaudeBubbleEl`'s own index math: `cc.messages.length - cs.claudePos`,
returning the message's `.body`) and writes it to the clipboard
(`navigator.clipboard.writeText`, same fire-and-forget pattern as
`copyReviewSummary`). Two carve-outs let native Cmd+C win instead, per the
long-standing rule that a real selection/editable field is never hijacked
(see `isNativeTextEditKey` in `.claude/rules/arrowjs-pitfalls.md`'s
conventions and `keyboard-navigation.md`):

- **A focused text field** (composer/reply) — `isNativeTextEditKey` at the
  very top of `onKeydown` already returns before this branch is ever reached.
- **An actual DOM text selection** — `window.getSelection().toString()`
  non-empty (e.g. the reviewer selected text inside the bubble by hand) is
  left alone so the browser copies exactly that selection, not the whole
  turn.

At the rest position (`cs.claudePos === 0`, no turn selected) or an empty
list, `activeClaudeMessageBody()` returns `null` and the branch is a no-op —
Cmd+C then does whatever it would have done anyway (typically nothing, same
as before this change). Test: `tests/claude-chat-copy-bubble.spec.mjs`.

### ↑/↓ walk a tall bubble 4 rendered lines at a time, before stepping to the next one

Reviewer request: the thread is deliberately not tall (`max-h-[38vh]`), which
is fine, but a single long Claude answer (one bubble — e.g. a big bulleted
explanation, see the reported screenshot) used to be an all-or-nothing jump:
`cs.claudePos`'s own ↑/↓ only ever steps a WHOLE bubble, so reading through a
long one required scrolling by hand with the mouse.

**`scrollClaudeMessageWithinBubble(dir)`** (`RelatedPanel.mjs`) is called from
`handleRelatedKey`'s ordinary `'claude'` `ArrowUp`/`ArrowDown` branch, BEFORE
it changes `cs.claudePos`/`cs.claudeOptionSel` — only while `cs.claudePos >=
1` (there is an actually-selected turn; the rest position/options rung is
untouched). It resolves the DOM node of the CURRENTLY active bubble
(`activeClaudeBubbleEl`, mirrors `scrollClaudeMessageIntoView`'s own index
math: `cc.messages.length - cs.claudePos`) and, if that bubble's own edge in
the requested direction is not yet visible inside `claude-chat-thread` (its
top for `'up'`, its bottom for `'down'`), scrolls the thread by
`CLAUDE_BUBBLE_SCROLL_LINES` (4, briefly tried at 10 in the same reviewer
conversation, then corrected back down) times the bubble's own computed
`line-height` — **4 rendered/word-wrapped lines as they sit on screen**,
not literal `\n` characters in the markdown. Returns `true` (the keypress is
consumed, `cs.claudePos` stays put) the moment it actually scrolled; `false`
the instant the requested edge is already visible, at which point the
ordinary per-bubble step (`cs.claudePos +/- 1`) takes back over exactly as
before — so a short bubble that already fits entirely keeps behaving exactly
like before this change, and once a tall bubble has been scrolled all the way
to its own top/bottom, the very next ↑/↓ steps onto the older/newer bubble as
usual. Symmetric in both directions (explicit reviewer answer — not only
↑, which is all the request literally named). Applies only to `'claude'`'s
own transcript; `'thread'`'s reaction walk (`cs.threadPos`) is unaffected —
not asked, and reaction bubbles are typically short.

### `claude-chat-thread`'s top fade sits flush against the card's own edge — the menu button now floats instead of reserving a row

Reviewer follow-up on the same screenshot ("top heeft nog veel ruimte, blur
kan verder omhoog"), then a correction once a first attempt widened the fade
itself instead ("ik bedoel niet dat het hoger moet, maar meer naar boven,
tegen de rand aan") — **not** a taller fade (that attempt, `scrollHint(dir,
tall)` swapping `h-7` for `h-16`, was reverted in full; `scrollHint` is back
to its original one-argument signature, `h-7` everywhere, including
`comment-thread`/`comment-detail-thread`), but the existing small fade
**repositioned** to actually touch the card's true top edge.

**Root cause:** `updateScrollHints` (`scrollFade.mjs`) already anchors the
"up" hint to the SCROLLER's own measured edge, not its wrapper's — that part
was always correct. The gap was structural, one level higher: `claude-chat-
card`'s own top-right menu button (`claudeMenuButton`) used to sit in its OWN
flex row (`<div class="flex items-center justify-end gap-2">…</div>`), a
sibling BEFORE the `relative min-h-0 flex-1` wrapper that holds the scroller.
That row's own height (a `h-6` button) plus the card's `gap-2` between its
children pushed the scroller — and therefore the fade, which can only ever
cover the scroller's own box — down by ~32px below the card's real top edge,
on top of the card's own `p-3` inset. The fade was rendering exactly where it
was told to; the reserved, mostly-empty row above it was the actual problem.

**Fix:** `claude-chat-card` gained `relative`, and the menu-button row was
replaced by an absolutely positioned `<div class="absolute right-2 top-2
z-20">` holding the same `claudeMenuButton` — so it now floats over the top
of the thread instead of reserving its own row, and the `relative min-h-0
flex-1` wrapper (and thus the scroller and its fade) becomes the card's
effectively-first piece of content, right after the card's own `p-3`
padding. `claude-chat-empty`'s paragraph (the "Nog geen gesprek…" filler,
the one full-width text that could otherwise wrap underneath the floating
icon) gained `pr-7` to reserve the icon's own width; every message bubble
already caps at `max-w-[92%]` and was never at risk. `z-20` keeps the button
clickable above the fade's own `z-10`. Verified by measuring
`getBoundingClientRect()` of the card/scroller/hint before and after: the
scroller's top offset from the card's own top dropped from ~44px to ~12px
(exactly the card's own `p-3`), and the "up" hint's own inline `top` style
(set by `updateScrollHints`) is `0` relative to that scroller — i.e. flush,
no code change needed there. `comment-thread`/`comment-detail-thread` were
NOT touched this round (their own header row — author, badges, source
label — is real content, not a reservation to remove) — flag it if the
identical "much empty room above the fade" complaint ever comes in for
those two.

### At most ONE code-generating turn at a time (`chat_write_gate.go`)

Also the reviewer's decision: *"Voor vragen, geen limit, voor het genereren van
code & aanpassingen maken wel (maximaal 1 per keer, sync)."* The two kinds are
**not** guessed at send time — `runOneClaudeTurn` already tells them apart for
an unrelated reason: every turn starts with the cheap read-only attempt and
only Claude's own `{"type":"need_write"}` directive escalates it to the shadow
worktree with Edit/Bash. That escalation IS the "this turn will change code"
signal, so a process-wide semaphore of 1 sits exactly around the second
attempt. A second code turn **waits** (never refused), and the wait is visible:
the new `waiting` phase renders as "Wacht op een andere codewijziging…"
(`PHASE_LABEL`, `ClaudeChat.mjs`) so a queued turn can't be mistaken for a
hang. Full account: "Two-step tool access" in
`.claude/docs/workflows-comments.md`.

Tests: `tests/claude-chat-parallel.spec.mjs` (two conversations, the first
one's Signal POST held open, asserting the second one's message really leaves
the browser instead of queueing), `chat_write_gate_test.go` and
`TestHandleChatProgressPerPR` (`events_api_test.go`).

## `RelatedPanel.mjs`: state, not template

The "Embedded Claude conversation" section owns:

- **`cc`** — this module's own `reactive()` chat state for whichever ONE
  conversation is currently in view: `{ commentId, runId, messages, status,
  queued, tick, conversations }` (`conversations` is PR-wide — no
  longer read by `claudeChatVisible()`, only by `chatAnchorComment()`'s
  internal anchor-resolution fallback, see "Superseded" above; `tick` is the
  1s heartbeat of the elapsed counter, see "Live progress"). **Whether a turn
  is running, what it is doing, and whether its last send failed are
  deliberately NOT on `cc`** — they live per conversation in
  `claudeTurns.mjs`, read here through `ccBusy()`/`ccProgress()`/
  `ccSendError()`, see "Parallel conversations". `status` is the
  PANEL's own loading/error state (ensuring the
  workflow, fetching the transcript) — a genuinely **failed Claude turn** is
  a normal message with `kind: 'error'` (ladder exhausted) or `'retrying'`
  (another attempt coming) — see `chat_workflow.go`'s `runOneClaudeTurn` and
  "Opnieuw proberen" below — not this field.
- **`cs.claudePos`** — added to the existing `cs` reactive alongside
  `threadPos`, bound in the same `bindUrlState(cs, [...], { ns: 'rel' })`
  list as `rel.cpos`, so a refresh restores the exact turn the reviewer was
  on (same `restorePending`/`applyRelRestore` snapshot-then-reapply pattern
  as every other panel cursor field).
- **`enterClaudeChat(pr)`** — the single entry point for both call sites
  above. It resolves its own anchor via `chatAnchorComment()` and returns
  without touching the focus when there is none, so no call site needs to
  pre-check. It takes **no** `commentTarget` callback: nothing here creates a
  comment any more, so the live cursor's anchor fields are irrelevant (the old
  `currentCommentTarget`/`claudeAnchorArgs` pair is gone with the placeholder
  comment).
- **`ensureAndLoadChat`/`loadChatMessages`/`sendClaudeMessage`** — the write
  paths: `POST /api/workflows/claude_chat` (idempotent, ensures the
  Execution), `GET /api/chat?commentId=` (read-only transcript),
  `POST /api/workflows/{runId}/signals/message` (one reviewer turn — free
  text or a clicked question option, same Signal). The Signal round-trip runs
  the Activities (including the real `claude` subprocess call) **inline** —
  see "Hard rule: only workflows mutate state" and the
  `SignalWorkflow`/`advance()` mechanics in `tembed-workflows.md` — so
  `sendClaudeMessage`'s own `await` genuinely spans the whole turn; that await
  is not what makes the reply appear (see "Live progress" below), it is the
  belt-and-braces refetch for the reviewer's own send.
  **A local optimistic echo of the reviewer's OWN text** (`addPendingOwnMessage`/
  `removePendingOwnMessage`) is pushed straight into `cc.messages` the instant
  `sendClaudeMessage` fires, before any of that round trip completes —
  reported bug: "als ik vanuit het menu een chat start, zie ik mijn bericht
  niet gelijk in de chat, uiteindelijk wel", most visible starting a BRAND NEW
  conversation (menu "Chat over deze regel"/"Chat over deze PR"), whose
  transcript is still empty right up to that point, so the reviewer used to
  stare at nothing for as long as the save+SSE-push+refetch round trip takes.
  The entry carries a locally-minted `__pending__N` id (never colliding with a
  real, server-issued one, see `chatMessageID` in `chat_workflow.go`) and is
  never itself persisted: the very next `loadChatMessages` — from the
  `chat.message` SSE push (see "Live progress" below) or this function's own
  belt-and-braces refetch — **replaces** `cc.messages` wholesale with the real,
  already-saved transcript (`saveChatMessage` persists the reviewer's turn
  before the actual claude call even starts), so the pending entry is
  superseded automatically, never duplicated. Only a failed/unreachable send
  never reaches that replacement, which is why `sendClaudeMessage` explicitly
  calls `removePendingOwnMessage` on both its failure paths — otherwise a
  message that was never actually saved would sit in the transcript forever.
  `queueClaudeMessage`'s own queued-turn bubble (`cc.queued`/`claudeQueuedRow`,
  rendered the moment a turn is typed while busy) already worked this way; this
  extends the same "show it before the network agrees" idea to the ordinary,
  not-busy send.
- **`ensureChatEvents`/`loadChatProgress`** — the live channel, see below.
- **`claudeChatVisible()`** — `hasVisibleComments() || cs.focus === 'new'`, a
  **strict iff** with whatever `InlineComments` itself renders (a visible
  comment thread, or the brand-new composer) — never on its own (explicit
  request, replacing an earlier looser rule that also kept the column visible
  via `chatConversationExists()`/`cs.focus === 'claude'` alone; see "Product
  decision" above). It must stay inside the existing
  `${() => claudeChatVisible()}` binding: a plain, non-reactive value would
  leave a column that should reappear invisible until the next navigation step
  (the static chunk-reuse trap, see `.claude/rules/arrowjs-pitfalls.md`).
- **`ClaudeChatPanel(state, commentTarget, openCommit)`** — the exported component
  `home.mjs` mounts inside `comments-and-related`'s own first row
  (`comment-claude-row`), directly next to `InlineComments`, split off by a
  vertical dashed divider (`data-testid=comment-claude-connector`,
  `border-l border-dashed`, `self-stretch` so it spans the full row height —
  not the horizontal connector the Onderliggende-code children use between
  each other; not a sibling column of `comments-and-related` any more — that
  was the earlier, wider-apart shape). The comment block and this Claude
  block have no border/bg/padding of their own — they merge into **one**
  visual card whose border/bg lives on `comment-claude-row` itself, with
  `items-stretch` so both columns are always exactly the same height (a
  reviewer request: "technisch wel 2 blokken, maar samengesmolten" — the left
  (comment/thread) and right (Claude) stay functionally separate, each with
  their own keyboard cursor, only their outer boxing merged). This column
  keeps its own `p-3` (`claudeChatColumn`'s root `<div>`,
  `data-testid=claude-chat-card`) — `InlineComments`' own cards already carry
  that inset via their own borders, so without it this column's content (the
  thread, the composer) sat flush against the shared card's edges,
  most visibly on the right where "Stuur" touched the border. The column's
  top row used to also carry a small mention-copy header label
  (`"Claude, je reviewbuddy"`-style text, one of `CLAUDE_MENTIONS`); removed
  on reviewer request ("bovenin mag weg, in de input mag het blijven") — the
  row now holds only the sparkle menu button (`claude-chat-menu`, right-
  aligned, `justify-end`), and the composer placeholder/empty-state sentence
  still pick the same random mention (`ClaudeChat.mjs`'s `CLAUDE_MENTIONS`). Its
  `claude-chat-thread` message list carries `flex-1` so it absorbs whatever
  vertical space a short/empty conversation leaves over, keeping the composer
  pinned to the bottom of the (`items-stretch`-driven, possibly taller) row
  instead of stranded right under the empty-state text — **and now also
  `max-h-[38vh] overflow-y-auto`** so a long conversation scrolls internally
  instead of stretching this column — and, via `<main>`'s `align-items:
  stretch`, the whole merged card and its sibling block-diff column — without
  bound. Same cap, same reasoning as the comment thread's own `comment-thread`
  pane — see "A capped, fading thread" in `.claude/docs/comments-panel.md` for
  the full story (including why this reverses, without repeating, an earlier
  `max-h-64 no-scrollbar` mistake). The scrollbar itself is hidden again
  (`no-scrollbar`, later reviewer request) and replaced by the same green
  up/down `scrollHint` chevron pair Block.mjs's diff panes use
  (`data-scroll-body` + `updateScrollHints`, `src/scrollFade.mjs`) — see that
  same section in `comments-panel.md` for why. The composer row
  itself is `flex items-end gap-2` (textarea + "Stuur" side by side, the same
  pattern as the comment thread's own `reaction-compose`/`reaction-send`),
  not a stacked column with the button below the field. Width is
  `claudeColumnWidthCls()` — **exactly half** of `relatedColumnWidthCls()`'s
  own clamp, `InlineComments` taking the **other half** (minus the connector's
  own width) via `commentColumnWidthCls()`, both defined next to
  `relatedColumnWidthCls` in `RelatedPanel.mjs`. `clamp()` scales
  homogeneously (`k·clamp(a,b,c) = clamp(k·a,k·b,k·c)`), so
  `commentColumnWidthCls() + connector + claudeColumnWidthCls()` is exactly
  `relatedColumnWidthCls()` at every code-growth width, not just at the
  floor/ceiling — see `relatedWidthCls`'s doc comment. Not a new
  content-driven computation of its own; the transcript wraps
  (`ClaudeChat.mjs`'s `claude-chat-actions` button row also wraps, rather
  than stretching the column, at this narrower width). **This "exactly half"
  split is only the REST-state case now**: below the 1920px
  `COMMENT_CLAUDE_WIDE_BREAKPOINT_PX` threshold (a deliberately separate,
  wider cutoff than the app-wide `narrow:` 1399px screen), whichever half of
  this row owns the keyboard grows to 2/3 while the other shrinks to 1/3 and
  goes read-only (content stays visible, every control disappears — never a
  collapsed rail) — a wide screen instead widens BOTH halves past the
  half-split, with nothing ever going read-only there. See "Read-only, not a
  rail" in `.claude/docs/comments-panel.md`.

## A PR-wide comment-index item can also start a conversation

## A PR-wide comment-index item can also start a conversation

`ClaudeChatPanel`/`comment-claude-row` above is strictly the **block-scoped**
chat — a comment-index item (`commentDetailCard`, see "The detail card, in
place of a `Block` diff card" in `.claude/docs/comments-panel.md`) has no diff
of its own, so until this feature it had no way to chat with Claude at all.
**"Chat met Claude"** (`prCommentCommandsFor`'s own command, `home.mjs`) fixed
that by opening the SAME `claude_chat` conversation for it.

**It IS on the `→` chain now** (it wasn't when this section was written — an
earlier version of this line said such an item has "no `→` chain to reach it
through"): the item's own thread cursor (`pct`) grew the same `→` the
block-scoped `'thread'` level has, so the walk is `index row → thread →
Claude chat`, with `←` stepping back into that thread (never onto the
`'comment'` level, which does not exist for an unanchored item). Full
mechanism and the reviewer request behind it: "Comment-index items" in
`.claude/docs/keyboard-navigation.md`. The menu command stays as the
mouse/palette equivalent.

- **`chatAnchorComment()` grew a third branch.** `home.mjs`'s `commentScope()`
  already returns a sentinel `{ none: true }` scope while a comment-index item
  is selected (see "Selecting a Start item empties the block-scoped index" in
  `.claude/docs/comments-panel.md`); it now carries the actual comment too —
  `{ none: true, prComment: b.comment }` — and `chatAnchorComment()`'s
  `s.none` branch returns it. The pre-existing `syncClaudeAnchorForSelection`
  watch (see "The Claude column must follow the browsed comment" above) then
  keeps `cc` anchored on whichever comment-index item is selected exactly like
  it already does for a block-scoped comment — **no second writer of `cc`**,
  no risk of the two contexts racing. This is why "Chat met Claude" needs no
  new fetch of its own for the anchor: by the time the reviewer opens the
  menu, `cc.commentId` already matches the selected item.
- **The column is the ordinary one, and it is simply THERE.**
  `isPrCommentScope()` (`RelatedPanel.mjs`) — `commentScope`'s sentinel with a
  real comment on it — is one of `claudeChatVisible()`'s reasons, so
  `comments-and-related`'s own `ClaudeChatPanel` renders next to the item for
  as long as it is selected, with the comments half hidden (empty by design).
  Reviewer request: "ik wil hetzelfde blokje zien als normaal rechts. Bij alle
  algemene comments en ai waarschuwingen." **This replaced** a second,
  embedded copy of the chat inside `commentDetailCard` (the `pcc` reactive
  plus `prCommentClaudeView`/`updatePccThreadPinned`/`jumpToPccThreadBottom`
  and a `pr-comment-claude-section` toggle) that only appeared after the
  command ran — one chat, one surface, one set of testids. Don't reintroduce
  it. Full write-up: "An unanchored item shows the ordinary Claude column, on
  the right" in `.claude/docs/comments-panel.md`.
- **`startPrCommentChat(c)`** is the MENU path only, and therefore only `await`s
  `ensureAndLoadChat(cs.pr, c.id)` (the same idempotent
  `POST /api/workflows/claude_chat` call `enterClaudeChat` makes) **before**
  focusing the composer — mirroring `enterClaudeChat`'s own ordering. Skipping
  that `await` is a real bug, not just untidy: `cc.runId` is only populated
  once the Execution-ensure request resolves, and `sendClaudeMessage`/
  `queueClaudeMessage` silently no-op on `!runId` — a reviewer who types and
  presses Enter before that resolves loses the message with no feedback (only
  ever hits, in practice, an automated test that doesn't wait for the natural
  round-trip a human's own typing speed provides; see
  `tests/pr-comment-claude-chat.spec.mjs`, which this exact race broke before
  the `await` was added).
- **`home.mjs`'s `state.selected` reset watch calls `leaveRelated()`** (which
  releases the panel's own `cs.focus`) when the NEWLY selected item is itself a
  comment-index item (`kind:'comment'`) — never on an ordinary block-to-block
  selection change, see the watch's own doc comment in `home.mjs` for why a
  blanket reset there is unsafe. `startPrCommentChat` does not set `cs.focus`
  itself, so a stale `cs.focus` left over from a DIFFERENT block's
  comment/thread/claude panel (never explicitly exited via `←`/Escape) used to
  survive a plain mouse click straight onto this composer — reported bug:
  typing into it and pressing Enter did nothing, swallowed by `home.mjs`'s
  `relatedActive()`-gated Enter/arrow handling instead of reaching
  `ClaudeChat.mjs`'s own send handler, "fixed" by a refresh only because a
  `cs.focus` restored from the URL that resolves to nothing gets dropped, not
  because anything was actually repaired. Test:
  `tests/pr-comment-claude-chat.spec.mjs`'s "a stale block-scoped cs.focus…"
  case.
- **`handleClaudeChatStart` (`tasks_api.go`) needs a REAL comment record**,
  regardless of `Kind` — it 400s "unknown comment" when `commentId` isn't
  found via `s.tasks.comments.List`. This is stricter than
  `chat_workflow.go`'s own directive handling (which tolerates an unresolvable
  comment and starts the turn "top-level" anyway) — that leniency is for a
  Claude-issued `comment_action` directive mid-conversation, not for starting
  a brand-new Execution. A genuinely PR-wide `ai_warning`/`issue` comment
  always satisfies this in practice: "File is kept either way, as a hint of
  what the finding is about" (`anchoredWarning`, `code_warning.go`) — a
  code_warning finding that can't be pinned to a block still keeps a non-empty
  `File`, it just has no row anchor. "PR-wide" here means *no row anchor
  within a block* (`Kind !== ''`), not *no file at all*; a genuinely file-less
  general PR comment only ever arrives via GitHub import (an Activity calling
  the comments module directly, bypassing this HTTP validation).

Test: `tests/pr-comment-claude-chat.spec.mjs` — seeds a real PR-wide
`ai_warning` comment via `task_code_comment`, opens "Chat met Claude", sends a
message, asserts the fake reply lands, then closes the column.

## Live progress: what Claude is doing, and the answer as it is written

A turn is a real `claude` subprocess call that can run for minutes, so the
panel must show **what** it is busy with and let the answer **stream in** —
originally there was neither, only a static "Claude denkt…" (the "geen token-
streaming"-decision this replaced; don't reintroduce that).

**Transport is SSE**, over the tab's one shared `EventSource`
(`src/events.mjs`, `GET /api/events`) — see `.claude/docs/server-events.md`
for the channel itself and its two hard rules. Neither polling loop survived:
`ensureChatEvents(pr)` subscribes once per page to

- **`chat.progress`** — the volatile snapshot of the running turn
  (`{running, phase, tool, detail, partial, startedAt}`), keyed on the
  conversation id. Applied per conversation (`claudeTurns.mjs`), for **every**
  key of this PR — not only the one on screen, see "Parallel conversations".
- **`chat.message`** — "this conversation's transcript changed"; for the
  conversation in view the handler refetches `GET /api/chat` (never trusts a
  pushed body) and then clears a finished progress snapshot; for another one it
  only marks it as "answered while you were elsewhere".
- **the resync** — refetch the transcript **and** `GET /api/chat/progress` for
  the conversation in view, plus the PR-wide `?pr=N` form for every other
  running turn. That is the snapshot read for a tab that opened or reconnected
  **mid-turn** (a refresh at that moment is the normal case: the Activity keeps
  running server-side, it has no idea a tab went away). Not a poll target.

Three details are load-bearing:

- **`applyChatProgress` is the single writer of a conversation's progress**,
  and `setTurnProgress` (`claudeTurns.mjs`) stamps when that happened per
  conversation. Both resync reads — `loadChatProgress` and the PR-wide
  `loadRunningTurns` — compare that stamp against the time their own request
  started and **yield to a newer pushed event**: a resync runs right next to
  the events it is catching up on, so without this it could wipe a fresher
  snapshot and freeze the status line (with a reconnecting stream, it wipes it
  over and over — that is what made `claude-chat-progress.spec.mjs` flicker
  before the PR-wide read got the same guard).
- **A `chat.message` only clears the progress of the conversation in view, and
  only when the turn is NOT running**
  (`clearFinishedChatProgress`). That event also fires for the reviewer's *own*
  message at the very start of a turn, and clearing there would blink the
  status line away a moment after it appeared. A 4s timer after a
  `running:false` frame is the safety net for a transcript event that never
  arrives.
- **`cc.tick`** is a 1s heartbeat that only runs while **any** turn is running
  (`syncChatTicker`/`anyTurnRunning`), purely so "Claude denkt… 12s" advances; the number itself
  comes from the clock, `cc.tick` is read only to register the reactive
  dependency.

Rendering: `claudeStatusText(p, elapsed)` (`ClaudeChat.mjs`, exported) turns the
snapshot into one sentence in words — "Werkmap klaarzetten…", "Claude denkt
na…", "Claude leest `src/Order.php`", "Claude schrijft… · 12s"
(`PHASE_LABEL`/`TOOL_VERB`). It used to render inline below the message
thread, as `claudeChatColumn`'s own `claude-chat-thinking` paragraph; that spot
is gone — the text now renders inside `CommentClaudeFooter`
(`RelatedPanel.mjs`, mounted in `home.mjs` right after the comment+Claude
columns), the ONE shared status line for **both** the comment and Claude
sides — see "The shared `composeTargetHint` header" and the send-status
section in `.claude/docs/comments-panel.md` for its comment-side half and the
`reaction-status` button it replaced. Still the same
`data-testid=claude-chat-status` on the text itself, so
`tests/claude-chat-progress.spec.mjs` needed no change, just relocated to
`data-testid=comment-claude-footer-claude`'s own span.

### `preparing` vs `starting`: three different waits used to share one label

`chatPhaseStarting` originally covered three very different things at once:
local prep (`gh pr view` + `git fetch` + a worktree refresh, ~7s), the `claude`
CLI spawning, and the wait for its first token or tool call — which, on an API
529 (overloaded), the CLI retries **silently**; a reviewer could watch the
exact same "Claude start… · 84s" for minutes with zero signal that anything
was even happening, let alone that it might fail. See `chat_progress.go` for
the measured spread across a day of shadow sessions (most turns 3-7s, a few
minutes-long outliers ending in a 529).

`startChatProgress` (`chat_progress.go`) now starts a turn in
`chatPhasePreparing` ("Werkmap klaarzetten…") — everything before
`prepareChatShellWorkDir` in `runOneClaudeTurn` (`chat_workflow.go`) returns.
Once that local prep is done and the claude CLI is about to be invoked,
`advanceChatProgress` (the same mutate+publish pair `chatProgressSink` uses for
every streamed CLI event, just called once from outside that stream) moves the
phase to `chatPhaseStarting` ("Claude start…") — which then covers ONLY "CLI
session started, waiting for its first event". `chatProgressSink`'s existing
`ChatEventStatus` case (the CLI's own `init` frame) still maps onto that same
`chatPhaseStarting`, so the label doesn't jump again when the CLI confirms it
actually started — it was already showing the right thing.

One more phase sits between those two, and only sometimes:
`chatPhaseEscalating` ("Schrijfrechten ophalen…"). It shows when the cheap
read-only attempt answered in PROSE that it cannot write instead of emitting
`{"type":"need_write"}`, and the turn escalates to the shell attempt anyway
(`looksLikeWriteRefusal`, `chat_workflow.go` — see "The prompt fix above was
not enough" in `.claude/docs/workflows-comments.md`), and equally when the
PREVIOUS turn dead-ended on the work-directory choice
(`lastTurnWasCheckoutDeadEnd`, same file — see "A third round" in that same
doc). Momentary by design:
`waiting`/`starting` replaces it as soon as the escalated call really begins,
and there is deliberately no bubble, no stored message and no reviewer-facing
control for any of it — this brief line is the whole visible surface.

### The live partial bubble: attempt 1's leftover directive, and glued text segments

`p.Partial` (`chatProgress.Partial`, `chat_progress.go`) is the running answer
text that makes `claudePartialBubble` (`src/ClaudeChat.mjs`,
`data-testid=claude-partial-body`) stream in — `chatProgressSink`'s
`ChatEventText` case does `p.Partial += ev.TextDelta` for every streamed
delta. Two reviewer-reported bugs lived here, both about a two-step turn
(task 3, see "Attempt 2" above): the live bubble showed the literal raw
`{"type":"need_write"}` text, directly glued in front of the following
sentences with no separator at all
(`{"type":"need_write"}Nu de flag toevoegen.Nu de Unleash-config…`).

- **Attempt 1's own streamed answer stayed in `Partial` across the
  escalation.** When the cheap read-only attempt's whole answer IS the
  escalation directive, that text streams into `Partial` exactly like any
  other answer — and nothing ever cleared it before attempt 2 started
  writing its own real text right after it. **`resetChatProgressPartial(repo,
  pr, conversationID)`** (`chat_progress.go`, same mutate+publish pair as
  `advanceChatProgress`) is called from `runOneClaudeTurn` right before the
  shell attempt's own `cl.RunChat(...)` call — the earliest point the caller
  knows a second attempt is really about to write. A no-op if the turn
  already finished, mirroring `mutateChatProgress`'s own late-event guard.
- **A brand-new text content block right after a tool/thinking block was
  glued onto the previous one with no separator.** `modules/claude/claude.go`
  fires a fresh `content_block_start` per block, and Claude's own deltas
  never carry a leading space/newline across that gap — so two genuinely
  distinct sentences (Claude narrating "now I'll do X" before/after a tool
  call) ran together as one word. `chatProgressSink`'s `ChatEventText` case
  now inserts a blank-line separator (`"\n\n"`, renders as its own paragraph
  once through `renderMarkdown`) whenever the phase just before this delta
  was **not** already `chatPhaseWriting` (a real block boundary) — two
  consecutive deltas of the SAME block stay glued exactly as before, only a
  tool/thinking gap in between separates.
- **The live bubble also renders a labelled icon instead of the raw JSON,
  as a second, independent safety net.** Even with the reset above, the
  directive is still genuinely visible for the brief moment attempt 1
  itself is still streaming it (before the caller even knows whether it
  will escalate). `claudePartialBubble` checks whether `p.partial`
  (trimmed) starts with `{"type":"need_write"` — a PREFIX match, since the
  JSON may still be forming mid-stream — and renders **`claudeNeedWritePill()`**
  instead of the ordinary markdown div: a lock icon plus the word **"Vraagt
  schrijftoegang"**, with a matching `title`, same shape as
  `claudeNoShellPill` below (words carry the meaning, colour is decoration
  only, per the colourblind rule). Neither of these two lines was ever a
  concern for an already-STORED message: `isNeedWriteDirective`'s own check
  (see "Attempt 2" above) already prevented the raw directive from ever
  landing in a saved `chat.Message.Body` — this whole section is about the
  ephemeral `Partial` snapshot only, so no existing, persisted message needed
  any cleanup.

Test: `tests/claude-chat-needwrite-icon.spec.mjs` (the icon pill, mocked
`chat.progress`), plus `TestChatProgressResetPartialBeforeShellAttempt`/
`TestChatProgressSeparatesTextBlocksAfterATool` in `chat_progress_test.go`.

**The same raw-JSON flash also happens for the OTHER internal directives**
(`{"type":"question",...}`/`{"type":"comment_action",...}`, `chat_workflow.go`)
while they are still streaming — a reviewer reported seeing a raw `{` followed
by JSON right before Claude produced a code suggestion via such a directive.
`claudePartialBubble` (`ClaudeChat.mjs`) therefore checks a second, GENERIC
prefix (any partial that still starts with `{"`, checked only once the
specific `need_write` prefix has already been ruled out) and renders
**`claudeGeneratingPill()`** — a spinner plus the word "Bezig met
genereren…" — instead of adding a named prefix/pill per directive. Same
reasoning as need_write: never reviewer-facing content, and
`isNeedWriteDirective`'s siblings already keep any of these out of a stored
`chat.Message.Body`, so this is purely about the ephemeral `Partial`
snapshot. Test: the second case in `tests/claude-chat-needwrite-icon.spec.mjs`.

**The long-wait suffix is front-end only, deliberately no new backend state.**
`elapsed` (`RelatedPanel.mjs`'s `elapsed()` getter) already counts seconds
since `startedAt`, which now marks the start of `preparing` and therefore keeps
counting straight through into `starting` — exactly the number a reviewer sees
in "· 84s". `claudeStatusText` (`ClaudeChat.mjs`) appends a fixed suffix once
`phase === 'starting'` (never `preparing`, which is bounded to a few seconds
and never needs this) and `elapsed >= LONG_WAIT_SECONDS` (30): "Claude start…
· 47s · het is nu druk, hij blijft proberen". Worded as a still-in-progress
sentence, not an error — "nog geen antwoord" was rejected as an opening because
it reads as something already went wrong, when the CLI is (usually) still
quietly retrying. The only consumer of `GET /api/chat/progress` is this same
UI with its own clock, so there is no reason to compute or store the threshold
server-side.

**Per-turn timing also goes to `server.log`** (`runOneClaudeTurn`,
`chat_workflow.go`): a `tm.logf` line after local prep finishes, one for the
first CLI event of any kind (in practice the `init` frame) and one for the
first real content event (thinking/text/tool), each with the elapsed time
since the turn started, plus one when `cl.RunChat` returns (with its error, if
any). Purely operational — never persisted, never reviewer-facing, same
carve-out as the rest of this file — but it turns "why did this turn take four
minutes" from a manual reconstruction (as the investigation behind this
section had to do) into one `grep` of the log.

**The Claude half wraps over up to THREE lines** (`line-clamp-3`
`[overflow-wrap:anywhere]`, on a `min-w-0 flex-1 items-start` half with the
pulsing dot nudged down to the first line). It used to be a single `truncate`d
line, which cut off exactly the informative cases: a long `Bash`/`Read` detail,
or the status plus the queue note ("· nog 2 berichten in de wachtrij", see
"Doorpraten tijdens een lopende turn"). Three lines is the cap on purpose — the
footer must not grow into a panel of its own — and the third line still ends in
an ellipsis when even that isn't enough. The comment-side half keeps its single
`truncate`d line: its texts are fixed and short ("Bezig…", "Verstuurd").

**The footer row itself carries `w-0 min-w-full`, and that is load-bearing.**
`comment-claude-row` (`home.mjs`) is a `flex-col` with no width of its own: its
width follows its widest child, and `<main>` scrolls horizontally, so nothing
clips it. A wrapping status line therefore did NOT wrap at first — the footer's
own intrinsic width simply stretched the whole merged card (measured: 640px →
1390px) and the text stayed on one line, now in a card wider than both columns.
`w-0` takes the footer out of that intrinsic-width calculation (the columns row
decides the width) while `min-w-full` stretches it back to exactly that width,
which is what finally gives `line-clamp-3` a boundary to wrap against. Same
reason the status span needs `min-w-0 flex-1` inside its half. Test: the
line-count assertions in `tests/claude-chat-progress.spec.mjs`, whose steady
mocked frame carries a deliberately long `Bash` detail.

`ClaudeChat.mjs` still
renders the **provisional bubble** (`data-testid=claude-partial`), rendering
`progress.partial` through the same `renderMarkdown` — that one stays inline in
the thread, only the status line moved. The word carries the meaning; the
pulsing dot is decoration (colourblind rule). The bubble is throwaway by
construction: no id, no key, never part of the message list, gone as soon as
the stored message is refetched.

**The durable side is untouched by all of this.** Fragments live only in memory
(`chat_progress.go`) and the callback that produces them is a Go func on
`RunRequest`, structurally unable to reach an Activity's recorded input — so the
one saved `chat.Message` stays a pure function of that input
(`.claude/rules/workflow-determinism.md`). Backend details, including the
`stream-json` parsing and the `TurnID`-derived message ids that make a replayed
turn overwrite instead of duplicate, are in the `claude_chat` section of
`.claude/docs/workflows-comments.md`.

## `src/ClaudeChat.mjs`: pure template, fed getters

A new file, deliberately holding **no `reactive()` state and no import of
`RelatedPanel.mjs`** — the same split `translationDiff.mjs` already has with
`Block.mjs`, so there's no circular import (`RelatedPanel.mjs` →
`ClaudeChat.mjs`, never the other way).

`claudeChatView()` (`RelatedPanel.mjs`) hands `claudeChatColumn` a `view`
object whose fields are **getter functions** (`{ messages: () =>
cc.messages, status: () => cc.status, busy: () => cc.busy, claudePos: () =>
cs.claudePos }`) — **not** a plain snapshot. This is load-bearing, not
stylistic:

### The bug this avoids: static chunk-reuse silently freezes plain content

Once a nested template of a given shape is mounted, arrow.js's chunk-reuse
re-patches it via a **static** path (`pe`, the same one documented in
"A statically interpolated template↔string slot leaks the template function
as text" in `arrowjs-pitfalls.md`) that only re-applies **attribute slots**
and slots whose value is **itself a function** — a plain array/string/number
computed once by a helper function and interpolated directly is captured at
first mount and **never revisited** on a later re-render of the same shape,
even though the enclosing `${() => ...}` binding genuinely re-executes and
computes a fresh value every time. This is the same class of bug as "a keyed
node reused without re-running its bindings", just for a **single nested
template** (or a list item matched by an unchanged key) instead of a whole
component.

Concretely, in this feature: `ClaudeChatPanel`'s outer visibility toggle
(`cs.focus`/`hasVisibleComments()` rarely changes) meant the returned
`<div data-testid="claude-chat-column">` mounted essentially once, and a
first attempt at `claudeChatColumn` that took a **plain snapshot** — passing
`cc.messages`/`cc.busy` as already-read values rather than getters, and
interpolating the resulting array/booleans directly — silently froze on
whatever was true at that first mount: new messages, the "Claude denkt…"
line, and disabled/active states never updated again, even though
`RelatedPanel.mjs`'s own console-log tracing proved the JS re-ran with fresh
data on every change. Regression risk: **any future edit to this file that
interpolates something dynamic without wrapping it in its own `${() => ...}`
binding will reproduce this exact silent freeze** — mirror
`reactionBubble`'s pattern in `RelatedPanel.mjs` (every attribute/class/
content slot that can change over time is its own nested reactive binding)
for anything new added here.

Concretely wrapped, each in its own `${() => ...}`:

- the transcript list (empty/error state as an array-of-one, per the
  single↔array-slot rule, else `messages.map(...).key('claude-msg:'+m.id)`);
- the `msg.answer ? <answer text> : claudeQuestionOptions(...)` toggle inside
  each bubble — **load-bearing even for a message matched by an unchanged
  key**: answering a question fills `answer` in place on that same row (see
  `chat_workflow.go`'s `saveChatAnswer`), so this slot must re-evaluate on a
  later render of the *same* `claude-msg:<id>` item, not just on first mount;
- the active-turn ring on each bubble's class (`claudePos`-driven, mirrors
  `reactionBubble`'s own `active`);
- the "Claude denkt…" paragraph (`busy`-driven);
- the send button's class + `disabled="${() => view.busy()}"` and the
  question-option buttons' `disabled`.

## ↑/↓ walks a still-open question's options before the transcript

Reviewer request: pick one of a still-open question's (up to 3) options with
the keyboard, not only a click — and the option buttons' text must be
left-aligned, not centered (the browser's own UA default for `<button>`,
which showed up as centered text on a two-line option — `text-left` on the
button fixes that on its own, no layout change needed since the buttons
already wrap onto their own line as soon as the text fills the row).

The keyboard part folds into the EXISTING `cs.claudePos` chain
(composer → turns, see "The chain, key by key" above) rather than adding a
second, disjoint arrow-key mode — explicit reviewer answer, not a guess:
"↑/↓ moet eerst door de keuze-opties lopen en daarna doorlopen naar het
transcript (oudere beurten) — één doorlopende cursorketen: composer → opties →
transcript, en omgekeerd terug."

**`cs.claudeOptionSel`** (`RelatedPanel.mjs`, ephemeral, not URL-bound — a
keyboard highlight, not a navigation position) is `cs.claudePos`'s own
sub-cursor for exactly this: `0` = nothing highlighted (composer/rest),
`1..N` = the N-th option counted from the BOTTOM of the options list (mirrors
`claudePos`'/`threadPos`' own "counted from the bottom" convention — the
option closest to the composer is reached first walking up from it). Only
meaningful while `cs.claudePos === 0` **and** the newest message is a
still-open, unanswered question with options (`pendingClaudeQuestion()`).

The chain, walking up from the composer: `claudePos 0, optionSel 0` (rest) →
`claudePos 0, optionSel 1..N` (the options, bottom to top) → `claudePos 1`
(the question bubble itself, `optionSel` back to `0`, same as an ordinary
turn) → `claudePos 2..` (older turns) — and the exact mirror walking down.
`handleRelatedKey`'s `'claude'` branch (`RelatedPanel.mjs`) implements this:
`ArrowUp` at `claudePos === 0` with a pending question increments
`claudeOptionSel` until it exceeds the option count, then hands off to
`claudePos = 1`; `ArrowDown` is the exact reverse, and re-entering `claudePos
1`'s question from above (its OWN `ArrowDown`) re-enters the options at the
topmost one. `focusClaudeComposer()` blurs the composer through the whole
options rung too (`claudePos === 0 && claudeOptionSel === 0` is now the ONLY
state that keeps it focused) — the highlighted button, not an empty
textarea, should read as "focused" — and
`scrollClaudeMessageIntoView0Options()` keeps the (always-newest) question
bubble in view while `claudePos` stays `0` there (`scrollClaudeMessageIntoView`
itself indexes off `claudePos`, which stays `0` through this whole rung and
would resolve to the wrong node).

**`Enter` sends the highlighted option** — `selectHighlightedClaudeOption(state,
commentTarget)` (`RelatedPanel.mjs`, exported) is the keyboard counterpart of
clicking a `claude-question-option` button: same `sendClaudeMessageFromNew`
path, then resets the highlight. A no-op (returns `false`) when nothing is
highlighted, so `home.mjs`'s `onKeydown` calls it unconditionally right before
the existing "Enter opens the Claude menu" branch and only falls through to
that branch when it returns `false` — load-bearing ordering, since the
composer is deliberately blurred while an option is highlighted and would
otherwise ALSO match that branch's own DOM-focus check.

**Highlight is a ring plus a leading `›` glyph** on the button's own text,
never a ring/colour alone (`claudeQuestionOptions`, `ClaudeChat.mjs`,
colorblind rule) — `data-active="true"/"false"` per option, mirroring the
app-wide `data-active` convention (`related-item`, `nestedChip`, …).
`cs.claudeOptionSel` is reset on every transition that already resets
`cs.claudePos`/leaves `'claude'` focus (`exitRelated`, `toComment`,
`toNewFocus`, `enterClaudeChat`, `enterClaudeChatFromNew`, `clearClaudeChat`).
Test: the "↑/↓ walks the question options before the transcript…" case in
`tests/claude-chat-panel.spec.mjs`.

## A "regel N" hint above the first message shows what a multi-line selection sent

Reported bug: a multi-line `Shift+↑/↓` range selection (see "Shift+↑/↓" in
`.claude/docs/keyboard-navigation.md`) left **no visible trace** of what was
actually referenced once sent to Claude. The selection's code/line range
(`commentTarget()`) travels along as the `context` field of
`sendClaudeMessage`'s Signal (`claudeContextBlock`), but that field is
**never rendered** — only the reviewer's own typed text becomes the stored
message body (`body: trimmed`) — so the transcript showed the question with
zero indication of which lines it was about, most confusing for a range wider
than one line.

Fix is display-only, using data already stored: the anchor comment
`ensureClaudeAnchorForNew` creates for a conversation's first turn already
stores `line: t.startLine` — the FIRST line of the (possibly multi-line)
selection (`Comment` has no separate end-line column, and the reviewer
explicitly accepted anchoring on the first line as a simplification, so no
backend change was needed). `claudeChatView().anchorHint` (`RelatedPanel.mjs`)
resolves that comment (`cs.list.find(x => x.id === cc.commentId)`, not
`chatAnchorComment()`/`selComment()` — those follow the currently SELECTED
comment, which can drift from the conversation actually in view while
browsing) into a short sentence, e.g. `"deze regel · regel 42"`
(`GRAN_LABEL[c.gran] + ' · regel ' + c.line`). `claudeBubble` (`ClaudeChat.mjs`)
renders it (`data-testid=claude-message-anchor`) above the conversation's
FIRST message only (`i === 0 && mine`) — the one turn that ever actually
carried this context (`claudeContextBlock` only attaches it on
`cc.messages.length === 0`), so it can never drift out of sync with which
turn the hint is shown on. Test: the "a multi-line Shift selection shows a
'regel N' hint…" case in `tests/claude-chat-panel.spec.mjs`.

`.innerHTML` bodies go through the same `renderMarkdown` convention as
`commentBody` (own small `claudeMessageBody(msg)` helper, `()=>
renderMarkdown(msg.body)`) — Claude's replies render as Markdown like any
other comment/reply.

Claude has no GitHub login/avatar; `avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')`
falls back to its initials-circle rendering (empty `avatarUrl`).

### No per-side focus border any more (an earlier decision, reversed)

`comment-claude-row`'s two halves used to give the comment side an
**unconditional** indigo border (`expandedConversation`) while the Claude side
had none at all — so the border stayed on the left even once `→` moved the
keyboard cursor (`cs.focus`) into the Claude column, misleadingly suggesting
the reviewer was still "in" the comment thread. That was fixed by giving both
halves a **conditional** border keyed on `cs.focus` — `expandedConversation`
indigo only while `cs.focus === 'comment'/'thread'`, `claudeChatColumn`'s
`claude-chat-card` indigo only while `cs.focus === 'claude'`, `border-transparent`
(never a neutral gray — "helemaal geen rand op de niet-gefocuste kant") the
rest of the time.

**That whole mechanism is gone now** (explicit reviewer request, deliberately
reversing the fix above): once both halves permanently merged into one shared
bordered `comment-claude-row` card (see "The shared `composeTargetHint`
header" in `.claude/docs/comments-panel.md`), a per-side focus border read as
a doubled border rather than a useful cue — most visible in the
`newCommentComposer`'s `isNewChatUnanchored()` state, whose own indigo border
was never made conditional in the first place and so stayed alongside
Claude's own conditional one. Neither `expandedConversation`, the
`isNewChatUnanchored()` composer card, nor `claudeChatColumn`'s
`claude-chat-card` carries a `border`/focus-border class any more, regardless
of `cs.focus`. Full rationale: "No per-side focus border any more" in
`.claude/docs/comments-panel.md`. The `tests/claude-chat-panel.spec.mjs` case
that asserted the border swapping sides was removed along with it — nothing
replaces it, since there is no longer a border to assert on.

## Testing hook: `SLASH_CLAUDE_CHAT_TURNS`

`claude.Fake.RunChat` returns `""` for every call unless programmed
(`SetChatTurns`), which made a real, deterministic Playwright test of the
"question with choices" flow impossible without a backend hook — mirrors the
existing `SLASH_JIRA_ASSIGNED` fixture-path convention exactly.
**`SLASH_CLAUDE_CHAT_TURNS`** (`tasks_api.go`, only read under
`SLASH_CLAUDE=off`) optionally points at a JSON `[]string` fixture that
programs the Fake's turn script at server startup. That script is
**per conversation, not a queue**: the Fake keeps a **cursor per session id**,
so every fresh session (`SessionID == ""`) starts again at turn 1 and only a
*resumed* session walks on to the next turn. It used to be one worker-wide
consuming FIFO, which was fine while a single spec used it and broke as soon as
a second chat spec landed on the same worker — the second conversation then got
turn 2 or 3 instead of turn 1, red or green purely by scheduler luck. Wired in `tests/_fixtures.mjs`'s worker-scoped server
fixture → `tests/fixtures/claude-chat-turns.json` (a plain-text reply, then a
strict `{"type":"question",...}` directive, then a follow-up reply).

## Tests: `tests/claude-chat-panel.spec.mjs` + `tests/claude-chat-progress.spec.mjs` + `claude-chat-queue.spec.mjs` + `claude-chat-newline.spec.mjs`

`claude-chat-queue.spec.mjs` covers "doorpraten": it **holds** the first
message Signal's POST via `page.route` (a running turn as a *steady* state,
never a slow real turn), then asserts the composer stays enabled, two further
messages queue up as visible `claude-queued` bubbles in order, nothing extra
goes on the wire, and releasing the held POST drains them FIFO.

`claude-chat-newline.spec.mjs` covers Shift+Enter: the newline lands in the
field, nothing is sent, Space still types a space, and the sent bubble keeps
both lines as a `<br>`.

The two specs below hand-build a `view` object for `claudeChatColumn`, so they
also pin its render contract — `queued: () => []` had to be added there when
the queue landed, and `pinned: () => true` when the "scroll to recent
messages" button did (see "A manual scroll-up must not get yanked back down"
in `.claude/docs/comments-panel.md`) — a hand-built `view` missing either
field throws (`view.pinned is not a function`) the moment the toggle it backs
first evaluates, since `claudeChatColumn` calls it unconditionally.
`tests/scroll-to-recent-button.spec.mjs` covers the button/pinned mechanism
itself end to end (through `RelatedPanel.mjs`'s real `claudeChatView()`, not a
hand-built one).


`claude-chat-progress.spec.mjs` covers the live half: it fulfils
`GET /api/events` with hand-written SSE frames (and makes the resync read
report no running turn, so anything the panel shows can only have come from the
push) and asserts the status line + the provisional bubble. The injected
progress stays `running` for the whole spec — a **steady** state, not a
transient one, per `.claude/docs/testing-playwright.md`. Note the first
connection deliberately carries only a `retry:` hint: the tab's `EventSource`
opens at page load, before the chat column is entered, and an event for a
conversation that isn't open yet is dropped by design.

Seeds an ordinary comment via the API (mirrors `comment-thread.spec.mjs`,
its own PR via `seededPr`), clicks the comment row, and drives the whole
chain with real keypresses: `↑` into the thread's own bubble then `→` (and,
separately, a single `→` straight from the comment card) both reach the
Claude block in one step — sends a plain message and asserts the programmed
reply, sends a second message and asserts the 3 option buttons render,
clicks one and asserts both the recorded `claude-question-answer` and the
next programmed reply, then `←` back onto the comment card directly.
Deliberately does **not** assert on the transient
"Claude denkt…" line (the Fake resolves near-instantly, and asserting a
transient state is explicitly disallowed — see
`.claude/docs/testing-playwright.md`).

## Ripple: the extra hop every spec once needed is gone again

While the panel was unconditionally reachable, every pre-existing spec that
pressed `→` twice (list→diff, diff→related) on a unit **without** a seeded
comment needed one extra hop, because the second press landed on `'claude'`.
Now that a comment-less unit has no chat column at all, those hops were
**reverted** — `related-nav.spec.mjs`, `related-tests-group.spec.mjs`,
`related-nested-chip.spec.mjs`, `footer-explanation.spec.mjs`,
`scroll-focus-vertical-only.spec.mjs`, `urlstate.spec.mjs` drive the original
chain again, including the two `scroll-focus-vertical-only.spec.mjs` "the
originally-focused diff column must still be fully in view" sanity assertions
that the intermediate stop had made untrue. `related-nav.spec.mjs`'s
comment-less case additionally asserts that **no** `claude-chat-column` and
**no** `comment-item` appear, so a reintroduced placeholder comment would fail
a test rather than quietly reappear.

## Every turn gets a real shell by default — no button, just ask in the message

**The backend half of this section (`chat_shadow.go`, the per-conversation
disposable shadow worktree) is SUPERSEDED.** A write turn now edits the PR's
ONE shared, standing local checkout of the reviewer's own — see
`chat_checkout.go` and `todo/todo-local-checkout-chat-edits.md` (kept local/
uncommitted), and "Agentic edits" in `.claude/docs/workflows-comments.md`.
Everything below about the FRONTEND (no buttons, `NoShell`/the "Geen
bestandstoegang" pill, asking in plain words) is unchanged — only where/how
the backend gets Edit/Bash access changed. A dirty/ambiguous local checkout
now surfaces as its own, more forceful `chat.KindDirectoryDecision` turn (see
"Every turn gets a real shell by default" → `claudeQuestionOptions`/
`chatKindBadge` in `ClaudeChat.mjs`), answered through the exact same reply
mechanism as an ordinary question.

**The checkout chip** (`checkoutChip`, next to `autoWarnToggleButton`/
`themeToggleButton` in `prInfoCard`'s `pr-info-theme-row`, `home.mjs`) is the
reviewer's own entry point into the same mechanism, outside a chat turn:
word + glyph state ("Geen directory" / a directory name / "Keuze nodig",
never colour alone), opening a small command-menu (mode `'checkout'`,
anchored via `isDescriptionMenu()`) with — dynamically, via
`checkoutChipCommandsFor()` — either the pending decision's own options
(answered via the SAME `"checkoutAnswer"` Action `chatCheckoutDecision`
already uses) or "Andere directory kiezen" (`"checkoutRelist"` — always
re-lists every eligible candidate, even a single one, never auto-picking:
see `listAllCheckoutChoices`, chat_checkout.go), plus "Nu terugzetten" while
a stash is pending (`"checkoutRestoreStash"`) and "Uit" (`"checkoutOff"`).
All four ride the existing `chat_merge` queue's "merge" Signal as new Action
values — no new endpoint/workflow — ensured first via
`POST /api/workflows/chat_merge` (idempotent, needed because the chip is
reachable before anything has ever landed/relisted for this PR). Read side:
`GET /api/chat/checkout` (batch-shaped like `/api/pending-push`), refetched
on the new `checkout.changed` SSE event. The PR-overview's own
`checkoutPill` (`overview.mjs`) reads the same endpoint for a
"this PR has a directory assigned" badge next to the unpushed one — see
`.claude/docs/pr-overview.md`. Test: `tests/checkout-chip.spec.mjs` (the
frontend contract, fully mocked — the git-plumbing side of these four
Actions is covered by `chat_checkout_test.go`/`chat_merge_test.go`).

### The selection ladder no longer asks about unpushed local commits, and prefers a directory already on the PR branch

Two follow-up fixes to `chat_checkout.go`'s selection ladder, both reviewer
decisions:

- **A clean checkout that is already on the PR's own branch, with real local
  commits origin doesn't have yet, is used straight away — no question.**
  This used to be `checkoutStageDivergedHistory`, a consult with exactly ONE
  option ("Doorgaan met de huidige lokale stand"). It is REMOVED, not just
  reworded: a write turn only ever **commits on top**, never discards or
  force-overwrites anything, so there was nothing this consult protected
  against in the first place — reviewer's own words: "je mag hier gewoon op
  verder bouwen". Its removal also fixed a real, reported bug: a reviewer
  reply that didn't match the option **byte-for-byte** (e.g. typed free text
  like "doe het toch" instead of clicking the literal button) never resolved
  it, so `prepareChatShellWorkDirAt` kept re-issuing the identical decision
  under a NEW message id forever — an unexplained, apparently-infinite loop.
  `chatCheckoutDirtyDecision` now only ever returns the genuinely-dirty
  (`checkoutStageDirtyTree`) consult; a clean-but-not-fast-forwardable
  candidate falls straight through in `prepareChatShellWorkDirAt`.
- **Matching a reply against a decision's Options is now trim + case-
  insensitive** (`matchCheckoutOption`), and a reply that still doesn't match
  anything gets a re-asked decision with an explicit **"Dat antwoord
  herkende ik niet als een van de keuzes."** prefix instead of a silent,
  byte-identical repeat — belt-and-braces on top of the removal above, for
  the stages that still do require an exact pick
  (`checkoutStageChooseDirectory`/`checkoutStageReuseMerged`/
  `checkoutStageDirtyTree`).
- **A directory already on the PR's own branch always wins over one that is
  merely on some other, already-merged (hence free) branch** —
  `prioritizeOnTargetBranch` (`chat_checkout.go`) narrows the classified
  candidates to the `OnTargetBranch` ones FIRST whenever at least one exists,
  before `selectCheckoutCandidate` ever decides none/one/many. So a single
  directory already on the PR branch auto-picks with no question at all, and
  choosing among several only ever compares directories genuinely already on
  that branch — a `master`/`develop` checkout only participates when NOTHING
  is on the target branch yet, exactly as before. Deliberately **not** folded
  into `listCheckoutCandidates` itself: the explicit "Andere directory
  kiezen" menu (`listAllCheckoutChoices`/`relistCheckoutCandidates`) keeps
  showing every eligible candidate unfiltered — that menu IS the reviewer
  overriding the automatic pick, so narrowing it there too would take away
  the very choice being asked for.

Tests: `TestPrepareChatShellWorkDirProceedsOnUnpushedLocalCommits`,
`TestPrepareChatShellWorkDirAsksAboutDirtyCandidate`'s "herkende ik niet"
assertion, `TestSelectCheckoutCandidatePrioritizesOnTargetBranch`,
`TestListAllCheckoutChoicesDoesNotPrioritize` (all `chat_checkout_test.go`).

**Follow-up: a short natural-language stand-in for an option is also
recognized**, not just its byte-for-byte (case/whitespace-insensitive) text.
Reported bug: typing "gewoon ernaast doen" instead of clicking the
`optKeepSeparate` button ("Los laten (buiten Claude's commit houden)") kept
coming back "Dat antwoord herkende ik niet als een van de keuzes" forever —
the exact same unanswerable-loop shape the byte-for-byte fix above already
covers for a genuine mismatch, but this reply was never really a mismatch,
just a paraphrase. `matchCheckoutOption` now falls back to
`checkoutOptionAliases`, a small `map[string][]string` (`chat_checkout.go`) of
short, distinctive phrases that only ever mean ONE offered option — checked as
a substring of the (lowercased) reply, only once no option matched
byte-for-byte. Deliberately narrow: only `optKeepSeparate` has aliases today
("ernaast", "naast elkaar", "los laten", "apart houden", "laat maar staan") —
a generic word that could plausibly mean several options is never added, since
a wrong match here would silently run the wrong git operation. Extend the map
rather than adding a second matching mechanism if another option turns out to
need this. Test:
`TestPrepareChatShellWorkDirRecognizesNaturalLanguageKeepSeparateReply`
(`chat_checkout_test.go`).

### A push the reviewer asks for IN the conversation is a real push

`modules/claude/prompts/chat_shell.md` used to only say "push when the
reviewer literally asks — never on your own, never `--force`", with no
instruction on HOW — and, separately, its own wording still described the
long-superseded disposable shadow worktree ("een apart, wegwerpbaar
klonetje"). Reported bug: asked to push, the assistant deflected to the
review-tree's "not pushed yet" todo row instead of just running the push
itself, even though a chat turn already has real Bash access to the exact
checkout that row is about (`.claude/rules/workflows-write-boundary.md`'s
"Exception: the Claude chat turn may act through a shell"). Fixed by
rewording the prompt: on an explicit push request, run `git push` yourself
via Bash in the checkout and report the outcome; never point at the todo row
as the answer to a push request made in this conversation — that row is
strictly for the reviewer to push on their own, without involving Claude, not
a substitute for a request made here. Test:
`TestChatShellSystemPromptInstructsARealPush` (`modules/claude/prompts_test.go`).

### "Wordt aangepast": a live, per-block status while an edit hasn't landed yet

Reviewer request: see a local Claude edit in the tree **immediately**, tagged
so it reads as still-in-progress, not with the existing unpushed label (which
keeps its own, separate meaning — "landed, not yet on GitHub"). Landing itself
stays post-turn, exactly as `.claude/docs/pending-push.md` describes (no live/
mid-turn commit) — this is purely a **status pill**, shown WHILE that landing
hasn't happened yet.

- **`chatProgress.EditedFiles`** (`chat_progress.go`) accumulates every
  repo-relative path an `Edit`/`Write` tool call touches, for the lifetime of
  ONE turn — unlike `Tool`/`Detail`, which the next tool call overwrites.
  `chatProgressSink` (`chat_workflow.go`) turns the tool's absolute
  `file_path` into a repo-relative one via a `*string` the caller
  (`runOneClaudeTurn`) points at the shell attempt's own `WorkDir` right
  before invoking it — empty during the read-only attempt, which never has
  an Edit/Write tool to begin with.
- **`chat_edit_pending.go`** is the PR-scoped "still pending" registry:
  `finishChatProgress` hands a finished turn's `EditedFiles` to
  `markChatFilesPending` right before the volatile snapshot disappears (the
  same operational, outside-the-write-boundary carve-out as
  `chat_progress.go`/`pending_push.go`'s own status maps — nothing here is
  durable, git is). `clearChatPendingFiles` wipes the WHOLE set for a PR the
  moment ANY landing for it succeeds (`processChatMergeAt`,
  `chat_merge.go`) — `commitCheckoutEditsAt` always `git add -A`s the whole
  checkout, so a successful landing by definition carries every file that
  was pending; also cleared on a cancelled turn's own "Verwijderen"/stash
  cleanup (`applyCancelCleanup`), since the edit is gone from the working
  tree either way.
- **`checkoutView.PendingFiles`** (`chat_checkout.go`'s `buildCheckoutView`)
  exposes the registry over the EXISTING `GET /api/chat/checkout` read model
  — no new endpoint — refetched on the same `checkout.changed` SSE event the
  checkout chip already reacts to (now also published after a successful
  landing, alongside the existing `pendingpush.changed`).
- **Frontend**: `editingPill` (`BlockList.mjs`, per index row) and
  `opts.editing`/`data-testid=block-editing` (`Block.mjs`, the diff card)
  mirror `unpushedPill`/`opts.unpushed` exactly (per FILE, not per block,
  same accepted trade-off) but read `state.checkout.pendingFiles`
  (`checkoutPendingFiles()`, `home.mjs`) instead of
  `state.pendingPush.files` — a deliberately different glyph (`✎`) and
  colour (sky, not amber) from the unpushed pill, so a block that is BOTH
  mid-edit and separately unpushed shows two distinguishable pills rather
  than one ambiguous one.

**This pill's own sibling picks up right where it leaves off.** The moment a
landing succeeds this "wordt aangepast" set is cleared, but the block/diff
panel doesn't actually show the new code until the ingest-refresh that
landing triggered finishes — a separate, THIRD status,
"wordt bijgewerkt" (`⟳`, violet), covered in full in "'Wordt bijgewerkt': auto-
refreshing the reviewer's OWN landing" in `.claude/docs/pending-push.md`
(`chat_refresh_pending.go`) — that file, not this one, is where that gap and
its automatic-refresh fix live.

Tests: `TestChatProgressAccumulatesEditedFiles` (`chat_progress_test.go`),
`TestBuildCheckoutViewReportsPendingFiles` (`chat_checkout_test.go`),
`TestProcessChatMergeClearsPendingEditedFilesOnSuccess`
(`chat_merge_test.go`).

Phase 3's backend (a per-conversation shadow worktree + a fast-forward-only
commit/push — see "claude_chat" → "Agentic edits" in
`.claude/docs/workflows-comments.md`) used to be reached from this panel via
two plain, native `<button>`s below the composer ("Bewerk code"/
"Commit wijziging", `data-testid=claude-chat-send-edit`/`claude-chat-commit`,
`ClaudeChat.mjs`) next to "Stuur", plus a two-step confirm menu
(`CLAUDE_COMMIT_CONFIRM_COMMANDS`, `home.mjs`, mode `'claudeCommit'`) before
the commit button's push. **Both buttons and the confirm menu are removed**
— reviewer request: "I'll just say what I want in the message, Claude should
be able to do it itself," rather than picking a separate action first.
`claudeChatColumn` (`ClaudeChat.mjs`) has only "Stuur" left;
`claudeChatCallbacks` (`RelatedPanel.mjs`) has only `onSend`; `ClaudeChatPanel`
lost its `openCommit` param; `home.mjs` lost `CLAUDE_COMMIT_CONFIRM_COMMANDS`
and every `'claudeCommit'` mode branch (`rootCommandsFor`/`resolveCommands`/
`menuAnchor`/`menuRegion`). `sendClaudeMessage` (`RelatedPanel.mjs`) still only
ever sends the plain `action: ''` Signal — unchanged frontend contract.

**The backend now does the widening itself, on every turn, regardless of
`action`.** Per `.claude/rules/workflows-write-boundary.md`'s "Exception: the
Claude chat turn may act through a shell", `runOneClaudeTurn`
(`chat_workflow.go`) tries `prepareChatShellWorkDir`
(`chat_shadow.go`, wrapping `ensureChatShadowWorktree`) for EVERY turn:

- **Succeeds** (gh/git reachable) → the CLI gets `WorkDir` set to the
  conversation's shadow worktree and `Tools:
  ["Read","Grep","Glob","Edit","Bash"]`, plus `claude.ChatShellSystemPrompt`
  (`prompts/chat_shell.md`) — the same question/`comment_action` JSON
  contracts as the plain prompt, plus explicit permission to run `git`/`gh`/
  `acli` via Bash (including committing/pushing) **only** when the reviewer
  explicitly asks for it in the message, never on its own initiative.
- **Fails** (gh/git unreachable, no network, a plumbing error) →
  `prepareChatShellWorkDir` swallows the error (best-effort `tm.logf` — the
  exact reason stays server-log-only) and the turn falls back to exactly the
  original tool-less completion: no `WorkDir`/`Tools`, `claude.ChatSystemPrompt`.
  A pure conversational turn therefore **never** fails because of this — this
  is the fix for an earlier, reverted attempt that defaulted every turn to the
  old `'edit'` action and made ordinary Q&A hard-depend on a live `gh pr view`
  + `git fetch` round trip (see `chat_shadow.go`'s doc comment and
  `chat_workflow_test.go`'s `stubUnreachableGh`/`stubReachableGh` for the two
  regression tests, `chat_shell_test.go`).

  **The degradation itself is not silent, only its reason is.** `runOneClaudeTurn`
  sets `chat.Message.NoShell` on the turn's own saved reply (`msg.NoShell =
  !hadShell`, right next to `msg.Model`) — never on a `KindError`/`KindRetrying`
  system message, where tool availability isn't the point. `ClaudeChat.mjs`'s
  `claudeNoShellPill` renders a "Geen bestandstoegang" badge (amber, WORD +
  glyph, never colour alone) next to the model pill whenever it's set, same
  "presence itself is the signal" shape as `claudeModelPill`: an ordinary turn
  with shell access shows nothing extra. Without this a reviewer had no way to
  tell that a reply which *talks* about the code never actually looked at
  it — see the wedged-submodule incident below for why this can happen for
  every turn of a conversation, not just a one-off network blip.

### Incident: a wedged shadow worktree degraded every turn to tool-less, silently

The reviewed repo (plug-and-pay) carries real, active submodules
(`forks/nova`, `modules/Ai`) and its shared local clone sets
`submodule.recurse=true`. `ensureChatShadowWorktreeAt`'s refresh path used to
run a plain `git reset --hard <tip>` on an existing shadow worktree — which,
combined with those two settings, makes git try to (re)initialize the
submodule's own gitdir in a PER-WORKTREE location
(`<clone>/.git/worktrees/<shadow>/modules/forks/nova`). That attempt could
fail partway (no credentials/network for a second, separate clone from this
subprocess's environment) and leave a HALF-INITIALIZED gitdir behind — just a
`config` file, no `HEAD`/`objects`/`refs`. Every later git command that
touches that path then aborts with `fatal: not a git repository: .../modules/
forks/nova` / `fatal: could not reset submodule index` — **permanently**,
since the corruption doesn't heal itself. This is why it looked like a
one-off ("gh/git happened to be unreachable") but actually wedged an entire
conversation to tool-less for every subsequent turn, and hit several PRs on
the same day (the shadow worktree only needs to live long enough for one
refresh).

Fix, in `chat_shadow.go`: the shadow worktree never needs a submodule's own
content (Claude only edits app code), so every git call that could touch one
now says so explicitly, per-invocation (never by writing to the shared
clone's `.gitconfig`):
- `git worktree add`/`git reset --hard` get `-c submodule.recurse=false`
  (git-reset(1)'s own gate for whether reset touches a submodule's index/
  working tree at all) — this also makes a refresh **self-healing** for a
  worktree wedged by an older build, since reset then never looks at the
  broken gitdir in the first place.
- `chatShadowPendingState`/`chatShadowLocalPendingState`'s `git status
  --porcelain` gets `--ignore-submodules=all` — dirty/ahead detection was
  never about submodule content, and without this flag `status` itself
  aborts on an already-wedged submodule (turning "can't tell, leave it alone"
  into a permanent no-op).

Regression test: `TestEnsureChatShadowWorktreeRefreshSurvivesBrokenSubmodule`
(`chat_shadow_test.go`) builds a real local submodule with a URL no init can
ever resolve, reproduces the exact production error on a plain `git reset
--hard`, and asserts `ensureChatShadowWorktreeAt` survives it — both on the
first refresh and on a worktree already wedged by an older build.

`ChatMessageSignal.Action`'s `""`/`"edit"`/`"commit"` trichotomy
(`tasks_api.go` validation) is otherwise unchanged: `"edit"` is now a no-op
synonym of `""` (every turn already gets the same widened access, so nothing
in `runOneClaudeTurn` branches on it any more) and `"commit"` still routes
straight to `enqueueChatMerge` before `runOneClaudeTurn` is even called (see
`workflows-comments.md`). No UI sends `"edit"`/`"commit"` today; a reviewer who
wants to commit/push can just ask for it in a plain message and Claude does it
itself via Bash.

**Test coverage:** `tests/claude-chat-panel.spec.mjs` asserts an ordinary
"Stuur" send still carries the plain `action: ''` (`toBeFalsy()` on the Signal
payload's `action` field) — unaffected by this change, since the widening now
happens entirely backend-side. The backend behavior itself
(reachable → widened Tools/WorkDir/prompt; unreachable → silent degrade, no
`KindError`) is covered by `chat_shell_test.go`'s two tests.

## Opt-in influence on the left comment thread (Phase 4)

Phase 4's backend is built — on the reviewer's explicit request,
`chat_workflow.go`'s `applyChatCommentAction` applies a validated
`comment_action` directive against the left comment thread. The two actions
deliberately diverge (a later, explicit reviewer correction — see "A `reply`
directive only drafts, never posts" below): `"resolve"` still signals the
thread's own `task_code_comment` Execution directly (`Source: "ai"`, no text
to review first) and records a `Kind: chat.KindAction` (success) or
`Kind: chat.KindError` (failure) confirmation turn; `"reply"` never signals
anything — see "Opt-in influence on the left comment thread (Phase 4)" in
`.claude/docs/workflows-comments.md`. `ClaudeChat.mjs`'s `chatKindBadge(msg)`
marks all three kinds distinctly, mirroring `RelatedPanel.mjs`'s
`aiWarningBadge`/`staleAnchorBadge`: a small pill with a word + a shape glyph
(a checkmark for `'action'`, a pencil for `'draft_reply'`, the same
warning-triangle SVG as `aiWarningBadge`/`related-covers-warning` for
`'error'`, a circular-arrows glyph for `'retrying'`) — the tint
(emerald/sky/rose/amber respectively) is decoration on top, never the sole
carrier, per the colourblind rule. Testids
`claude-message-action`/`claude-message-draft-reply`/`claude-message-error`/
`claude-message-retrying`.

**`msg.kind` is NOT fixed at message creation any more** (it used to be, and
the badge was interpolated statically because of it): the automatic retry
ladder rewrites the SAME row id per attempt, so one bubble walks
`'retrying' → 'retrying' → 'error'` or is replaced by a plain reply (see "A
failed Claude call degrades to a visible turn" in
`.claude/docs/workflows-comments.md`). The key is that row id, so arrow.js
reuses the node and only re-applies function-valued slots — hence
`${() => chatKindBadge(msg)}` and `${() => claudeModelPill(msg)}` at the call
site, and hence the class binding (already a function) picking up the new
tint for free. Keep them functions.
Test: the "action turn and an error turn each get their own badge" case in
`tests/claude-chat-panel.spec.mjs` (a direct-mount unit test of
`claudeChatColumn`, since driving a real `comment_action` directive through
the Playwright fixture would need the comment's run id known before the
fixture file loads — see the test's own comment; the backend's
KindAction/KindDraftReply/KindError decisions are already covered end-to-end
by `chat_workflow_test.go`).

### `chat.KindAutoCheck`: badging a turn the reviewer never typed

A different case of the same `chatKindBadge` mechanism, but on a **`role:
"user"`** message rather than an assistant one: `autoStartKiloCheck`
(`workflows.go`) sends the automatic first turn of a kilo-code finding's
verification chat with `Action: chatActionAutoCheck`, which
`claudeChatWorkflow` (`chat_workflow.go`) turns into
`Kind: chat.KindAutoCheck` on the saved message — see "A kilo-code finding
gets an automatic verification chat" in `.claude/docs/workflows-comments.md`
for the trigger/gate/prompt. The bubble itself still renders exactly like any
other own message (indigo tint, "Jij" label) — `chatKindBadge` adds an extra
indigo pill, "automatische controle van kilo-opmerking" with a magnifying-glass
glyph (`data-testid=claude-message-auto-check`), which is the ONLY thing that
tells a reviewer this specific message was never typed by them. Deliberately
not a bigger visual departure (a different name/avatar, a system-style bubble):
the turn genuinely runs through the ordinary reviewer-turn path (a real Claude
call with shell access, a real reply bubble underneath), so a badge next to
the existing rendering was enough, rather than inventing a third bubble shape
next to "mine"/"Claude's".

**Kilo's own wording inside that bubble is COLLAPSED.** The stored body still
contains it verbatim (Claude needs it — the turn carries no other context, see
`kiloCheckPrompt` in `.claude/docs/workflows-comments.md`), but the reviewer
has the very comment being verified open right next to this chat, so repeating
it in full was pure noise. `claudeMessageBody` (`ClaudeChat.mjs`) therefore
routes an `auto_check` turn through `splitAutoCheckQuote` + `autoCheckHTML`:
the intro line (file/regel) and the instruction render as usual, the
contiguous run of `>` lines in between goes behind a **native `<details>`**
(`data-testid=auto-check-quote`, body `auto-check-quote-body`) whose summary
names what is hidden with a WORD — "opmerking van kilo" — not just the
disclosure triangle, per the colorblind rule. Native `<details>` on purpose:
no reactive state, no keyboard wiring, so the whole thing stays one plain HTML
string for the existing `.innerHTML` binding and no arrow.js pitfall applies.
`splitAutoCheckQuote` returns `null` when there is no blockquote at all (a
body stored before this prompt shape existed), and the bubble falls back to
the ordinary rendering. Test: the "an auto_check turn hides kilo's own wording
behind a collapsed details" case in `tests/claude-chat-panel.spec.mjs`.

### A `reply` directive only drafts, never posts

Explicit correction to the paragraph above, from Reindert: "Claude mag namens
mij een bericht sturen, ik wil het daarna kunnen bewerken... je hoeft het dus
vooral alleen in de input te plaatsen en de focus erop te zetten." A
`comment_action` with `action: "reply"` used to be signalled straight onto the
comment thread (`Source: "ai"`) the moment Claude produced it — the reviewer
only found out afterwards. Now `applyChatCommentAction` never signals a
`"reply"` at all: it records the drafted body as its own turn
(`chat.KindDraftReply`, `saveChatDraftReply` in `chat_workflow.go`), and this
panel's `applyPendingDraftReplies` (`RelatedPanel.mjs`, called from
`loadChatMessages` right after `cc.messages` is reassigned — i.e. on the
initial load, every `chat.message` SSE-triggered refetch, and the resync read,
exactly the three places a new turn can arrive) is the ONLY thing that acts on
it: it merges the drafted body into `replyDrafts` (the same session-only,
per-comment-id draft cache `reaction-compose`/`toComment` already use for a
half-typed reviewer reply) and seeds the mounted field via `prefillField`.
Sending afterwards is the ordinary, unprivileged `sendReaction` path — the
message posts with the reviewer's own identity, never `Source: "ai"`.
`"resolve"` is untouched by this — there is no text to review, so it keeps
applying immediately.

Three explicit rules govern how the merge behaves (`appliedDraftReplyIds`
tracks which `chat.KindDraftReply` turns were already merged, keyed by the
turn's own stable id — see `chatMessageID`'s turnID-derived id in
`chat_workflow.go` — so a later, unrelated re-render of the same turn, e.g. a
resync, never re-appends the same text twice):

1. **Deliberately not a one-shot-then-frozen value.** A follow-up Claude
   proposal later in the SAME conversation gets its own turn id and therefore
   its own `appliedDraftReplyIds` entry, so it merges in too — "daarnaast mag
   die input overschreven/samengevoegd worden door vervolg chat met claude"
   (Reindert's own words).

   **But "already applied" must survive a reload too.** Reviewer report: "als
   ik in de tree een comment verstuur is de input niet gelijk leeg (ik heb het
   laten genereren vanuit de chat)". `postThreadReply`/`sendReaction`
   (`RelatedPanel.mjs`) already clear `reaction-compose` synchronously, before
   the send even starts — that part always worked. The bug was one level up:
   a `chat.KindDraftReply` message is never deleted from the transcript
   (`saveChatDraftReply`, `chat_workflow.go`), so `GET /api/chat` keeps
   returning it forever. `appliedDraftReplyIds` used to be a plain, in-memory
   `Set` — reset to empty on every fresh page load/reload — so the very next
   time the reviewer reopened that SAME conversation, `applyPendingDraftReplies`
   saw the id as "unseen" again and rewrote the already-sent draft straight
   back into the now-empty field. Fixed by backing `appliedDraftReplyIds` with
   `draftStorage.mjs` (`isDraftReplyApplied`/`markDraftReplyApplied`,
   `RelatedPanel.mjs`, keyed via the same PR-scoped `dsKey` every other
   composer draft already uses) — once a draft id has been applied, in THIS
   page load or an earlier one, it never seeds the field again. Test:
   "a drafted reply already sent is not written back into the reply field
   after a reload" in `tests/claude-chat-panel.spec.mjs`.
2. **Focus only moves onto `reaction-compose` when the reviewer is NOT
   currently MID-TYPING an unsent follow-up in the Claude composer**
   (`document.activeElement` checked against
   `[data-testid=claude-chat-compose]` **and** that field's own `.value` is
   non-empty) — the text is written into `replyDrafts` (and the mounted
   field, if any) unconditionally either way, only the caret-steal is
   conditional. Deliberately a plain, synchronous `document.querySelector` +
   `.value=`/`.focus()`, NOT `prefillField`'s rAF + `focusToken`-gated wait:
   that mechanism exists for a field that is only ABOUT to mount because of
   the very state change that requested the focus, and entering/leaving the
   Claude column in between can bump `focusToken` before the deferred write
   lands — which silently dropped the draft in an early version of this
   feature. `reaction-compose` is (per "One card per conversation, only the
   focused... expands" in `.claude/docs/comments-panel.md`) already mounted
   whenever `applyPendingDraftReplies` runs, or genuinely not part of the
   current view at all (then only `replyDrafts` gets the write, picked up
   next time `toComment` opens this thread) — either way a synchronous read
   settles it with no race.

   **That "genuinely not part of the current view" case turned out to have a
   THIRD shape, missed above: read-only, not absent.** Below
   `COMMENT_CLAUDE_WIDE_BREAKPOINT_PX` (see "Read-only, not a rail" in
   `.claude/docs/comments-panel.md`) the comment side goes read-only —
   composer unmounted entirely — for exactly as long as `cs.focus ===
   'claude'`, which is precisely the moment a draft lands. On an ordinary
   laptop-width screen `reaction-compose` is therefore missing every single
   time, not just "some other unrelated conversation is on screen", and the
   synchronous read above used to bail out silently — the "concept in
   comment-veld gezet" badge showed, `replyDrafts` held the text, but the
   keyboard stayed in the now-empty, still-focused Claude composer with
   nothing visibly holding the draft at all (reviewer report + screenshot:
   `data/review-shots/task-focus-comment-input-after-generate.png` — every
   existing regression test for this feature runs at a forced 2000px
   viewport, above the threshold, so none of them ever exercised this path).
   `applyPendingDraftReplies` now calls `toComment(false)` itself in exactly
   this situation (`cs.focus === 'claude' && cc.commentId === commentId`,
   after the same "not mid-typing" guard above) — the same hand-off `←`
   already performs — and applies the write (`writeIntoReplyField`, the
   shared value+autogrow+focus/select step both branches now call) one
   `requestAnimationFrame` later, guarded by a **freshly re-read**
   `focusToken` (snapshotted AFTER `toComment()`'s own `releaseFocus()` bump,
   not before it, so this continuation isn't cancelled by its own trigger).
   Test: "a drafted reply still lands in and focuses the comment composer,
   even though the comment side is read-only..." in
   `tests/claude-chat-panel.spec.mjs`, in its own narrow-viewport
   `test.describe`.

   **Focus after placing a draft — the empty-vs-non-empty refinement.**
   Reviewer request: "hierna wil ik gelijk een focus hebben in de
   comment-input" (right after sending "maak hier een comment van" and
   seeing the "concept in comment-veld gezet" badge, the caret stayed in the
   now-empty, but still-focused, Claude composer instead of jumping into the
   comment field). `ClaudeChat.mjs`'s Enter/"Stuur" handlers clear
   `claude-chat-compose`'s value on send but never blur it, so
   `document.activeElement` still matches it the moment the response (and its
   `draft_reply` turn) lands — the original bare
   `active.matches('[data-testid=claude-chat-compose]')` check therefore also
   suppressed the steal for this, by far the most common, case. Requiring
   `active.value.trim()` too fixes exactly that: an empty, merely-still-focused
   composer no longer counts as "in progress", so the focus now lands on
   `reaction-compose` right after the send completes, while a GENUINELY
   mid-typed (non-empty) follow-up still keeps the keyboard, unchanged.
3. **An already-typed reviewer draft is never overwritten or discarded** —
   Claude's text is appended UNDERNEATH it (`existing + '\n\n' + body`), so
   both survive; a reviewer composing their own reply while Claude is
   mid-conversation keeps their own words on top.

### A pure (still-unedited) Claude draft is select-all'd, and Enter posts it straight to GitHub

A later, explicit reviewer request on top of the three rules above: "als ik
een comment genereer vanuit Claude chat, dan wil ik dat de input gelijk
geselecteerd is... [en] hoef ik in dat geval niet nog een menu te zien, maar
mag het gelijk op GitHub als een comment geplaatst worden." This only applies
when rule 3 above did NOT fire — `reaction-compose` was genuinely EMPTY the
moment the draft landed, so the whole field is Claude's own text, nothing
merged in from an earlier reviewer draft.

- **`applyPendingDraftReplies`** tracks this per comment id in
  `pureChatDraftReplyIds` (a plain `Set`, mirrors `appliedDraftReplyIds`'s
  session-only shape) and, when it does focus the field (rule 2's "not
  mid-typing an unsent follow-up in Claude" gate still applies), calls
  `el.select()` instead of placing the caret at the end — so a bare Enter
  sends it as-is, and typing anything replaces the whole draft in one go
  rather than appending after it.
- **The mark is cleared by the FIRST edit**: `reaction-compose`'s own `@input`
  handler deletes the comment's id from `pureChatDraftReplyIds` the moment the
  reviewer changes so much as one character — from then on this is ordinary
  reviewer-typed (or reviewer-edited) text and the mark, and the auto-post
  behavior below, never re-applies to it.
- **`sendReaction` skips the publish-choice menu** (`needsPublishChoice`/
  `openPublishMenu`) entirely when the thread's id is still marked pure, and
  posts straight through `postThreadReply(c, body, 'reply', false)` — the same
  write the menu's own "Alleen mijn antwoord op GitHub" item makes, not
  `'thread'`: only Claude's generated text becomes the new public GitHub
  comment. The thread's own local root — often still the anchor placeholder
  body Claude's conversation was started against (see "Optimistically visible
  while composing a brand-new comment" above) or an unfinished reviewer draft —
  stays local; nothing about it is published without the reviewer separately
  choosing to. The mark is consumed (deleted) on this send, so a later reply on
  the same thread, once it carries its own edits, goes through the ordinary
  publish-choice flow like any other local thread.
- This is strictly about the drafted TEXT, not a new capability: Enter still
  requires an explicit reviewer keypress, exactly like the plain "type, Enter"
  flow `COMPOSE_COMMANDS`'s default item already gives a brand-new comment
  (see `.claude/docs/command-palette.md`) — nothing here posts on its own
  while the reviewer is merely chatting with Claude.

Test: the "a pure, unedited Claude draft…" case in
`tests/claude-chat-panel.spec.mjs` (select-all on arrival, then Enter posts
directly with no publish menu and a non-zero `githubId` afterwards) — modelled
on `tests/reply-publish-local-thread.spec.mjs`'s own `githubId` poll.

The core merge (rules 1 and 3, plus "never auto-posts to the comment thread")
is covered by `tests/claude-chat-panel.spec.mjs`'s "a drafted reply lands in
the comment composer, appended under an existing draft, never auto-posted" —
driven by mocking `GET /api/chat?commentId=` to return a `chat.KindDraftReply`
turn (the same reasoning as the badge test above for why this can't drive a
real `claude` subprocess call). Rule 2's "focus stays put while typing in the
Claude composer" half has no Playwright coverage yet (frontend gap, flagged in
"Open" below) — hard to drive deterministically without racing the SSE
reconnect timing `claude-chat-progress.spec.mjs` also relies on. The backend
behavior (no Signal reaches the comment thread for `"reply"`, the saved turn
carries `chat.KindDraftReply` with the body verbatim, and the same draft still
succeeds even if the target thread's own Execution has gone terminal — a draft
never touches it, unlike `"resolve"`) is covered by
`TestClaudeChatCommentActionDraftsReplyWithoutTouchingCommentThread` and
`TestClaudeChatCommentActionDraftsReplyEvenOnTerminalRun` in
`chat_workflow_test.go`.

### Clicking straight into the composer of an already-anchored conversation is the `→`-equivalent

Reviewer bug report with a screenshot: chatting with Claude by clicking
directly into `claude-chat-compose` with the MOUSE (never pressing `→` first)
left the drafted reply completely invisible — the comment card stayed
collapsed (`data-expanded="false"`) and `reaction-compose` was never even
mounted for `applyPendingDraftReplies` to write into, so nothing appeared
except the `chatKindBadge` "concept in comment-veld gezet" pill in the Claude
column itself; the reviewer only saw the draft after a SEPARATE click on the
comment item. Root cause: entering the Claude column via `→` from `'comment'`
already flips `cs.focus` to `'claude'` (`enterClaudeChat`), which is exactly
what `commentCard` (`RelatedPanel.mjs`) checks to stay/become expanded — but a
mouse click straight into the already-visible composer of an EXISTING
conversation (`claudeChatVisible()` shows it for ANY visible comment,
regardless of `cs.focus`, see "The Claude column must follow the browsed
comment" above) never touched `cs.focus` at all. A genuine gap in
mouse-navigation.md Rule 1 ("a click is the Enter/→-equivalent, never its own
behaviour") — there was no click-equivalent for landing in this composer.

**Fix:** `ClaudeChat.mjs`'s composer textarea got a plain `@focus` handler
(`callbacks.onFocus()`) — deliberately `@focus`, not `@click`, so Tab reaches
the same behavior — wired in `RelatedPanel.mjs` to `onClaudeComposeFocus`,
which calls the existing, idempotent `enterClaudeChat(cs.pr)` whenever
`chatAnchorComment()` resolves to a real, already-anchored comment and
`cs.focus` isn't already `'claude'`.

**Deliberately scoped to `cs.focus !== 'new'`** — the still-open, not-yet-placed
"Comment op deze regel" composer. Two regressions, both found by a broken
Playwright spec rather than by inspection, are why:

1. `chatAnchorComment()`'s first branch is `selComment()` =
   `cs.list[selI()]`, and neither is reset by `toNew()` when the reviewer opens
   a brand-new composer on a line that already carries a DIFFERENT, existing
   comment — `selComment()` then still resolves to that unrelated,
   already-anchored conversation, so calling `enterClaudeChat` unconditionally
   here would silently swap the visible (correctly fresh/empty) transcript out
   from under the new composer the instant the reviewer clicks into the Claude
   field to type its first message. Broke "a new comment on an
   already-commented line gets its own comment + Claude block, not the
   existing one".
2. Calling `enterClaudeChatFromNew()` instead for the genuinely anchor-less
   case flips `cs.focus` to `'claude'` the moment the reviewer merely clicks
   into the Claude field, before ever pressing `→`. `isNewChatUnanchored()`
   then goes `false` as soon as Claude's first reply lazily creates the
   anchor, unmounting the still-open `comment-compose` composer the reviewer
   may still be mid-typing in. Broke "placeComment never creates a SECOND
   comment once this anchor exists" (the composing-a-new-comment spec).

The keyboard's own `→` still reaches `enterClaudeChatFromNew` exactly as
before for both cases above — only the mouse-click shortcut is limited to an
already-anchored conversation. Test: "clicking straight into the composer of
an already-anchored conversation (no → first)…" in
`tests/claude-chat-panel.spec.mjs`.

## Doorpraten tijdens een lopende turn (steeren, met de wachtrij als vangnet)

Like the Claude CLI, the reviewer can **keep typing while a turn is still
running** — and, like the CLI's own interactive mode, such a message is handed
to the **running** turn whenever that is still possible (see "Steeren" below);
the client-side queue underneath is the fallback for every case where it
isn't. The composer used to be `disabled` for the whole turn (`view.busy()`
on the textarea's `@keydown`, on `claude-chat-send` and on every question
option), which meant a message typed meanwhile did nothing at all — the text
just sat in the field. All three gates are gone.

- **`queueClaudeMessage(text)`** (`RelatedPanel.mjs`) is now the single entry
  point for a composer turn: nothing running **for this conversation**
  (`ccBusy()`) → send straight away; a turn running → append to **`cc.queued`**
  and return. `cc.queued` is reactive and only ever REASSIGNED, never mutated.
  The gate is deliberately per conversation, not global: a turn running on
  another selection must never hold up a message typed here — see "Parallel
  conversations" above for the bug that was.
- **`drainClaudeQueue()`** runs from `sendClaudeMessage`'s own `finally`, so the
  queue drains itself **one turn at a time per conversation**, FIFO — each send
  ends in another drain, and two conversations drain independently. The entry is removed from the queue **before** it is sent, which is
  what makes its "in de wachtrij" bubble give way to the ordinary user bubble
  that send produces. Three messages in a row therefore become three separate
  turns in the order they were typed.
- **Each entry carries the `runId`/`commentId` it was typed against**, and
  `sendClaudeMessage` takes an optional `target` that pins those instead of
  reading the live `cc.*` — a queued turn is sent minutes later, by which time
  the reviewer may be looking at another conversation. The transcript refetch
  after such a send only happens when that conversation is also the one in view
  (`commentId === cc.commentId`), and `claudeChatView().queued()` filters on the
  same thing so a queued bubble only shows in its own column.
- **A queued turn is visible immediately** (`claudeQueuedBubbles`,
  `ClaudeChat.mjs`, `data-testid=claude-queued`): right-aligned like a real own
  message, dashed border, plus a pill carrying the **word** "in de wachtrij"
  and a glyph — never colour alone (the colourblind rule in
  `conventions.md`). The shared footer says how many are waiting
  (`claudeQueueNote`), which is also why `hasCommentClaudeFooter()` now counts
  a non-empty queue as "something to report".
- **A queued turn carries no selection context.** A running turn means this is
  never the conversation's first turn, and only that one gets a context block
  (see "Invisible selection context" below); it would be stale by send time
  anyway.
- **The queue is only reached when steering isn't possible** — see the next
  section. `queueClaudeMessage` tries `steerClaudeMessage` first and only falls
  through to `cc.queued` on a `false`.

**The queue itself needed no backend change, and that is not a coincidence:** tembed's
`SignalWorkflow` takes the **per-run lock** and drives the turn inline, so a
second `POST .../signals/message` simply blocks on that lock, then appends its
own `EventSignalReceived` and the eternal `for { w.WaitSignal(...) }` loop picks
it up as the next turn. Ordering and determinism are the engine's, not ours.

**Accepted trade-off — a QUEUED message is not crash-durable.** Because the run
lock is held for the whole turn, the queued Signal only reaches the workflow
history *after* the running turn finishes; until then it lives client-side only,
so a server restart mid-turn loses it (the reviewer does see it sitting in the
queue the whole time). Making it durable would mean appending the signal event
outside the run lock — a tembed change, deliberately not done here (and the
seq-CAS in `AppendEvent` makes it actively unsafe: the running Activity would
lose the race for its own `ActivityCompleted` seq, `panic(blocked{"concurrent"})`,
and the whole claude turn would be re-run). A **steered** message does not share
this trade-off — it is a Signal on its own Execution, recorded before anything
is delivered.

## Steeren: het bericht gaat naar de turn die NU draait

`claude` accepts more input **during** a turn: with `--input-format
stream-json` its stdin stays open, and a user frame written to it is picked up
by the model at the running turn's **next step boundary** — right after a tool
call. Verified against the real CLI with exactly the flags a chat turn uses
(`--include-partial-messages`, `--session-id`, `--allowedTools Read,Grep,Glob`):
the text deltas keep streaming, the turn produces one `result` frame, the
session id survives, and Claude really changes course mid-turn.

- **`modules/claude`**: `RunRequest.Steer` (a `<-chan string`, `RunChat` only).
  Nil keeps the historical `-p <prompt>` argv invocation byte for byte, so
  `comment_batch`/`test_run` are untouched. Non-nil switches that one call to
  stream-json input: the prompt becomes the first stdin frame, a goroutine
  writes every steer message as one more, and **stdin is closed again at the
  first `result` frame** — without that the CLI keeps waiting for input, never
  exits, and `cmd.Wait` blocks forever.
- **The step boundary is a real limitation.** A message that arrives while
  Claude is producing its final text (or during a turn that calls no tool at
  all) is executed by the CLI as its **own follow-up turn**, with a second
  `result` frame. `readChatStream` therefore JOINS a second result onto the
  first instead of letting it overwrite it, so both halves land in the one
  bubble this turn owns.
- **`chat_steer.go`**: delivery into a running call is in-memory
  (`chatSteerByConv`, registered per CLI call by `runOneClaudeTurn`, the same
  shape as `chatCancelByConv`) — an Activity that has already started is a
  black box, so a live channel is the only way in. But the reviewer's **action**
  is not in-memory: it is a `steer` Signal on a real Execution.
- **A conversation gets a SECOND Execution for this** (`chat_steer`, run id
  `chatsteer-<commentID>`, one Activity per Signal). It cannot be a `message`
  Signal on the conversation's own `claude_chat` run: `Engine.SignalWorkflow`
  takes that run's lock and drives the turn inline, so the Signal would block
  for exactly as long as the turn it means to steer — the same reason
  `chat_cancel.go` is not a Signal. Using a second Execution whose lock is free
  is the shape `chat_merge` already established. **No write-boundary carve-out
  is added:** the UI only starts/signals a workflow, and only Activities write.
- **The words are framed before delivery** (`chatSteerPrompt`, `chat_steer.go`).
  A bare instruction appearing mid-turn out of nowhere reads to the model as an
  injection attempt, and it says so: verified against the real CLI, an unframed
  "change of plan" message got *"Ik zie dat je probeert me om te leiden met een
  tegengestelde instructie"* and the original task was finished anyway. With one
  line of framing ("de reviewer stuurt je tijdens deze turn een aanvullend
  bericht … en heeft voorrang") the same message is followed. Only the CLI sees
  this; the stored transcript keeps the reviewer's own words unchanged. The
  live check is `TestLiveSteerManual` (`modules/claude`), skipped unless
  `SLASH_LIVE_CLAUDE=1` — the one test that talks to the real CLI, because this
  whole feature rests on a CLI contract nothing else can verify.
- **`deliverChatSteer`** hands the text over and, only when that succeeded,
  stores the reviewer's message itself (id derived from the Signal's id, so a
  replay can't duplicate it). **`forwardChatSteerAsMessage`** is the fallback
  when nothing was running after all (the turn ended in the split second
  before, or it sits in work-directory prep / the write-turn slot / a retry
  backoff): it forwards the text as an ordinary `message` Signal, i.e. as the
  next turn, stored once by the usual `saveChatMessage`. It runs
  **asynchronously** (`ExecuteActivityAsync`) because it blocks on the busy
  conversation's run lock — otherwise it would hold up the HTTP request that
  delivered the steer Signal, and the next steer behind it.
- **Frontend**: `steerClaudeMessage` (`RelatedPanel.mjs`) first reads
  `GET /api/chat/steerable?commentId=X` (in-memory, read-only: is a claude CLI
  call genuinely in flight — "busy" alone isn't enough, a turn can be busy with
  no live CLI), then ensures the `chat_steer` Execution
  (`POST /api/workflows/chat_steer`) and signals it. A steered message shows up
  as an ordinary own bubble via the transcript refetch — no "in de wachtrij"
  pill, because it isn't waiting for anything. Any failure anywhere falls back
  to the queue.
- **Accepted limitation, deliberate:** that a running turn was steered is not
  visible in the `claude_chat` run's OWN history — only that Activity's final
  result is recorded there. The reviewer's message and the decision behind it
  are fully recorded, in the `chat_steer` run. This is the same class as the
  CLI's `--resume` session state, which an Activity's result already depends on
  without the history describing it.

Tests: `chat_steer_test.go` (delivery into a running turn, and the fallback),
`TestLiveSteerManual` (the real CLI, opt-in),
`tests/claude-chat-steer.spec.mjs` (the frontend's steer-instead-of-queue
decision), plus the unchanged `tests/claude-chat-queue.spec.mjs` for the
fallback path end to end.

## The composer is a `<textarea>`, not an `<input>`

`ClaudeChat.mjs`'s composer (`data-testid=claude-chat-compose`) is a
single-row (`rows="1"`, `resize-none`) `<textarea>`, so a multi-line message
is possible: plain `Enter` still sends (`@keydown` calls `e.preventDefault()`
and only then checks `!e.shiftKey`/non-empty before firing
`callbacks.onSend` — the former `busy` check is gone, see "Doorpraten tijdens
een lopende turn" above), `Shift+Enter` falls through to the textarea's own
default behaviour and inserts a newline. Reading/writing its value
(`el.value`) via `querySelector('[data-testid=claude-chat-compose]')` in the
"Stuur" click handler is unaffected by the element swap.

### The newline was never the problem — the RENDER was

Reported as "Shift+Enter doesn't work in the Claude chat". A probe
(`claude-chat-newline.spec.mjs`) showed the keystroke was already fine: the
field is a `<textarea>`, none of the Enter paths claim a shifted Enter
(`ClaudeChat.mjs`'s own `@keydown`, `home.mjs`'s palette/`isComposeOpen()`/
`relatedActive()` branches all test `!e.shiftKey`), and the value really did
contain `\n`. What went missing was the **display**: the bubble renders through
`renderMarkdown`, and Markdown collapses a lone newline into a space, so two
typed lines came back as one running sentence.

Fix: **`hardBreaks(text)`** (`src/markdown.mjs`, exported) turns every single
newline into a Markdown hard break (`  \n` → snarkdown's `<br />`), leaving a
blank line as a paragraph break and never touching a fenced block's own lines.
Applied by the caller, **before** `renderMarkdown` — so it sits in front of
every step inside it (escaping, fence extraction, `highlightMentions`) and no
other render point (comment bodies, PR description) changes at all.

Applied only to the **reviewer's own** turns (`msg.role === 'user'`, plus the
queued bubbles): Claude's own answers are written AS Markdown, where a
soft-wrapped source line joining the sentence above it is intended. The
composer also carries a `title="Enter verstuurt · Shift+Enter nieuwe regel"`,
so the affordance is stated in words somewhere.

Space keeps typing a space in the composer, unaffected by the global
approve-and-continue Space shortcut — that branch sits behind `onKeydown`'s
`relatedActive()`/`isEditableFocused()` guards. Asserted in the same spec, since
it is exactly the kind of thing a later global shortcut could quietly break.

"Stuur" sits **below** the composer, not beside it (`flex-col` instead of a
row) — a narrow Claude column left almost no width/height for the textarea
when the button sat to its side. See "Auto-grow composer textareas" below for
how it actually grows taller as you type.

## Auto-grow composer textareas (`src/textareaAutoGrow.mjs`)

A bare `rows="1"`/no-rows `<textarea>` never grows with its content on its
own — an earlier version of this doc claimed the Claude composer already did,
which was wrong (there was no `@input` handler at all, so the field stayed
stuck at one row while typing a longer message). `textareaAutoGrow.mjs` is a
small shared module, imported by both `ClaudeChat.mjs` and `RelatedPanel.mjs`,
so all **four** composer fields in the app behave identically:

- `autoGrowTextarea(el)` — called from every composer's `@input` binding.
  Resizes `el` to `scrollHeight`, capped at `MAX_COMPOSER_HEIGHT_PX` (~12rem,
  about 8 lines); past that the textarea scrolls internally
  (`overflow-y: auto`) instead of pushing the surrounding column ever taller.
- `resetTextareaHeight(el)` — called right after a successful send clears
  `el.value`, for the two composers that stay MOUNTED after sending (the
  Claude composer, `reaction-compose`) so the grown inline `style.height`
  doesn't linger on an now-empty field. The two composers that instead
  UNMOUNT on send (`comment-compose`, `comment-detail-reply`) need no reset —
  they mount fresh, with no inline height, the next time they open.
- `prefillField` (`RelatedPanel.mjs`) also calls `autoGrowTextarea` right
  after seeding `.value` — setting `.value` in JS fires no `input` event, so
  a restored multi-line draft (see `composeDrafts`/`replyDrafts` below) would
  otherwise sit clipped at the field's natural height until the next
  keystroke.

The four fields: `claude-chat-compose` (`ClaudeChat.mjs`), `comment-compose`
(the new-comment composer), `reaction-compose` (an inline thread's reply —
converted from a plain `<input>` to a `<textarea rows="1">` for this, so it
can support `Shift+Enter` too) and `comment-detail-reply` (the PR-wide
comment reply) — all in `RelatedPanel.mjs`. All four share the same
Enter-sends/Shift+Enter-newline keydown shape; `comment-compose` is the one
exception that has no *local* `@keydown` for Enter — that path already ran
through the document-level handler in `home.mjs` (`isComposeOpen()`, which
opens the comment-kind menu on plain `Enter` and leaves `Shift+Enter` alone
for the browser's own newline) before this change and still does; only its
auto-grow `@input` is new.

## Invisible selection context on a conversation's FIRST turn

Before this, `claude` genuinely had no idea what code a conversation was
about — the CLI's `Prompt` was just the reviewer's typed text, so a question
like "wat weet jij over de code wat ik heb geselecteerd?" (asked with nothing
else in the prompt) could only be answered "I don't know, tell me the
file/line". Fixed end to end, but deliberately **invisible**: the reviewer's
own chat bubble must show exactly what they typed, nothing more.

- **`claudeContextBlock(commentTarget)`** (`RelatedPanel.mjs`) builds a plain
  text block — the file, "Oude regels"/"Nieuwe regels" (whichever side(s) the
  current unit actually touches), the unit's label, and its code excerpt —
  from `commentTarget()` (`home.mjs`), the exact same object the comment
  composer already renders against, so it reflects whatever granularity
  (group/line/call, `f`/`d`/`s`) the reviewer is on. Returns `''` only when
  there is no target at all (or one without a file), which is treated as "send
  nothing extra".
- **A block with no changed lines gets a context block too — code excerpt or
  not.** `commentTarget()`'s own `!unit` branch (a block with no navigable
  changes: `code: ''`, `startLine: 0`) used to fall through to `''`, so such a
  turn was sent with NO context whatsoever. In practice that is exactly the
  drilled Onderliggende-code column on an UNCHANGED block — a class constant or
  property — and it is the most harmful emptiness, not the least: the reviewer
  is looking at one specific symbol, types "waar gebruiken we dit?", and Claude
  gets a prompt in which "dit" refers to nothing at all, so it answers about
  whatever the PR as a whole is about. Reported on PR 13451, drilled into
  `SessionEnricher::DEFAULT_UTM_VALUES`, answered about
  `TemporalSessionFlow`/`EventServiceProvider`; the stored `message` Signal for
  that run really did carry no `context` field. The second branch now sends
  file + `Onderdeel:` + `Regel:` plus one sentence saying this part has no
  changed lines in this PR, so no sample code is attached. Deliberately **no**
  source code, same reasoning as `claudeRangeContextBlock` right below it:
  Claude has read access to the checkout and can open the exact spot itself.
- **Old + new line ranges, not just one side:** `commentTarget()`'s existing
  `startLine`/`endLine`/`side` (used for GitHub anchoring, see `placeComment`)
  only ever describe ONE side of a unit. `unitBothLineRanges` (`home.mjs`,
  next to `unitLineRange`) is the same aligned-row counting algorithm but
  tracks BOTH sides' counters/ranges at once, so `commentTarget()` additionally
  returns `oldStartLine`/`oldEndLine`/`newStartLine`/`newEndLine` (0 when that
  side has no rows in the unit — e.g. a pure addition has no old range). Purely
  additive fields; every existing consumer of `commentTarget()`
  (`createComment`/`placeComment`) is unaffected.
- **Only the conversation's FIRST turn carries it** (`cc.messages.length === 0`
  at send time, checked inside `claudeContextBlock`) — the claude CLI's own
  `--resume` session already has the context from turn 1, so repeating it on
  every later turn would only bloat the prompt for nothing. A "Bewerk code"/
  quick-option send goes through the exact same `sendClaudeMessageFromNew`
  choke point, so this is not special-cased per button.
- **The block never touches the visible bubble.** `sendClaudeMessage(text,
  action, context)` sends `context` as `ChatMessageSignal`'s own
  **`context`** field (`chat_workflow.go`), separate from `body` — the
  workflow's `saveChatMessage` still only ever stores `sig.Body` (what the
  reviewer typed), while `runClaudeTurn`'s Activity input carries
  `Context: sig.Context` alongside it. `runOneClaudeTurn` builds the actual CLI
  prompt via **`buildChatPrompt(selectionContext, body)`** — `selectionContext
  + "\n\n" + body` when non-empty, otherwise a plain pass-through of `body`
  (every turn after the first, or no cursor info available: unchanged
  behaviour). `tasks_api.go`'s `SignalMessage` handler decodes the extra
  `context` field from the POST body into the Signal; no new validation (it's
  always optional, mirroring `Action`).
- **Deterministic under replay** (`.claude/rules/workflow-determinism.md`):
  `Context` is part of the Signal's own recorded input, exactly like `Body` —
  `buildChatPrompt` is a pure function of it, no new non-determinism.
  **Write-boundary**-clean (`.claude/rules/workflows-write-boundary.md`): no
  new write path, just one more field flowing through the existing
  Signal → Activity chain.
- Tests: `TestChatTurnContextEnrichesPromptNotBody`
  (`chat_workflow_test.go`) asserts at the `runOneClaudeTurn`/`claude.Fake`
  level that the saved `chat.Message.Body` stays exactly the typed text while
  `Fake.Calls[i].Prompt` carries the context prepended, and that a turn with no
  `Context` is an unchanged pass-through. `tests/claude-chat-panel.spec.mjs`'s
  "composing a new comment…" test intercepts the first `.../signals/message`
  POST and asserts its JSON body has `context` (containing `Bestand:`/
  `Voorbeeldcode:`) while `body` is exactly the typed text and the rendered
  reviewer bubble (`claude-message-body`) shows only that typed text; a second
  send in the same conversation asserts `context` is empty/absent.

**Third caller of the "open, then auto-send" pattern: the inline code
editor's "Opslaan".** Besides the `/`-menu no-match fallback (typed query,
`sendClaudeChatText(state, commentTarget, q)`, `home.mjs`) and dictation's
second F5 (the transcript, `sendComposer`'s synthetic Enter,
`.claude/docs/dictation.md`), `saveInlineEdit` (`home.mjs`) now does the same:
`startClaudeChat(target)` then, in a `requestAnimationFrame`,
`sendClaudeChatText(state, target, text)` — but with a **fixed** instruction
sentence as `text` rather than anything the reviewer typed, since the real
payload (the reviewer's edited code) already travels invisibly as this
target's own `proposedCode`/`proposedStale` fields (see "'Opslaan': builds a
`commentTarget`-shaped object…" in `.claude/docs/inline-edit.md`). Reviewer
report: "ik wil dat de chat die aanpassing overneemt en direct doorvoerd" —
before this, `proposedCode` only ever reached `claudeContextBlock` once the
reviewer typed something themselves and pressed Enter, so nothing showed up
in the chat until a second, manual step.

### The already-written comment thread also rides along, chronologically — but only THIS conversation's own thread

`claudeContextBlock` also folds in **`claudeThreadContextBlock()`**
(`RelatedPanel.mjs`, same file, same first-turn-only gate) — every
already-written message on **this conversation's own anchor comment only**
(`chatAnchorComment()`'s opening body plus every reaction/reply, via
`threadMessages`). Each comment has its own, separate `claude_chat` Execution
(Run ID is the comment id, see `.claude/docs/workflows-comments.md`), so a chat
hanging on comment A must never learn about comment B's text just because a
reviewer happened to place both on the same block/line.

This was **not** always the scope: an earlier version deliberately widened it
to "own thread plus any OTHER comment thread on the same unit" (exactly
`visibleComments()`/`cs.view`, the same "under this selection" scope
`recomputeView`/`commentUnder` compute for the comment index itself) — "de
tussenvorm", own thread plus same-unit threads, not PR-wide. That was reversed
on reviewer report: a chat opened on one comment on a line was picking up the
TEXT of a sibling comment on the same line, which the reviewer never intended
that particular chat to see. Each comment's chat is its own conversation; the
fact that two comments sit on the same selection is a coincidence of where the
reviewer clicked, not a reason to merge their contexts.

**The still-cross-thread on-screen "Codeblok N" badges are a deliberate,
accepted divergence from this, not a leftover to "fix" back into sync** — see
"Codeblok numbering diverges from chat context (on purpose)" below.

### Chat over een heel bereik (`startRangeChat`, an index-level Shift-selection)

"Chat met Claude over dit bereik" (`rangeCommandsFor`, see
`.claude/docs/command-palette.md`) opens the same brand-new `'claude'` state as
"Chat over deze regel" (`startClaudeChat`) — `startRangeChat` is its twin, just
also flagging `cs.rangeCompose = true` and capturing the whole Shift-selection
(`rangeComposeItems`, `RelatedPanel.mjs`). The anchor is still ONE real block —
the cursor's own, exactly like an ordinary chat (see "The anchor is
deliberately the CURSOR's own item" in `command-palette.md`) — only the
**context sent on the first turn** widens to cover the whole selection.

`claudeContextBlock` branches on `cs.rangeCompose`: instead of the single-unit
snippet (file/old-new-lines/label/code, above) it calls
**`claudeRangeContextBlock(rangeComposeItems)`**, which sends a plain
**manifest** — one line per block/method: its label, file, and start line
(plus its old/new start line too, but only when its code happens to already be
loaded from earlier browsing — never fetched just for this) — and explicitly
**no source code for any of them**.

This is a deliberate, discussed product decision, not an oversight or a
reused cap: a Shift+↑/↓ **line**-range within one block already has a size
question, but it's bounded by `MAX_EXPLAIN_LINES` only for the *automatic*
explain, and an explicit chat about it is exempt (see "Shift+↑/↓ — selecting
multiple lines/groups at once" in `.claude/docs/keyboard-navigation.md`) — a
reviewer-initiated chat about a handful of rows within ONE block was judged
cheap enough to just send. An index-level range is a different kind of size
problem: it can cover any number of **whole blocks**, each with its own diff,
so embedding every one's code would make the prompt grow with the size of the
selection rather than with one unit's row count — unbounded, unlike the
line-range case. Sending only a manifest keeps the prompt small and
predictable regardless of how many blocks are selected. Claude already has
Read/Bash access in its own shadow worktree for this very conversation (see
the carve-out in `.claude/rules/workflows-write-boundary.md`), so nothing is
actually lost: Claude opens a listed file itself the moment it needs to see
the code, rather than every block's code being pushed into the prompt whether
it turns out to be needed or not.

Two alternatives were considered and explicitly rejected in favour of this one:
embedding full code but capping the combined total row count across the whole
selection (would still need an arbitrary cutoff, and silently drops blocks past
it), and capping the number of whole blocks the action works on at all (turns
a large, legitimate selection into a dead action instead of a smaller prompt).

`placeComment`'s equivalent for "Plaats comment over dit bereik"
(`startRangeComment`) is much simpler and needs no such cap: a placed GitHub
comment has no invisible context field, so the scope is made visible by
prepending a short, capped label list (`rangeCommentPrefix`) to the reviewer's
own typed text — see `command-palette.md`.

Reviewer's second explicit requirement: it must be unambiguous which remark is
the standing one to react to, not an unordered dump. So the thread's own
messages (opening + replies) are kept in `threadMessages`' own order — already
chronological, since a reply is stored after the message it replies to — and
the **last** line is explicitly tagged `[meest recent — het gesprek gaat
hierop verder]`. `CLAUDE_ANCHOR_PLACEHOLDER` bodies are filtered out (not a
real reviewer message, see `ensureClaudeAnchorForNew` above). Same
invisibility/determinism guarantees as the selection block above: only the
`context` Signal field, the visible bubble is untouched; no new write path.

Test: the first "embedded Claude chat…" spec in `tests/claude-chat-panel.spec.mjs`
seeds a SECOND, sibling comment thread on the exact same file+label before
entering the chat on the first comment, and asserts the first turn's
intercepted `context` contains only the first comment's own body (tagged
`meest recent`, since it's the only message in scope) and explicitly does
**not** contain the sibling thread's text — the regression test for the
information-leak fix described above.

### Emitting a fence at all is a PROMPT rule, not a rendering one

Reported symptom: "hoe ziet ActivityConverted eruit?" came back as one long
paragraph of prose with dozens of inline-code pills (field names, paths) and
not a single fenced block, even though the answer literally is a piece of
code. Nothing was wrong with the rendering — the chat bubble has rendered
fences as code cards all along (see the numbering section below and the
code-preview column further down). The three chat system prompts
(`modules/claude/prompts/chat.md`, `chat_readonly.md`, `chat_shell.md`) only
said that a code example does not count toward the ~700-character cap, never
that one is expected, so "kort en to the point" won and the code got
flattened into prose.

They now carry one shared paragraph requiring a ` ``` ` block whenever the
answer shows what a piece of code looks like (class, DTO, signature, payload,
config, example usage), stated broadly on purpose: as soon as more than a few
fields or lines are enumerated, they belong in a fence rather than in a row of
backticked names. Deliberately only those three files — the other prompts
(`chat_conflict.md`, `comment_batch.md`, `explain_code.md`, …) are not
conversational answers. If a future session wants fewer/more code blocks in
chat answers, this paragraph is the knob; no frontend change is involved.

### Codeblok numbering diverges from chat context (on purpose) — the mechanism for acting on a fenced code block/suggestion

A fenced code block (` ``` `) or a GitHub `` ```suggestion `` block in a
comment/reply gets a visible, running **"Codeblok N"**/**"Suggestie N"** badge
(`markdown.mjs`, see "Fenced code blocks get a language badge…" in
`.claude/rules/conventions.md`). This is a deliberate product decision,
reversed from an earlier plan that would have added a dedicated
"accept suggestion" action (a new write path, a git commit onto the PR
branch): **there is no button, no menu item, no write path for this at all.**
The reviewer instead refers to the number in the embedded Claude chat — "pas
codeblok 3 toe: gebruik hier een early return" — and Claude acts on it exactly
like any other request in the conversation, through its existing Bash/Edit
tool access in the conversation's own shadow worktree (see "Agentic edits" in
`.claude/docs/workflows-comments.md`, and the write-boundary carve-out in
`.claude/rules/workflows-write-boundary.md`).

**Until the fix described in the previous section, the two numbering systems
below shared one mechanism and always matched.** They no longer do, on
purpose:

- `RelatedPanel.mjs`'s `orderedThreadMessages()` still walks the chronological,
  **cross-thread** message list — every comment thread on the same block/line,
  i.e. `visibleComments()`/`cs.view` — and backs `threadFenceStartIndexes(c)`:
  each message gets the running fence-count BEFORE its own fences, so a card
  rendered later on the SAME line keeps counting on from an earlier card's
  badges instead of resetting to "Codeblok 1". `commentBody(c, startIndex)`
  (see `.claude/rules/conventions.md`) takes that as its numbering offset. This
  is purely a rendering convenience and stays cross-thread.
- `claudeThreadContextBlock` (the previous section) now only summarizes THIS
  conversation's own anchor comment (`threadMessages(chatAnchorComment())`),
  and numbers the fences **within that one thread alone**, starting back at 0.

**Accepted consequence:** the "Codeblok N" badge the reviewer sees on a
SIBLING comment's card (same block/line, different comment/different Claude
conversation) no longer corresponds to any number in THIS chat's own context.
Referencing that sibling's codeblock by number in this chat is not something
Claude can resolve anymore — it was never shown that comment's text at all.
Reunifying the two numbering schemes again would require re-widening
`claudeThreadContextBlock`'s scope back to cross-thread, which is exactly the
information leak this fix removed (see "The already-written comment thread
also rides along…" above) — don't "fix" this divergence back without
re-reading that reasoning first.

`markdown.mjs` still exports `countCodeFences(text)`/`annotateFenceNumbers(text,
startIndex)` as the one shared low-level primitive (same fence regex as
`renderMarkdown`/`extractCodeFences`, so a "codeblok" is counted identically
everywhere) — only the SCOPE each caller feeds it now differs.
`threadFenceStartIndexes`' own `inScope`/fallback behaviour (numbering
continuously within just one thread for a PR-wide comment-index item, which has
no Claude chat/cross-thread scope to match) is unchanged.

## "Opnieuw proberen" — a failed turn, and which model answered

The backend half (the 3/6/12/24/48s ladder, the `retrying`/`error` Kinds, the
Opus→Sonnet escalation, the `"retry"` Signal) is in
`.claude/docs/workflows-comments.md`; this is what the reviewer sees.

- **A `kind: 'retrying'` bubble** is the failure with another attempt already
  coming: amber tint, badge word "nieuwe poging", and a body naming the
  attempt, the wait and the model of the next try ("Poging 2 van 6 mislukt —
  nieuwe poging over 6 seconden met Sonnet."). No button: nothing for the
  reviewer to do. Each attempt rewrites the same row, so the text updates in
  place — the panel refetches because every attempt's Activity ends in
  `publishChatChanged`. Deliberately **no live countdown**: that would need a
  UI timer for a number the reviewer does not act on.
- **A `kind: 'error'` bubble** is the exhausted ladder: rose tint, badge word
  "foutmelding", body ending in "Probeer het handmatig opnieuw."
- **The "Opnieuw proberen" button** (`data-testid=claude-retry`, word + glyph)
  renders **only** on a `'error'` bubble that is the **last** message of the
  transcript — that is the one whose input the workflow still holds in
  `lastFailedTurn`. `disabled="${() => busy()}"` uses the plain attribute name
  (never `?disabled=`, see `.claude/rules/arrowjs-pitfalls.md`).
- **Keyboard twin:** `claudeChatCommandsFor()` (`home.mjs`) lists "Probeer de
  mislukte turn opnieuw" in the Claude column's Enter palette, **below** "Wis
  Claude-gesprek", with no confirm submenu (re-running one turn is not
  destructive). Both it and the button call the same `retryClaudeTurn()`
  (`RelatedPanel.mjs`), per `.claude/docs/mouse-navigation.md`. It is listed
  unconditionally — the workflow ignores the Signal when nothing failed, which
  is cheaper than teaching the menu to inspect the transcript. That is exactly
  why it must NOT be first: `defaultSel` selects the list's first real item, and
  a reflexive Enter should never land on an action that is a silent no-op
  whenever nothing failed. See the order note on `claudeChatCommandsFor`.
- **The model pill** (`claudeModelPill`, `data-testid=claude-message-model`)
  names the model behind an assistant turn **only when it isn't the default**
  (`DEFAULT_MODEL`/`MODEL_LABEL` mirror `chatModelLabel` in
  `chat_workflow.go`). So an ordinary Opus turn looks exactly as before, and
  the pill's mere presence already means "another model answered this one" —
  a word, never a colour.

### "Ook andere opnieuw proberen" — retry every failed chat of the PR in one click

Reviewer request: retrying one conversation at a time after a usage-limit hit
(the CLI reason above tends to fail *every* running chat of the PR at once,
not just the one on screen) was tedious. Next to the per-turn button above
sits a second one, `data-testid=claude-retry-all`, same `canRetry` gate (only
on the last message of the transcript, hidden while read-only), calling
`retryAllFailedClaudeChats()` (`RelatedPanel.mjs`) instead of
`retryClaudeTurn()`. It retries the **open** conversation (via the ordinary
`sendClaudeMessage('', 'retry')` fast path) **and** every OTHER conversation
of the PR whose own last message is a `kind: 'error'`/`'cancelled'` one —
"gefaald" here always means that literal last-message check
(`isChatFailureTurn`), never a workflow run's `tembed.Status`.

That check is exactly why this can't be a `GET /api/problems` read the way an
ordinary task retry is (`retryFailedRun`, "Taken" block, `home.mjs`): a
`claude_chat` workflow never actually fails on a `KindError`/`KindCancelled`
turn — `chat_workflow.go` loops right back to `WaitSignal` — so such a
conversation is never `tembed.StatusFailed` and never shows up there at all.
It also can't reuse `otherClaudeChatsAll()` (the "Andere chats in deze PR"
list just above): that list deliberately drops a chat once it is both 'seen'
and answered, and `otherTaskAnswered` counts **any** assistant-role message,
`KindError` included — a failed chat the reviewer already glanced at once
must still be retryable here. So `retryAllFailedClaudeChats` does its own
walk over `prConversationIds()` (every conversation of the PR, fetched
fresh), skips one with a turn running right now, and otherwise fetches its
transcript (`GET /api/chat?commentId=`, the same read `loadChatMessages`
uses) to check only the last message — mirroring
`resumeStuckClaudeAfterCheckout`'s own PR-wide walk just above it in the same
file (same "ensure the run via the idempotent `POST /api/workflows/
claude_chat`, then Signal `retry` against the runId it returns" two-step for
a conversation that isn't on screen and so has no runId of its own yet).
Best-effort per conversation (one unreachable transcript must not stop the
rest), serialized behind its own busy flag (`isRetryingAllFailedClaudeChats`,
disables both retry buttons while it runs — `view.retryAllBusy` in
`ClaudeChat.mjs`). Test: `tests/claude-retry-all.spec.mjs`.

### A failure bubble shows the CLI's own reason when it has one — e.g. a usage limit

Reported bug: a real account usage-limit hit rendered as the exact same
generic, fake-sounding "Er ging iets mis... Poging 5 van 6 mislukt — nieuwe
poging over 48 seconden" as any other failure — misleading, since nothing
about *this* attempt (waiting 48s) was going to fix a limit that resets hours
later.

**Root cause, verified directly** (a manual `claude -p --output-format
stream-json --verbose` run with a deliberately invalid `--model`): the CLI
still completes its stream and writes a final `result` frame with
`"is_error":true` and a real, human-readable `result` string explaining
exactly what went wrong — while the *process itself* still exits non-zero.
`modules/claude.RunChat` checked `cmd.Wait()`'s error BEFORE ever looking at
that already-parsed text, so it was thrown away every time in favor of a bare
`exit status 1` — the reason chat_workflow.go's `chatFailureTurn` could only
ever produce the one generic sentence, no matter the real cause underneath.

Fix, `modules/claude/claude.go`:

- `ChatResult` gained `IsError bool` (`readChatStream` now also parses
  `is_error` off the `result` frame).
- `RunChat` returns a new `*ChatCallError{Reason, Definitive, Err}` instead of
  a bare wrapped error. `Reason` is the CLI's own `result` text when
  `IsError` was true (checked **before** the exit-code check, since this can
  be true even on a zero exit) — `Definitive: true` in that case, meaning the
  CLI itself, having run the turn to completion, judged it a failure — as
  opposed to a bare process/exec problem (pipe broken, binary missing, our
  own context timeout), where `Reason` falls back to the last non-blank
  stderr line (now captured at all, where it used to be discarded
  entirely) and `Definitive` stays `false`.
- `chat_workflow.go`'s `chatFailureTurn(attempt, model, callErr)` (now takes
  the error) uses `errors.As` to pull out a `*claude.ChatCallError`: a
  non-empty `Reason` replaces the generic "Er ging iets mis" wording with
  "Claude (Sonnet) meldde zelf een fout: `<reason, verbatim>`" — never a
  message this app invents. When `Definitive` is also true, the automatic
  retry ladder is skipped **immediately** (`chat.KindError`, no countdown): a
  verdict the CLI already reached on its own is very unlikely to change
  within the ladder's few-second/-minute rungs — a usage limit in particular
  normally resets hours later. A `Reason` that isn't `Definitive` (a plain
  exec hiccup) keeps the existing ladder unchanged, and a bare error with no
  `ChatCallError` at all (e.g. `context.DeadlineExceeded`, or what every
  pre-existing retry test in `chat_workflow_test.go` already programs via
  `Fake.SetChatError`) produces **exactly** the pre-existing generic wording —
  additive only, no behaviour change for those.
- Deliberately **not** a dedicated "usage limit" Kind/badge: there is no
  verified, stable signal in the CLI's stream-json output that identifies a
  usage limit specifically (as opposed to any other API-level error) short of
  string-matching the CLI's own free-form English sentence, which would be
  exactly the "fragiele stringmatch" this app avoids gambling on. Showing the
  CLI's OWN words verbatim — whatever they say — is the honest middle
  ground: if the real cause is a usage limit, the reviewer reads that in
  Claude's own sentence instead of a manufactured generic one.
- Tests: `TestReadChatStreamParsesIsError`,
  `TestRunChatSurfacesTheCLIsOwnReasonOnANonZeroExit` (a fake `claude` binary
  reproducing the exact real-CLI shape above, `modules/claude/stream_test.go`)
  and `TestChatFailureTurn*` (three cases — a `Definitive` reason, a
  non-`Definitive` one, and a bare error — `chat_workflow_test.go`).

## Cancelling a running turn (`chat.KindCancelled`, `chat_cancel.go`)

Reviewer request: "ik wil een chat kunnen annuleren als het bezig is met een
antwoord". The chat itself works exactly as before — this only adds a way to
stop a turn that is already running.

### Why this cannot be a Signal

`Engine.SignalWorkflow` (`tembed/engine.go`) takes the run's own lock and
drives the whole turn **inline** before returning — the entire
`runChatTurnWithRetries`/`runOneClaudeTurn` call happens synchronously inside
that one call. A "cancel" Signal aimed at the SAME run would therefore simply
queue up behind the turn it is trying to interrupt and block for exactly as
long as that turn runs — the opposite of a cancel. See
`chat_cancel.go`'s own doc comment, and the matching write-boundary carve-out
in `.claude/rules/workflows-write-boundary.md`.

Instead, `chat_cancel.go` keeps a purely in-memory
`map[conversationID]context.CancelFunc` (`chatCancelByConv`).
`runOneClaudeTurn` derives its own `runCtx` (`context.WithCancel(ctx)`) at the
top of the Activity and registers `cancel` for the conversation's duration;
`POST /api/chat/cancel {commentId}` (`handleChatCancel`, `tasks_api.go`) just
looks it up and calls it. `runCtx` is used for every piece of OUTBOUND work
the turn does — both `cl.RunChat` calls, the write-turn-slot wait
(`acquireWriteTurnSlot`), and the git/gh checkout prep — **never** for
persisting the turn's own outcome, which always uses the Activity's
ORIGINAL, uncancelled `ctx` (tembed always calls an Activity with
`context.Background()`, see `tembed/workflow.go`), so a `chat.KindCancelled`
message can still actually be saved after the cancel fires.

Cancellation is detected via `runCtx.Err() != nil` at each of the points that
context could have made a difference — never by inspecting the error VALUE a
killed `claude` subprocess returns (`cmd.Wait()`'s own `*exec.ExitError` does
not itself wrap `context.Canceled`, even though `exec.CommandContext` caused
the kill).

### `chat.KindCancelled` — a NEW Kind, deliberately not `KindError`

The reviewer was explicit: "afgebroken", not a foutmelding — nothing actually
went wrong. `chatCancelledMessage` (`chat_workflow.go`) saves this Kind and a
plain "Afgebroken op jouw verzoek." body. The workflow's own
`lastFailedTurn`/"Opnieuw proberen" bookkeeping treats `KindCancelled` exactly
like `KindError` (same TurnID kept, so `chatActionRetry` reruns the very same
turn) — the ONE deliberate difference is that `runChatTurnWithRetries`'
automatic backoff ladder is **skipped entirely** for a cancel: a
`chat.KindCancelled` result is never `chat.KindRetrying`, so there is no
durable `w.Sleep` scheduled at all, and therefore nothing that could restart
the turn behind the reviewer's back. (This was flagged up front as the single
biggest risk of building this feature the naive way — a killed process just
looks like any other transient failure to the existing ladder — and is the
one thing `TestCancelledTurnDoesNotAutoRetry` exists to pin down.)

Frontend: `chatKindBadge`/`claudeBubble` (`ClaudeChat.mjs`) give it its OWN
tint (neutral slate/zinc — deliberately **not** the rose of `KindError` or the
amber of `KindRetrying`, which already mean something else) plus the badge
word "afgebroken" and a stop-square glyph — word carries the meaning, per the
colourblind rule. `canRetry` (the "Opnieuw proberen" button) now also fires on
`kind === 'cancelled'`, on the same "last message of the transcript" gate as
`KindError`.

### The Stop control: mouse + keyboard, per `.claude/docs/mouse-navigation.md`

- **Mouse:** a "Stop" button (`data-testid=claude-chat-cancel`) next to
  `claude-chat-status` in `CommentClaudeFooter` (`RelatedPanel.mjs`), visible
  exactly while `hasActiveClaudeTurn()` is true. Calls `cancelClaudeTurn()`
  (`RelatedPanel.mjs`), a plain `POST /api/chat/cancel {commentId: cc.commentId}`.
- **Keyboard:** "Stop deze Claude-beurt" in `claudeChatCommandsFor()`
  (`home.mjs`) — same `cancelClaudeTurn()` call. Listed **unconditionally**,
  same reasoning as "Probeer de mislukte turn opnieuw" right above it: the
  endpoint is a silent no-op when nothing is running, cheaper than teaching
  the menu to inspect `chat_progress` state. Deliberately **last** in that
  menu, never first (the reflexive-Enter rule this file already documents for
  the retry item).
- **Keyboard, from inside the composer itself:** Escape, while the composer
  textarea (`data-testid=claude-chat-compose`) holds DOM focus and
  `view.active()` (`hasActiveClaudeTurn()`, exposed on `claudeChatView` next
  to the narrower `busy()`) is true — the composer's own `@keydown`
  (`ClaudeChat.mjs`) calls `callbacks.onCancel()` → `cancelClaudeTurn()`, same
  function as the two entry points above. Reviewer request: cancel without
  leaving the field, so a `stopPropagation()` (called FIRST, per the
  nested-handler ordering rule in `.claude/rules/arrowjs-pitfalls.md`) keeps
  this Escape from also reaching `home.mjs`'s document-level `onKeydown`,
  whose `isEditableFocused()` fallback would otherwise blur the field
  (`leaveRelated()`) on the very same keypress. With no turn running
  (`view.active()` false) this branch does not match at all, so Escape falls
  through unchanged to that existing "leave the field" behavior — a SECOND
  Escape, once the turn is gone, still leaves the composer as before. No new
  visual feedback: this mirrors the Stop button's own "silent until the
  `chat.KindCancelled` bubble lands" behavior.
- The client-side reviewer-typed **queue** (`cc.queued`/`drainClaudeQueue`,
  "Doorpraten tijdens een lopende turn" below) is deliberately **untouched**
  by a cancel — only the currently running turn is interrupted; whatever the
  reviewer already queued up drains normally right after (the blocked
  `fetch()` for the cancelled turn's own Signal call finally returns once
  `SignalWorkflow` unblocks, and `sendClaudeMessage`'s own `finally` calls
  `drainClaudeQueue()` exactly as it does for an ordinary turn).

### Cleaning up after a cancel: the blocking werkmap choice

Reviewer decision: if the just-cancelled turn's OWN shell attempt had already
started editing the PR's shared checkout (its Edit/Bash tool calls run before
the kill reaches the CLI), ask what should happen to that — but **only** when
there really is something dirty. `raiseCancelCleanupChoice`
(`chat_workflow.go`) snapshots the dirty paths of the checkout the shell
attempt was using right after a cancel is detected on that attempt
specifically (never on the read-only attempt, which never has file access at
all) and, only if dirty and no other choice is open yet, raises the PR's one
**blocking werkmap choice** (`a.Pending`, stage `checkoutStageDirtyTree`, i.e.
the fullscreen `workDirOverlay.mjs`) with the same five options
`chat_checkout.go` already has for an unrelated dirty tree (`optDiscard`/
`optStashManual`/`optStashAuto`/`optKeepSeparate`/`optKeepCombined`).

**It used to be a `chat.KindCleanupChoice` bubble in the conversation, and
that is the bug this replaced.** The bubble scrolled out of sight the moment
the reviewer typed again, while the leftovers it asked about kept every write
turn of the PR blocked on a transient "een andere Claude-conversatie is deze
werkmap nog aan het landen" — an hour of that on PR 13798. Reviewer's rule
for the fix: a blocking state must be unmissable and you must not get past it
until it is answered, with exactly one exit rather than two competing
questions. The overlay is precisely that (no local way to close it, see
`isWorkDirOverlayOpen`). The full backend half — including the
`chatLandExpected` liveness flag that stops a cancelled/failed turn's
leftovers from being read as "still landing" — is in
`.claude/docs/workflows-comments.md`. Everything below about
`chatActionCleanup`/`applyCancelCleanup` still applies to a bubble **stored
before** this change, which keeps its own round trip.

**Deliberately its own small mechanism, NOT `chatCheckoutDecision`/
`a.Pending`'s existing answer/resume round trip.** That machinery
(`prepareChatShellWorkDirAt`'s `hasPendingCheckoutDecision` check at the top of
`runOneClaudeTurn`) exists so an EARLIER, still-open request can continue once
a checkout question is answered — its non-`Final` resolutions fall through to
`effectiveBody = chatCheckoutResumedPrompt`, which calls Claude AGAIN with a
synthetic "ga verder" prompt. Reusing that for a post-cancel cleanup choice
would make resolving it **silently start a brand-new Claude call** — exactly
what a reviewer who just pressed Stop would never expect. So the cleanup
choice is answered through its own dedicated Signal action instead
(`chatActionCleanup = "cleanup"`, validated server-side against the five known
option strings before it ever reaches git, per the validate-before-exec
rule), handled by its own workflow branch (no Claude call, ever — mirrors
`chatActionClear`/`chatActionCommit`) and its own Activity
(`applyCancelCleanup`, `chat_checkout.go`), which re-checks dirtiness fresh
(the reviewer may take a while to answer) and performs the chosen git
housekeeping directly against whichever checkout is currently assigned to the
PR. `resolveCancelCleanup(choice)` (`RelatedPanel.mjs`) is the frontend send
path; `claudeQuestionOptions` (`ClaudeChat.mjs`) routes a click on a
`cleanup_choice` bubble's chips through `onCleanup` instead of the ordinary
`onSend`.

If such an old bubble is never resolved (or the reviewer retries the original
request without resolving it first), nothing is silently lost: the very next
shell attempt
that reclassifies this same checkout directory
(`prepareChatShellWorkDirAt`'s ordinary `a.Dir != ""` branch) will find it
still dirty and raise the SAME kind of "what do you want to do with this"
question again, through the pre-existing `chatCheckoutDirtyDecision` path —
this cleanup bubble is a proactive convenience on top of that existing safety
net, not the only thing standing between a cancel and a silently overwritten
edit.

### Process-tree cleanup (`killOwnProcessGroup`, `modules/claude/claude.go`)

Both `exec.CommandContext` call sites (`Run`/`RunChat`) now make the `claude`
process the leader of its own process group (`SysProcAttr{Setpgid: true}`) and
override `cmd.Cancel` to `kill(-pid, SIGKILL)` the whole group instead of the
exec package's own default of killing only `cmd.Process`. Without this, an
agentic turn's own Bash tool calls (real child processes of `claude`, not of
this Go process) kept running after a cancel — the UI already said
"afgebroken" while a child process quietly continued. POSIX-only
(`Setpgid`/negative-pid `kill`), matching every other platform assumption
already in this codebase.

### Testing: `SetChatBlockUntilCancel` (`modules/claude.Fake`)

`SLASH_CLAUDE_CHAT_TURNS` (see "Testing hook" below) has no way to express
"this turn is still running" — every scripted entry is a finished answer.
`Fake.SetChatBlockUntilCancel(true)` makes every subsequent `RunChat` call
hang on `<-ctx.Done()` and return `ctx.Err()` instead, so a Go test can drive
the whole cancel path (register → cancel → `chat.KindCancelled` saved → the
retry ladder never fires) without a real subprocess. See
`TestCancelledTurnDoesNotAutoRetry` (`chat_workflow_test.go`) — the load-
bearing regression test for this entire feature, run on a separate goroutine
from the blocking `SignalWorkflow` call it is cancelling out from under.

### The write-turn slot's own staleness: nobody could stop the ACTUAL holder

Reported symptom, distinct from the cancel feature above: "hij wacht op een
andere chat, maar die kan ik niet stoppen" — a chat stuck at `chatPhaseWaiting`
(`chat_write_gate.go`'s `acquireCheckoutWriteSlot`), with no way to see or
cancel whichever OTHER turn actually holds the checkout's one write-turn slot.
The Stop button above only ever cancels the conversation currently open in the
panel; if that conversation is itself the one WAITING (not holding), cancelling
it only makes it give up waiting (→ `chat.KindCancelled`) — it was never
holding the slot, so nothing is freed for the next attempt either.

**The gap:** `chat_write_gate.go`'s `writeTurnSlots` is a plain
`chan struct{}` (capacity 1) per checkout directory, with no owner identity,
no timeout, and — before this — no way to recover from a leaked token short of
restarting the whole server (a crashed/permanently wedged goroutine that never
reaches its deferred `release()` wedges every later write turn for that
checkout forever; the in-memory `chatProgressByConv` entry for such a holder
was observed staying at `phase: waiting` for tens of minutes with no further
update, live, against `PR 13810`).

**Fix, in `chat_write_gate.go`:**

- **Holder visibility.** `writeTurnHolders map[string]writeTurnHolder` records
  a short `Label` (e.g. `"chat turn (<conversationId>)"`, `"test run"`,
  `"checkout: restoring a stash"`) and `AcquiredAt` for whoever currently holds
  each key. `buildCheckoutView` (`chat_checkout.go`) exposes
  `holderLabel`/`holderStale` on `GET /api/chat/checkout`, and
  `checkoutChipTitle` (`src/home.mjs`) now says "Wacht op: \<holder\>" instead
  of a bare "Wachten…" whenever a label is known.
- **Automatic staleness release.** `acquireWriteTurnSlot`'s WAITING loop no
  longer only blocks on the channel send — it also polls every
  `writeTurnStaleCheckInterval` (30s) and calls
  `forceReleaseStaleWriteTurnSlot`, which drains the slot once its holder has
  sat on it for at least `writeTurnStaleTimeout` (90 minutes). That number is
  **measured, not guessed**: the longest single `claude_chat` write turn that
  ever completed *successfully* in this deployment's own workflow history
  (`data/workflows.db`'s `events` table — the gap between a conversation's
  `SignalReceived("message")` and its own
  `ActivityCompleted("runClaudeTurn")`) was **~2546s (~42.4 minutes)** — a real
  `Bash` test-suite run, "1095 passed ... 2821 assertions, 1235s" in its own
  reply (run `chat-47284166cc7147a9794cf3ba`, PR 13729). The next-highest,
  independent (different conversation) value in the same history was 766s;
  every other successful turn was well under that. `writeTurnStaleTimeout` is
  set to more than 2x the measured maximum so a real, slow-but-alive turn is
  never mistaken for an abandoned one.
- **Manual force-release.** `POST /api/checkout/force-release {pr}`
  (`handleCheckoutForceRelease`, `tasks_api.go`) is the reviewer-facing
  counterpart — the "Forceer vrijgeven" command on the checkout chip
  (`checkoutChipCommandsFor`, only offered while `c.waiting`). It calls the
  exact same `forceReleaseStaleWriteTurnSlot` check, so it can never interrupt
  a turn that is merely slow — pressing it against a fresh holder is a
  reported no-op (`{ok:true, freed:false}`), not a kill switch. Stateless
  operational carve-out per `.claude/rules/workflows-write-boundary.md`
  (ninth example there): no module, no read-model, no workflow-history write.
- **The double-release race this had to close.** A force-released holder
  might not actually be dead — its own deferred `release()` could still fire
  later. Without a guard, that late call would drain whichever LATER,
  unrelated acquirer had since taken the freed slot, corrupting the
  capacity-1 semaphore into allowing two concurrent write turns. Each
  acquisition now carries its own `*atomic.Bool` (`released`), and both the
  real release closure and `forceReleaseStaleWriteTurnSlot` gate their actual
  channel drain behind winning a `CompareAndSwap` on it — exactly one of the
  two ever runs. Regression test:
  `TestWriteTurnSlotForceReleaseIsIdempotentAgainstTheRealHolder`
  (`chat_write_gate_test.go`).
- Tests: `TestWriteTurnSlotForceReleasesStaleHolder`,
  `TestWriteTurnSlotDoesNotForceReleaseFreshHolder`,
  `TestForceReleaseCheckoutWriteSlotRespectsStaleness`
  (`chat_write_gate_test.go`) — all override the package-level
  `writeTurnStaleTimeout`/`writeTurnStaleCheckInterval` vars to millisecond
  scale and restore them via `t.Cleanup`, rather than actually waiting 90
  minutes.

### A rejected Signal must not be silent

`sendClaudeMessage` (`RelatedPanel.mjs`) used to `await fetch(...)` and never
look at the response. A **rejected** message Signal therefore produced
literally nothing in the UI: no bubble, no status line, no disabled button —
the reviewer pressed "Stuur" (or "Opnieuw proberen") and the column just sat
there, looking perfectly healthy. Bug report: "ik kan niet reageren op claude".

The incident behind it: **`src/` is served straight off disk, the Go process is
not.** A browser reload therefore picks up a frontend that is newer than the
running binary. The page had the "Opnieuw proberen" button (and the palette
twin), the server predated the `"retry"` action, and `handleWorkflows`'
validate-before-exec switch answered every press with `400 invalid action`
(`tasks_api.go`) — which the frontend then threw away. The button was dead with
zero feedback and no way to tell it apart from a UI that had simply stopped
working. The operational fix is a restart; the *code* fix is that the reviewer
must be told.

- The reviewer-facing sentence for the LAST send lives **per conversation**,
  `''` when it was accepted — `setTurnSendError`/`turnSendError`
  (`src/claudeTurns.mjs`), read here through `ccSendError()` (narrowed to
  `cc.commentId`, same pattern as `ccBusy()`/`ccProgress()`). It used to be a
  single field `cc.sendError`, cleared at the start of every send and wherever
  `cc` itself reset (`toNew`, `syncClaudeAnchorForSelection`) — see "A rejected
  send must survive navigating away" below for why that was wrong, not just
  incomplete.
- `sendErrorText(status)` maps the three statuses the endpoint really produces:
  **400** → "de server kent deze actie niet … herstart slash" (the version-skew
  case above — the only one whose fix is not in the browser), **409** →
  `SignalWorkflow` refused because this Execution is completed/failed, so the
  conversation can never take another turn, **anything else** → named by
  status. The `catch` (previously absent, so the rejection escaped as an
  unhandled rejection out of the click handler) covers "the request never
  completed at all".
- `claudeSendError(view)` (`ClaudeChat.mjs`) renders it directly **above the
  composer**, not in the thread: nothing was stored, so it is not a turn, and
  the reviewer's next move (reload, restart, wipe) is a composer-level one.
  Leading word "Niet verstuurd" + a glyph carries the meaning, the rose tint is
  decoration (colourblind rule). A `${() => ...}` function binding, per the
  statically-interpolated-template↔string pitfall.
- Deliberately distinct from the two error states that already existed:
  `cc.status === 'error'` is the PANEL failing to load, and a `kind: 'error'`
  bubble means Claude **was** reached and the call failed. This one means the
  message never left the page.
- Test: `tests/claude-chat-send-rejected.spec.mjs` (mocked 400, then an
  accepted send clears the line again). The three hand-built `view` stubs in
  `claude-chat-panel.spec.mjs` grew a `sendError: () => ''` along with the
  contract.

### A rejected send must survive navigating away

Follow-up on `db0e5f7` ("Chat with Claude on several selections at once",
which moved `busy`/`progress` off `cc` into `claudeTurns.mjs` — see "Parallel
conversations" above): `cc.sendError` itself was left as the one single-slot
field the commit's own note flagged. Reviewer send on conversation A, walk to
conversation B before A's rejection arrives → the sentence landed on
`cc.sendError` regardless of which conversation was on screen by then, so it
showed under **B**, not A; and `syncClaudeAnchorForSelection`'s unconditional
`cc.sendError = ''` on every switch meant that even a rejection that DID land
correctly was wiped the moment you walked back to A to go read it. Fixed by
giving `sendError` the exact same per-conversation home as `busy`: a
`sendError` field on `claudeTurns.mjs`'s per-id entry
(`setTurnSendError`/`turnSendError`), `sendClaudeMessage` keys every write by
its own already-computed `commentId` (never the live `cc.commentId`, which may
already point at a different conversation by the time the response arrives),
and the two stale plain-field resets (`toNew`, `syncClaudeAnchorForSelection`)
are simply gone — `ccSendError()` narrows to whichever conversation `cc`
currently shows, so switching naturally reveals that conversation's OWN last
sentence (or `''` if it never had one) without needing to clear anything by
hand.

**`status` and `summary`/`summaryStatus` did NOT get the same treatment —
checked and found to need something narrower, or nothing at all:**

- **`cc.status`** (`'idle'|'loading'|'error'`) is purely the PANEL's own
  "ensuring the workflow / fetching the transcript" state — it is never shown
  outside this panel, and `ensureAndLoadChat` reruns it from scratch every time
  the reviewer re-enters a conversation's chat, so there is nothing to
  *persist* across a navigation away and back (unlike `sendError`, which
  reports a fact about a specific past attempt the reviewer would want to see
  again). The real bug was narrower: `ensureAndLoadChat`'s two `cc.status =
  'error'` writes (a failed POST, and the `catch`) were the only writes in
  this area missing the stale-response guard `loadChatMessages` already uses
  (`if (cc.commentId !== commentId) return`) — so conversation A's ensure
  failing after the reviewer already switched to B could flip B's, currently
  visible, status to `'error'` for a failure that was never B's. Fixed with
  that same existing guard, not a registry move — "werk minimaal": nothing
  here needs to survive being looked away from, it only must not leak onto
  whatever conversation is currently on screen.
- **`cc.summary`/`cc.summaryStatus`** were checked and are already safe, no
  change: their only writer, `loadChatMessages`, already bails via that exact
  `if (cc.commentId !== commentId) return` guard before touching them, and
  their only reader/continuer, `convertClaudeAnchorToComment`/
  `pollChatSummary`, already checks `want !== focusToken || cc.commentId !==
  commentId` before using or continuing to poll. No reachable path writes a
  stale conversation's summary into the currently-shown one. Recorded here so
  a future pass doesn't have to re-derive this from scratch.

Test: `tests/claude-chat-parallel.spec.mjs` grew a case asserting the rejected
send's sentence is still there when walking back to that conversation after
visiting another one in between.

## "Wis Claude-gesprek" — clearing a conversation (chatActionClear)

A command-palette item, not a header button (explicit product choice).
It **runs on the first Enter, with no confirmation** — reviewer request ("na
wis claude gesprek, hoef ik geen bevestiging te zien") — **except** while the
PR's shared local checkout (`chat_checkout.go`, superseding the old
per-conversation shadow worktree — see "Every turn gets a real shell by
default" above) still holds pending agentic-edit work: there it keeps the
two-step confirm submenu ("dan wel als bevestigingscherm laten in dat geval"),
the same shape "Keur de HELE PR goed"'s own `REVIEW_APPROVE_CONFIRM_COMMANDS`
uses unconditionally. This warning is now purely INFORMATIONAL, not "will this
get deleted" — clearing a conversation's own transcript never touches the
shared checkout at all any more (it is shared with every other conversation
of this PR), so the confirm step exists only so the reviewer isn't surprised
by unrelated pending work they'd otherwise only discover later. Backend
mechanics (the `"clear"` `ChatMessageSignal.Action`, `clearChatConversation`)
are in `.claude/docs/workflows-comments.md`'s `claude_chat` section; this
section is the frontend/palette half.

**The general (PR-wide, code-less) chat is the one caller that does NOT end
in `exitRelated()` after deleting the placeholder anchor** — its own
still-open composer needs a fresh anchor to re-attach to instead. See
"'Wis Claude-gesprek' from the empty composer, inside the overlay" under
"The general chat" above for that branch and the keyboard-precedence fix
that made reaching it from inside the overlay work at all.

- **Reached via Enter on the Claude column, but only while the composer is
  NOT the focused DOM element** (`home.mjs`'s `onKeydown`, inside the
  `relatedActive()` block): `focusClaudeComposer` only focuses the composer at
  `cs.claudePos === 0` (the rest position, where Enter must keep
  sending/newlining via `ClaudeChat.mjs`'s own `@keydown`) and explicitly
  blurs it for any stepped-up position (`claudePos > 0`, walking the
  transcript via ↑) — exactly the state this menu opens in. A DOM-focus check
  rather than a value-emptiness check (unlike `commentReplyEmpty` for the
  comment column): the composer clears its own value **synchronously** on
  send, so reading its value from the document-level handler — which runs
  *after* the composer's own bubbled keydown handler already cleared it —
  would misread an ordinary just-sent message as "empty composer" and reopen
  this menu right after every send.
- **`claudeChatCommandsFor()`/`claudeChatClearConfirmCommandsFor()`** (`home.mjs`,
  wired into `rootCommandsFor`/`resolveCommands` as mode `'claude'`): the root
  item ("Wis Claude-gesprek") carries **either** a plain `run: clearClaudeChat`
  **or** `children` — the one-item confirm submenu ("Ja, toch wissen — …") —
  depending on whether `claudeChatShadowWarning()` returns a warning at open
  time. So the warning is both the gate and the confirm label; there is no
  plain "Ja, wis dit gesprek" row any more, because a conversation with nothing
  pending never reaches that submenu. Built fresh on every open (not a static
  list) for exactly that reason.
- **`menuAnchor()`/`menuRegion()` need their own `'claude'` branch** — every
  other mode ultimately falls back to the selected block's diff row
  (`[data-change-active]` et al.), which does not exist when the Claude column
  is reachable with no diff on screen (e.g. a comment-thread-only view); without
  a dedicated branch `positionMenu` finds no anchor/region and the palette
  never becomes visible at all — it stays permanently `visibility:hidden`.
  Anchors on `claude-chat-card` (falling back to `comment-claude-row`).
- **The pending-shadow-work warning**: `refreshChatShadowWarning(pr, commentId)`
  (`RelatedPanel.mjs`) is a fire-and-forget read run from `enterClaudeChat`
  right after entering the chat — it hits the read-only
  `GET /api/chat/shadow-status` (see `workflows-comments.md`) and caches a
  Dutch warning sentence when the PR's shared local checkout still has
  uncommitted or locally-unpushed work (PR-scoped now, not per-conversation —
  `commentId` is accepted but no longer consulted server-side). `home.mjs` reads
  that cache **synchronously** at menu-open time via `claudeChatShadowWarning()`
  — the menu is built by plain, non-reactive code
  (`rootCommandsFor`/`openMenu`) that cannot itself `await` a fetch, the same
  reason `commentCommandsFor`'s own `focusedCommentGithubId()` is a snapshot
  read rather than a live query. Now that the same value decides whether there
  is a confirm step at all, a stale/failed check means the clear runs on the
  first Enter instead of asking — accepted deliberately (the alternative is
  blocking the menu on a network round trip), and never a wrong block: the
  clear itself is unchanged.
- **`clearClaudeChat()`** (`RelatedPanel.mjs`) sends the `"clear"` Signal and
  resets `cc.progress`/`cs.claudePos` locally — belt-and-braces on top of the
  `chat.message` SSE event's own refetch, same reasoning as `sendClaudeMessage`'s
  own post-send refetch. It **returns** whether the backing comment/index row
  was actually removed (`true` only for the still-`CLAUDE_ANCHOR_PLACEHOLDER`
  branch — a chat hanging off a REAL reviewer comment leaves that row in
  place). `home.mjs`'s `runClearClaudeChat()` (both entry points below call
  this, not `clearClaudeChat` directly) uses that return value to decide
  whether to navigate on to the next comment/chat "Start" row — see "Narrowed
  the next day…" in `.claude/docs/command-palette.md`.
- Tests: `tests/claude-chat-panel.spec.mjs` has both halves — the ordinary
  case clears on a single Enter, and a second case routes
  `GET /api/chat/shadow-status` to report pending work and asserts the confirm
  submenu appears (transcript still there) before the second Enter clears it.

## "Comment hiervan maken" on an empty Claude input

Reviewer request: "enter op een claude input veld wat leeg is moet een menu
laten zien met de keuze om de chat te verwijderen of er een comment van te
maken. Verwijder dan ook gelijk de (empty)comment." The "(empty)comment" is
`CLAUDE_ANCHOR_PLACEHOLDER` — the throwaway body
(`ensureClaudeAnchorForNew`) a Claude conversation's backing comment gets when
the reviewer starts chatting before ever typing into "Comment op deze regel".

- **Reaching the menu — a SECOND, callback-driven path, not a widened
  DOM-focus check**: `Enter` on the Claude column already opened
  `claudeChatCommandsFor()` while the composer wasn't the focused DOM element
  (stepped up into the transcript via `↑`, `home.mjs`'s own
  `document.activeElement !== composerEl` check). Enter on the composer
  itself, while EMPTY, needs a second, independent route to that same
  `openMenu('claude')` — deliberately NOT a widened version of that same
  DOM-focus branch: `home.mjs`'s window-level `onKeydown` only ever sees this
  key AFTER `ClaudeChat.mjs`'s own `@keydown` (bound directly to the textarea)
  has already run and, for an ORDINARY non-blank send, already cleared
  `e.target.value` **synchronously in that same dispatch** — so by the time a
  document-level handler could read the field, a just-sent real message and a
  genuinely blank Enter both read `""`, indistinguishable. (This exact
  landmine broke `tests/claude-chat-panel.spec.mjs`'s own "Wis Claude-gesprek"
  and several other specs during development — the menu popped open right
  after an ordinary send.) The fix keeps the decision where it's genuinely
  known: `ClaudeChat.mjs`'s `@keydown`, in the `else` branch of its existing
  `if (e.target.value.trim())` guard (which used to silently swallow Enter on
  a blank field), calls `callbacks.onEmptyEnter?.()` — a new callback next to
  `onSend`/`onRetry`/`onFocus` in `claudeChatCallbacks` (`RelatedPanel.mjs`),
  wired to `openClaudeMenuFromComposer()`, which calls the registered
  `claudeMenuOpener` — `home.mjs` hands that opener down once at module load
  via `setClaudeMenuOpener(() => openMenu('claude'))`, the EXACT same
  downward-injection shape `setReplyPublishMenuOpener` already uses for the
  same reason (`RelatedPanel.mjs` never imports from `home.mjs`, which would
  be circular). **`e.stopPropagation()` right before that call is
  load-bearing, not belt-and-braces**: `openMenu('claude')` sets `menu.open =
  true` synchronously, and if the SAME keydown event were then allowed to go
  on bubbling into `home.mjs`'s window-level `onKeydown`, its own "the menu is
  open → this Enter runs/enters the highlighted command" handling (checked
  before any mode-specific branch) would immediately act on the very keypress
  that just opened the menu — observed as the menu popping open already
  showing "Wis Claude-gesprek"'s **confirm submenu**, one level too deep, in
  early testing.
- **The extra item**: `claudeChatCommandsFor()` inserts **"Comment hiervan
  maken"** between "Wis Claude-gesprek" and "Probeer de mislukte turn
  opnieuw", but only while `claudeAnchorIsPlaceholder()` — the anchor comment
  is looked up via `cc.commentId` + the private `commentById` helper (never
  `chatAnchorComment()`/`selComment()`, which can resolve to an unrelated
  comment on the same unit while nothing is anchored yet, see
  `isNewChatUnanchored`), so this can't misfire for a neighbouring comment. A
  comment that already carries the reviewer's own real text never gets the
  item — nothing left to "make a comment of".
- **What it does**: `convertClaudeAnchorToComment()` steps the keyboard back
  onto the comment card exactly like `←`/Escape from `'claude'` does
  (`toComment(false)`, see `handleRelatedKey`'s `'claude'` branch) and opens
  the origin bubble's own inline editor — the pre-existing "Bewerk bericht"
  mechanism (`editState`/`editTargetId`, `startEditMessage`'s own machinery),
  not a second parallel editor — prefilled with a Claude-WRITTEN summary of
  the conversation rather than an empty field or the placeholder sentence
  (reviewer, when asked "empty field or prefilled?": "Voorgevuld met de chat,
  maar dan door chat geschreven in maximaal 2 zinnen. In die 2 zinnen alleen
  `,` of `.` gebruiken. code sugesties mogen wel en labels ook met de `
  tekens enzo"). The reviewer still edits/sends it via that same existing
  field — nothing here posts anything by itself.
- **Generating the summary — `summarize_chat`, the same shape as
  `explain_code`**: a genuinely new short-Dutch-summary Workflow Type
  (`workflows.go`), because nothing existing summarizes a chat conversation —
  but built to the exact template `explain_code`/`pr_status`'s own summary
  Activity already established: one context-only Haiku call
  (`claude.ChatSummarySystemPrompt`, `modules/claude/prompts/chat_summary.md`
  — Dutch, at most 2 sentences, comma/period punctuation only, inline
  code/code-suggestion fences allowed), `markChatSummarySearching` →
  `generateChatSummary` → `saveChatSummary`, an empty result recorded as a
  terminal `'failed'` status exactly like `explainCodeWorkflow`. Idempotent
  per conversation **content**: `StartSummarizeChat`'s deterministic Run ID
  (`chatSummaryRunID`) hashes `commentId + the conversation's current message
  count`, so clicking the item again with no new messages since is a free
  reuse, and a further reply makes the next click regenerate. Storage reuses
  the EXISTING `chat_conversations` row (two new columns, `summary`/
  `summary_status` — `chat.Module.SaveSummarySearching`/`SaveSummary`/
  `Summary`) rather than a new module: a conversation already has exactly one
  such row, so a summary is naturally 1:1 with it, unlike `explanations`
  (keyed per navigation unit, many units per PR).
- **Reaching the frontend**: `GET /api/chat?commentId=` (already polled/
  refetched at every point `loadChatMessages` runs — after a send, on the
  `chat.message` SSE event, on (re)entering the column) now also returns
  `summary`/`summaryStatus`, mirrored onto `cc.summary`/`cc.summaryStatus`.
  `convertClaudeAnchorToComment` reuses an already-`'done'` summary for the
  CURRENT length instantly; otherwise it starts the workflow
  (`POST /api/workflows/summarize_chat {pr,repo,commentId,msgCount}`) and
  polls that same `GET /api/chat` every 500ms for up to ~10s
  (`pollChatSummary`) — deliberately a poll, not a new SSE event, for a
  one-shot Haiku call that isn't worth a dedicated channel on top of the
  existing `chat.message` one. The edit field shows a "Claude schrijft een
  samenvatting…" placeholder meanwhile, and the eventual prefill is skipped if
  the reviewer already started typing their own text into it (a plain
  string-equality check against that same placeholder — deliberately not the
  generic `prefillField` helper's own timing, since this specific race —
  several seconds of LLM latency — is far likelier to matter than anywhere
  else that helper is used). A `'failed'` result (offline/hiccup) leaves the
  field empty, the same fallback as before summaries existed.
- **Cleanup ties to CONTENT, not to which gate opened the menu**: "verwijder
  dan ook gelijk de (empty)comment" — but only when the anchor comment is
  still `CLAUDE_ANCHOR_PLACEHOLDER` at the moment "Wis Claude-gesprek" is
  confirmed (reviewer, when asked "always cleanup, or only via the empty-field
  entry point?": "Alleen via het lege veld, maar ik zie het ook als een leeg
  veld als ik '(Nog geen eigen comment getypt — gesprek met Claude gestart.)'
  zie" — i.e. the state decides, not the entry point). `clearClaudeChat()`
  therefore checks the SAME `commentById(cc.commentId)` snapshot after
  clearing and, only if its body is still the placeholder, deletes it
  (`deleteComment`) + reloads the comment list + calls `exitRelated()` (there
  is nothing left to focus). A comment already carrying real reviewer text is
  untouched regardless of how "Wis Claude-gesprek" was reached — including the
  PRE-EXISTING transcript-`Enter` path, which needed no change of its own for
  this: the guard is purely content-based.
- **Testing the Haiku call deterministically**: `claude.Fake` only keyed
  outputs by model id, and `chat_summary` shares `ModelHaiku` with
  `pr_status`'s `generatePRSummary`/`generateSinceReviewSummary` — a plain
  `SetOutput(ModelHaiku, …)` would leak into those. `Fake.SetOutputForPrompt
  (model, systemPrompt, out)` (additive, `modules/claude/claude.go`) keys on
  model+SystemPrompt instead, checked before the plain `outputs` map — safe
  because every context-only action already carries its own distinct static
  `SystemPrompt`. `SLASH_CLAUDE_CHAT_SUMMARY` (plain string env var, not a
  JSON fixture — there is only ever one canned summary needed) programs it at
  worker-spawn time in `tasks_api.go`, mirroring `SLASH_CLAUDE_CHAT_TURNS`;
  `tests/_fixtures.mjs` sets it once for every worker, harmless for every
  other test since nothing else triggers `summarize_chat`.
- Test: `tests/claude-empty-composer-menu.spec.mjs`.

## A brand-new comment ALWAYS gets its own Claude block, even on an already-commented line

`toNew()`/`ensureClaudeAnchorForNew()` used to decide "is there already an
anchor for this draft" via `chatAnchorComment()`/`selComment()` — which
resolve to whatever comment is currently selected in the unit's scoped list,
non-null as soon as the unit carries **any** existing comment, whether or not
it has anything to do with the brand-new draft being composed. That silently
made a second "Comment op deze regel" on an already-commented line keep
showing — and appending to — the FIRST comment's Claude conversation instead
of starting a wholly separate one (explicit reviewer request: "een nieuwe
comment per regel moet een hele nieuwe comment + claude blok worden, ook als
er al een comment bestaat").

Fixed by decoupling the two questions: `toNew()` now **unconditionally**
resets `cc` (the visible chat state) to blank/idle on every open — a fresh
draft never inherits whatever conversation happened to be on screen before.
`ensureClaudeAnchorForNew()`'s own "already anchored" check no longer reads
`chatAnchorComment()` at all — it compares `claudeAutoAnchor.draftKey` against
`draftKeyFor(t)` instead, which is only ever set by this same function once it
has actually created THIS draft's own backing comment; an unrelated existing
comment on the same unit no longer matches. `chatAnchorComment()` itself is
unchanged and still correct everywhere else (`enterClaudeChat`,
`applyRelRestore`'s `'claude'` branch, `commentCard`'s "stays expanded" check)
— those only ever run while `cs.focus` genuinely sits on an existing
comment/thread/claude cursor, never while composing `'new'`.

Test: "a new comment on an already-commented line gets its own comment +
Claude block, not the existing one" in `tests/claude-chat-panel.spec.mjs` —
seeds one comment, gives its conversation real turns, opens a SECOND, brand-new
"Comment op deze regel" on the same line, and asserts the Claude column shows
an empty transcript and a send creates a distinct second comment, leaving the
first one's conversation untouched.

## `claude-chat-thread` scrolls itself to the bottom, not an ancestor

`claude-chat-thread` (`ClaudeChat.mjs`) is `overflow-auto` and is itself the
scrolling container — unlike every other `scrollIntoViewVertical` call site in
`RelatedPanel.mjs` (comment reactions, chips, tasks), which walk up to an
ancestor that scrolls. A newly appended bubble or a growing partial-progress
bubble never moved this div's own `scrollTop`, so a just-sent message (added
either optimistically by `addPendingOwnMessage` or once the transcript is
refetched — see "the reviewer's OWN just-sent text" above) could land below
the fold and stay there even after the turn finished and the progress line
disappeared again.

**`scrollClaudeThreadToBottom()`** (`RelatedPanel.mjs`, next to
`scrollClaudeMessageIntoView`) sets `el.scrollTop = el.scrollHeight` directly
on that div via `requestAnimationFrame` — no ancestor lookup, so it does not
touch the `scrollIntoView`-axis rule in `arrowjs-pitfalls.md` (that rule is
about `Element.scrollIntoView()` moving the wrong axis on an ancestor; this
sets a container's own `scrollTop`, a different mechanism entirely). Called
from the three moments new content is appended at the bottom of that div
without anything else moving its scroll position: `focusClaudeComposer`'s
`claudePos === 0` branch (right after a send), `loadChatMessages` once a
fresher transcript lands, and `applyChatProgress` (the partial bubble/"Claude
denkt…" line growing before the real message exists). A no-op whenever
`cs.claudePos !== 0` — walking older turns via `↑` must never be yanked back
to the bottom.

Test: "a just-sent Claude message scrolls into view and stays there once the
turn finishes" in `tests/claude-chat-panel.spec.mjs` — forces the thread to
overflow deterministically via an injected `max-height`, regardless of how
short the fixture replies are, and polls `scrollHeight - scrollTop -
clientHeight` after two sends.

## A full-size code-preview column

Reviewer request: "code blokken uit comments blok (+claude conversatie), als
je code examples hebt, maar dan losse blokken rechts daarvan die de code
volledig laten zien. laat het ook een diff zien (onder elkaar, oude boven,
nieuwe onder)." A fenced code block inside a comment/Claude bubble
(`markdown.mjs`'s `extractCodeFences`) sits in the narrow comment/Claude
column (half of `relatedColumnWidthCls()` each) and gets its own horizontal
scrollbar as soon as a line is wide — unreadable without scrolling
line-by-line. This is a click-driven side column that shows the same code
full-size, and — when there is a sensible unit to compare against — stacked
against the current PR code of that unit.

Four decisions (D1-D4), all made explicitly rather than assumed, since the
reviewer's own instruction left them open. **D2 and D3 were later reversed**
by a follow-up reviewer request — see "Always on, stacked in one column
(reversing D2/D3)" below — kept here verbatim for the reasoning that is still
current (D1, D4) and as the record of what changed and why. **D3 was reversed
a second time and D4's `suggestion` exclusion was dropped** — see "Always on,
stacked BELOW (reversing D3 again)" further down:

- **D1 — no real line-diff.** There is no clientside diff algorithm in this
  codebase: `Block.mjs`'s `codeDiff`/`unifiedCodeDiff` only render `rows` the
  backend already shaped from the PR's own git hunks, never two arbitrary
  strings. Vendoring/writing a diff algorithm for this one feature was judged
  out of proportion, so `CodePreview.mjs`'s `codePreviewPanel` renders two
  independently Prism-highlighted panes, stacked "Huidig (PR)" above
  "Voorgesteld (chat)" below — literally what was asked, without colour-coded
  line-level comparison. A real diff is a possible follow-up, not this one.
- **D2 — click-driven, a native `<button>`** (superseded twice: the click went
  away with "Always on" below, and the button itself was **removed** on request
  — see "The dead "Bekijk volledig" button is gone" at the end of this
  section; its data attributes now sit on the fence wrapper).
  `extractCodeFences` gave every
  non-`suggestion` fence a `data-testid="code-fence-open"` button in its
  header (`Bekijk volledig ↗`) carrying the RAW code + resolved language word
  as `data-fence-code`/`data-fence-lang` (HTML-entity-encoded, decoded back by
  the browser's own attribute parsing when read via `.dataset`) — chosen over
  a new per-fence keyboard cursor, which doesn't exist anywhere in this app
  (`cs.claudePos`/`cs.threadPos` navigate per *message*, not per *codeblock
  within* a message) and would be disproportionate for this feature. A native
  `<button>` is still reachable by Tab/Enter/Space, so this isn't purely
  mouse-only. `markdown.mjs` itself stays a pure string renderer with no
  reactive state (see its own file header), so the click is handled by ONE
  delegated listener per owning column instead — `handleFenceClick`
  (`RelatedPanel.mjs`) is wired via `@click` onto `InlineComments`' and
  `ClaudeChatPanel`'s own root elements (both already receive `commentTarget`,
  needed for D1's "Huidig" side below); a click anywhere in either column
  bubbles up and is a no-op unless it actually lands on such a button.
- **D3 — a sibling column, not a child of `comment-claude-row`** (superseded,
  see "Always on, stacked BELOW (reversing D3 again)" below — kept for the
  original reasoning). `home.mjs`
  wraps `comment-claude-row` and `CodePreviewPanel()` in one
  `flex items-start gap-3` row (`comment-claude-and-preview-row`) inside
  `comments-and-related` — the preview appears to the RIGHT of the merged
  comment+Claude card instead of stretching its height, and (since
  `comments-and-related`'s own width is auto/shrink-to-fit inside `<main>`'s
  horizontal scroll, same as every width variation already documented in
  `diff-card.md`) `<main>` simply scrolls further to show it, exactly like an
  uncapped `fit`-width diff card already does. Not built as a real drilled
  column (own rail, `←`/`→` stop, `Escape` handling) — that infrastructure is
  disproportionate for "show this one block bigger"; `cp` (RelatedPanel.mjs's
  own reactive state, mirrors `cc`/`rc`: exactly one preview open at a time)
  only opens/closes via the button/its own close (✕) button, with no new stop
  in the keyboard chain in `keyboard-navigation.md`. Resetting it on every
  navigation step was deliberately NOT added either — it simply stays open
  until closed or replaced by opening a different fence, same "last thing
  wins" rule `cc` already follows for the Claude conversation itself.
- **D4 — scope: every fence gets the button (except `suggestion`, GitHub's own
  "replace these lines" convention, not a code example — this exclusion was
  itself dropped later, see "Always on, stacked BELOW (reversing D3 again)"
  below); only a PHP-or-
  unlabeled fence AND a resolvable unit get the "Huidig (PR)" comparison
  pane.** `openCodePreview` checks `!lang || lang.toLowerCase() === 'php'`
  before keeping `oldCode` — the same "unlabeled fence defaults to php" rule
  `highlightForLang` already uses. Comparing a PHP unit's current code against
  a JSON/bash/SQL example makes no sense, so those fences still open (solving
  the readability problem) but without a "Huidig" pane.

**D1's answer to "wat is oud/nieuw"** (the reviewer's own words, verbatim
minus an evident typo): "dat wat niet is in de pr vergelijken met wat er in de
chat is voorgesteld" — the "old"/"Huidig" side is the CURRENT PR code of
whichever unit the comment/Claude panel is scoped to, the "new"/"Voorgesteld"
side is the fenced code itself. `handleFenceClick` gets that current code from
**`commentTarget()`** — the exact same live-cursor value the composer/
`claudeContextBlock` already anchor a NEW comment/the first Claude turn's
context against (see "Invisible selection context" above) — never a second,
separate anchor lookup: the comment/Claude panel is by construction always
scoped to whichever unit is currently in view. `commentTarget()` itself
already returns `null` for a PR-wide/orphan comment-index item (`b.kind ===
'comment'`, see `home.mjs`), which is exactly why such an item's fence never
gets a "Huidig" pane either — no extra branching needed in `openCodePreview`
for that case.

## Always on, stacked in one column (reversing D2/D3)

Reviewer follow-up: "'Bekijk volledig' mag altijd aan, alle blokken rechts
daarvan laten zien als comment|claude blok zichtbaar zijn" — the click-driven,
one-preview-at-a-time design above (D2/D3) is reversed. There is no
open/close cycle any more: **every** non-`suggestion` fence currently
rendered inside the comment/Claude columns gets its preview shown
automatically, for as long as `claudeChatVisible()` holds — the same
predicate that already gates `comment-claude-row`'s own visibility. D1 (no
real diff, two stacked Prism panes) and D4 (scope: every fence except
`suggestion`; only PHP-or-unlabeled + a resolvable unit gets the "Huidig (PR)"
pane) are unchanged.

- **One column, not one column per fence.** Asked explicitly (a thread with
  several fences would otherwise spawn several `w-[42rem]` columns, pushing
  `<main>`'s horizontal scroll out further per fence): `CodePreview.mjs`'s
  `codePreviewColumn` renders ONE `w-[42rem]` column, `previewCard` per fence
  stacked inside it with `flex flex-col gap-3`, each card carrying its own
  title + "Huidig (PR)"/"Voorgesteld (chat)" pane pair (`data-testid=
  code-preview-card`, keyed `'fence:' + index` off the ORIGINAL DOM/document
  order — the render order itself is recency-grouped, newest message first,
  see "Default-collapsed cards, a richer title, and per-class labels" below).
- **DOM-derived, not markdown-reparsed.** `extractCodeFences`
  (`markdown.mjs`) already stamps every non-`suggestion` fence's header with a
  `data-fence-code`/`data-fence-lang` (at the time on a `code-fence-open`
  button, now on the fence wrapper itself — see the end of this section).
  Reusing those same data attributes as the read source
  avoids a second, duplicate fence-parsing implementation in
  `RelatedPanel.mjs`: `recomputeCodePreviews` just
  `document.querySelector('[data-testid="comment-claude-columns"]')`s and
  reads every `[data-testid="code-fence"]` underneath it.
- **A `MutationObserver` drives the recompute**, not a `watch` over
  `cs.list`/`cc.messages`: a live Claude turn's streaming reply
  (`ClaudeChat.mjs`'s `p.partial`) is a separate, un-exported reactive field
  local to that module, not something `RelatedPanel.mjs` can subscribe to —
  and a fence only exists once its closing ` ``` ` has streamed in anyway
  (`extractCodeFences`' regex requires it). `ensureCodePreviewObserver`
  observes `[data-testid="comment-claude-columns"]` — the columns container,
  deliberately **not** the outer row that also holds this module's own
  `CodePreviewPanel` (a sibling further out, in
  `comment-claude-and-preview-row`) — so the preview column's own re-renders
  can never feed back into the observer that triggers them. Retried via
  `requestAnimationFrame` until the container exists (arrow.js builds the
  template before it's attached to the real DOM), then set up exactly once.
  `scheduleRecomputeCodePreviews` coalesces a burst of mutation records into
  one recompute per animation frame, and `recomputeCodePreviews` itself skips
  reassigning `cp.items` when the recomputed set is unchanged (same length,
  same code/lang/oldCode per item) — without that guard, every character of a
  streaming reply would rebuild (and re-Prism-highlight) the whole column.
- **No close button any more.** "Always on" means a reviewer can't dismiss one
  preview — it disappears on its own once the fence holding it is no longer
  rendered (comment/thread collapsed, different block selected).

**Files:** `markdown.mjs` (the button + its data attributes, now read-only —
see its own doc comment on `extractCodeFences`), `src/CodePreview.mjs`
(`codePreviewColumn`/`previewCard`, pure templates — same
no-reactive-state/no-import-of-RelatedPanel split as `ClaudeChat.mjs`/
`translationDiff.mjs`), `RelatedPanel.mjs` (`cp.items`,
`recomputeCodePreviews`, `scheduleRecomputeCodePreviews`,
`ensureCodePreviewObserver`, `CodePreviewPanel`), `home.mjs` (the mount point
next to `comment-claude-row`, now passing `commentTarget` into
`CodePreviewPanel`).

Test: `tests/code-fence-preview.spec.mjs` — an orphan comment's fence shows its
preview automatically with only the "Voorgesteld" pane; a block-scoped
comment (PR 12903, block 1) gets both panes.

## Always on, stacked BELOW (reversing D3 again), suggestion fences included

Second reviewer follow-up, quoted (translated) as "I actually want the
related blocks of a Claude conversation (right of the comment block) under
the block" plus "make sure code suggestions etc. within the conversation are
also visible the same way": the preview column above (D3, then its own
"Always on, stacked in one column" reversal) still sat as a **sibling column
to the RIGHT** of `comment-claude-row` — reversed again, this time to a
**stacked row BELOW** it, matching the placement the "Underlying code" card
(`related-code`) already has below `comment-claude-row` in the same
`comments-and-related` wrapper (see "The block column and its neighbour" in
`.claude/docs/detail-layout.md`). Two changes, both minimal:

- **Placement (`home.mjs`).** The `comment-claude-and-preview-row` wrapper
  (the `flex items-start gap-3` row that held `comment-claude-row` and
  `CodePreviewPanel()` side by side) is gone. `CodePreviewPanel(commentTarget)`
  is now an ordinary sibling **row** inside `comments-and-related`, directly
  after `comment-claude-row` and before `RelatedPanel(...)` — the exact same
  stacking spot `related-code` already occupies one row further down.
  `RelatedPanel.mjs`'s own `cp` state, `recomputeCodePreviews`, the
  `MutationObserver` on `comment-claude-columns` and `CodePreviewPanel`'s
  export are all unchanged — only where `home.mjs` mounts it moved.
- **Width (`CodePreview.mjs`).** `codePreviewColumn`'s root was
  `w-[42rem] shrink-0` (sized to sit narrow, next to `comment-claude-row`);
  now that it stacks below with nothing beside it, it takes `shrink-0` plus a
  `getWidthCls()` slot the caller supplies. A bare `w-full` (100% of the
  unconstrained, shrink-to-fit `comments-and-related` ancestor) turned out not
  to actually bound the column — an unbounded child (a long unwrapped
  `previewCard` context line) could still push that ancestor, and thus this
  "full width" column, wider than `comment-claude-row` itself (reviewer
  report: the code-preview cards spilled out past the comment/chat card's
  right edge). `RelatedPanel.mjs`'s `CodePreviewPanel(state, commentTarget)`
  now passes `commentClaudeRowWidthCls(state)` — the row's own real, bounded
  width (the same `relatedWidthCls` clamp `commentColumnWidthCls`/
  `claudeColumnWidthCls` sum to) — so its cards read as wide as, and never
  wider than, the comment/Claude card above them.
- **Suggestion fences now also get a preview (`markdown.mjs`).** D4's
  exclusion — a `` ```suggestion ``` `` fence carried no preview data at all,
  so `recomputeCodePreviews` never saw it — is dropped:
  `extractCodeFences` now stamps that data onto **every** fence, suggestion
  included. Its distinct in-bubble header ("Suggestie N", the emerald accent)
  is untouched — only the underlying full-size preview card was added, using
  the exact same "unlabeled fence defaults to PHP" path a plain unlabeled
  fence already took (a suggestion fence never announces a language, so
  `langWord` stays empty and it gets a "Huidig (PR)" comparison pane under
  the same D4 rule as any other unlabeled fence).

Test: `tests/code-fence-preview.spec.mjs` updated — asserts
`code-preview-column` renders as a sibling BELOW `comment-claude-row` (not a
sibling to its right any more) and that a `suggestion` fence now also gets a
preview card (title "Codeblok", same as
any other unlabeled fence), alongside the plain fence's existing preview.

### `↓` walks the chat's own code blocks

Reviewer request: *"als vanuit een claude chat, andere blokken zijn die te
maken hebben met de chat, dan wil ik daar doorheen kunnen gaan met mijn keys
naar beneden en naar boven"* — those "other blocks" are exactly the
code-preview cards stacked below the merged comment/Claude row, which until
now had no keyboard cursor at all (the earlier write-up above explicitly noted
one didn't exist anywhere in this app).

- **`cs.previewPos`** (`RelatedPanel.mjs`) is that cursor: `0` = not in the
  cards, `1..n` = the n-th card counted from the **TOP**, i.e. in render
  order — the recency-grouped order (below), not raw DOM order any more.
  Every other cursor in this panel (`threadPos`/`claudePos`/`claudeOptionSel`)
  counts from the bottom because those chains are walked UPWARD out of the
  composer; this one is walked DOWNWARD out of it, so counting from the top
  is the mirror-image of the same rule — `1` is in both cases the rung
  closest to the composer, and (since the reordering below) also the most
  recently generated card.
- **It is one continuous chain with the rest**, not a separate mode: `↓` at
  the rest position (`claudePos === 0 && claudeOptionSel === 0`) lands on card
  1, `↓` walks down, `↑` walks back up and hands the composer its caret
  back at `previewPos === 0`. `handleRelatedKey`'s `'claude'` branch handles
  both keys **before** the existing options/transcript rungs, so nothing about
  those changed.
- **This overrides the "no tussenstop" decision above**, on the reviewer's own
  explicit say-so: `↓` at `claudePos === 0` no longer advances to the next
  block immediately, it advances only once the cards (and the tasks rung
  below, see next bullet) are walked through. The reasoning behind the
  original decision is untouched — the **Onderliggende-code** panel is still
  skipped entirely; only the chat's own code blocks were added, and they sit
  visually right below the chat anyway.
- **`cs.claudeTasksPos` ("Andere chats in deze PR") is walked BEFORE `cs.previewPos`,
  not after** — `↓` at the rest position reaches the "Andere chats in deze PR" rows
  first (see "Where a turn on OTHER code is visible" below), then the
  code-preview cards, matching the on-screen order: that block renders
  **above** the code-preview cards, not below. It used to be the reverse
  (cards first, tasks only reachable once every card had been walked past),
  which read as "ik kan ook elders bezig pas selecteren nadat ik gegenereerde
  codeblokken naar beneden heb gedrukt" — reported bug, fixed by swapping the
  two rungs in `handleRelatedKey`'s `'claude'` branch (both `↓` and, mirrored,
  `↑`) and in `advanceFromComment`'s own entry point.
- **The highlighted card blurs the composer** (`focusPreviewCard`, the
  counterpart of `focusClaudeComposer`) so the CARD reads as focused, exactly
  like the options/transcript rungs already do, and scrolls it into view with
  `scrollIntoViewVertical` (never `scrollIntoView` itself — the axis rule in
  `.claude/rules/arrowjs-pitfalls.md`).
- **Rendering** (`CodePreview.mjs`): `previewCard(it, active)` takes the cursor
  as a **getter** and uses it in whole-value `class`/`data-active` bindings —
  deliberately NOT in `.key(it.key)`, which would tear down and re-Prism-
  highlight the whole card on every step. The active card gets the same
  `border-indigo-300`/`ring` pair as every other selected card plus a leading
  **▸** glyph on its title, so the state is carried by a shape, not only by
  colour (colourblind rule).
- **`cs.previewPos` is deliberately NOT bound to the URL**, unlike
  `cs.claudePos` (`rel.cpos`) and like `cs.claudeOptionSel`/`cs.chipPath`:
  `cp.items` is derived from the **rendered DOM**
  (`recomputeCodePreviews`' `MutationObserver`), not from loaded data, so a
  restore would need its own re-apply pass in `applyRelRestore` for what is a
  purely ephemeral highlight. `recomputeCodePreviews` does **clamp** it to the
  recomputed item count, so a fence disappearing under the cursor can never
  leave it pointing at nothing.
- **The composer's own blur must happen SYNCHRONOUSLY, not one
  `requestAnimationFrame` later** — a flaky-test postmortem
  (`tests/claude-chat-other-tasks.spec.mjs`, "the footer shows which chat is
  selected…", ~50% failure rate reproduced with `--workers=1 --repeat-each`
  on plain, unmodified `main`). `focusClaudeComposer`/`focusPreviewCard`/
  `focusClaudeTaskRow` (`RelatedPanel.mjs`) used to defer their `input.blur()`
  into `requestAnimationFrame`, purely because the original code queried/blurred
  inside the same callback that also does the (genuinely render-dependent)
  `scrollIntoViewVertical`. That left a window — up to one animation frame —
  in which the composer textarea was STILL the real DOM-focused element even
  though `cs.claudeTasksPos`/`cs.previewPos`/`cs.claudeOptionSel` had already
  reactively moved off the rest position. A keypress landing inside that
  window (Playwright's back-to-back `press()` calls hit it easily; a fast
  real keystroke can too) is dispatched with the **composer** as `e.target`,
  so `ClaudeChat.mjs`'s own `@keydown` ran FIRST — for an Enter on the still-
  empty B composer that meant its "blank field → open the Claude menu"
  branch (`stopPropagation()` and all), not `home.mjs`'s document-level
  `selectHighlightedClaudeTask()` the reviewer's `↓` had actually earned.
  Symptom: Enter right after `↓` into "Andere chats in deze PR" sometimes opened the
  wrong menu and the composer never regained focus at all, and it was NOT
  fixable by asserting a different DOM state — `cs.focus`/`cs.claudeTasksPos`
  themselves were already correct and stayed so; the bug was purely about
  which element the keydown DISPATCHED to. Fix: all three functions now blur
  the composer immediately (synchronously, at call time, right after
  `releaseFocus()`), and leave only the `scrollIntoViewVertical`/optional
  re-blur belt-and-braces inside the `requestAnimationFrame`. Verified 12/12
  clean (`--workers=1`) plus a `--workers=4 --repeat-each=3` pass and the full
  suite; the one pre-existing unrelated failure (`block-moved.spec.mjs`)
  reproduces identically with this fix reverted, so it is not this bug.
- **Rendering/cursor scope.** A fence inside a comment body gets its preview
  card exactly as before, but the cursor itself is scoped to the chat
  (`CodePreviewPanel` passes `cs.focus === 'claude' && …`) — `Enter` on a
  highlighted card toggles its in-/uitklappen state, see "Default-collapsed
  cards, a richer title, and per-class labels" below (it used to do nothing).

Test: the "↓/↑ at the bottom of the Claude chat walk the code-preview cards"
case in `tests/code-fence-preview.spec.mjs`.

### Default-collapsed cards, a title only when there is something to say, and per-class labels

Reviewer request, on top of everything above: a bare `Codeblok 1 · PHP`
header said nothing about what the block actually was, and a long-running
chat left every past code block permanently full-size, forcing a lot of
scrolling to find the one still relevant to the current answer. Three
changes, all in the same three files (`markdown.mjs`, `RelatedPanel.mjs`'s
`recomputeCodePreviews`, `CodePreview.mjs`):

- **The card title names the class(es) the snippet declares, and ONLY
  renders at all when one is detected** — `classDetail(code)`
  (`RelatedPanel.mjs`, `it.classLabel`) runs a top-level `\bclass\s+(\w+)`
  scan over the fence's own code: zero matches → `''`, one match → that
  class's name, two or more → every name in source order joined with `", "`
  (the reviewer explicitly wants the names, not a bare count — the card's own
  `truncate` class still clips an overlong line). Only classes are scanned,
  deliberately not traits/interfaces/functions. **This USED to fall back to a
  bare `Codeblok N · PHP`/`· <LANG>` header when no class was found** — a
  LATER reviewer report ("Codeblok 1 · PHP mag weg... description mag net zo
  duidelijk als in de normale chat text") removed that fallback entirely: the
  fence's own "Codeblok N"/"Suggestie N" number/word already shows on the
  SAME fence's inline badge in the chat bubble directly above the card
  (`markdown.mjs`'s `fenceLabel`/`data-fence-label`), so repeating it here was
  pure clutter with no information of its own — a card with no detected class
  now shows no title line at all. The `▸` "this card is under the ↓/↑
  cursor" marker used to live glued to that same title text, then became its
  own always-mounted `data-testid=code-preview-active-marker` span next to
  (not inside) the conditional title so it still rendered even on a
  title-less card — **later removed entirely** (reviewer request, "stipje
  bovenin kan dan weg", alongside the icon-only expand button below): the
  border/ring pair every active card already gets is enough of a shape cue
  on its own, so the separate marker glyph was redundant. The "over: …"
  context line
  (`data-testid=code-preview-context`, below) also switched from a small
  muted `text-[11px] text-slate-400` to the SAME size/colour ordinary chat
  bubble text uses (`text-xs leading-relaxed text-slate-700`/`dark:text-zinc-300`)
  — same reviewer report, "as clear as normal chat text". The collapse
  toggle's visible label text ("Inklappen"/"uitklappen (Enter)") is gone too,
  first replaced with a neutral chevron glyph (`▾`/`▸`, same convention as
  `testsBar`'s expand chevron elsewhere in this file), and later — a further
  reviewer follow-up ("uitklap ding... kan helemaal weg") — the glyph itself
  removed too: there is no visible collapse affordance left at all. The click
  target moved from that small button onto the card's own header row (the
  title + context block, still `data-testid=
  code-preview-toggle`, `cursor-pointer`), with the Dutch wording surviving
  only as its `title` tooltip. This click had to keep working, not just stay
  as a convenience alongside `Enter`: a fence embedded in a plain PR-comment
  thread (`cs.focus === 'comment'`) has NO keyboard route to a code-preview
  card at all — `cs.previewPos` only ever moves while `cs.focus === 'claude'`
  (`handleRelatedKey`, `RelatedPanel.mjs`) — so for that case the header click
  is the ONLY way to reach the other state.
- **A short snippet of the chat text that sat directly above the fence** is
  shown as a second, muted line under the title (`data-testid=
  code-preview-context`) — "over: …". `markdown.mjs`'s `extractCodeFences`
  tracks where the previous fence ended and slices the text in between.
  Stored as a new `data-fence-context` attribute on the same `code-fence`
  wrapper the code/label/lang attributes already live on (empty → attribute
  omitted, e.g. a fence that opens a message with nothing above it). See
  "Truncate the context line only when collapsed" below for how (and how much
  of) it gets visually clipped, and "Every piece of a message's text is
  reachable from some card" below for the FULL-gap behaviour this grew into
  later (it originally kept only the last paragraph of that slice).
- **A card not belonging to the LAST answer starts collapsed** (title +
  context line only, no code at all — not even a one-line teaser, reviewer's
  explicit choice) — `Enter` on the focused card, or a click on its own
  header row (`data-testid=code-preview-toggle`, see above — was a text
  "Inklappen"/"uitklappen (Enter)" button, then a bare chevron button, same
  wording convention as `prInfoCard`'s `toggleSinceExpanded`), toggles it.
  "Last answer" is decided per fence's nearest
  `[data-testid="claude-message"], [data-testid="comment-item"]` ancestor
  ELEMENT (compared by identity, not by message id) against the very last
  fence's own ancestor — a fresh Claude reply (or a new/edited comment)
  containing a fence demotes every older card to collapsed on its next
  recompute. `RelatedPanel.mjs`'s `cp.expandedOverride` (a plain `key -> bool`
  map, reassigned wholesale like `cp.items` itself, never mutated in place)
  holds a manual override so a toggle survives an unrelated recompute;
  `isPreviewExpanded(it)` falls back to `it.isLast` when there is no override
  yet. `toggleCodePreviewExpanded(key)` is exported for both the header row's
  `@click` and `home.mjs`'s `Enter` branch (`activeCodePreviewKey()`, reading
  `cs.previewPos` so home.mjs itself never has to import `cs`).
  **`key` must be STABLE across a recompute, not the fence's raw position**
  (bug report: "eerder had ik iets anders ingeklapt, dat moet niet effect
  hebben op andere blokken" — collapsing one card visibly collapsed a
  DIFFERENT, unrelated one instead). It used to be the bare loop index
  (`'fence:' + i`) into `fences` — but `next` is re-sorted right after being
  built ("most-recently-generated … renders at the TOP", below), so a fresh
  message/comment with its own fence arriving reshuffles which fence sits at
  which index; `cp.expandedOverride`, keyed by that same index string, then
  silently applied to whichever fence happened to land there next, not the
  one the reviewer actually toggled. Fixed by keying each fence on
  `containerKey(container) + ':' + localIdx` — the owning message/comment's
  own stable id (`data-message-id` on `claude-message`, added for this;
  `data-comment-id` already existed on `comment-item`, prefixed `m`/`c` so
  the two id spaces can't collide with each other) plus the fence's own
  position AMONG that container's fences (stable, since one message/comment's
  body never reorders itself). Falls back to the old index-based key only
  when no ancestor at all is found (not expected in practice).
- **A snippet spanning 2+ classes gets a label above EACH class's own code**,
  not just in the title — reviewer's own follow-up, "ook boven elke stukje
  code (als dat kan)". `CodePreview.mjs`'s `splitCodeByClasses(code)` is a
  deliberately conservative, best-effort split: a plain top-level
  `class Name … {` scan with a string-literal-aware brace-depth counter to
  find each class's own closing `}`. It returns `null` (render as today, one
  plain pane, no per-segment labels) rather than guess, whenever: fewer than
  2 top-level classes are found (the title already names the one class);
  a class's opening brace has no matching close within the snippet (a
  truncated/partial body); two classes' regions would overlap (a `class`
  token found INSIDE a previous class's own body — a nested/anonymous class,
  or a trait/interface sitting between two classes — is silently folded into
  the surrounding segment instead of getting its own label). PHP heredoc/
  nowdoc (`<<<EOT … EOT`) is not recognised at all; a stray `{`/`}` inside one
  most likely trips the "unbalanced" bail rather than mis-segmenting, which
  is the safe direction but is a known, accepted gap. Applied only to the
  primary code pane (`it.code`, "Codeblok"/"Voorgesteld (chat)") — not to
  `it.oldCode`'s "Huidig (PR)" comparison pane, which always comes from one
  already-known PR unit and is not expected to ever span multiple classes.
- **Two arrow.js shape rules worth calling out** (see
  `.claude/rules/arrowjs-pitfalls.md`): `pane()`'s body slot is ALWAYS a keyed
  array (one entry when there are no class segments, N when there are) —
  never a bare single element in one case and an array in another, since the
  SAME `pane()` call site renders both shapes across different fences. Each
  segment's own class-label toggle (`segmentBlock`) sits inside a stable
  `<div class="contents">` root as a nested `${() => …}` function binding,
  never as that node's entire keyed body — the same two pitfalls the
  "Default-collapsed cards" bullet above and `stepChevronSlot` already work
  around elsewhere.

### A collapsed card's own affordance is back — a labelled button, not the removed chevron

The chevron-less, click-anywhere header from the section above turned out to
be TOO quiet: reviewer report (screenshot) — "onder de chat en comment blok
komen dezelfde teksten opnieuw in blokken maar dan groter, die zijn ingeklapt
als er nieuwe thread dingen zijn gekomen, dus die moeten duidelijk zijn dat
het ingeklapt is" — a card demoted to "not the last answer" (see "A card not
belonging to the LAST answer starts collapsed" above) reads as plain,
unremarkable text; `cursor-pointer` plus a hover-only `title` tooltip
("Uitklappen (Enter)") gave no visible cue at all that there was more to see,
or how to get to it.

`CodePreview.mjs`'s `previewCard` now renders a small, clearly visible
button — `data-testid="code-preview-expand-btn"` — directly below the
(possibly CSS-truncated) context line, but ONLY while `!expanded()`. It
originally carried a labelled word, **"Blok ingeklapt — klik om uit te
klappen"**, plus a `▾` glyph (colourblind rule: the word carries the meaning,
the glyph is decoration). A further reviewer request ("vervang [de tekst] met
een pijltje naar beneden") dropped the on-screen word entirely — the button
is now icon-only (a bare `▾`), with the former label text preserved as its
`title`/`aria-label` instead, so it stays accessible/discoverable without a
visible word. It is a SIBLING of the `code-preview-toggle` header block, not
nested inside it, so its own `@click` (still `stopPropagation`-first, this
file's established habit, even though the click can't actually reach the
header here) calling `onToggle(it.key)` is the only handler that fires. No
symmetrical "collapse" button once expanded — the header's own click-to-toggle
(unchanged, still the only way to collapse a card again) already covers that
direction; the reviewer's request was specifically about discoverability of
the COLLAPSED state, not about undoing the earlier "uitklap ding... kan
helemaal weg" removal for the expanded one. The same reviewer request also
removed the separate `code-preview-active-marker` glyph (see "Default-collapsed
cards…" above) as redundant now that the collapsed-card affordance is a
glyph of its own. Test: the `code-preview-expand-btn` assertions in
`tests/codeblock-card-collapse.spec.mjs` (including the `title`/`aria-label`
check).

Test: `tests/codeblock-card-collapse.spec.mjs`.

### A pending-edits card: links to what the latest chat-driven edit touched — REMOVED

Reviewer request: *"als je iets hebt aangepast doordat de chat dat doet met
claude, laat een blok eronder zien met linkjes naar de plekken wat is
aangepast"*. Built as a summary card (`kind: 'edits'`, "✎ Aanpassingen van
Claude · N"), prepended above the ordinary code-preview cards, linking to
every block touched by the latest not-yet-pushed chat edit
(`state.pendingPush.files`), with its own nested `↓`/`↑` link cursor.

**Removed on a later reviewer request** ("Aanpassingen van Claude blokje mag
weg") — display/navigation only, taken out in full: `pendingEditsItem`,
`combinedPreviewItems` (calls to `cp.items` directly again),
`cs.editLinkSel`, `selectHighlightedEditLink`, `setEditsJumpCallback`/
`jumpToPendingEditBlock` (`RelatedPanel.mjs`/`home.mjs`), and
`previewCard`'s `kind === 'edits'` branch plus `pendingEditLink`/
`pendingEditLinks` (`CodePreview.mjs`). `tests/pending-edits-card.spec.mjs`
removed; `tests/codeblock-card-collapse.spec.mjs` lost the one regression
test whose only available way to shrink `cp.items` from 2 to 1 was this
card disappearing (see that file's own note where the test used to be).

**Deliberately untouched**, since this card only ever READ from it:
`state.pendingPush`/`pendingPushFiles()` (`home.mjs`), the `⇧ ongepusht`
pill, `pushTodoRow`, and everything else in `.claude/docs/pending-push.md`
— the pending-push mechanism itself (landing, the push step, the read
model) is a separate feature this card merely surfaced navigation links
into.

### Three follow-up reviewer reports on the cards above: scroll, truncation, order

Screenshots this time, not just typed reports. All three land in
`RelatedPanel.mjs`/`CodePreview.mjs`/`markdown.mjs`, no other files.

- **The selected card must always stay in view, including on ↑.**
  `focusPreviewCard()` used to call `scrollIntoViewVertical(el)` — "nearest
  edge" scrolling, fine for a short row but not for a card that can be much
  taller than the scroller once expanded (a full pane of code): depending on
  which direction the cursor came from, the OTHER edge — including the
  card's own selection border/title, the part that actually shows "where is
  my selection" — was left off-screen. Switched to `alignToTopVertical(el)`,
  the exact same fix already applied to comment cards/Onderliggende-code
  children (`scrollCommentIntoView`/`scrollCodeIntoView`, same file, same
  "a card selected below the fold otherwise stays half out of sight"
  reasoning) — it unconditionally scrolls the selected card's TOP to the
  scroller's top rather than only nudging the nearest edge into view.
  `focusClaudeTaskRow()` (single-line rows, never tall) is untouched.
- **Truncate the context line only when collapsed, and only via CSS.**
  Reviewer report: the `over: …` line was cut off well short of a wide
  card's actual right edge, and the cut showed even on an EXPANDED card.
  Root cause: `markdown.mjs`'s `fenceContext()` hard-cut the text at a fixed
  80 characters and appended its own `'…'` — a character-count cut has no
  idea how wide the card ends up being, so the `'…'` almost never lands
  flush against the real edge. That fixed cut (and its own `'…'`) is gone;
  `fenceContext` now only strips Markdown decoration and keeps the last
  paragraph, capped at a generous `FENCE_CONTEXT_SAFETY_MAX` (400 chars, no
  `'…'` of its own) purely as a defensive backstop against a pathological
  wall of text with no blank line anywhere above the fence — not the design
  truncation mechanism. The VISIBLE clipping is CSS `truncate`
  (`text-overflow: ellipsis`) in `CodePreview.mjs`'s context `<span>`, now a
  whole-value `class="${() => …}"` binding (per the "mixed literal+dynamic
  attribute value" rule in `arrowjs-pitfalls.md`) that only adds `truncate`
  while `!expanded()` — an expanded card shows the full text (wrapping
  normally), so the ellipsis only ever appears on a collapsed card, and
  always exactly at that card's own real edge.
- **Every piece of a message's text is reachable from some card** (reviewer
  request: "dus alles moet ik terug kunnen vinden in de gegeneerde blokken").
  Two gaps used to be silently dropped: the text before the FIRST fence of a
  message was cut to only its last paragraph (`fenceContext` used to
  `split(/\n\s*\n/)` and keep the last entry, losing everything written
  earlier in a longer message — reviewer report, screenshot: a card only
  showed a short "heeft:" instead of the paragraph that led up to it), and
  the text AFTER the last fence of a message had no card at all, so it was
  simply never shown anywhere. Fixed by making `fenceContext(raw)` return the
  FULL (trimmed) text of whatever gap it is given — no paragraph-split, no
  heading/bullet stripping, no whitespace collapsing (the result goes through
  `renderMarkdown`, which already understands headings/lists/blank lines, so
  collapsing them first would only lose structure) — chosen over keeping
  "last paragraph only" for the gaps BETWEEN two fences: the reviewer's own
  clarification was that the most literal reading covers every gap, not just
  the first/last one, so a message with 3+ fences also keeps its full
  in-between text recoverable, not just a truncated snippet of it.
  `extractCodeFences` now also computes, for the LAST fence of a message
  only, the text after it via this same function, stored as a new
  `data-fence-trailing` attribute (empty → attribute omitted, exactly like
  `data-fence-context`). `CodePreview.mjs`'s `previewCard` renders
  `it.trailing` (when present) as one more line below the code pane(s),
  inside the same card, via `renderMarkdown` — same styling as the context
  line above the code. `FENCE_CONTEXT_SAFETY_MAX` grew from 400 to 4000
  chars to match (still a defensive backstop only, not the design mechanism —
  see "Truncate the context line only when collapsed" above).
- **Two cards from the SAME message get a dashed divider instead of a gap; a
  different message keeps the ordinary gap.** Reviewer request: "de blokken
  die uit dezelfde message komen, moeten … gescheiden worden met een
  horizontale stippellijn, voor de rest mogen die aan elkaar plakken" — a
  single message's own 2+ fences (e.g. the "only a suggestion fence…" test's
  ordinary-fence-then-suggestion-fence body) should visually read as one
  group, a NEW message should still read as its own separate block, exactly
  as before. `recomputeCodePreviews` already grouped fences by container for
  the "most-recently-generated group on top" sort just below; it now also
  stamps each item with `it.groupWithPrev` (true when the item right before
  it in the SORTED order shares that same group), computed from the same
  `_groupRank` the sort itself just assigned, right before that field is
  discarded. `CodePreview.mjs`'s `codePreviewColumn` dropped its uniform
  `gap-3` between every card in favour of an explicit `mt-3` per card
  (skipped when `groupWithPrev`) plus a `groupDivider()` — a bare dashed
  `border-t` `<div>`, shape not colour, per the colourblind rule — inserted
  right before a grouped card instead. A fence with no comment-item/
  claude-message ancestor at all (the pre-existing defensive fallback, not
  expected in practice) shares one `groupWithPrev` bucket with every other
  such orphan fence, same as it already shared one sort rank with them.
  Tests: `tests/code-fence-preview.spec.mjs` ("a message with code examples
  shows its full leading/middle/trailing text, and a dashed divider between
  two cards from the same message", "two cards from different messages get
  no dashed divider between them").
- **Most-recently-generated code block renders on TOP, not at the bottom.**
  Reviewer report: a long conversation buried the newest (and, per the
  bullet above, the only DEFAULT-EXPANDED) card at the bottom of an
  ever-growing stack of collapsed older ones. `recomputeCodePreviews` now
  groups fences by the SAME nearest-container lookup `isLast` already uses
  (`[data-testid="claude-message"], [data-testid="comment-item"]`), then
  stable-sorts the GROUPS newest-first — never reordering the fences WITHIN
  one group, so a single message with 2+ fences (e.g. the existing "only a
  suggestion fence…" test: one comment body, an ordinary fence followed by a
  `suggestion` fence) keeps them in their own authored order; only whole
  messages/comments reorder relative to each other. `cs.previewPos` still
  counts "1..n from the top" exactly as before — top is now the most
  recent group instead of the oldest, so `1` (the rung closest to the
  composer) is also the newest card. `key: 'fence:' + index` still comes
  from the ORIGINAL (pre-sort) DOM index, so a given fence's identity survives
  the reorder across recomputes.

Test: the extended scenario in `tests/codeblock-card-collapse.spec.mjs` (now
also asserting card order and the scroll/truncation behaviour above).

### `↓` from the bottom of a COMMENT also walks those same code blocks first

Reviewer follow-up, on the exact same unit's cards as above: *"als ik in een
comment naar beneden ga, en er zijn code blocks gegenereerd door de chat, dan
wil ik ook eerst door die code blokken heen, net als dat ik vanuit de chat naar
beneden ga."* Before this, `advanceFromComment()` (`RelatedPanel.mjs` — `↓` at
the bottom of the last comment conversation, or at `threadPos === 0`) jumped
straight to `enterRelated()` (stop 6) whenever there was no next conversation,
skipping the chat's own code-preview cards entirely — a reviewer had to
explicitly step `→` into `'claude'` first to reach them.

`advanceFromComment` now checks `codePreviewCount() > 0` in that same spot: if
the unit's Claude conversation has code-preview cards, it sets `cs.focus =
'claude'`, `cs.previewPos = 1` and calls `focusPreviewCard()` — landing on the
FIRST card exactly as `↓` from the chat's own rest position already does.
Everything downstream is untouched: this only changes the entry point, not the
chain itself (further `↓`/`↑` inside `'claude'` behaves exactly as documented
above, including the top-level "skip stop 6, advance to the next block" rule
once the cards are exhausted). With no code-preview cards, `advanceFromComment`
falls through to `enterRelated()` exactly as before.

Test: the "↓ from the bottom of a comment thread walks its Claude
conversation's code blocks before advancing" case in
`tests/code-fence-preview.spec.mjs`.

### Inside a DRILLED column, `↓` past the last card stays in that column

The top-level "skip stop 6 entirely, advance to the next visible block"
decision above is explicit and TOP-LEVEL-ONLY. Reported bug, inside a drilled
column (`state.focusLevel > 0`): exhausting a drilled unit's own code-preview
cards and pressing `↓` once more jumped the TOP-LEVEL sidebar selection
(`advanceToNextBlockFromClaudeChat`, `home.mjs`, ignored
`state.focusLevel`/`state.drill` entirely) — landing on an unrelated block
elsewhere in the PR instead of the drilled unit's own next Underlying-code
child (e.g. `FindFirstSessionActivity::run`, rendered right below
`SessionFlow::run`'s own Claude conversation and code-preview cards, connected
by the usual drill-hint chip connector).

There is no meaningful "next block in the sidebar" once you're this deep — the
reviewer is reviewing THIS unit's own call graph — so `home.mjs`'s `'advance'`
handling now branches on `state.focusLevel`: `0` still calls
`advanceToNextBlockFromClaudeChat()` unchanged; `> 0` calls
**`enterRelatedFromClaudeChat()`** (`RelatedPanel.mjs`) instead, which continues
into that SAME drilled column's own Onderliggende-code panel (`enterRelated()`,
landing on its first child) rather than touching the top-level selection at
all.

**`↑` from that first child returns to the exact card just left, not an
ordinary comment-tail landing.** `enterRelatedFromClaudeChat()` marks a small
module-local flag, `codeFromClaudeTail` (plain state, not reactive — mirrors
`rangeComposeItems`'s own shape) — consumed exactly once by the `cs.focus ===
'code'`, `codeSel === 0` `ArrowUp` branch, which then steps back into
`'claude'` at its own tail instead of `enterCommentsTail()`/`exitRelated()`.

**The previewPos to restore is captured EAGERLY, at the moment
`enterRelatedFromClaudeChat()` runs — not re-read later when `↑` is actually
pressed.** Entering `'code'` collapses the comment card back to its compact
rendering (`commentCard`'s own expanded-iff-`cs.focus`-is-`comment`/`thread`/
`claude` rule), which drops its fence(s) out of the DOM — so
`recomputeCodePreviews`' `MutationObserver` empties `cp.items` shortly after,
asynchronously, on its own `requestAnimationFrame`. A `codePreviewCount()` read
made later (once the reviewer has actually walked into Underlying code and
pressed `↑`) reliably reads `0` by then, which would always send them back to
the empty composer instead of the card they left. `codeFromClaudeTailPreviewPos`
is that eager read, taken synchronously inside `enterRelatedFromClaudeChat()`
itself, before `enterRelated()` flips `cs.focus` away from `'claude'` — same
synchronous-call-stack ordering trick as everywhere else `cs`/`cc` gets read
right before a focus transition changes what it means.

Test: the "↓ past a drilled column's own Claude code blocks stays inside that
column's Underlying code, and ↑ returns to the same card" case in
`tests/code-fence-preview.spec.mjs`.

## "Huidig (PR)" only for a `suggestion` fence (sharpening D4)

Reviewer report: "huidig en voorgesteld klopt niet echt als het niet een
```suggestion blok is. ik wil wel die 2e code daar zien, maar wat nu bij Huidig
PR staat, is niet nuttig." D4 gave the comparison pane to every PHP-or-
unlabeled fence, and a `suggestion` fence is unlabeled by definition — so an
ORDINARY php/unlabeled fence got it too, stacking the anchored unit's current
code (possibly a YAML line, possibly an unrelated method) under "Huidig (PR)"
above a chat snippet under "Voorgesteld (chat)". Two unrelated things, framed
as a before/after.

- **`recomputeCodePreviews` (`RelatedPanel.mjs`) now requires
  `data-fence-suggestion="true"`** on top of D4's existing conditions (PHP or
  unlabeled + a resolvable `commentTarget()` unit). Everything else about D4 is
  unchanged.
- **An ordinary fence keeps its full-size pane** — explicitly requested, that
  code is the whole point of the preview column — it just renders as the single
  "Codeblok" pane `CodePreview.mjs` already had for the no-comparison case
  (`oldCode == null`), never as "Voorgesteld (chat)" without a counterpart.
- **The card title is now the fence's own label**, `data-fence-label`
  ("Codeblok 3"/"Suggestie 2", straight from `fenceLabel` in `markdown.mjs`),
  with the announced language appended (`Codeblok 3 · SQL`). It used to be just
  the uppercased language or the bare word "Codeblok", so the card and the
  inline badge named the same block differently — and the running number is the
  ONE handle a reviewer has on a fence (see "Codeblok numbering diverges from
  chat context (on purpose)").

Test: `tests/code-fence-preview.spec.mjs`'s "only a suggestion fence gets the
\"Huidig (PR)\" comparison pane" — one body with both fence kinds, asserting
one pane on the ordinary one and both on the suggestion.

## The dead "Bekijk volledig" button is gone; the wrapper carries the data

Once the preview column became always-on (the two reversals above), the
`code-fence-open` button in every fence header still said "Bekijk volledig ↗"
but did nothing at all — a click target with no click. Removed on explicit
request ("bekijk volledig knop moet weg, geen actie nodig"). The only thing it
still did was CARRY data, so that moved one level up:

- `extractCodeFences` (`markdown.mjs`) puts `data-fence-code` (always the FULL
  raw code, never the truncated inline copy) next to the pre-existing
  `data-fence-index`/`data-fence-lang`/`data-fence-suggestion`/
  `data-fence-truncated` on the fence's own
  `<div data-testid="code-fence">` wrapper. Nothing is rendered in the header
  beside the label + language word any more.
- `recomputeCodePreviews` (`RelatedPanel.mjs`) walks
  `[data-testid="code-fence"]` instead of `[data-testid="code-fence-open"]`.
  Same reading order, same data, one element less.

**Don't reintroduce a button to carry data**: the wrapper already exists, is
already the element the preview walks, and a rendered button that isn't a
control is exactly what the reviewer asked to get rid of.

## A "Kopieer" button IS reintroduced later — a real control, not a dead data-carrier

Reviewer request: "maak een copy knop in alle codeblok dingen die uit een
check of comment komt. die kan je dan rechts in dit balkje plaatsen" — the
slim header bar every fence already has (label + language word on the left,
`justify-between` leaving the right side empty) gets a small "Kopieer" button
on that right side. This does not contradict the "don't reintroduce a button"
rule right above it — that rule is about a button with no action (the old
"Bekijk volledig" once the preview column went always-on); a copy action is a
genuine control.

Two render points share one mechanism, `src/codeCopy.mjs`:

- **`markdown.mjs`'s inline fence header** (`extractCodeFences`,
  `data-testid="code-fence-copy"`, both the ordinary and the `suggestion`
  emerald header variant) — raw HTML string, so the click is handled by
  `initMarkdownCodeCopy()`, ONE document-level delegated listener (called once
  from `home.mjs`, same shape as `imageLightbox.mjs`'s `initImageLightbox`)
  matching a click on that testid and reading the fence's full raw code off
  the ancestor `[data-fence-code]` wrapper — the exact same attribute
  `recomputeCodePreviews` already reads (see "The dead 'Bekijk volledig'
  button" above), so no new data plumbing was needed.
- **`CodePreview.mjs`'s `pane()` header** (`data-testid="code-preview-copy"`)
  — a real arrow.js template, so a plain `@click` calling
  `copyCodeToClipboard(e.currentTarget, code)` is enough; `stopPropagation`
  first, per the nested-`@click` ordering rule in arrowjs-pitfalls.md
  (this pane sits inside `previewCard`'s own click-to-toggle header). Added to
  every `pane()` call uniformly (both the "Huidig (PR)" and "Voorgesteld
  (chat)"/single "Codeblok" panes) — `pane()` is only ever used inside this
  comment/chat-derived preview card, never elsewhere.

**Feedback is the button's own label swapping "Kopieer" → "Gekopieerd!"**
(reusing the `'Gekopieerd!'` i18n key `overview.mjs`'s copy-URL button already
established for this exact pattern) for 1.5s, then reverting — a WORD, not a
colour change, per the colourblind rule. Applied via a direct DOM
`textContent`/attribute write on the clicked button (`flashCopied` in
`codeCopy.mjs`) rather than through arrow.js reactive state: the
`markdown.mjs` button has no arrow.js binding to hang state off at all (it's
a plain string in an `.innerHTML` blob), so both call sites share the exact
same mechanism instead of inventing a second one for the arrow.js side.

**Deliberately excluded: `Block.mjs`'s diff code panes.** Those show the PR's
own diff code, not something "uit een check of comment" — copying that is a
different, pre-existing feature (`copySelectedCode`/"Kopieer deze regel",
`home.mjs`).

Test: `tests/code-fence-copy.spec.mjs`.

## The INLINE fence is capped to ~2 lines, faded — the full code is already below

Reviewer follow-up, once the preview card above always shows the full code
below the comment/Claude column: "code bloks in een communicatie, graag
maximaal 2 rijen, de rest staat er al onder als referentie" — the fence
rendered INLINE inside a comment/Claude bubble no longer needs to show the
whole block, since it is fully duplicated in the preview card underneath.

- **`markdown.mjs`'s `extractCodeFences(text, store, startIndex, truncate)`**
  gained a fourth parameter. When `truncate` is on and a fence has more than 2
  source lines, only the first `INLINE_MAX_LINES` (3) lines are fed to
  `highlightForLang` for the visible `<pre>` — 2 full lines plus one more that
  carries the fade (below). Everything beyond that is not rendered inline at
  all (not just visually hidden) — it exists only in the preview card. A fence
  of 2 lines or fewer is completely unaffected (no point capping something
  already short).
- **`data-fence-code` always carries the FULL, untruncated raw code**,
  regardless of `truncate` — that attribute is `recomputeCodePreviews`'s only
  data source for the preview card (see "Always on, stacked in one column"
  above), so shortening it there would shorten the preview card too, which is
  exactly the opposite of the point (the preview card is the place the full
  code is supposed to live).
- **No "+N regels meer" text.** Explicitly rejected in favour of a purely
  visual cue: the last visible line fades to transparent via a `mask-image`
  gradient (`code-fence-fade-bottom`, `index.html`) — a static class here
  rather than JS-toggled (unlike `src/scrollFade.mjs`'s `updateScrollHints`
  chevrons) since a truncated fence is truncated for its whole lifetime,
  nothing to react to. This is a shape/mask signal, not colour-only, per the
  colourblind rule.
  `isLong` also stamps `data-fence-truncated="true"` on the fence's wrapper
  `<div>` for tests/future tooling to key off, alongside the fade class on the
  `<pre>` itself.
- **`truncate` is opt-in per call site, default `false`** — only where a
  full-size preview card actually exists to point at:
  `RelatedPanel.mjs`'s `commentBody` (every comment/reply/reaction bubble) and
  `ClaudeChat.mjs`'s three body renderers (`claudeMessageBody`, the partial
  streaming bubble, a still-open question's own body). **Not** `home.mjs`'s
  `prInfoCard` (the PR summary/description) — it does not sit next to a
  code-preview column, so it keeps the pre-existing, untruncated rendering
  via the default.

Test: `tests/code-fence-preview.spec.mjs` (or a sibling spec) asserts a
>2-line fence renders truncated (a `<pre>` with fewer lines than the source,
carrying `code-fence-fade-bottom`) inline while its preview card below still
shows the full code.

## A preview card only shows for a fence inside the FOCUSED comment card

`compactConversation` (the collapsed summary rendered for every comment card
that isn't currently focused, see its own doc comment in `RelatedPanel.mjs`)
still runs its body through `commentBody`/`renderMarkdown`, so a fence's
`<div data-testid="code-fence">` wrapper — `data-fence-code` and all — is
genuinely present in the DOM even while the card is collapsed; `line-clamp-3`
only clips it visually. Left as-is, `recomputeCodePreviews` (see "Always on,
stacked in one column" above) picked that fence up too, so a "Suggestie
N"/"Codeblok N" preview card appeared for a `↑`/`↓`-selected-but-not-yet-opened
comment index item — see "A block-anchored index item auto-expands its block…"
in this doc/`.claude/docs/comments-panel.md` for the navigation state (a
selected comment's block auto-expands, but the comment card itself only
expands once the keyboard actually moves into it via `→`) that made this
visible: the reviewer saw a full "Suggestie 1" card for a comment they hadn't
opened yet.

**Fix:** `recomputeCodePreviews` filters `[data-testid="code-fence"]` matches
by `el.closest('[data-testid="comment-item"]')` — both `compactConversation`
and `expandedConversation` stamp that testid plus `data-expanded="false"`/
`"true"` on their own root — and only keeps a fence whose nearest such
ancestor is expanded, or has none at all (a Claude chat bubble, which has no
compact/expanded state and always shows its fences). Switching a card between
compact and expanded replaces the whole subtree (different templates), which
is already a `childList` mutation the existing `MutationObserver` picks up —
no new observer config needed.

## A stale, cut-off card from the live streaming answer

Reviewer report (screenshot): a code-preview card's trailing text abruptly
stopped mid-sentence ("Eén ding om te checken vo…") even though the chat
bubble right above it already showed the full, final answer. Root cause: the
live streaming answer (`claudePartialBubble`, `ClaudeChat.mjs`, `data-testid=
"claude-partial"`, see "Live progress" above) is deliberately kept mounted
for a moment AFTER the real, complete message has already landed — "Keep the
partial visible for a moment so the bubble doesn't blink out before the real
message has been refetched" (the `chat.progress` handler, `RelatedPanel.mjs`)
— a genuine overlap window, not a race. A fence inside that partial is, by
definition, mid-stream and therefore truncated, but `recomputeCodePreviews`
had no filter against it, so it could contribute its own stale preview card
— or even take the position the real message's card should have had.

**Fix:** `recomputeCodePreviews` now also excludes any fence whose nearest
`[data-testid="claude-partial"]` ancestor exists, mirroring the existing
`comment-item`/expanded filter right above this section. The partial is
explicitly "a THROWAWAY render of throwaway data… never part of the message
list" (its own doc comment), so it must never contribute a preview card —
the real message's fence always supersedes it, and the exclusion is
unconditional (it doesn't matter whether the turn is still `running`).

Also fixed defensively, matching the established convention in
`.claude/rules/arrowjs-pitfalls.md` ("Never key a template whose entire body
is one toggling expression"): `claudePartialBubble`'s mount site
(`ClaudeChat.mjs`) now wraps the call in a stable `<div class="contents">`
root instead of interpolating `${() => claudePartialBubble(view)}` bare — the
function's own body IS one toggling expression (`if (!p.partial) return ''`,
else a template), the exact shape that pitfall entry warns leaves an
orphaned/corrupted DOM fragment behind once toggled to `''`.

Test: `tests/code-fence-preview.spec.mjs` ("a truncated streaming partial
answer never leaves a stale, cut-off code-preview card once the real message
has landed") reproduces the overlap entirely via mocked network — the real
transcript GET plus the ONE `GET /api/chat/progress?commentId=` resync read
`loadChatProgress` fires the moment the conversation opens — deliberately
NOT via a mocked SSE stream: an earlier version of this test mocked
`/api/events` instead, and the EventSource's own reconnect timing made the
extra stale card flap in and out non-deterministically between runs (a
repeated remount/teardown cycle of the very bug being tested), so the
one-shot resync read is both simpler and actually deterministic.

## Afbeeldingen meesturen (paste, sleep, of de paperclip)

Reviewer request, verbatim: "zorg ervoor dat ik ook afbeeldingen in de chat kan
meegeven. zo kan ik soms een afbeelding vanuit clipboard hebben of een
afbeelding slepen vanuit finder". Eén mechanisme voor **beide** chats die
bestaan — de review-tree (`/pr/<id>`: de chat-kolom én de general-chat-overlay)
en de planpagina (`/plan/<KEY>`) — want die twee verschillen alleen in
**welk Signal** de ids uiteindelijk meerijden, niet in hoe het bestand wordt
opgeslagen of getoond.

### De keten in één blik

1. **Composer** (`src/ClaudeChat.mjs`, gedeeld door beide pagina's): een
   `@paste` op de textarea (alleen wanneer `clipboardData.files` een
   afbeelding bevat — een gewone tekst-paste valt ongemoeid door), een
   `@dragover`/`@drop` op de **hele kaart** (`claude-chat-card`, niet alleen
   het invoerveld: slepen vanuit Finder landt zelden precies op een
   éénregelig veld), plus een paperclip-knop (`chat-attachment-add`) die een
   verborgen `<input type=file>` opent — de enige route voor wie
   toetsenbord-first werkt. Tijdens het slepen verschijnt
   `chat-attachment-drophint`: een **gestreepte rand plus het woord** "Laat
   los om de afbeelding toe te voegen" — nooit kleur alleen (de reviewer is
   kleurenblind), zelfde regel als `scrollHint`/`stepChevron`.
2. **Upload** (`src/chatAttachments.mjs`): per bestand één
   `POST /api/workflows/chat_attachment` met base64. De thumbnail staat er
   meteen (een lokale object-URL), met het **woord** "uploaden…" zolang hij
   onderweg is en "mislukt" als het misging.
3. **Opslag** (`chat_attachment.go`): de `chat_attachment`-workflow — één
   Activity, geen signals, geen klok, geen loop, dezelfde
   strikt-one-shot-vorm als `whisper_model`. Hij decodeert, controleert de
   **magic bytes** (de door de browser geclaimde MIME en de bestandsnaam
   worden nooit vertrouwd) en schrijft naar
   `<appDataDir>/chat-attachments/<conversatie>/<sha256>.<ext>`.
4. **Versturen**: het bericht-Signal draagt alleen `attachments: [{id, name,
   mime}]`. De handler hervalideert elk id — vorm én bestaan, en scoped op
   *deze* conversatie — vóór het Signal wordt verstuurd.
5. **Prompt**: de turn krijgt één extra regel met de **absolute paden** plus
   de opdracht ze met `Read` te bekijken (`chatAttachmentPromptNote`). Meer is
   niet nodig: Claude's eigen Read-tool rendert een afbeelding als echte
   vision-input. Het enige extra stukje plumbing is `--add-dir`
   (`RunRequest.AddDirs`, `modules/claude`), omdat de bijlagen naast de DB's
   staan en niet in de worktree waarin de turn draait.
6. **Weergave**: de bubbel van de reviewer toont de thumbnails
   (`chat-message-attachments`), in een container met `markdown-body` en per
   `<img>` een `data-md-image` — precies de twee haakjes die
   `src/imageLightbox.mjs` gebruikt, dus klikken opent dezelfde fullscreen
   viewer met →/← door alle afbeeldingen als overal elders. Geen tweede
   implementatie. (De planpagina had die lightbox nog niet en mount hem nu
   ook, exact zoals `home.mjs` dat doet.)

### Waarom de bytes NIET door het Signal van het gesprek gaan

Base64 op `ChatMessageSignal` zou megabytes in de history van de
`claude_chat`-run zetten, en tembed **replayt** die history vanaf het begin bij
iedere volgende turn (`.claude/rules/workflow-determinism.md`). Vandaar een
eigen, kortlevende Execution voor de upload en alleen een verwijzing op het
Signal. Idem voor de planpagina: daar zou de base64 anders in het
`plan`-document belanden dat elke poll opnieuw over de lijn gaat.

### Waarom het een workflow is en geen upload-endpoint

Een geplakte screenshot is **duurzame** state: de bubbel toont hem dagen later
nog en de turn die hem leest draait mogelijk minuten na de paste. Dat sluit de
`/api/transcribe`-vorm uit (een handler die een tijdelijk bestand schrijft en
binnen hetzelfde request weer weggooit, zie de WRITE BOUNDARY-notitie in
`whisper.go`) — per `.claude/rules/workflows-write-boundary.md` moet dit door
een Activity. `GET /api/chat/attachment` is de read-only tegenhanger, met
dezelfde bewaking als `/api/image`: de extensie-allowlist bepaalt de
Content-Type, `X-Content-Type-Options: nosniff`, en het id is het enige door
de caller aangeleverde deel van het pad (`^[0-9a-f]{64}\.(png|jpg|gif|webp|avif)$`).

### De "bucket" is niet altijd een conversatie

Een gloednieuwe chat ("Chat over deze regel") **heeft** nog geen conversatie:
die ontstaat pas doordat het eerste bericht lui zijn anker-comment aanmaakt
(`ensureClaudeAnchorForNew`). Zo'n bijlage wordt daarom geparkeerd onder de
eigen draft-key van de composer (status `waiting`, de `File` apart in
`fileByKey`) en pas geüpload door `takePendingAttachments`, zodra het echte
conversatie-id bestaat. `sendClaudeMessageFromNew` onthoudt die bucket
**vóór** de ankerstap, want die stap verzet `cc.commentId` — en daarmee de
bucket — terwijl de al geplakte afbeeldingen nog onder de oude hangen.

### Losse regels die hierbij horen

- **Alleen afbeeldingen**, max **10 MB** per stuk en max **5** per bericht —
  in de UI gemeld vóór een zinloze upload, en serverside nog eens afgedwongen.
- **Een bericht mag uit alleen afbeeldingen bestaan**: slepen/plakken + Enter
  is één handeling. De handler vult dan een korte placeholder-body in
  (`chatAttachmentOnlyBody` → "(afbeelding)"), die `RelatedPanel.mjs`/
  `plan.mjs` letterlijk dupliceren voor hun optimistische bubbel — zelfde
  precedent als `CHECKOUT_CHOICE_OPEN_BODY`, dus houd ze gelijk.
- **Steeren gaat niet samen met een bijlage**: een bericht dat de lopende turn
  in wordt geduwd gaat via stdin en kan geen bestand dragen, dus zo'n bericht
  wordt altijd een gewone turn in de wachtrij.
- **Mislukt versturen verliest de afbeeldingen niet**: de bestanden staan al
  op schijf, dus alleen het Signal faalde — de chips komen terug
  (`restorePendingAttachments`).
- **Opruimen**: "wis gesprek" (`chatActionClear`) gooit de map van die
  conversatie weg, en de `cleanup`-workflow veegt elke map waarvan het
  nieuwste bestand ouder is dan `chatAttachmentMaxAge` (90 dagen) —
  leeftijdsgebaseerd, net als de `test_run`-residu-sweep, omdat de twee chats
  hun transcript op twee verschillende plekken bewaren en geen van beide
  gezaghebbend is over de ander.
- **Schrijven gebeurt in `appDataDirOrDefault()`, nooit in `m.dataDir`** — dat
  laatste is de workflow-store/worktree-map. De twee vallen alleen bij default
  samen; elke Playwright-worker (en elke deploy met aparte `-db`/`-data`)
  zou anders schrijven waar niets leest. Dezelfde aanroep die de
  `app_settings`-Activities voor `settings.json` gebruiken.
- Test: `tests/chat-attachment.spec.mjs` (paste → chip → versturen zonder
  tekst → de afbeelding komt terug in de bubbel, en een niet-afbeelding wordt
  geweigerd), plus `chat_attachment_test.go` voor de opslag-, pad- en
  scope-bewaking.

## Open (frontend gaps)

- No draft-persistence (`composeDrafts`/`replyDrafts`-style) for the chat
  composer — a page navigation away loses an unsent, half-typed message. Not
  requested; flagging as a known gap mirroring the existing comment
  composer's own draft feature.
- `applyPendingDraftReplies`'s "focus stays put while the reviewer is
  GENUINELY mid-typing an unsent follow-up in the Claude composer" half (see
  "Focus after placing a draft" above) still has no Playwright coverage —
  driving a second, LATER draft turn to arrive precisely while a real
  keystroke sits in `claude-chat-compose` would need the same SSE-reconnect
  timing `claude-chat-progress.spec.mjs` relies on, without that spec's
  luxury of a steady state to poll for. The far more common counterpart — the
  composer is EMPTY but still focused right after the reviewer's own send —
  IS covered: "Claude chat: focus lands in the comment field right after
  sending, once the composer is empty" in `tests/claude-chat-panel.spec.mjs`.
  The merge/append/never-auto-post behavior itself is also covered (see
  above).
