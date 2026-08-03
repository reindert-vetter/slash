# Command palette (`src/CommandMenu.mjs`)

Every menu in the review tree is the same searchable popover component, opened
in a different **mode**. `Enter` opens a block-scoped palette, `/` a PR-wide
one, and several follow-up menus open by themselves after an approve. The
command lists live in `home.mjs`; `CommandMenu.mjs` is pure presentation — it
receives `menu`, a `resolve(query)` function and `onRun`, and contains no
filter or navigation logic.

Arrow-key navigation of the tree itself lives in
`.claude/docs/keyboard-navigation.md`.

## Modes

| `ms.mode` | Opened by | List |
|---|---|---|
| `block` | `Enter` in list/diff mode | `COMMANDS` |
| `pr` | `/` anywhere, and `Enter` at stop 1 (the description column) | `PR_COMMANDS` |
| `comment` | `Enter` on a focused comment row with an empty reply field | `commentCommandsFor()` |
| `prComment` | `Enter` on a comment-index row | `prCommentCommandsFor()` |
| `compose` | `Enter`/"Place…" with text in the composer | `COMPOSE_COMMANDS` |
| `postApprove` | automatically after a palette approve | `POSTAPPROVE_COMMANDS` |
| `reviewApprove` / `reviewChoice` / `reviewReject` | automatically when nothing is left ahead | `REVIEW_APPROVE_COMMANDS` / `REVIEW_CHOICE_COMMANDS` / built from the typed text |

`openMenu(mode)` sets the mode, `closeMenu` resets it to `'block'`, and
`resolveCommands`/`rootCommandsFor` switch on it.

## Opening, ownership and positioning

`home.mjs` (`menuOverlay`) renders the menu once at `<main>` level as a
`position:fixed` element (`data-testid=command-anchor`, the menu itself
`data-testid=command-menu`) with a full-screen catch layer
(`data-testid=command-overlay`) that closes on an outside click.

While the menu is open it **owns the keyboard**: `onKeydown` handles `↑`/`↓`
(selection), `Enter` (execute via `runCommand`, which closes first and then
runs the action), `Esc` (close — from a submenu it first steps back to the
root), and block navigation is suspended. Typed characters flow into the
focused input (`data-testid=command-input`, two-way bound to `ms.query`).

`positionMenu` anchors it just **below** the selection and gives it the width
of the right (NEW) pane — half width, over the code you're reviewing:

- **Vertical:** `menuAnchor()` → the **last** row of the active change unit
  (`[data-change-active-end]`, present in both list preview and diff mode),
  otherwise the block card, otherwise the sidebar row. Deliberately the *last*
  row: for a multi-row `group` or an extended Shift+↑/↓ range the menu must
  float below the *bottom* of the selection instead of covering it.
  `[data-change-active]` (`Block.mjs`) keeps marking only the **first** row and
  stays reserved for `scrollChangeIntoView`.
- **Width + left edge:** `menuRegion()` → the `[data-pane="new"]` pane of the
  selected block, falling back to `[data-pane="old"]` for a removed block, then
  the whole block column (`data-pane` sits on `codePane`, `Block.mjs`).
- **From the block index** (`state.mode==='list'`, the `block`/`postApprove`
  palettes — `isIndexMenu()`): anchors on the selected sidebar row
  (`[data-idx="${state.selected}"]`) and takes the full sidebar width
  (`[data-testid="pr-index"]`) — not the list-mode diff preview in `<main>`,
  which also carries a `[data-change-active]` but is not where the reviewer
  pressed.
- **At stop 1** (the `pr` menu while `state.showDescription` — `isDescriptionMenu()`,
  applies to both `Enter` and `/`): anchors on `[data-testid="pr-info-card"]`
  with the width of `[data-testid="pr-info-column"]`. The card is tall, so the
  menu usually flips above/over the column, but it always sits next to the
  description instead of in the diff region. Outside stop 1 the `pr` menu keeps
  the default diff positioning. Test: `tests/pr-description-menu.spec.mjs`.
- **`comment` mode** anchors on the focused comment row resp. the thread pane;
  **`prComment` mode** on `[data-testid=comment-detail-card]`, falling back to
  `[data-testid=block-column]`.

If it doesn't fit below the screen it flips above, and is clamped within the
viewport regardless. It starts `visibility:hidden` until `positionMenu` has
placed it (no flash top-left), and repositions on resize, scroll (capture, also
inner scrollers), after every keystroke (the filter list changes height) and
220ms after opening (the panel width animates 200ms when stepping into the
diff).

### Ephemeral state: a stable `menu` plus a disposable `ms`

The menu state is deliberately **not** in the URL. It is split in two: a stable
`reactive({ open })` (which the top-level `${() => menu.open ? … : ''}` binding
hangs off) and a disposable `let ms = reactive({query, sel, sub, mode, commands})`
that `openMenu` **replaces with a fresh object on every open**. Orphan bindings
from a previous open then point at the old `ms`, which is never touched again,
so they never fire. `closeMenu` only sets `menu.open = false`.

This is load-bearing: arrow.js does not fully clean up a dropped subtree, so
reopening in a different mode used to crash (`W[t] is not a function`). For the
same reason `resolveLabel`/`snapshotCommands` resolve every **label function**
once, in `openMenu`, and store a plain string on `ms.commands`/`ms.sub` — a
label function reaching the nested `CommandMenu` tree becomes an ever-growing
ghost that recomputes on every later navigation step. See "arrow.js doesn't
fully clean up a dropped subtree" in `.claude/rules/arrowjs-pitfalls.md`.

### `withClose` + `defaultSel`

`withClose(list, onClose)` (`home.mjs`) prepends a pinned **"Close menu"** item
to every root list (`COMMANDS`, `PR_COMMANDS`, `COMPOSE_COMMANDS`,
`commentCommandsFor()`, `prCommentCommandsFor()`, `POSTAPPROVE_COMMANDS`,
`REVIEW_APPROVE_COMMANDS`, `REVIEW_CHOICE_COMMANDS`) **and** every submenu
(`children`, incl. "Open GitHub", the Jira submenus and the approve-confirm
submenu). Choosing it always closes the entire palette, even from a submenu
(`Esc` still just steps one level back). `postApprove`'s own `onClose` also
clears `postApproveTarget`.

So the pinned row never becomes the default Enter action, every fresh
menu/submenu opens on the **2nd item**: `defaultSel(list)` =
`Math.min(1, Math.max(0, list.length-1))`, used by `openMenu`/`enterSubmenu`/
the Esc-back-to-root branch. Deliberately **not** applied to the `reviewReject`
step or the "no match" `make-comment` fallback — both are dynamic 0/1-item
lists where "type, Enter" would break. The per-keystroke `sel` reset
(`CommandMenu.mjs`'s `@input`) stays at `0` (the top row of the filtered
result).

### Filtering, submenus, and the no-match fallback

Filtering is a **subsequence fuzzy match** (`filterCommands`, exported from
`CommandMenu.mjs` so the keyboard handler walks exactly the same filtered list
as the render — `ms.sel` and the visible rows stay in sync).

A command may carry **`children`**: choosing it opens a submenu instead of
running an action (`runCommand` → `enterSubmenu`, which resets query/selection
and repositions). `ms.sub` holds the open child list; `resolveCommands` filters
that instead of the root list (without the comment fallback).

If filtering yields **nothing** for a non-empty query, the menu falls back to
one item, **"Create a comment with this"**, which starts the typed text
directly as a comment task on the selected line (`createComment` from
`RelatedPanel.mjs` → `POST /api/workflows/task_code_comment`, within the write
boundary). Filter + fallback both live in `resolveCommands(query)`.

## `Enter` — the block palette (`COMMANDS`)

Block actions only: toggle approve, comment on this line (`startComment` from
`RelatedPanel.mjs`), and **Open GitHub**. Deliberately **no** navigation items
(step in diff / next / previous) — that's what the arrows and `f`/`d`/`s` are
for.

At **stop 1** (the description column) there is no block context, so `Enter`
there opens the `pr` menu instead
(`openMenu(state.showDescription ? 'pr' : 'block')`). Block 0 in the list is a
different stop (`showDescription` is `false`) and keeps the block palette.

**Approve is scoped to the current navigation unit** (`toggleApprove`/
`approveTargetRows`): the whole block in list mode, the selected
group/line/call in diff mode — it approves exactly the rows of that unit, or
retracts them if already approved. At `gran==='group'`/`'line'` (not `'call'`)
it additionally sweeps a directly-following filler row along, one-way — see
"the filler-row sweep" in `.claude/docs/approval.md`.

**`focusLevel`/`drillCursor`-aware:** a drilled column has its own block plus
its own `change`/`gran` cursor, so `approveContext()` (`home.mjs`) resolves
`{ block, mode, gran, change }` once (mirroring
`findNextUnapproved`/`fKey`/`dKey`/`setDrillGran`'s own `focusLevel` branch) and
`approveNoun`/`approveTargetRows`/`toggleApprove`/`toggleCallApprove` + the
`COMMANDS` label take that context instead of reading `curBlock()`/`state.gran`/
`state.change`. Without it, `Enter` → "Approve …" invisibly approves the
top-level block while a drilled column owns the keyboard. See "Column
navigation" in `.claude/docs/drilling.md` and `tests/drill-approve.spec.mjs`.

The label is a function so it names the live unit (`approveNoun`): "Approve
this block" (list), "Approve these lines" (group), "Approve this line" (line),
"Approve this call" (call), and "Retract approval of …" when already approved.
See `.claude/docs/approval.md`.

**Open GitHub** has two children: *Line in Files changed* (`openGithubLine` —
the anchor `#diff-<sha256(path)><R|L><line>`, line = the `start` of the code
side plus the active unit's offset; new side `R`, removed block `L`) and *PR
page*.

## The postApprove follow-up menu

After approving **via the palette** (not via the block card's own checkbox,
which stays a plain toggling click), if there is still a next unapproved unit a
follow-up menu opens immediately (`ms.mode = 'postApprove'`,
`POSTAPPROVE_COMMANDS`): pinned **"Close menu"** or **"Ga door"** (default, the
2nd item — it only navigates, never auto-approves). This only triggers when the
action **added** approval (`toggleApprove`/`toggleCallApprove` detect that via
`allIn`/`keys.has(key)` **before** the mutation — a retract never opens it) and
`findNextUnapproved()` actually found something.

Two exceptions skip the menu and navigate straight away, both because there is
nothing to choose besides continuing:

- **The next unit stays within the same block** (step 1 below).
  `toggleApprove`/`toggleCallApprove` pass the just-approved block id into
  `afterApproveAction(approving, blockId)`, captured **synchronously** (before
  the async `findNextUnapproved` gap); `afterApproveAction` compares it against
  the plan's **landing block** (the last entry of `target.path`, or the
  top-level block at `target.root` for an empty path), plus `!keepList` and
  `root === state.selected`. On a match it calls `applyNextUnapproved(target)`
  directly. **Deliberately NOT a bare `target.path.length === 0` check** —
  inside a drilled column step 1's plan always carries a non-empty `path`
  (`state.drill.slice(0, level)`), so a path-length check would never fire
  there. Test: `tests/drill-approve-line-skip.spec.mjs`.
- **Approving from the block index** (`state.mode !== 'diff'`, captured
  synchronously as `keepList`): there is no diff/drill to jump into, only the
  sidebar selection to move. `applyNextUnapproved` branches on
  `target.keepList` and then moves **only** `state.selected` (to `target.root`)
  + `scrollSelectedIntoView()` — `target.path` is ignored, so an index approve
  never drills. Because `postApprove` can therefore never open with `keepList`
  true, its `postapprove-next` label is a plain string again ("Ga door"), not a
  keepList-aware function.

A diff-mode approve landing on a *different* block still opens the menu.

## `findNextUnapproved()` — walking the review tree

"Next" follows the review **tree**, not the flat sidebar list, depth-first
(`home.mjs`), four steps per call:

1. **Further within the column that owns the keyboard** — the top-level block
   (`state.gran`/`state.change`), or the drilled column at `state.focusLevel`
   with its own `state.drillCursor` cursor (`firstUnapprovedOwnUnit`,
   forward-searching at the current granularity).
2. **Down into its Underlying-code children** (`orderedChildBlocks` — the same
   order the panel shows, excluding `covered_by` to avoid the method↔test
   cycle), depth-first per child (`firstUnapprovedInSubtree`, cycle-safe via a
   `seen` set): the child itself from its first `'group'` unit, otherwise its
   own children, and so on. See `.claude/docs/underlying-code.md`.
3. **Up** through the drill stack: back to the parent (an earlier drilled
   column, or the top-level block) and its **next, not-yet-tried** sibling
   child, repeated upward.
   3b. (top level only) the **remaining methods** of the current `test_class`
   row — see `.claude/docs/test-class-grouping.md`.
4. **Across `state.blocks`** in sidebar order, also subtree-aware
   (`firstUnapprovedInSubtree` per candidate), so a top-level block that only
   has an Underlying-code child still open is not skipped.

With lazy `ensureCode` fetches for every visited block. Only **forward**, no
wrap, no searching back to skipped units — so a `null` result means "nothing
left ahead of me", not "the PR is done" (see the review-submit menus below).

It returns a plan `{ root, path, gran, change }` (`root` = top-level index,
`path` = the chain of PR blocks to drill through, empty = the top-level block)
and stashes it in `postApproveTarget`. "Ga door" applies it via
`applyNextUnapproved`, which trims `state.drill` to the common prefix with
`path` (mirroring `expandColumn`'s trim) and drills only the remainder
(`drillIntoChild`) instead of tearing down the whole stack for a nearby sibling
step; a different `root` resets `state.drill`/`drillCursor`/`focusLevel`. No
recomputation is needed — the palette owns the keyboard while it's open. This
is one-off: after navigating, no new follow-up menu opens.

**Steps 2/3/3b run regardless of `inDiff` — only step 1 is genuinely
diff-only.** They used to sit inside the same `if (focused && inDiff)` gate as
step 1, but `inDiff` (`level > 0 || state.mode === 'diff'`) is false in plain
list mode — exactly where a reviewer approves a small block or a freshly added
test method without ever pressing `→`. That silently returned `null` while a
sibling test method still showed `0/N`, or while a resolved-call child (hidden
from the flat sidebar via `resolvedCallTargetIds`, so unreachable by step 4)
still had unapproved rows. Step 1 staying a no-op in list mode is correct:
there is no cursor within the block to resume from, and approving the whole
block from the list already covered all of its own rows. Test:
`tests/findnextunapproved-list-mode.spec.mjs` (PR 110, PR 112).

## `lastIndexRowRect` — keeping a follow-up menu at the same spot

`isIndexMenu()` counts `postApprove` too, so `menuAnchor()` tries
`[data-idx="${state.selected}"]` for both menus. But a fully approved block's
row disappears from the sidebar immediately (see "Hiding approved blocks" in
`.claude/docs/approval.md`), and that happens *before* the follow-up menu
opens — `menuAnchor()` would then fall back to the whole `[data-testid="pr-index"]`
aside, whose much taller rect throws `positionMenu()`'s flip-above calculation
to the top of the viewport.

`lastIndexRowRect` (a module-level `let` next to `isIndexMenu`) caches the
row's `getBoundingClientRect()` while it still exists; once the row is gone,
`menuAnchor()` reuses that cached rect as a duck-typed object exposing only
`getBoundingClientRect()` (all `positionMenu()` ever calls). `openMenu(mode)`
resets the cache on every open that is **not** an approve follow-up
(`isReviewFollowup(mode)`, covering `postApprove` plus the three review-submit
modes), so a stale position never leaks into an unrelated session. Test:
`tests/postapprove-menu.spec.mjs`.

## Review-submit menus: `reviewApprove` / `reviewChoice` / `reviewReject`

When `findNextUnapproved()` returns `null`, `afterApproveAction` opens one of
two follow-ups based on `state.approvalTotal` (the PR-wide combined counter —
see "Combined approval per tree" in `.claude/docs/approval.md`), read after a
few `await Promise.resolve()` ticks (the `approvalSummaries`/`approvalTotal`
watch is decoupled and only fills as a microtask):

- **Everything approved** (`done === total`, `total > 0`) → `reviewApprove`
  (`REVIEW_APPROVE_COMMANDS`): pinned "Close menu" / **"Approve the whole PR"**
  (default). Nothing left to reject.
- **Something still open** somewhere outside the forward search → `reviewChoice`
  (`REVIEW_CHOICE_COMMANDS`): pinned "Close menu" / **"Approve the whole PR"**
  (default) / **"Reject the PR"**.

**Approving the whole PR is deliberately a TWO-STEP choice** (a real GitHub
review was "too easy to hit by accident"). Neither "Approve the whole PR" item
carries a `run`; both carry `children: REVIEW_APPROVE_CONFIRM_COMMANDS`, so
choosing it opens a one-item confirmation submenu through the ordinary
`children` mechanism (no new mode). That submenu also goes through `withClose`,
so its one real item ("Yes, approve the whole PR") is the default 2nd item, and
only that calls `submitReview('APPROVE')`. Both items carry a check-in-circle
icon (`c.icon`, `commandIcon` in `CommandMenu.mjs`); the icon **shape** plus
the label text carry the "this affects the whole PR" meaning, the emerald
colour is decoration only (see the colourblind rule in
`.claude/rules/conventions.md`). "Reject the PR" got no confirm step — its
mandatory free-text reason already is one.

`submitReview` posts `POST /api/workflows/submit_review {pr, event, body}` (the
sanctioned write path, see `.claude/rules/workflows-write-boundary.md` and
`submit_review` in `.claude/docs/workflows-trackers.md`). Error handling is
deliberately minimal (`console.error`) — this app has no toast convention. A
successful submit is a fresh workflow run, so `submitReview` calls
`pollWorkflows()` so it shows in "Taken" before the next `WORKFLOWS_POLL_MS`
tick.

**"Reject the PR" doesn't post right away** — GitHub (and
`validateSubmitReview`, 400) reject an empty `REQUEST_CHANGES` body. It opens
`reviewReject`, a **free-text** step that reuses the palette textarea
(`ms.query`) as the reason field. `rootCommandsFor` returns no static list;
`resolveCommands` builds **one** command from the typed text, and only once
it's non-empty — an empty query yields `[]`, which via `onKeydown`'s existing
`if (list[ms.sel]) runCommand(...)` guard makes `Enter` a no-op rather than a
silent close. `CommandMenu.mjs`'s placeholder changes for this mode ("Type the
reason for rejection (required)…") as the only instruction. With text, the one
row calls `submitReview('REQUEST_CHANGES', reason)`.

All three modes share the `lastIndexRowRect` exception with `postApprove` via
`isReviewFollowup(mode)`. Tests: `tests/review-submit-menu.spec.mjs`, plus the
last test in `tests/postapprove-menu.spec.mjs`.

### After a successful submit: copy a one-line summary to the clipboard

`submitReview` also copies a short summary of the just-submitted review to the
clipboard — for pasting into Slack/a PR checklist elsewhere — but **only**
after the `fetch` actually succeeded (never on a `!res.ok` or a network error,
both of which `return`/throw before reaching this). `buildReviewClipboardText`
builds the text from `state.prUrl || GITHUB_PR` (the same fallback the
"Open GitHub" links use) plus the event:

- **`APPROVE`** — `${link} ✅`, or, when the reviewer has own comments still
  open, `${link} ✅ met N comment`/`comments` (singular at exactly 1). "Own"
  reuses `isOwnComment` (see below); "still open" is `c.status !== 'resolved'`.
  The count (`ownOpenCommentCount`) is **PR-wide**, not scoped to one block —
  it reads the whole `commentListSnapshot()` (`RelatedPanel.mjs`), matching
  what "approving the whole PR" itself covers. Deliberately **not** scoped to
  "placed during this session" — a reviewer who reopens the same PR later
  still gets an accurate count of what they left open.
- **`REQUEST_CHANGES`** — deliberately **no emoji**: `${link} met nog een paar
  aanpassingen: ${reason}`, `reason` being the typed rejection text verbatim
  (only internal whitespace/newlines are collapsed to one line — never
  summarized or truncated).

`copyReviewSummary` wraps `navigator.clipboard.writeText` with the same
minimal error handling as `submitReview` itself (`console.error`, no toast
convention). Tests: the three cases (no comments, with own unresolved
comments, reject) in `tests/review-submit-menu.spec.mjs`, using the same
`navigator.clipboard` stub as `tests/overview.spec.mjs`'s "Kopieer GitHub URL"
test.

## The comment-scoped menu (`comment`, `commentCommandsFor`)

If the keyboard is on a placed comment row in `RelatedPanel`
(`cs.focus === 'comment'`, before stepping into the thread) **and the reply
field is empty**, `Enter` opens this menu instead of the block palette — three
to five rows:

1. **"Close menu"** (pinned).
2. **"Resolve comment"** (default, 2nd item).
3. **"Verwijder comment"**.
4. **"Comment hiervan maken"** — only when `source === 'ai'` (a `code_warning`
   finding; see "Converting an AI-controle finding into a real comment" in
   `.claude/docs/comments-panel.md`).
5. **"Open op GitHub"** — only when the comment actually has a GitHub anchor.

`commentCommandsFor()` is built fresh on every open (unlike the static lists it
is data-conditional per focused comment), still via `withClose`.
`focusedCommentGithubId()` (`RelatedPanel.mjs`) decides whether item 5 exists
at all — `null` for a local note or a comment whose GitHub post never landed
(`comments.Comment.GithubID` is 0 then) — so there is never a dead row. It
opens `(state.prUrl || GITHUB_PR) + '#discussion_r' + githubId`; this panel only
ever shows block-scoped review comments (`kind === ''`), so that anchor form is
always right (never `#issuecomment-<id>`).

A **non-empty** reply field leaves `Enter` alone — the field's own `keydown`
wins (`sendReaction`), so "type a quick reply, press Enter" keeps working
(`isCommentFocused`/`commentReplyEmpty` guard the distinction).

**Mouse path:** the send-status button next to "Stuur" (`reaction-status`)
opens this same menu on click, so resolve/delete stay reachable without the
keyboard. See the send-status paragraph in
`.claude/docs/comments-panel.md`.

- **"Verwijder comment"** → `deleteCommentAndSelectRow`/`deleteFocusedComment`
  sends a **`delete` Signal** (`POST /api/workflows/{runID}/signals/delete`) to
  the comment's Execution — the only write path. The workflow marks the comment
  `deleting`, removes it from GitHub (best-effort) and then from its read
  model. The request rides along on the same `reply` Signal as a reaction
  (`ReactionSignal.Action`) because a workflow can only `WaitSignal` on one name
  at a time. Where the keyboard lands afterwards: see
  `.claude/docs/comments-panel.md`.
- **"Resolve comment"** → `resolveFocusedComment` sends a **`reply` Signal**
  with `done:true` and the sentinel body `"/resolve"` (never posted as text).
  The workflow sets the status to `resolved` and, for a review-diff thread,
  resolves the conversation on GitHub too; a PR-wide thread has no GitHub
  resolve concept, so it stays local. See
  `.claude/docs/workflows-comments.md`.

## The comment-index item menu (`prComment`, `prCommentCommandsFor`)

`Enter` on a comment-index row (a PR-wide comment as an ordinary "Start" row)
opens this; `→` deliberately does something else (steps into the thread) — see
"Comment-index items" in `.claude/docs/keyboard-navigation.md` for the arrow
side and `.claude/docs/comments-panel.md` for the row/detail card itself.
`selectedComment()` gates a branch checked **before** the generic
Enter-opens-menu handling.

Rows: **"Sluit menu"** (pinned) → **"Beantwoorden"** and **"Resolve comment"**,
whose order depends on `isOwnComment(c)` (`home.mjs`): for the reviewer's own
comment — placed in this app (`!c.source || c.source === 'ui'`) or placed on
GitHub by them and later imported (`c.source === 'github'` +
`c.author === meLogin()`) — **"Resolve comment"** comes first (thus default);
otherwise **"Beantwoorden"** stays first. Both are always present, only the
order changes → optionally **"Comment hiervan maken"** (only
`source === 'ai'`, never true at the same time as "own") → **"Ignore"**
("Ignore ongedaan maken" once ignored — `toggleIgnoreComment`, a durable
sidebar-visibility flag through the per-PR `ignore_comment` tracker).

Because the detail card already shows on selection, "the thread shows above the
menu" is just a consequence of the anchoring, not a separate menu variant.

**"Beantwoorden"** (`startPrCommentReply`) only reveals + focuses the reply
textarea in the detail card; typing + `Enter` (or the send button) sends, via
the same `reply` Signal (`done:false`). **"Resolve comment"**
(`resolvePrCommentItem`) sends that Signal with the `"/resolve"` sentinel +
`done:true`. No new write path either way.

## The compose (comment-kind) menu (`compose`, `COMPOSE_COMMANDS`)

If the composer is open and text has been typed, `Enter` (and the composer's
own **"Plaats…"** button, via `RelatedPanel`'s `openCompose` prop) opens this
menu instead of placing the comment immediately. Six rows: **"Sluit menu"**
(pinned), **"Plaats comment"** (default, 2nd — so "type, Enter, Enter" still
places it directly), *Claude command* (placeholder), *Let Claude implement this
(group/line/call)* (placeholder, label names the unit via `granNoun()` from
`commentTarget()`), **"Alleen voor mijzelf"**, and *Jira* (a submenu of three
placeholders).

**"Plaats comment"** → `placeComment(state, commentTarget)` posts a normal
public comment; **"Alleen voor mijzelf"** → `placeComment(…, { local: true })`
stores a private note that never reaches GitHub (see the `local` flag in
`.claude/docs/workflows-comments.md`). Both `run`s are `async` and call
`pollWorkflows()` after a successful place, so the new `task_code_comment` run
shows in the "Taken" card immediately instead of at the next
`WORKFLOWS_POLL_MS` tick. Placing a comment also retracts the approval of the
unit it hangs on — see `.claude/docs/approval.md`.

The Enter branch sits in `onKeydown` **before** the `relatedActive()` branch
(`isComposeOpen()` + `composeHasText()`), so it works whether the composer was
opened by keyboard or button; **Shift+Enter** falls outside it and stays a
newline. This was the first flow to open a menu **over** an open composer,
which is what surfaced the arrow.js orphan-binding crash the fresh-`ms` split
fixes (above).

## `/` — the PR-wide menu (`pr`, `PR_COMMANDS`)

The same overlay, with actions on the **whole PR**. Five root items:

1. **"Sluit menu"** (pinned).
2. **"GitHub"** (submenu, thus the default item — a submenu rather than a
   direct action, deliberately left as-is): *Open on GitHub* and *Place comment*
   (reuses `startComment`).
3. **"Jira"** (submenu): *Open in new tab* (deep link), plus *Place comment* and
   *Create subtask* as **placeholders** (no Jira write integration yet).
4. **"Diepgravend onderzoek"** — starts `code_warning` on Opus
   (`checkPRWarnings`, see `.claude/docs/workflows-analysis.md`).
5. **"Show full description" / "Collapse description"** — a label function
   toggling `state.descriptionExpanded`, the same ephemeral flag as the in-card
   "more…" affordance (see `.claude/docs/detail-layout.md`). The label is
   snapshotted at open time by `snapshotCommands`, so no reactive binding leaks
   into the `CommandMenu` tree.

A typed `/` in a focused input never reaches this handler — the
`relatedActive()` branch catches it earlier, so the character flows into the
field.

The Jira/GitHub links need **PR metadata** (title + URL, and the `KEY-123`
ticket key derived from the title) from the `prmeta` read model via
`GET /api/pr?pr=N`, filled by `pr_status` (see
`.claude/docs/workflows-trackers.md`). `home.mjs` (`loadPRMeta`) ensures the
tracker on load; missing metadata falls back to the bare PR URL resp. the Jira
base.
