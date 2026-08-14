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
  that).

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
- **`↓` at `cs.claudePos === 0`** (nothing further to walk): **explicit
  request, deliberately NOT** the "↓ loopt door" convention
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
`exitPrCommentThread`/`closePrCommentChat` on every selection change, and —
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

### Stay open while a Claude turn is running

Reviewer request: while Claude is actively working on a turn, the fully
opened-out conversation — the transcript with the reviewer's own just-typed
message and the live status underneath it — must keep showing, even if the
reviewer navigates away to a different block/comment or explicitly closes the
panel (`←`/`Escape`, the PR-comment column's own "Sluit" button). Before this,
every one of those released the panel down to `CommentClaudeFooter`'s bare
one-line status ("Claude denkt…"), hiding the very message that status is
about.

**`hasActiveClaudeTurn()`** (`RelatedPanel.mjs`, exported) is the one shared
"a turn is running for the anchored conversation" predicate —
`cc.busy || !!cc.progress || cc.queued.length > 0` — replacing two
near-identical local closures that used to live separately in
`hasCommentClaudeFooter()` and `CommentClaudeFooter()`'s own `claudeActive`.
Three call sites now use it to stay open, not just to report status:

- **`claudeChatVisible()`** gained it as a third, independent `||` branch
  (alongside `hasVisibleComments()`/`isNewChatUnanchored()`) — the block-scoped
  `comment-claude-row` (comment column + `ClaudeChatPanel`) now also renders
  while a turn is running, regardless of whether the current block/selection
  still has a visible comment of its own.
- **`syncClaudeAnchorForSelection`** skips its own re-sync while
  `hasActiveClaudeTurn()` is true, next to its existing `cs.focus ===
  'claude'/'new'` skip — without this, merely navigating to a different block
  would still re-anchor (and thereby reset/hide) `cc` out from under the
  running turn the instant `cs.sel`/`cs.list`/`cs.scopeSig` changed, even
  though `claudeChatVisible()` itself now says to keep showing it.
- **`commentDetailCard`'s `pr-comment-claude-section` toggle** (the
  PR-comment-index "Chat met Claude" column) widened from a bare `pcc.open &&
  pcc.commentId === c.id` to `(pcc.open && pcc.commentId === c.id) ||
  (hasActiveClaudeTurn() && cc.commentId === c.id)`. `pcc.open` is what an
  explicit open/close (`startPrCommentChat`/`closePrCommentChat`, including the
  "Sluit" button and the unconditional `closePrCommentChat()` in `home.mjs`'s
  `state.selected` reset watch) still toggles, but the second clause keeps the
  section rendering regardless of that toggle for as long as `cc` — kept
  anchored on this exact comment by the `syncClaudeAnchorForSelection` skip
  above — still has a turn in flight. Clicking "Sluit" mid-turn is therefore a
  no-op in practice (the section reappears on the very next render); it only
  actually closes once the turn finishes.

Not extended to `pcc.pinned`/the scroll position or to `cs.focus` itself —
this is purely about the CONTENT staying visible, not about the keyboard
cursor following it around; `exitRelated()`/`leaveRelated()` still release
`cs.focus` exactly as before, so a reviewer who explicitly stepped away keeps
their keyboard on whatever they navigated to, while the still-running
conversation stays visible (read-only, until they click back into it) wherever
its own card renders.

## `RelatedPanel.mjs`: state, not template

The "Embedded Claude conversation" section owns:

- **`cc`** — this module's own `reactive()` chat state for whichever ONE
  conversation is currently in view: `{ commentId, runId, messages, status,
  busy, progress, tick, conversations }` (`conversations` is PR-wide — no
  longer read by `claudeChatVisible()`, only by `chatAnchorComment()`'s
  internal anchor-resolution fallback, see "Superseded" above;
  `progress`/`tick` are the live turn, see "Live progress"). `status` is the
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
  text or a clicked question option, same Signal). **No optimistic append**:
  the Signal round-trip runs the Activities (including the real `claude`
  subprocess call) **inline** — see "Hard rule: only workflows mutate state"
  and the `SignalWorkflow`/`advance()` mechanics in `tembed-workflows.md` —
  so `sendClaudeMessage`'s own `await` genuinely spans the whole turn — but
  that await is no longer what makes the reply appear (see "Live progress"
  below); it is the belt-and-braces refetch for the reviewer's own send.
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
  "Claude" heading, the composer) sat flush against the shared card's edges,
  most visibly on the right where "Stuur" touched the border. Its
  `claude-chat-thread` message list carries `flex-1` so it absorbs whatever
  vertical space a short/empty conversation leaves over, keeping the composer
  pinned to the bottom of the (`items-stretch`-driven, possibly taller) row
  instead of stranded right under the empty-state text — **and now also
  `max-h-[38vh] overflow-y-auto`** (a VISIBLE scrollbar, `no-scrollbar` was
  removed here) so a long conversation scrolls internally instead of
  stretching this column — and, via `<main>`'s `align-items: stretch`, the
  whole merged card and its sibling block-diff column — without bound. Same
  cap, same reasoning, same `.scroll-fade-top` (`src/scrollFade.mjs`) top-fade
  cue as the comment thread's own `comment-thread` pane — see "A capped,
  fading thread" in `.claude/docs/comments-panel.md` for the full story
  (including why this reverses, without repeating, an earlier `max-h-64
  no-scrollbar` mistake). The composer row
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
  than stretching the column, at this narrower width).

## A PR-wide comment-index item can also start a conversation

`ClaudeChatPanel`/`comment-claude-row` above is strictly the **block-scoped**
chat — a comment-index item (`commentDetailCard`, see "The detail card, in
place of a `Block` diff card" in `.claude/docs/comments-panel.md`) has no diff
and no `→` chain to reach it through, so until this feature it had no way to
chat with Claude at all. **"Chat met Claude"** (`prCommentCommandsFor`'s own
command, `home.mjs`) fixes that by opening the SAME `claude_chat` conversation
directly under the item's own detail card instead.

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
- **`pcc`** (`RelatedPanel.mjs`, `{ open, commentId }`) is the ephemeral
  visibility toggle, mirroring `picm`/`pct`'s own shape (scoped to ONE
  comment id, since the selected AND the look-ahead preview item both render
  through the very same `commentDetailCard`). It only toggles whether the
  column is SHOWN — the conversation data stays `cc`.
- **`startPrCommentChat(c)`** sets `pcc.open`/`pcc.commentId`, then `await`s
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
- **`closePrCommentChat()`** just resets `pcc` — the conversation itself is
  untouched (mirrors `←` out of the block-scoped chat never deleting it).
  Called from the "Sluit" button inside the embedded column, and from
  `home.mjs`'s existing `state.selected` reset watch (alongside
  `cancelPrCommentReply`/`exitPrCommentThread`) so a stray open column never
  leaks onto whatever gets selected next. **That same watch also calls
  `leaveRelated()`** (releases the BLOCK-SCOPED panel's own `cs.focus`), but
  only when the NEWLY selected item is itself a comment-index item
  (`kind:'comment'`) — never on an ordinary block-to-block selection change,
  see the watch's own doc comment in `home.mjs` for why a blanket reset there
  is unsafe. `pcc` never touches `cs.focus` itself (it has no keyboard cursor
  of its own, mouse only, see `prCommentClaudeView()` below), so a stale
  `cs.focus` left over from a DIFFERENT block's comment/thread/claude panel
  (never explicitly exited via `←`/Escape) used to survive a plain mouse click
  straight onto a comment-index item's "Chat met Claude" composer — reported
  bug: typing into that composer and pressing Enter did nothing, swallowed by
  `home.mjs`'s `relatedActive()`-gated Enter/arrow handling instead of
  reaching `ClaudeChat.mjs`'s own send handler, "fixed" by a refresh only
  because a `cs.focus` restored from the URL that resolves to nothing gets
  dropped, not because anything was actually repaired. Test:
  `tests/pr-comment-claude-chat.spec.mjs`'s "a stale block-scoped cs.focus…"
  case.
- **`prCommentClaudeView()`** is `claudeChatView()`'s sibling: same `cc`-backed
  fields, but `claudePos`/`focused` come from `pcc` instead of the
  block-scoped panel's `cs.claudePos`/`cs.focus` (an unrelated, URL-bound
  keyboard cursor for the diff-mode column — must never be touched from here).
  **Deliberately smaller scope**: no `↑`/`↓` turn-walking cursor of its own
  yet (`claudePos` always `0`) — mouse/click only. `claudeChatColumn`
  (`ClaudeChat.mjs`) is reused as-is, rendered inside `commentDetailCard`
  behind its own `${() => pcc.open && pcc.commentId === c.id ? html\`...\` :
  ''}` toggle (same "toggling template↔string needs a function binding" shape
  as the reply composer right above it in the same card — see
  `.claude/rules/arrowjs-pitfalls.md`); mutual exclusivity with the
  block-scoped column's own `claude-chat-compose`/`claude-chat-send` (both
  reused testids, one global `document.querySelector` inside
  `claudeChatColumn`'s send button) is guaranteed by construction — a
  comment-index item (`b.kind === 'comment'`) never also renders
  `comments-and-related`'s block-scoped `ClaudeChatPanel` content, see "The
  detail card, in place of a `Block` diff card" in
  `.claude/docs/comments-panel.md`.
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
  conversation id. Applied to `cc.progress`.
- **`chat.message`** — "this conversation's transcript changed"; the handler
  refetches `GET /api/chat` (never trusts a pushed body) and then clears a
  finished progress snapshot.
- **the resync** — refetch the transcript **and** `GET /api/chat/progress`,
  which is the snapshot read for a tab that opened or reconnected **mid-turn**
  (a refresh at that moment is the normal case: the Activity keeps running
  server-side, it has no idea a tab went away). Not a poll target.

Three details are load-bearing:

- **`applyChatProgress` is the single writer of `cc.progress`** and stamps
  `lastProgressAt`. `loadChatProgress` compares that against the time its own
  request started and **yields to a newer pushed event** — a resync runs right
  next to the events it is catching up on, so without this it could wipe a
  fresher snapshot and freeze the status line.
- **A `chat.message` only clears the progress when the turn is NOT running**
  (`clearFinishedChatProgress`). That event also fires for the reviewer's *own*
  message at the very start of a turn, and clearing there would blink the
  status line away a moment after it appeared. A 4s timer after a
  `running:false` frame is the safety net for a transcript event that never
  arrives.
- **`cc.tick`** is a 1s heartbeat that only runs while a turn is running
  (`syncChatTicker`), purely so "Claude denkt… 12s" advances; the number itself
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

### The focus border follows the keyboard, not "which side is merely shown"

`comment-claude-row`'s two halves used to give the comment side an
**unconditional** indigo border (`expandedConversation`) while the Claude side
had none at all — so the border stayed on the left even once `→` moved the
keyboard cursor (`cs.focus`) into the Claude column, misleadingly suggesting
the reviewer was still "in" the comment thread. Fixed: both halves now carry
the **same conditional border**, keyed on which one actually has `cs.focus`:

- `expandedConversation` (`RelatedPanel.mjs`) — `border-indigo-300
  dark:border-indigo-500/40` only while `cs.focus === 'comment' || cs.focus
  === 'thread'`, else `border-transparent`.
- `claudeChatColumn`'s `claude-chat-card` (`ClaudeChat.mjs`) — the same
  indigo pair only while `view.focused()` (`claudeChatView()`'s `focused: ()
  => isClaudeChatFocused()`, i.e. `cs.focus === 'claude'`), else
  `border-transparent`.

**Deliberately `border-transparent`, never a neutral gray, on the unfocused
side** — explicit reviewer correction to an earlier draft of this fix that
gave the unfocused side a neutral `border-slate-300`/`dark:border-zinc-700`
fallback (so it would always show *some* border, matching
`compactConversation`'s resting style). Reindert: "helemaal geen rand op de
niet-gefocuste kant" — only the column the keyboard is actually in ever shows
a border; the other side blends into the shared `comment-claude-row` card
with no border of its own, not even a muted one that could read as "also kind
of active".

This is a genuinely different condition from `commentCard`'s existing "stay
expanded while `cs.focus === 'claude'`" rule (see its own doc comment,
`RelatedPanel.mjs`) — the comment card can be **expanded for context** while
`cs.focus === 'claude'` and carry **no border**, exactly the case this fix
targets. Don't collapse the two checks back into one.

Test: the "the focus border follows cs.focus" case in
`tests/claude-chat-panel.spec.mjs` (navigates comment → claude via `→` and
asserts the border color swaps sides).

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
2. **Focus only moves onto `reaction-compose` when the reviewer is NOT
   currently typing in the Claude composer** (`document.activeElement` checked
   against `[data-testid=claude-chat-compose]`) — the text is written into
   `replyDrafts` (and the mounted field, if any) unconditionally either way,
   only the caret-steal is conditional. Deliberately a plain, synchronous
   `document.querySelector` + `.value=`/`.focus()`, NOT `prefillField`'s rAF +
   `focusToken`-gated wait: that mechanism exists for a field that is only
   ABOUT to mount because of the very state change that requested the focus,
   and entering/leaving the Claude column in between can bump `focusToken`
   before the deferred write lands — which silently dropped the draft in an
   early version of this feature. `reaction-compose` is (per "One card per
   conversation, only the focused... expands" in `.claude/docs/comments-panel.md`)
   already mounted whenever `applyPendingDraftReplies` runs, or genuinely not
   part of the current view at all (then only `replyDrafts` gets the write,
   picked up next time `toComment` opens this thread) — either way a
   synchronous read settles it with no race.
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
  currently typing in Claude" gate still applies), calls `el.select()` instead
  of placing the caret at the end — so a bare Enter sends it as-is, and typing
  anything replaces the whole draft in one go rather than appending after it.
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

## Doorpraten tijdens een lopende turn (de wachtrij)

Like the Claude CLI, the reviewer can **keep typing while a turn is still
running**. The composer used to be `disabled` for the whole turn (`view.busy()`
on the textarea's `@keydown`, on `claude-chat-send` and on every question
option), which meant a message typed meanwhile did nothing at all — the text
just sat in the field. All three gates are gone.

- **`queueClaudeMessage(text)`** (`RelatedPanel.mjs`) is now the single entry
  point for a composer turn: nothing running → send straight away; a turn
  running (`cc.busy`) → append to **`cc.queued`** and return. `cc.queued` is
  reactive and only ever REASSIGNED, never mutated.
- **`drainClaudeQueue()`** runs from `sendClaudeMessage`'s own `finally`, so the
  queue drains itself **one turn at a time**, FIFO — each send ends in another
  drain. The entry is removed from the queue **before** it is sent, which is
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
- **Deliberately not merged into the running turn.** The workflow's own
  `WaitSignal` loop (`chat_workflow.go`) is what makes each turn a separate
  replayable step, and its `pendingQuestionID` bookkeeping assumes one reviewer
  message per turn.

**No backend change was needed, and that is not a coincidence:** tembed's
`SignalWorkflow` takes the **per-run lock** and drives the turn inline, so a
second `POST .../signals/message` simply blocks on that lock, then appends its
own `EventSignalReceived` and the eternal `for { w.WaitSignal(...) }` loop picks
it up as the next turn. Ordering and determinism are the engine's, not ours.

**Accepted trade-off — a queued message is not crash-durable.** Because the run
lock is held for the whole turn, the queued Signal only reaches the workflow
history *after* the running turn finishes; until then it lives client-side only,
so a server restart mid-turn loses it (the reviewer does see it sitting in the
queue the whole time). Making it durable would mean appending the signal event
outside the run lock — a tembed change, deliberately not done here.

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
  (group/line/call, `f`/`d`/`s`) the reviewer is on. Returns `''` when there's
  nothing useful (no target, or a block-level fallback with no real code — see
  `commentTarget`'s own `!unit` branch), which is treated as "send nothing
  extra", unchanged from before this existed.
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

### The already-written comment thread(s) on this unit also ride along, chronologically

`claudeContextBlock` also folds in **`claudeThreadContextBlock()`**
(`RelatedPanel.mjs`, same file, same first-turn-only gate) — every
already-written comment message scoped to the exact same code block/line: the
conversation's own anchor thread (opening + every reaction) **plus** any other
comment thread on that same unit, i.e. exactly `visibleComments()`/`cs.view`,
the same "under this selection" scope `recomputeView`/`commentUnder` already
compute for the comment index itself. Deliberately **not** every comment on
the whole PR — reviewer's explicit choice, "de tussenvorm": own thread plus
same-unit threads, not PR-wide.

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
the standing one to react to, not an unordered dump. So every message
(comment openings + reactions, across every thread on the unit) is sorted
**chronologically by `createdAt`** (comments/reactions both carry
`RFC3339Nano` timestamps, see `modules/comments/comments.go`, so ties across
near-simultaneous inserts are never actually ambiguous) and the **last** line
is explicitly tagged `[meest recent — het gesprek gaat hierop verder]`.
`CLAUDE_ANCHOR_PLACEHOLDER` bodies are filtered out (not a real reviewer
message, see `ensureClaudeAnchorForNew` above). Same invisibility/determinism
guarantees as the selection block above: only the `context` Signal field, the
visible bubble is untouched; no new write path.

Test: the first "embedded Claude chat…" spec in `tests/claude-chat-panel.spec.mjs`
seeds a second comment thread on the exact same file+label before entering the
chat, and asserts the first turn's intercepted `context` contains both
bodies, in creation order, with the later one tagged `meest recent`.

### Codeblok numbering must match what Claude sees — the ONLY mechanism for acting on a fenced code block/suggestion

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
`.claude/rules/workflows-write-boundary.md`). No backend change was needed for
this at all — only the numbering itself, and getting Claude's own copy of the
context to carry the same numbers.

For that to work, "codeblok 3" must mean the exact same block to the reviewer
and to Claude, so the numbering used in the visible badges and the numbering
folded into `claudeThreadContextBlock`'s text (above) share ONE mechanism:

- `markdown.mjs` exports `countCodeFences(text)` (count only, no render) and
  `annotateFenceNumbers(text, startIndex)` (returns `{text, count}`: the SAME
  text with a `[Codeblok N]`/`[Suggestie N]` marker line inserted right before
  each fence, using the same `fenceLabel` wording the visual badge renders) —
  both driven off the identical fence regex `renderMarkdown`/`extractCodeFences`
  use, so a "codeblok" can never be counted differently between the three.
- `RelatedPanel.mjs`'s `orderedThreadMessages()` (the function
  `claudeThreadContextBlock` already builds, factored out) also backs
  `threadFenceStartIndexes(c)`: it walks the same chronological, cross-thread
  message list and assigns each message the running fence-count BEFORE its own
  fences. `commentBody(c, startIndex)` (see `.claude/rules/conventions.md`)
  takes that as its numbering offset, so a bubble rendered later in the thread
  continues the count instead of restarting at 1 — exactly mirroring how
  `claudeThreadContextBlock` threads its own `running` counter through
  `annotateFenceNumbers` across the same messages, in the same order.
- **Scope, same as `claudeThreadContextBlock`'s own:** continuity only holds
  across `visibleComments()` — the block-scoped case where an embedded Claude
  conversation actually exists. A PR-wide comment-index item's own
  `commentDetailCard` thread (which has no Claude chat, see "Scope: one
  conversation per comment thread" in `.claude/docs/workflows-comments.md`)
  falls back to numbering continuously within just that one thread instead
  (`threadFenceStartIndexes`' own `inScope` check) — nothing to keep in sync
  with there, but still nicer than resetting to 1 in every bubble.

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

- `cc.sendError` holds the reviewer-facing sentence for the LAST send, `''`
  when it was accepted. Cleared at the start of every send and wherever `cc`
  itself resets (`toNew`, `syncClaudeAnchorForSelection`), so it never sticks
  to another conversation.
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

## "Wis Claude-gesprek" — clearing a conversation (chatActionClear)

A confirm-gated command-palette item, not a header button (explicit product
choice) — mirrors "Keur de HELE PR goed"'s own `REVIEW_APPROVE_CONFIRM_COMMANDS`
two-step shape rather than a plain click. Backend mechanics (the `"clear"`
`ChatMessageSignal.Action`, `clearChatConversation`/`clearChatShadow`) are in
`.claude/docs/workflows-comments.md`'s `claude_chat` section; this section is
the frontend/palette half.

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
  list is one item ("Wis Claude-gesprek") whose `children` is a one-item
  confirm submenu ("Ja, wis dit gesprek" / "Ja, toch wissen — …") — never runs
  directly, mirroring `REVIEW_APPROVE_CONFIRM_COMMANDS`. Built fresh on every
  open (not a static list) because the confirm label carries a live warning.
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
  Dutch warning sentence when the conversation's own agentic-edit shadow
  worktree still has uncommitted or locally-unpushed work. `home.mjs` reads
  that cache **synchronously** at menu-open time via `claudeChatShadowWarning()`
  — the confirm submenu is built by plain, non-reactive code
  (`rootCommandsFor`/`openMenu`) that cannot itself `await` a fetch, the same
  reason `commentCommandsFor`'s own `focusedCommentGithubId()` is a snapshot
  read rather than a live query. A stale/failed check just means the extra
  warning line is missing, never a wrong block.
- **`clearClaudeChat()`** (`RelatedPanel.mjs`) sends the `"clear"` Signal and
  resets `cc.progress`/`cs.claudePos` locally — belt-and-braces on top of the
  `chat.message` SSE event's own refetch, same reasoning as `sendClaudeMessage`'s
  own post-send refetch.
- Test: `tests/claude-chat-panel.spec.mjs`'s "Wis Claude-gesprek" case drives
  the full two-Enter confirm flow and asserts the transcript is empty
  afterwards.

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
only once the transcript is refetched — see "No optimistic append" above)
could land below the fold and stay there even after the turn finished and the
progress line disappeared again.

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
  code-preview-card`, keyed `'fence:' + index` — DOM/document order, i.e.
  comments column first, then the Claude column).
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
  now that it stacks below with nothing beside it, it takes the full width of
  the row instead (`w-full shrink-0`) — so its cards read as wide as the
  comment/Claude card above them, not as a narrow strip underneath a wide one.
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
  ONE handle a reviewer has on a fence (see "Codeblok numbering must match what
  Claude sees").

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
  gradient (`code-fence-fade-bottom`, `index.html`, mirrors the existing
  `.scroll-fade-top` pattern in `src/scrollFade.mjs` — same technique, bottom
  instead of top, and a static class here rather than JS-toggled since a
  truncated fence is truncated for its whole lifetime, nothing to react to).
  This is a shape/mask signal, not colour-only, per the colourblind rule.
  `isLong` also stamps `data-fence-truncated="true"` on the fence's wrapper
  `<div>` for tests/future tooling to key off, alongside the fade class on the
  `<pre>` itself.
- **`truncate` is opt-in per call site, default `false`** — only where a
  full-size preview card actually exists to point at:
  `RelatedPanel.mjs`'s `commentBody` (every comment/reply/reaction bubble) and
  `ClaudeChat.mjs`'s three body renderers (`claudeMessageBody`, the partial
  streaming bubble, a still-open question's own body). **Not** `home.mjs`'s
  `prInfoCard` (the PR summary/description) or `inbox.mjs`'s task description
  — neither sits next to a code-preview column, so both keep the
  pre-existing, untruncated rendering via the default.

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

## Open (frontend gaps)

- No draft-persistence (`composeDrafts`/`replyDrafts`-style) for the chat
  composer — a page navigation away loses an unsent, half-typed message. Not
  requested; flagging as a known gap mirroring the existing comment
  composer's own draft feature.
- `applyPendingDraftReplies`'s "focus stays put while the reviewer is typing
  in the Claude composer" rule (see "A `reply` directive only drafts, never
  posts" above) has no Playwright coverage — driving a second, LATER draft
  turn to arrive precisely while a real keystroke sits in
  `claude-chat-compose` would need the same SSE-reconnect timing
  `claude-chat-progress.spec.mjs` relies on, without that spec's luxury of a
  steady state to poll for. The merge/append/never-auto-post behavior itself
  IS covered (see above).
