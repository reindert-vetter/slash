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
comment (↑ walks its own thread bubbles) → claude → (↓, nothing left) → Onderliggende code
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

**A conversation that already happened never becomes unreachable**, even if
its comment falls out of the visible index (an orphan or PR-wide comment,
which `recomputeView` filters out): `cc.conversations` — the ids of this PR's
conversations that actually have turns, from `GET /api/chat?pr=N` — keeps the
column visible, and `chatAnchorComment()` resolves the same comment for both
the visibility check and `enterClaudeChat`, so the column can never be shown
without `→` being able to reach it. A genuinely **deleted** comment is the one
irreducible case: without a row there is no file:line, so its conversation has
no unit to appear under any more.

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
— typing into the Claude composer and clicking "Stuur"/"Bewerk code" — exactly
the same weight "Plaats…" already has.

- **`ensureClaudeAnchorForNew(state, commentTarget)`** (`RelatedPanel.mjs`) is
  the lazy-creation step, called from `sendClaudeMessageFromNew` (which
  `claudeChatCallbacks`' `onSend`/`onSendEdit` use instead of calling
  `sendClaudeMessage` directly). A no-op — returning `null`, changing
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
  transcript (and, worse, let "Commit wijziging" act on its stale `runId`).
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
- **`↓` at `cs.claudePos === 0`** (nothing further to walk): falls through to
  `enterRelated()` — the same "↓ loopt door" convention `advanceFromComment`
  already uses at the bottom of a comment thread.
- **`←` on `cs.focus === 'claude'`**: steps back directly to `cs.focus ===
  'comment'` (`toComment()`, which also resets `cs.threadPos` — `'thread'` is
  never visited on the way back) — always possible, since entering `'claude'`
  guarantees a comment now exists.

No new stop exists between `'code'` and `'claude'` — `→` has no meaning past
`'claude'` (nothing deeper), only `↓`'s fallthrough reaches Onderliggende
code from there. A dashed connector (`data-testid=comment-claude-connector`,
the same look as the Onderliggende-code chip connector, `RelatedPanel.mjs`'s
`nestedChipColumn`) renders between the comment block and the Claude column
whenever `claudeChatVisible()` (`home.mjs`, next to the `ClaudeChatPanel(...)`
call) — built here rather than waiting for TODO 3 (the column-width pass),
which reuses it once the two columns sit side by side at their final widths.

## `RelatedPanel.mjs`: state, not template

The "Embedded Claude conversation" section owns:

- **`cc`** — this module's own `reactive()` chat state for whichever ONE
  conversation is currently in view: `{ commentId, runId, messages, status,
  busy, progress, tick, conversations }` (`conversations` is PR-wide, see
  `claudeChatVisible()`; `progress`/`tick` are the live turn, see "Live
  progress"). `status` is the PANEL's own loading/error state (ensuring the
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
- **`claudeChatVisible()`** — `hasVisibleComments() ||
  chatConversationExists() || cs.focus === 'claude'`. The middle term reads
  `cc.conversations` (reactive, refreshed by `loadChatConversations` on every
  comment poll and only ever **reassigned**, never mutated) through
  `chatAnchorComment()`. It must stay inside the existing
  `${() => claudeChatVisible()}` binding: a plain, non-reactive value would
  leave a column that should reappear invisible until the next navigation step
  (the static chunk-reuse trap, see `.claude/rules/arrowjs-pitfalls.md`).
- **`ClaudeChatPanel(state, commentTarget, openCommit)`** — the exported component
  `home.mjs` mounts inside `comments-and-related`'s own first row
  (`comment-claude-row`), directly next to `InlineComments`, connected by the
  same dashed connector the Onderliggende-code children use between each
  other (`data-testid=comment-claude-connector`, built in TODO 2 of
  `todo/todo-claude-chat-blok.md`; not a sibling column of
  `comments-and-related` any more — that was the earlier, wider-apart shape).
  Width is `claudeColumnWidthCls()` — **1/3** of `relatedColumnWidthCls()`'s
  own clamp, `InlineComments` taking the other **2/3** (minus the connector's
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

Rendering (`ClaudeChat.mjs`): one **status line**
(`data-testid=claude-chat-status`) in words — "Claude denkt na…", "Claude leest
`src/Order.php`", "Claude schrijft… · 12s" (`PHASE_LABEL`/`TOOL_VERB`) — plus a
**provisional bubble** (`data-testid=claude-partial`) rendering `progress.partial`
through the same `renderMarkdown`. The word carries the meaning; the pulsing dot
is decoration (colourblind rule). The bubble is throwaway by construction: no
id, no key, never part of the message list, gone as soon as the stored message
is refetched.

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
programs the Fake's reply queue at server startup — a **worker-wide FIFO**,
safe because no other workflow in this app calls `RunChat` (only the
one-shot `Run`), so only `tests/claude-chat-panel.spec.mjs`'s own sends ever
consume from it. Wired in `tests/_fixtures.mjs`'s worker-scoped server
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

## Triggering the two agentic actions (`edit` / `commit`)

Phase 3's backend (a per-conversation shadow worktree + a fast-forward-only
commit/push — see "claude_chat" → "Agentic edits" in
`.claude/docs/workflows-comments.md`) is reached from this panel via two
plain, native `<button>`s below the composer (`data-testid=claude-chat-actions`,
`ClaudeChat.mjs`), next to the existing "Stuur":

- **"Bewerk code"** (`data-testid=claude-chat-send-edit`) sends the SAME typed
  composer text as "Stuur", but as an `action: "edit"` turn
  (`callbacks.onSendEdit` → `sendClaudeMessage(text, 'edit')`,
  `RelatedPanel.mjs`) — Claude may then use its Edit tool against the
  conversation's own throwaway shadow worktree. **No confirm step**: nothing
  real (the PR's actual branch) is touched yet, so this is exactly as
  low-friction as an ordinary plain turn.
- **"Commit wijziging"** (`data-testid=claude-chat-commit`) needs no typed
  text at all (`sendClaudeMessage`'s own guard skips the "needs real text"
  check only for `action === 'commit'`, mirroring the backend's identical
  validation in `tasks_api.go`) and genuinely fast-forward-pushes onto the
  PR's real head branch (`chat_shadow.go`/`chat_merge.go`), so it does **not**
  act on a single click: it only opens a confirm menu
  (`CLAUDE_COMMIT_CONFIRM_COMMANDS`, `home.mjs`, mode `'claudeCommit'`) —
  "Sluit menu" pinned, "Ja, commit en push naar de PR-branch" the default 2nd
  item — mirroring the two-step "Approve the whole PR" confirm
  (`REVIEW_APPROVE_CONFIRM_COMMANDS`, see `.claude/docs/command-palette.md`).
  Confirming calls the exported `commitClaudeChange()`
  (`RelatedPanel.mjs`), which is the only thing that actually sends the
  `action: "commit"` Signal. The eventual outcome (pushed / nothing to commit
  / a merge conflict) is **never** returned synchronously from either the
  button or the confirm — it lands later as its own assistant chat message
  once the PR's `chat_merge` queue processes the request, exactly like any
  other turn's reply arrives (see "Live progress" above).

**Keyboard reachability is free, by construction — no new global shortcut.**
Both are ordinary `<button>` elements (like "Stuur" itself), so Tab-focusing
one and pressing Enter/Space fires the exact same `@click` handler a mouse
click would — no parallel implementation (mouse-navigation.md's rule 1). The
existing plain-Enter-sends-a-message behaviour in the composer's own
`@keydown` is deliberately **untouched**: overloading Enter to open a
choose-an-action menu (the way `COMPOSE_COMMANDS` does for a brand-new
comment) would have turned every ordinary conversational turn — still the
overwhelmingly common case — into a two-Enter flow, which is not the
"continuing a conversation" weight this send already has (mirrors why a
thread **reply** field sends directly while a **new** comment composer opens
a menu — see `.claude/docs/comments-panel.md`).

`ClaudeChatPanel(state, commentTarget, openCommit)`'s `openCommit` param
(mirrors `InlineComments`' own `openCompose`/`openCommentMenu` props) exists
purely to reach `home.mjs`'s `openMenu` — `RelatedPanel.mjs`/`ClaudeChat.mjs`
have no access to it directly, same reason `InlineComments` needs those two
callbacks. `commentTarget` was added alongside it for `ensureClaudeAnchorForNew`
(see "Optimistically visible while composing a brand-new comment" above).
`menuAnchor()`/`menuRegion()` gained a `'claudeCommit'` branch anchoring on
`[data-testid=claude-chat-card]`/`-column]`.

**Test coverage is deliberately end-to-end for the Signal, not for the git
outcome.** `tests/claude-chat-panel.spec.mjs` clicks both buttons on its
existing seeded conversation: "Bewerk code" really sends an `action: "edit"`
Signal, which then needs a per-conversation shadow worktree
(`ensureChatShadowWorktree`, `chat_shadow.go`) — that in turn needs a REAL PR
head branch from `gh`, which a synthetic `seededPr` number doesn't have even
under the offline Fake, so it deterministically reports the "no worktree"
`KindError` turn instead of a normal reply. That failure message is exactly
what the test asserts on: it still proves the button reaches the workflow
with the right action, without needing a real git remote. "Commit wijziging"
is asserted only up to opening/closing the confirm menu — actually confirming
would push to a real remote. The real success/conflict git plumbing for both
actions is covered offline at the Go level
(`chat_shadow_test.go`/`chat_merge_test.go`).

## Opt-in influence on the left comment thread (Phase 4)

Phase 4's backend is built — on the reviewer's explicit request,
`chat_workflow.go`'s `applyChatCommentAction` signals the left comment
thread's own `task_code_comment` Execution (`Source: "ai"`) and records a
`Kind: chat.KindAction` (success) or `Kind: chat.KindError` (failure)
confirmation turn — see "Opt-in influence on the left comment thread
(Phase 4)" in `.claude/docs/workflows-comments.md`. `ClaudeChat.mjs`'s
`chatKindBadge(msg)` now marks both kinds distinctly, mirroring
`RelatedPanel.mjs`'s `aiWarningBadge`/`staleAnchorBadge`: a small pill with a
word + a shape glyph (a checkmark for `'action'`, the same warning-triangle
SVG as `aiWarningBadge`/`related-covers-warning` for `'error'`) — the tint
(emerald resp. rose) is decoration on top, never the sole carrier, per the
colourblind rule. `msg.kind` is fixed at message creation (unlike `answer`,
which fills in later on the same row), so the badge needs no `${() => ...}`
getter wrapper of its own — same reasoning as the existing `isError`/`mine`
locals just below it. Testids `claude-message-action`/`claude-message-error`.
Test: the "action turn and an error turn each get their own badge" case in
`tests/claude-chat-panel.spec.mjs` (a direct-mount unit test of
`claudeChatColumn`, since driving a real `comment_action` directive through
the Playwright fixture would need the comment's run id known before the
fixture file loads — see the test's own comment; the backend's
KindAction/KindError decision is already covered end-to-end by
`chat_workflow_test.go`).

## The composer is a `<textarea>`, not an `<input>`

`ClaudeChat.mjs`'s composer (`data-testid=claude-chat-compose`) is a
single-row (`rows="1"`, `resize-none`) `<textarea>` that grows with its
content, so a multi-line message is possible: plain `Enter` still sends
(`@keydown` calls `e.preventDefault()` and only then checks
`!e.shiftKey`/busy/non-empty before firing `callbacks.onSend`), `Shift+Enter`
falls through to the textarea's own default behaviour and inserts a newline.
The composer row is `items-end` (not `items-center`) so "Stuur" stays pinned
to the bottom as the textarea grows taller. Reading/writing its value
(`el.value`) via `querySelector('[data-testid=claude-chat-compose]')` in the
"Stuur"/"Bewerk code" click handlers is unaffected by the element swap.

## Open (frontend gaps)

- No draft-persistence (`composeDrafts`/`replyDrafts`-style) for the chat
  composer — a page navigation away loses an unsent, half-typed message. Not
  requested; flagging as a known gap mirroring the existing comment
  composer's own draft feature.
