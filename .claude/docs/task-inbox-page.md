# The task inbox page (`/inbox`)

A personal, scored to-do list — distinct from the PR-centric `/pr-overview`
inbox — over the derived **task** list from `GET /api/tasks` (the `task_inbox`
workflow's aggregation of PR reviews, unread comments on your own PRs, and Jira
tickets assigned to you; see "The task inbox" in
`.claude/docs/workflows-trackers.md` for the backend/scoring side).
`inbox.html` → `src/inbox.mjs`, registered in `api.go`'s `routes` next to
`/pr-overview`, same static-shell pattern. **Not yet linked from either other
page** — reached only by navigating to `/inbox` directly.

## Layout

Mirrors `/pr/<id>`: a `position:fixed` left **index**
(`data-testid=task-index`, `w-[26rem]`, mirrors `pr-index`) and a
`position:fixed` right **detail panel** (`data-testid=task-detail`, mirrors the
block column). **No URL-state binding** (unlike `/pr/<id>`):
`state.selectedId` lives purely in memory and resets on every page load to the
first visible row.

## Index (`taskIndex`)

One row per task (`taskRow`, `data-testid=task-row`, `data-task-id`), sorted
**points descending** (tie-break: most recently updated first,
`visibleTasks()`) — a kind icon (`ICON_PATHS`/`KIND_ICON_CLS`, one SVG per
`pr_review`/`comment_unread`/`jira`), title + subtitle, a points pill
(`data-testid=task-points`) and a clock-icon **snooze button**
(`data-testid=task-snooze-btn`).

### Snoozing

The snooze button opens a small duration popover (`snoozePopover`,
`data-testid=task-snooze-popover`: Tomorrow 08:00 / Next Monday 08:00 / 7 days
/ 14 days / Always — `SNOOZE_CHOICES`) right on the row. Choosing one calls
`snoozeTask(taskId, kind)`: `snoozeUntil(kind)` computes the **absolute**
expiry in browser-local time, the row is **optimistically** removed
(`state.snoozes` reassigned wholesale, so it disappears immediately, reconciled
on the next `loadSnoozes()` poll), and the choice is sent as a `SnoozeSignal`
to the per-repo `task_snooze` tracker
(`POST /api/workflows/{taskSnoozeRunId}/signals/snooze {taskId, until}` — the
sanctioned write path, see "Snoozing a task" in
`.claude/docs/workflows-trackers.md`).

Below the row list a **"Show/Hide N snoozed tasks"** toggle
(`data-testid=task-snoozed-toggle`) expands a compact list of currently-snoozed
tasks (`data-testid=task-snoozed-row`, `snoozedTasks()`) with their expiry
(`formatSnoozeUntil`) and an **unsnooze** button
(`data-testid=task-snoozed-unsnooze` → `unsnoozeTask`, sends
`{taskId, clear:true}`). `isSnoozed(taskId)` is a read-time expiry check
(`until === 0 || until > Date.now()`). The duration choices, the hidden drawer
and this read-time check all mirror the removed per-PR `ignore` feature, just
keyed on a task id instead of a PR number.

## Detail panel (`taskDetailPanel`/`taskDetail`)

Shows the selected task's kind-specific view (`detailBodyFor`, routed through a
`${() => …}` function binding so a kind switch actually swaps the nested
template shape instead of leaving the previous kind's DOM in place — the
"static template↔string slot" pitfall in `.claude/rules/arrowjs-pitfalls.md`,
generalized here to template↔template) plus a shared **points breakdown**
(`pointsBreakdown`, `data-testid=task-points-breakdown`: the total plus one
`data-testid=task-point-note` row per `PointNote` the backend computed —
"basis" first, always present, then each matching bonus rule; scoring table in
`.claude/docs/workflows-trackers.md`).

- **`pr_review`** (`prReviewDetail`): title, author, `+adds −dels`,
  review-decision pill, a CI-status pill (`CHECKS_STYLE`), and action links —
  **"Open review tree"** (`data-testid=task-open-tree`, only when
  `detail.hasGraph`, links straight to `/pr/<n>`) and **"Open on GitHub"**.
- **`comment_unread`** (`commentUnreadDetail`): title, file/label, the same
  `composeTargetHint` code-fragment card `RelatedPanel.mjs` uses for a placed
  comment's reference code (reused, not duplicated — only shown when the task's
  comment carries one), the full thread (`commentThreadMessage`, reusing
  `avatarHTML`/`commentBody` from `avatar.mjs`/`RelatedPanel.mjs`), a reply
  textarea (`data-testid=task-reply-input`) and two buttons — **"Verstuur"**
  (`data-testid=task-reply-send` → `replyComment`) and **"Oplossen"**
  (`data-testid=task-reply-resolve` → `resolveComment`, sends the sentinel
  `/resolve` body when the field is empty). Both go through **the same,
  existing** `task_code_comment` reply Signal
  (`POST /api/workflows/{runId}/signals/reply {author, body, done}`) that
  `RelatedPanel.mjs` already uses — no new write path: a `comment_unread`
  task's id is `"comment:" + runId` (`commentRunId(t)` strips the prefix) and a
  comment's `RunID` **is** its id (see `modules/comments` in
  `.claude/docs/workflows-comments.md`), so the same Signal target resolves it.
- **`jira`** (`jiraDetail`): title, ticket key + status, the description
  rendered as **Markdown** (`renderMarkdown`, the same `snarkdown`-based helper
  as the PR-info column, see `.claude/rules/conventions.md`), and an **"Open in
  Jira"** link (`data-testid=task-open-jira`).

## Load / poll (mirrors `overview.mjs`)

On load, `init()` ensures both trackers (`POST /api/workflows/task_inbox` and
`…/task_snooze`, each returning a Run ID) and then immediately loads both
read-models (`GET /api/tasks`, `GET /api/tasksnoozes`) — showing whatever is
already there.

**The `refresh` Signal on the task-inbox tracker is deliberately NOT awaited
before that load.** `tembed`'s `SignalWorkflow` runs Activities inline/blocking
(`tembed/engine.go`'s `advance()`), and the `task_inbox` aggregation includes a
live Jira lookup (`modules/jira`'s `AssignedToMe`, a real `acli` subprocess)
that can take seconds — or hang indefinitely if `acli` needs interactive
re-auth with no TTY. Awaiting it left the whole page stuck on "Laden…", which
read as "the page is broken" even though both GETs worked fine; don't
reintroduce that. `refreshTaskInbox()` therefore runs in the background
(`.then(() => repollAfterRefresh())`), mirroring `overview.mjs`'s
`sendRefresh()`/`repollAfterRefresh()`: a few extra reloads of both read-models
1.5s apart right after the refresh lands, then settling into the 60s heartbeat
(`sendHeartbeat`, only while the tab is visible+focused — `activeTab()`) + 15s
reload (also only while active) cadence. Regression test:
`tests/inbox-tasks.spec.mjs` ("shows the existing task list without waiting for
a slow refresh signal" — holds the `signals/refresh` response open indefinitely
via `page.route`).

## Keyboard

A plain `window` `keydown` listener — no command-palette/popover-focus
machinery like `/pr/<id>`/`overview.mjs`. `↑`/`↓` (`moveSelection`) walk
`visibleTasks()` and scroll the row into view; `s` toggles the snooze popover
for the selected row; `Escape` closes an open popover, or first blurs a focused
textarea/input if one has focus. Typing in the reply textarea is left alone
(the listener bails out early whenever `document.activeElement` is a
TEXTAREA/INPUT, except for `Escape`).

## Write paths

All sanctioned: snooze/un-snooze (`task_snooze`'s `signals/snooze`) and comment
reply/resolve (the existing `task_code_comment` reply Signal) — both
start-or-signal an Execution, per
`.claude/rules/workflows-write-boundary.md`. Everything else on this page is
read-only (`GET /api/tasks`, `GET /api/tasksnoozes`).

Test: `tests/inbox-tasks.spec.mjs` (all three kinds rendered with a points
badge + breakdown; an unread comment placed via `task_code_comment` on an
authored PR turns it into a `comment_unread` task deterministically, entirely
offline).
