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
"`'new'`, or `'claude'` with no anchor yet" condition once, since three call
sites need it identically: `claudeChatVisible()` above,
`newCommentComposer`'s own visibility toggle, and `ensureClaudeAnchorForNew`'s
guard (both below) — see "Two bugs the → path never actually exercised" for
why letting these three drift apart is exactly what broke.

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
  a normal message with `kind: 'error'` (see `chat_workflow.go`'s
  `runOneClaudeTurn`), not this field.
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
  instead of stranded right under the empty-state text. The composer row
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
snapshot into one sentence in words — "Claude denkt na…", "Claude leest
`src/Order.php`", "Claude schrijft… · 12s" (`PHASE_LABEL`/`TOOL_VERB`). It used
to render inline below the message thread, as `claudeChatColumn`'s own
`claude-chat-thinking` paragraph; that spot is gone — the text now renders
inside `CommentClaudeFooter` (`RelatedPanel.mjs`, mounted in `home.mjs` right
after the comment+Claude columns), the ONE shared status line for **both**
the comment and Claude sides — see "The shared `composeTargetHint` header" and
the send-status section in `.claude/docs/comments-panel.md` for its comment-side
half and the `reaction-status` button it replaced. Still the same
`data-testid=claude-chat-status` on the text itself, so
`tests/claude-chat-progress.spec.mjs` needed no change, just relocated to
`data-testid=comment-claude-footer-claude`'s own span. `ClaudeChat.mjs` still
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

`.innerHTML` bodies go through the same `renderMarkdown` convention as
`commentBody` (own small `claudeMessageBody(msg)` helper, `()=>
renderMarkdown(msg.body)`) — Claude's replies render as Markdown like any
other comment/reply.

Claude has no GitHub login/avatar; `avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')`
falls back to its initials-circle rendering (empty `avatarUrl`).

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

## Tests: `tests/claude-chat-panel.spec.mjs` + `tests/claude-chat-progress.spec.mjs`

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
  `prepareChatShellWorkDir` swallows the error (best-effort `tm.logf`, never
  surfaced to the reviewer) and the turn falls back to exactly the original
  tool-less completion: no `WorkDir`/`Tools`, `claude.ChatSystemPrompt`. A pure
  conversational turn therefore **never** fails because of this — this is the
  fix for an earlier, reverted attempt that defaulted every turn to the old
  `'edit'` action and made ordinary Q&A hard-depend on a live `gh pr view` +
  `git fetch` round trip (see `chat_shadow.go`'s doc comment and
  `chat_workflow_test.go`'s `stubUnreachableGh`/`stubReachableGh` for the two
  regression tests, `chat_shell_test.go`).

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
`'error'`) — the tint (emerald/sky/rose respectively) is decoration on top,
never the sole carrier, per the colourblind rule. `msg.kind` is fixed at
message creation (unlike `answer`, which fills in later on the same row), so
the badge needs no `${() => ...}` getter wrapper of its own — same reasoning
as the existing `isError`/`mine` locals just below it. Testids
`claude-message-action`/`claude-message-draft-reply`/`claude-message-error`.
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

## The composer is a `<textarea>`, not an `<input>`

`ClaudeChat.mjs`'s composer (`data-testid=claude-chat-compose`) is a
single-row (`rows="1"`, `resize-none`) `<textarea>`, so a multi-line message
is possible: plain `Enter` still sends (`@keydown` calls `e.preventDefault()`
and only then checks `!e.shiftKey`/busy/non-empty before firing
`callbacks.onSend`), `Shift+Enter` falls through to the textarea's own
default behaviour and inserts a newline. Reading/writing its value
(`el.value`) via `querySelector('[data-testid=claude-chat-compose]')` in the
"Stuur" click handler is unaffected by the element swap.

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
