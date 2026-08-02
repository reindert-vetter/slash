# Embedded Claude chat panel (frontend)

The frontend half of the embedded, multi-turn Claude conversation next to a
comment thread — the `claude_chat` workflow (backend: `modules/claude`'s
`RunChat`, `modules/chat`, `chat_workflow.go`) is documented in
`.claude/rules/tembed-workflows.md`/`workflows-comments.md`; this file covers
the review-tree panel that talks to it: `src/ClaudeChat.mjs` (pure template)
and the "Embedded Claude conversation" section of `src/RelatedPanel.mjs`
(state machine, polling, focusToken discipline).

## Product decision: always reachable via `→`, one hop past the comment thread

A Claude conversation always hangs off an existing comment thread (the
backend's own constraint — `CommentID` must name an existing comment of the
PR). The panel is nonetheless **unconditionally reachable via `→`**, not
gated behind "does a comment already exist": the `→` chain becomes

```
comment → thread → claude → (↓, nothing left) → Onderliggende code
```

reached from the diff exactly like the comment stop already was — `→` from
the diff enters the first comment conversation when `hasVisibleComments()`
is true (unchanged), **otherwise it now goes straight to the embedded Claude
chat** instead of the Onderliggende-code panel. The **first** time a unit's
chat is entered this way, `enterClaudeChat` (`RelatedPanel.mjs`) silently
creates an **empty, private** (`Local: true`, never posted to GitHub)
comment via the existing `createComment` write path to hang the conversation
on, then ensures the `claude_chat` workflow for it
(`POST /api/workflows/claude_chat {pr, commentId}`). From then on the unit
genuinely has a comment thread (visible as an ordinary, if near-empty,
inline comment card above the chat column — `CLAUDE_PLACEHOLDER_BODY`), so a
later `→` from the diff lands on that thread first, same as any other
commented unit — the "auto-create" path only ever fires once per unit.

**Deliberately not gated on "comments already exist"**: "net zo'n blok als
het comments-blok, zichtbaar zodra er al comments zijn" describes the
*normal* case (a reviewer typically comments before chatting about it), not
a hard precondition — see `claudeChatVisible()` below for the exact
visibility rule, which is looser than that on purpose (visible while
genuinely focused too, covering the async gap right after auto-create).

### The chain, key by key

- **`→` from the diff**: `hasVisibleComments() ? enterCommentsHead() :
  enterClaudeChat(state.pr, commentTarget)` (`home.mjs`'s `onKeydown`).
- **`→` on `cs.focus === 'thread'`** (the deepest existing comment-thread
  stop): `enterClaudeChat(cs.pr)` — no `commentTargetFn` needed, a comment
  already exists (`RelatedPanel.mjs`'s `handleRelatedKey`).
- **`↑`/`↓` on `cs.focus === 'claude'`**: walk the transcript exactly like
  `'thread'` walks reactions, via its own `cs.claudePos` cursor (mirrors
  `cs.threadPos`, 0 = composer, 1..n = the n-th turn from the bottom).
- **`↓` at `cs.claudePos === 0`** (nothing further to walk): falls through to
  `enterRelated()` — the same "↓ loopt door" convention `advanceFromComment`
  already uses at the bottom of a comment thread.
- **`←` on `cs.focus === 'claude'`**: steps back to `cs.focus === 'thread'`
  (mirrors `'thread'`'s own `←` stepping back to `'comment'`) — always
  possible, since entering `'claude'` guarantees a comment now exists.

No new stop exists between `'code'` and `'claude'` — `→` has no meaning past
`'claude'` (nothing deeper), only `↓`'s fallthrough reaches Onderliggende
code from there.

## `RelatedPanel.mjs`: state, not template

The "Embedded Claude conversation" section owns:

- **`cc`** — this module's own `reactive()` chat state for whichever ONE
  conversation is currently in view: `{ commentId, runId, messages, status,
  busy }`. `status` is the PANEL's own loading/error state (ensuring the
  workflow, fetching the transcript) — a genuinely **failed Claude turn** is
  a normal message with `kind: 'error'` (see `chat_workflow.go`'s
  `runOneClaudeTurn`), not this field.
- **`cs.claudePos`** — added to the existing `cs` reactive alongside
  `threadPos`, bound in the same `bindUrlState(cs, [...], { ns: 'rel' })`
  list as `rel.cpos`, so a refresh restores the exact turn the reviewer was
  on (same `restorePending`/`applyRelRestore` snapshot-then-reapply pattern
  as every other panel cursor field).
- **`enterClaudeChat(pr, commentTargetFn)`** — the single entry point for
  both call sites above. `commentTargetFn` (the same callback
  `home.mjs`/`ClaudeChatPanel` already thread through, mirroring
  `commentTarget()`) is stashed in a module `let currentCommentTarget` so the
  keyboard-only re-entry (from `'thread'`) doesn't need its own copy.
- **`ensureAndLoadChat`/`loadChatMessages`/`sendClaudeMessage`** — the write
  paths: `POST /api/workflows/claude_chat` (idempotent, ensures the
  Execution), `GET /api/chat?commentId=` (read-only transcript),
  `POST /api/workflows/{runId}/signals/message` (one reviewer turn — free
  text or a clicked question option, same Signal). **No optimistic append**:
  the Signal round-trip runs the Activities (including the real `claude`
  subprocess call) **inline** — see "Hard rule: only workflows mutate state"
  and the `SignalWorkflow`/`advance()` mechanics in `tembed-workflows.md` —
  so `sendClaudeMessage`'s own `await` genuinely spans "Claude thinking", and
  a plain refetch once it resolves is enough. No token streaming, per
  product decision — "Claude denkt…" (`cc.busy`) is the only status shown
  mid-turn.
- **`ensureChatPoll`** — a light `setInterval` (4s), fetching only while
  `cs.focus === 'claude'`. Not strictly required for the reviewer's own
  sends (already covered by the inline-Activity await above), kept as the
  agreed transport (fetch + polling, explicitly no SSE/websocket) for
  anything else that might move the conversation along without the reviewer's
  own send being the trigger — e.g. a `KindAction`/`KindError` outcome turn
  from the opt-in comment-thread influence path (see "Opt-in influence on the
  left comment thread (Phase 4)" in `.claude/rules/workflows-comments.md`).
- **`claudeChatVisible()`** — `hasVisibleComments() || cs.focus === 'claude'`.
- **`ClaudeChatPanel(state, commentTarget)`** — the exported component
  `home.mjs` mounts as its own **sibling column** next to
  `comments-and-related` inside `<main>`'s flex-row (not stacked inside that
  column — a chat transcript is a different kind of content from a code
  excerpt). Width reuses the exported `relatedColumnWidthCls()` verbatim —
  same clamp as `InlineComments`/`related-code`, for visual symmetry across
  all three columns, not a new content-driven computation.

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

## Test: `tests/claude-chat-panel.spec.mjs`

Seeds an ordinary comment via the API (mirrors `comment-thread.spec.mjs`,
its own PR via `seededPr`), clicks the comment row, and drives the whole
chain with real keypresses (`→` comment→thread, `→` thread→claude): sends a
plain message and asserts the programmed reply, sends a second message and
asserts the 3 option buttons render, clicks one and asserts both the
recorded `claude-question-answer` and the next programmed reply, then `←`
back into the thread. Deliberately does **not** assert on the transient
"Claude denkt…" line (the Fake resolves near-instantly, and asserting a
transient state is explicitly disallowed — see
`.claude/rules/testing-playwright.md`).

## Ripple: every existing "→ from the diff enters the related panel directly"
## test needed an extra hop

Any pre-existing spec that pressed `→` twice (list→diff, diff→related) on a
unit **without** a seeded comment now lands on `'claude'` on the second
press, not `'code'` — an intentional consequence of the product decision
above, not a regression. Fixed by inserting either one more `→` (comment
already exists in that test) or one `↓` (comment-less unit, falls through
past the freshly auto-created empty chat) at each such call site:
`related-nav.spec.mjs`, `related-tests-group.spec.mjs`,
`related-nested-chip.spec.mjs`, `footer-explanation.spec.mjs`,
`scroll-focus-vertical-only.spec.mjs`, `urlstate.spec.mjs`. Two of
`scroll-focus-vertical-only.spec.mjs`'s "the originally-focused diff column
must still be fully in view" sanity assertions were removed rather than
patched: with the embedded Claude chat now sitting between the diff and the
related panel, `scrollFocusIntoView`'s existing left-alignment of that
intermediate stop already scrolls the original diff column partway
off-screen at a narrow viewport — expected pre-existing scroll behaviour
(see "Unfocused columns collapse into a narrow rail" in `drilling.md`), not
something this spec (which guards against *additional* scroll from chip
navigation specifically) needs to re-assert.

## Open (frontend gaps — Phase 4's backend is now built)

- **Phase 3's backend is built** (a per-conversation shadow worktree + a
  fast-forward-only commit/push — see "claude_chat" → "Agentic edits" in
  `.claude/rules/workflows-comments.md`), but **this panel has no UI yet to
  trigger it**: `sendClaudeMessage` always sends a plain (`action: ""`) turn.
  A later pass needs to add the composer action(s) that set
  `action: "edit"`/`"commit"` on the `POST .../signals/message` call — no
  backend change needed, only this file's send path.
- **Phase 4's backend is now built** — on the reviewer's explicit request,
  `chat_workflow.go`'s `applyChatCommentAction` signals the left comment
  thread's own `task_code_comment` Execution (`Source: "ai"`) and records a
  `Kind: chat.KindAction` (success) or `Kind: chat.KindError` (failure)
  confirmation turn — see "Opt-in influence on the left comment thread
  (Phase 4)" in `.claude/rules/workflows-comments.md`. **`ClaudeChat.mjs` does
  not style `KindAction` distinctly yet** — `msg.kind === 'action'` isn't
  checked anywhere in this file, so such a turn currently renders as a plain
  bubble (readable, since its text is a human sentence, just visually
  identical to an ordinary reply). A later pass should give it its own small
  marker (mirroring `isError`'s `msg.kind === 'error'` check) so a successful
  comment-thread action is visually distinguishable, per the app-wide
  never-colour-only rule.
- No draft-persistence (`composeDrafts`/`replyDrafts`-style) for the chat
  composer — a page navigation away loses an unsent, half-typed message. Not
  requested; flagging as a known gap mirroring the existing comment
  composer's own draft feature.
