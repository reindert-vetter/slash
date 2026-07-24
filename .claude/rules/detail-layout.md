# Detail layout & related panel (placeholder)

To the right of the sidebar sits the `DetailPanel` (`home.mjs`): a `<main>` as a
**flex-row** that packs its columns **from the left** (`justify-start`, no
stretching) and scrolls horizontally (`overflow-x-auto no-scrollbar`) as soon as
together they're wider than the screen — the `no-scrollbar` utility (`index.html`)
hides the scrollbar chrome, the scrolling itself keeps working (both
programmatically and via trackpad/mouse). **The resting position is always
flush-left:** a `resetMainScroll()` helper (`home.mjs`, next to
`scrollFocusIntoView`) forcibly resets `<main>.scrollLeft` to `0` on every
transition *to* the resting position — `enterDiff`/`openTask` (list → diff,
`focusLevel===0 && drill.length===0`), `applyNextUnapproved` for an empty `path`
(no drill), and the two `←` paths in `onKeydown` that respectively pop
**fully** out of a drilled column back to `focusLevel===0` and that leave the
whole diff session (`state.mode='list'`). This covers a stray manual horizontal
scroll (trackpad/scrollbar-drag) that would otherwise keep hanging around until
the next drill-focus switch. **This deliberately does not fight back
during/after the drilling itself** — as long as `focusLevel > 0` remains (drilled,
even after a partial `←` pop) the existing, intentional scroll-to-the-right of
`scrollFocusIntoView` takes precedence (see "Unfocused columns collapse into a
narrow rail" further down): that deliberately lets earlier columns disappear
off-screen to the left, with the ‹ chevron hint. Regression test:
`tests/main-scroll-rest-left.spec.mjs`.

**PR-info column, stop 1 of the nav chain, hidden by default, physically to the
left of the pr-index** (`data-testid=pr-info-column`, `w-[39rem]` — 1.5x the
original `26rem`, widened so title/summary/description/Jira box truncate less
quickly —, rendered by `prInfoCard(state)` inside its own `PrInfoPanel(state)`
component in `home.mjs`). This column is the leftmost stop of the left→right
navigation chain described in `.claude/rules/keyboard-navigation.md`, and is also
**visually** the leftmost spot on the screen — not as the first child of `<main>`
(that was the case earlier, but then it only appeared *after* the pr-index
instead of before it), but as its **own `position:fixed` panel**, a sibling of
`<aside>` (the pr-index, `BlockList.mjs`) and `<main>`, mounted before both in
`home.mjs`. Reason: `<aside>` is itself `position:fixed` and thus sits
**outside** `<main>`'s flex-flow — to actually get the PR-info column visually
before it (instead of after, as a flex-child of `<main>` would do) it must sit
at the same level and take over the pr-index's fixed `left-6` spot, while the
pr-index itself shifts to the right.

`state.showDescription` (default `false`) determines whether the column exists
— closed, it takes up **no space** at all (the entire
`${() => state.showDescription ? html\`…\` : ''}` block drops away, as before).
Open (only possible in `state.mode==='list'`, see below) makes two things
happen at once, both driven by the same `state.showDescription` flag, so always
in lockstep:
- `PrInfoPanel` appears at `left-6` (the spot where `<aside>` normally sits).
- `<aside>` (the pr-index) shifts itself `40.5rem` to the right
  (`translate-x-[40.5rem]` instead of `translate-x-0`, in `BlockList.mjs`'s own
  class ternary — before the existing `mode==='diff'` check, which takes
  precedence: in diff mode the pr-index still shifts entirely away, regardless
  of `showDescription`). 40.5rem = the width of the PR-info column (39rem) plus
  the 1.5rem gap between them, so both columns sit snugly against each other —
  the same gap as between the pr-index and `<main>` normally.
- `<main>` (`DetailPanel`) in turn **also** shifts 40.5rem to the right
  (`left-[69.5rem]` instead of the usual `left-[29rem]`, in the same class
  ternary as the existing `mode==='diff' → left-6` branch), so the block column
  doesn't end up underneath the shifted pr-index. This is **decoupled from**
  `<aside>`'s own transition but uses the same 40.5rem distance, so both move
  in the same 200ms CSS transition in sync.

Reached from the pr-index (stop 2, `state.mode==='list'`) with `←`; `→` closes
it again. While it's open, `onKeydown` ignores `↑`/`↓` (no internal cursor).
Both this card and the pr-index `<aside>` show the **same** on/off indigo
focus border as the block-diff card while they hold the keyboard — see
"Focus highlight per stop" in `.claude/rules/keyboard-navigation.md` for the
full pattern. A white card with title + Jira badge, a meta line (author,
`+add −del`, file count, branch, "on GitHub ›"), a **Summary** section
(Claude text), a **Description** section (PR body + optionally a Jira box),
and review/CI pills at the bottom.
**Description truncation (`state.descriptionExpanded`, ephemeral):** a **long**
PR body (> `DESC_TRUNCATE_AT` = 280 characters) is truncated by default
(`max-h-40 overflow-hidden`) with a clickable fade affordance at the bottom
(`data-testid=pr-info-body-toggle`, "more…") that expands the body fully; once
open it becomes a plain "Collapse" link. A **short** body always renders in
full (no misleading toggle — purely based on character length, so
deterministic, no DOM measurement). The same flag is also toggled by the
PR menu item **"Show full description" / "Collapse description"**
(`PR_COMMANDS`, `/` menu, see `.claude/rules/keyboard-navigation.md`), so the
in-card click and the menu stay in lockstep. `state.descriptionExpanded`
(default `false`) lives **outside the URL** (ephemeral, just like
`showDescription`). The class strings of the body + toggle are **whole-value**
function bindings (no partial interpolation — arrow.js pitfall in
`conventions.md`). The review/CI pills are styled like the dark-zinc pills in
`overview.mjs` but in the light card theme (`bg-emerald-50`/`bg-rose-50`/
`bg-amber-50` instead of `bg-emerald-500/15` etc.). The card reads
**exclusively** `state.prMeta`/`state.pr`/`state.prUrl`/`state.jiraKey` —
never `b.code` — so it never becomes a co-subscriber with the diff render (see
the "stuck on loading" pitfall in `conventions.md`).
**Progressive loading:** `state.prMeta` (empty object at start) is
**wholesale reassigned** by `pollPRMeta` in `home.mjs` on every poll of
`GET /api/pr?pr=N` (every 1.5s, until the statuses are there or after a max of
20 polls) — the `pr_status` workflow fills the `prmeta` read-model in **3
stages** (basics → Claude `summary` → review/checks statuses), so each section
appears as soon as its stage is done (placeholder ("generating summary…", a
pulsing skeleton pill) until then). `loadPRMeta` fires the
`POST /api/workflows/pr_status` **fire-and-forget** (not awaited — that POST
blocks until all 3 stages are done) and then immediately starts the poll loop.
All of this loads/polls regardless of whether the column is currently visible
— `state.showDescription` only determines whether it's rendered, not whether
the data exists by the time you open it.

**PR-wide comments (`PrWideComments`, under `prInfoCard` in the same
`pr-info-column`):** a second card (`data-testid=pr-wide-comments`, its own
internal scroll), **below** `prInfoCard` in the same `state.showDescription`
gated container in `PrInfoPanel` — so it has **no toggle of its own for
visibility**, it simply doesn't exist until the column itself is mounted.
**Height distribution follows which of the two cards holds the keyboard
(`isPrWideFocused()`, reads `pw.focus`):** with the keyboard on the description
(`pw.focus === null`) this card gets `flex-[4]` (4/5) and `prInfoCard` the
small share `flex-1` (1/5); navigating within this block (`pw.focus !== null`)
gives this card `flex-[5]` (5/6) and `prInfoCard` still `flex-1` (1/6) —
`prInfoCard` thus stays fixed at `flex-1` in both states, only this card
switches between `flex-[4]`/`flex-[5]`. This card's share in the
description-focused state was doubled on request (was 2/5) — the comments are
often truncated too short to read comfortably, so they get structurally more
room, not only once they have focus; a `min-h-[20rem]` on the card itself also
guarantees a readable floor, no matter how narrow the column actually turns
out to be in practice. Both class bindings are reactive whole-value functions
(`${() => ...}`, per the arrow.js class-binding convention) that read the same
`isPrWideFocused()` — `flex-1`/`flex-[n]` both set a 0% flex-basis, so the
ratio comes purely from the two grow numbers. Replaces the earlier fixed
`shrink-0 max-h-[16rem]` cap. Shows the comments with **`kind !== ''`** —
GitHub-imported issue comments and review(-summary) comments without a
line anchor — from the same `cs.list` that the block-scoped comments panel
(see "Comments/tasks sidebar" below) already loads/polls (`syncComments`, no
second fetch); `recomputeView` deliberately filters those *out* there
(`!c.kind`), so this card is their only place. Each row
(`data-testid=pr-wide-item`) shows a status dot (the same `CSTATUS_DOT` as the
block-scoped panel), a kind badge (`data-testid=pr-wide-kind`, "PR comment"
for `issue`/`review`, "Review" for `review_summary`), the existing
`sourceBadge` ("source: github") and a relative time (`relTime`). A click
(or `Enter`, see below) opens the thread **inline below the row** — unlike the
block-scoped panel (which shows the list and thread side by side) this is a
single column here, so the selected item shows its `threadMessages`/
`reactionBubble`s (reused, unchanged) plus a reply textarea
(`data-testid=pr-wide-compose`) and a separate resolve button
(`data-testid=pr-wide-resolve`) directly below its own row. Reply/resolve go
through **exactly the same** `POST /api/workflows/{runId}/signals/reply`
Signal as the block-scoped panel (`done:false`/`done:true`) — the backend
already turns a reply on a PR-wide thread into a new GitHub issue comment and
treats resolve as local-only, so the frontend needs no separate case.
The comment body text is rendered by one small shared helper
(`commentBody(c)`, `RelatedPanel.mjs`, reused by both this card and the
block-scoped `commentRow`) — purely plain text, deliberately no markdown yet,
but exactly the one place a later markdown pass would need to change.
**Own cursor `pw`** (`RelatedPanel.mjs`, separate from `cs.focus`/`cs.sel` of
the block-scoped panel and separate from `state.showDescription` itself):
`pw.focus` (`null`/`'item'`/`'thread'`) + `pw.sel` + `pw.threadPos` — see
`.claude/rules/keyboard-navigation.md` (section "PR-wide comments, stop 1")
for the full keyboard mechanism (`handlePrWideKey`/`isPrWideFocused`, called
from `home.mjs`'s `onKeydown`).

Next comes the **block column** (`data-testid=block-column`,
**`shrink-0`** — not `flex-1`, so at its **natural diff width**
(`w-[70rem] 2xl:w-[82rem]` for a two-sided `modified` block; a **one-sided
added/removed block** shows only one pane (`singleSide` in `Block.mjs`) and
therefore gets **the same narrow 60% width** `w-[42rem] 2xl:w-[49.2rem]` as the
`a` toggle — one-sided is always narrow, regardless of `a`, since there's
nothing to show next to it) instead of filling the remaining space) with the
card of the selected block plus the look-ahead preview of the next block
(dashed connector if they come from the same file). **Directly next to** that
column (not at the right edge of the screen) the **Underlying code** card
(`RelatedPanel.mjs`'s default export, `data-testid=related-code`, `shrink-0`
with a **reactive, dynamically growing** width (`relatedColumnWidthCls`, see
the "Underlying code" section further down) — the **default/floor** is still
`w-[42rem] 2xl:w-[49.2rem]`, the same fixed width as a one-sided/`a`-narrowed
block (see above), so "Underlying code" is **always** as wide as the column
next to it for short code excerpts instead of narrower (was
`w-[34rem] 2xl:w-[41rem]`, deliberately half of one pane of the side-by-side
diff — that gave a one-sided/narrowed block two visibly unequal column widths
side by side, see the screenshot issue that led to this change); a genuinely
wide, non-wrapping code body in one of the visible children has since let the
column grow **beyond** that floor, with a ceiling that deliberately stays
**below** the full block column (`w-[56rem] 2xl:w-[65rem]`, instead of the
`w-[70rem] 2xl:w-[82rem]` of the block column itself — an earlier, equally
tall ceiling let this card take up half the screen width on one incidental
long line, which was reported as a bug) — that symmetry with the neighboring
column is thus deliberately **no longer guaranteed** once something wide
appears in it) — stop 5 of the nav chain, unchanged, inline in `<main>`'s
horizontally scrolling column flow (see "Underlying code" further down).
Comments and Tasks are **no longer** part of this column flow — see the
"Comments/tasks sidebar" section below.

## Comments/tasks sidebar (fixed, toggled with Cmd+→)

Comments and Tasks together form their **own `position:fixed` panel on the
right side of the screen** (`RelatedPanel.mjs`'s `CommentsSidebar` export,
`data-testid=comments-sidebar`, `right-6 top-6 w-[36rem]`, with a
**reactive**, 3-way bottom reservation — `bottom-6` (no reservation) as soon
as the footer shows nothing (`!state.footerVisible`), `bottom-[90px]` as soon
as only the inline diff is showing, or `bottom-[140px]` as long as the footer
is also showing an AI description (`state.footerExplain`, see the Footer
section in `.claude/rules/keyboard-navigation.md`); the collapsed hint rail
mirrors that) — mirroring how `PrInfoPanel` is a fixed panel on the left (see
the section above), **separate from** `<main>`'s horizontally scrolling
column flow. Mounted as its own top-level component next to
`PrInfoPanel`/`BlockList`/`DetailPanel` in `home.mjs`, not nested inside
`DetailPanel`. Within the sidebar sits the **comment block**
(`data-testid=comments-panel`, `flex-1`) **above** the **tasks block**
(`data-testid=workflows-panel`, `shrink-0 max-h-[16rem]`) — stacked
vertically, comments gets the most room and scrolls internally as it grows,
tasks holds a smaller, self-scrolling height beneath it.

**Toggled with Cmd+→** (`e.metaKey && e.key === 'ArrowRight'`, `toggleSidebar`,
exported from `RelatedPanel.mjs`, called from `home.mjs`'s `onKeydown` —
globally, in both `'list'` and `'diff'` mode, regardless of whether the diff,
the Underlying-code card, or the sidebar itself currently holds the keyboard):
closed → open + **restore the last comment spot of this session**
(`restoreLastSidebarFocus`, see below), or — without such a memory — highlight
on the "+ Comment on this line" row (`enterComments`, a deterministic anchor
point — mirroring how `enterRelated` always lands on the first child); open
but the keyboard is elsewhere (diff/Underlying code) → highlight back to that
row, stays open; open and the keyboard is already in the sidebar
(composer/comment row/thread/task) → close, keyboard back to the diff.
**`enterComments` deliberately does not yet open the composer/focus a
textarea** (unlike `toNew`, which `startComment`/arrow navigation to row 0/the
restore flow still do use) — only highlighting, so a **second Cmd+→**
immediately collapses the sidebar again instead of the key landing in the
already-focused text field (the `isEditableFocused` guard would otherwise eat
it). Only **`Enter`** on that highlighted row (`isNewFocused()` +
`openComposer()` in `home.mjs`, mirroring the
`isCommentFocused`/`isCodeFocused`/`isTaskFocused` Enter branches) actually
opens the composer and focuses the textarea. Visibility lives in its own,
**ephemeral** flag `cs.sidebarOpen` (not in the URL — just like
`state.showDescription` — a refresh always starts collapsed), decoupled from
`cs.focus`: the sidebar can stay open while the diff has the keyboard (after
`←`, see below). A click on the collapsed hint rail (see below) follows the
same open+focus logic as Cmd+→ (`openSidebar`).

**Cmd+→-out → Cmd+→-back restores the last comment/thread row within the same
session** (not merely "open on row 0"). Every time the sidebar leaves the
keyboard via `exitRelated` (`←` from the sidebar, or the closing Cmd+→ branch
above) and `cs.focus` at that moment was `'new'`/`'comment'`/`'thread'`,
`exitRelated` snapshots that into the module `let` `lastSidebarFocus`
(`{focus, sel, threadPos}` — deliberately **not** `'code'` or `'task'`, and
deliberately **not** on `cs`/in the URL: this is a purely within-session
memory, not a navigation-position restore — that already exists separately
for `cs.focus`/`sel`/`threadPos` via the `rel` URL namespace, and
`cs.sidebarOpen` itself stays outside the URL, so a refresh still always
starts collapsed). A subsequent `openSidebar` (Cmd+→, or a click on the hint
rail) calls `restoreLastSidebarFocus`: if the last spot was a comment row or a
thread, the keyboard lands there again (row index clamped to the currently
visible comment list, `threadPos` clamped to the thread length — mirroring
`applyRelRestore`'s clamping); if the last spot was the composer row itself,
or there's no memory yet, or the remembered comment/thread is no longer
visible (deleted, or the reviewer has since moved to a different block/unit
whose comment scope is empty), it falls back to the existing
`enterComments()` landing (row 0, highlight only). **This restore
deliberately never focuses the reply/reaction text field**
(`toComment(false)`/`focusThread(false)` — the `focusInput` parameter,
default `true` for every other caller such as a click or an arrow-key step):
only highlight the row/thread again, exactly the same "highlight-only"
philosophy as `enterComments()` itself. Without this, a Cmd+→ reopen — if the
reviewer had earlier left the sidebar from a comment row or thread — would
land right in a focused text field, after which a **second Cmd+→** (meant to
collapse the sidebar again) would land in that field instead of closing the
sidebar (the global Cmd+→ handler in `home.mjs` explicitly ignores the key as
long as `isEditableFocused()` is true). Mirrors the `preTaskFocus` pattern.
Test: `tests/sidebar-focus-restore.spec.mjs`.

**A placed comment immediately gives the keyboard back to the code it's
attached to.** `placeComment` (`RelatedPanel.mjs`) — called by both
`COMPOSE_COMMANDS` items in `home.mjs` ("Place comment" and "Only for
myself") — after a successful `createComment` no longer only calls
`cs.composing = false` but `exitRelated()`: functionally the same step as a
`←` from the sidebar (see above) — keyboard focus goes back to the diff of
the block/column the comment was attached to (`commentTarget()` follows
`focusedBlock()`, so also a drilled column), the sidebar itself stays open.
`home.mjs`'s `compose-post`/`compose-self` `run` functions then call
`scrollFocusIntoView()` to re-align `<main>` on that column — the same call
that `onKeydown`'s `relatedActive()` branch already does after a `←` exit.
This lets the reviewer continue with `↑`/`↓`/`f`/`d`/`s` through the diff
right after "type, Enter, Enter", without navigating back themselves. Test:
`tests/place-comment-return-focus.spec.mjs`.

**Collapsed** (`!cs.sidebarOpen`) the sidebar renders as a narrow hint rail on
the right edge (`data-testid=sidebar-collapsed`, `right-0 w-12`, clickable):
two numbers, a speech-bubble icon with the **number of comments**
(`visibleComments().length` — scoped to the selected block/navigation unit,
the same scope as the comment index itself) and a clock icon with the
**number of genuinely running tasks** (`runningTaskCount(state)`, strictly
`status === 'running'` — **not** `waiting`, unlike `taskRuns`' own
active/done split). Several long-lived per-PR trackers (`build_relations`,
`approve`, `pr_status`) sit in `waiting` indefinitely once their initial run
is done, without being busy (see `.claude/rules/tembed-workflows.md`), so
counting/coloring those as "active" here was misleading — the clock icon's
color follows the same count (a reactive whole-value class binding, per the
arrow.js rule in `conventions.md`): amber only while `runningTaskCount(state)
> 0`, otherwise the same neutral gray as the comments icon. Purely a hint —
no click actions per number, only the whole rail is clickable.

**`<main>` reserves a reactive right margin so it doesn't disappear behind the
rail/sidebar.** Both are separate `position:fixed` overlays with a **higher**
z-index than `<main>` (`z-20` vs. `<main>`'s `z-10`), so without a margin
`<main>`'s rightmost column (the Underlying-code card, or the rightmost
drilled column) would visibly disappear behind/under it as soon as you scroll
`<main>` all the way right — `<main>`'s own `overflow-x-auto` doesn't clip
anything beyond its own right edge, so what you see always stays within that
edge. `DetailPanel`'s class binding (`home.mjs`) reads `sidebarOpen()` for
this (exported from `RelatedPanel.mjs`, a thin reader on `cs.sidebarOpen` —
`cs` is module-private, so `home.mjs` cannot read it directly, the same
pattern as `isCodeFocused`/`relatedActive`) in the same function binding as
the existing `state.showDescription` ternary for the left margin: closed
(the rail, `right-0 w-12` = 3rem) → `right-[4.5rem]`; open (`right-6
w-[36rem]`, so the sidebar's left edge sits at `1.5rem + 36rem = 37.5rem`) →
`right-[39rem]`. Both add another 1.5rem of breathing room on top — the same
gap convention as the PR-info-column margin (`left-[69.5rem]` = 39rem +
1.5rem + 29rem, see above). Because the class string stays a single whole
(no partial interpolation) and this is an ordinary attribute function binding
(not a keyed array item), no arrow.js pitfall from `conventions.md` applies
here.

**Keyboard within the sidebar:** comments is a flat row list (the empty
composer at row 0, then one row per comment — see `rowCount`/`currentRow`/
`gotoRow` in `RelatedPanel.mjs`), tasks its own row list
(`cs.taskSel`/`taskRuns`). **`↓`/`↑` walk within such a list, and also cross
between them** — the stacked-layout equivalent of what `→`/`←` used to do
between comments and Tasks: `↓` on the last comment row (or the empty
composer if there are no comments), or on the bottom of an opened thread
(`threadPos === 0`, the reply field), descends to the first task row; `↑` on
the first task row climbs back to where it came from
(`preTaskFocus`/`toTask` — the composer, a comment row, or the same thread).
`→` on a comment row still goes deeper into the thread
(`enterThread`, unchanged); within a thread `↑`/`↓` still walk through the
message history (`threadPos`), not between comments/tasks — only the
**bottom** of the thread (`threadPos === 0`) descends further into tasks.
**`←` closes **no** column and peels back **nothing** layer by layer** — from
**anywhere** in the sidebar (comment row, thread, task) `←` goes back in
**one jump** to the diff of the last-active block/column
(`state.focusLevel` stays unchanged), and the **sidebar stays open** (only
the keyboard focus leaves it, `cs.sidebarOpen` stays `true`) — this replaces
the older step-by-step pattern (`toComment`/`toCode` as intermediate steps)
entirely for this path.

The **tasks block** (`<section data-testid=workflows-panel>`, title
**"Tasks"**) shows the **workflow runs of the current PR** (`state.workflows`,
filled by `pollWorkflows` in `home.mjs` via `GET /api/workflows?pr=N`, every
2.5s). That endpoint is **read-only** (`RunsForPR` in `tasks_api.go` filters
`engine.Runs()` on the `pr` field in each run's stored input — no mutation, so
within the write boundary), not to be confused with the existing, unrelated
placeholder block `data-testid=tasks` (Tasks + chat) *inside* the comment
block. The card splits **active** (`running`/`waiting`, at the top, at full
opacity) from **recently done** (`completed`/`failed`, below, dimmed) under
the headings "Active"/"Recent"; each row shows a readable workflow label
(`WORKFLOW_LABELS` in `RelatedPanel.mjs`, e.g. `build_relations`→"Relations")
plus a color-coded status badge (amber/blue/green/red). The row key encodes
**runId + status** (not just runId) so a status change (e.g.
`running`→`completed`) forces a **fresh** node instead of reusing a keyed
node without re-evaluating its static classes — the same pitfall as the
block-card key, see `.claude/rules/conventions.md`. The empty state wraps in
an array of one (`.key('no-workflows')`), per the "no comments" pitfall in
that same conventions rule.

Each row also shows, below the label + status badge, a short **description**
(`data-testid=workflow-note`, gray, `line-clamp-2`, `workflowNote` in
`RelatedPanel.mjs`): for a `task_code_comment` run the rich
`class::method · line N · "snippet"` from the run's supplied `comment` ref
(`WorkflowRunView.comment`, see `.claude/rules/tembed-workflows.md`); for
every other type a short sentence explaining *why* the run is in that status
(`WORKFLOW_STATUS_NOTE`, a `${workflow}:${status}` map, e.g.
`resolve_call:running` → "searching for call definitions"), with the bare
status as fallback when no combination matches. **The text must never
suggest active work while the badge shows "waiting"** — `build_relations`
runs its build Activity once synchronously at start and then waits
indefinitely for a `rebuild` Signal (see
`.claude/rules/tembed-workflows.md`), so `waiting` there always means
"already built, idle until the next rebuild", never "busy". `workflowNote`
therefore replaces the generic text for that combination with a concrete
summary of what has already been built (`buildRelationsSummary`, read from
`state.relations`/`state.callResolve`/`state.testCovers` — the same arrays
the rest of the panel already tracks, no extra fetch), e.g. "3 relations · 5
calls resolved — waiting for changes"; without usable data it falls back to
the static `WORKFLOW_STATUS_NOTE` text. Below the description sits a second,
even smaller line (`data-testid=workflow-updated`, `relTime(run.updatedAt)`)
with a relative time indication ("just now" / "4 min ago" / "2 hours ago" /
"1 day ago") — `updatedAt` already comes along in `GET /api/workflows`
(`WorkflowRunView.UpdatedAt`, `tasks_api.go`), so this is a pure frontend
addition without a backend change.

A run with a `comment` ref is **clickable** (`cursor-pointer`, the rest is
purely informational): the click calls `openTask(run)`, a callback that
`home.mjs` passes to `CommentsSidebar(state, commentTarget, openCompose,
openTask)` (separate from `search.drill`, which now only goes to the
`RelatedPanel` default export/Underlying-code card — see below). `openTask`
(in `home.mjs`) looks up the block in `state.blocks` by
`comment.file`+`comment.label`, selects it, steps the diff to the stored
granularity/row range (`unitsFor`+`unitAtRow`, the same walk as `setGran`),
and finally selects the comment itself via `selectComment(runId)` (exported
from `RelatedPanel.mjs` — `runId` == the comment's id) once the
comment-scope watch has had a chance to catch up (a couple of
`await Promise.resolve()` ticks, needed because arrow.js' `watch` runs
microtask-deferred — see the watch-timing note in `conventions.md`). If a
step fails (block/comment not yet found), `openTask` silently does nothing.
This does not explicitly open/focus the sidebar itself — it's only called
from a click/`Enter` on an already-visible tasks row, so the sidebar is
already open at that moment.

**Keyboard within Tasks:** `cs.focus === 'task'` gives the Tasks card the
keyboard — reached via `↓` from comments (see "Comments/tasks sidebar" above
for the full cross-navigation), no longer via `→`/stop 7 of the old nav
chain. `↓`/`↑` move `cs.taskSel` through the **active-then-done** order
(`taskRuns(state)`, exported from `RelatedPanel.mjs` — the same order
`workflowsSection` renders, so the row index and keyboard cursor always
match); the focused row gets an indigo ring (`data-active=true` on
`data-testid=workflow-row`). `↑` on the first row climbs back to where `↓`
came from (`preTaskFocus` in `RelatedPanel.mjs`: the composer, a comment
row, or the same thread) — going back to the **composer** only highlights
the "+ Comment on this line" row (`enterComments`, just like a fresh
Cmd+→ open), without opening/focusing it immediately; only an explicit
`Enter` (`isNewFocused`+`openComposer`, `home.mjs`) opens it. Going back to a
**comment row**/**thread** still immediately focuses the reply field, as
ordinary row navigation within comments always does. `←` closes the
sidebar focus in one jump toward the diff (see above), regardless of
`preTaskFocus`. `Enter` (handled in `home.mjs`, not in `RelatedPanel.mjs` —
`openTask` lives there because it drives the shared navigation `state`)
opens the focused run just like a click on it; only meaningful for a
`task_code_comment` run with a linked comment, silently ignored for the rest
(the same `run.comment` guard as the click). A click on a non-clickable row
also lands the keyboard cursor on it now (`toTask(i)`), so mouse and
keyboard share the same cursor.

## Drilling: Underlying code as its own column (`state.drill`)

`Enter` on a **resolved** child in the Underlying-code card (a relation
child or a resolved method call — see `isCodeFocused`/`focusedRelatedChild`
in `RelatedPanel.mjs`) **or a mouse click on that child** (`@click` on
`data-testid=related-item`, via the `drill` callback that `home.mjs` passes
as an option to `RelatedPanel`) opens that child as a full-fledged diff
column to the right of the existing columns (between the diff and
`RelatedPanel`), instead of only showing the flat code excerpt. Click and
Enter both go through the same `drillIntoChild(child)`. `home.mjs` keeps a
**stack** for this, `state.drill`: every `drillIntoChild(child)` (called from
the `Enter` branch in `onKeydown` — Enter on a focused child drills,
unresolved calls search automatically without Enter — or from the click
callback) pushes one entry onto it **plus** a corresponding cursor entry onto
`state.drillCursor` (`{change:0}`), and sets `state.focusLevel` to that fresh
(deepest) level. Unlike before, nothing of this closes automatically anymore:
every drilled column stays open for as long as the diff session lasts (see
"Column navigation" below for how you leave it again).

A drill entry is **one of two forms**:
- **A real PR block** — if the child is already in `state.allBlocks` (a
  relation child, or the definition of a resolved method call that itself
  changes in this PR), then that existing block object is reused (no copy):
  it already carries `code`/`approvedRows`/etc., and
  `relatedChildren`/`resolvedCallChildren`/`callRows` work generically on any
  block id — so this child gets **out of the box** its own full, navigable
  Underlying-code panel (recursion works for free).
- **A synthetic frame** — a resolved method call to a file the PR doesn't
  change (no PR block, so nothing to reuse): a minimal object
  (`{ id, label, file, class, name, status:'unchanged', code:null,
  synthetic:true }` — `unchanged`, because the PR doesn't touch this file, so
  old === new and the diff is entirely equal; a `modified` badge would be
  misleading here, class/name split from `child.label` on `::`), for which
  `ensureCode` fetches the old/new source just like for any other block. This
  level shows **only** its diff — no Underlying-code card of its own (no
  caller scan is ever run for a synthetic frame).

**A drilled column survives a refresh** — `state.drill`/`drillCursor` do not
themselves live in the URL (too large/not directly serializable, the same
reason as `state.blocks`), but `home.mjs` mirrors them in three plain
URL-facing fields, exactly like `blockRef` mirrors `state.selected` (see the
URL-state section in `CLAUDE.md`): `state.drillRef` (each entry's stable
`.id` — a real block id, or a synthetic call frame's caller-scoped
`b.id + '::' + callKey` — joined with `>`, which occurs in no id) →
`?drill=`, and `state.drillGran`/`drillChange` (only of the **deepest,
focused** column — `state.drillCursor`'s last entry; every ancestor column
collapses to a rail anyway, so its own cursor is never visible) →
`?dgran=`/`?dchg=`. Restore follows the same
snapshot-before-the-clobbering-watch pattern as `blockRefPending`:
`drillRefPending` (the path, split on `>`) and `drillCursorPending`
(`{gran, change}`) are captured right after `bindUrlState`, and are only
applied by **`applyDrillRefRestore`** once `loadBlocks` has loaded the
blocks/relations **and** callresolve/testcovers (those latter two are
normally fire-and-forget — only if there's a `drillRef` to restore do we
still await them, so that a method-call/covers child is already findable via
`relatedChildren`). The walk traverses the path starting from `curBlock()`,
looking at each level for the child in `relatedChildren(parent)` whose
`(c.blockId || c.id)` matches, and reuses **`drillIntoChild`** itself (so
every side effect — `ensureCode`, `focusLevel`, scroll, the entrance
animation — is identical to a real Enter/click drill). Not found (deleted
relation, resolver rerun, expired link) → stops silently, just like
`applyBlockRefRestore`'s own not-found fallback: whatever has been drilled up
to that point stays as is. The deepest cursor is only applied once its rows
are actually known (`applyDrillCursorRestore`, with a `b.synthetic || b.code`
guard) — for a synthetic frame that's synchronous, for a real PR block only
once `ensureCode`'s `/api/code` fetch completes (the same "drilled column's
code arrived" branch that already existed, see below). Requires an active
diff session (`state.mode==='diff'`) — drilling has no meaning outside diff
mode. The same three fields also travel along in the `/pr-overview`
round-trip (`overviewExitUrl()`/`treeUrl()`, see "`?sel=` travels along…" in
`.claude/rules/pages-and-routing.md`), so `←` to the PR inbox and back via
"Open review tree" also lands in the same drilled column again.

## Column navigation: `state.focusLevel` (every drilled column is a full-fledged diff)

Unlike the earlier "always the deepest level" model, **every** column — the
original top-level block card and every drilled column — is a full-fledged,
navigable diff with its **own** change-group cursor. `state.focusLevel`
points to which column currently owns the arrow keys: `0` is the top-level
selected block (which keeps using `state.change`/`state.gran`, as always),
`1..state.drill.length` indexes `state.drill[level-1]` with its own cursor in
`state.drillCursor[level-1]` (`{change, gran}`, a mirror of
`state.change`/`state.gran`). A drilled column thus **does** zoom with
`f`/`d`/`s` (group → line → call, exactly the same `setGran` logic as the
top-level block, but as `setDrillGran(level, delta)` on its own
`drillCursor` entry). Unlike a same-file neighbor block at level 0
(`sameFileNeighbour`/`stepBlock`, only for the top-level cursor), a drilled
column has no "next block" to walk through — but it does have a **sibling**:
if `↓`/`f` (at `call`) goes past the **last** unit of the column (or `↑`/`d`
past the **first**), navigation steps **sideways** to the next/previous child
in the Underlying-code list of the **parent** column, instead of clamping —
this lets the reviewer walk through a block's entire underlying-code tree
top-to-bottom without having to press `←` every time to reach a next sibling.
This **replaces the drilled column at the same level**
(`drillToSibling`: pop the current `state.drill`/`drillCursor` entry, then
`drillIntoChild(sibling)`, which immediately puts a fresh entry back at the
same depth) — it never stacks deeper. `drillSiblingContext` determines the
parent (`curBlock()` at level 1, otherwise `state.drill[level-2]` — so it
works at any drill depth) and its sibling list: exactly
`relatedChildren(parent)` (the same list/order the panel shows if the parent
were focused), minus the non-drillable `tests_group` toggle bar; the current
column is found within it via `blockId`-or-`id` (the same pattern
`drillIntoChild` itself uses to resolve a descriptor to a real block or
synthetic frame). **No wrap-around**: on the last/first sibling, navigation
still simply clamps, as before. Sideways-forward (`↓`) lands on the new
column's **first** `group` unit (the normal `drillIntoChild` default);
sideways-back (`↑`) lands on its **last** `group` unit — mirroring the
existing `stepBlock` convention ("stepping up lands on the last change") —
best-effort synchronous: if the sibling's code hasn't loaded yet, it falls
back to the first unit instead of waiting (no `pendingLast`-like deferral,
deliberately kept simple). `dKey`'s `call`-level guard (`cur.change > 0`) is
extended with `hasPrevDrillSibling()` so `d` on the very first call segment
also already steps back to the previous sibling, mirroring the top-level
`dKey`'s `sameFileNeighbour(-1)` check. `fKey`/`dKey`/`sKey` in `home.mjs`
branch on `state.focusLevel`: `> 0` operates on the drillCursor entry of that
level (and thus, at the edges, the sibling walk above), `0` operates as
always on `state.gran`/`state.change`. See `tests/drill-sibling-walk.spec.mjs`.

**The `Enter` command-palette approve action follows that same `focusLevel`
pattern** (`approveContext()` in `home.mjs`): without that function,
"Approve …" would invisibly approve the TOP-LEVEL block/cursor while a
drilled column held the keyboard — the reviewer would see nothing happen in
the drilled column (the reported "I can't approve anything in underlying
code"). See the "Enter — command palette" section in
`.claude/rules/keyboard-navigation.md` and `tests/drill-approve.spec.mjs`.

- **Right after drilling, focus is on the diff of the new column** — not on
  its Underlying-code panel. `drillIntoChild` calls `leaveRelated()` (the
  exported `exitRelated` from `RelatedPanel.mjs`) for this instead of the
  earlier `enterRelated()`: the reviewer lands on the first change group of
  the new column and walks through it with `↑`/`↓`
  (`drillNextChange`/`drillPrevChange` in `home.mjs`).
- **The drilled column reuses exactly the same diff render as the top-level
  block card** — both call the same `Block(b, {...})` from `Block.mjs`
  (red/green, char diff, filler alignment are thus identical). What was
  missing was **scrolling to the active change**: on a large function the
  reviewer landed at the top of the function body, with the actual (correctly
  colored) diff hunk scrolled out of view — which looks like "no diff
  formatting" while the formatting is actually there, just not visible.
  `drillIntoChild` therefore also calls `scrollChangeIntoView(false)` after
  pushing the column (for the cached case — a synthetic frame or a child
  whose code was already loaded earlier for the Underlying-code panel);
  `ensureCode` does the same as soon as the code of a **not-previously-loaded**
  drilled/focused child arrives (mirroring the existing top-level branch:
  `state.drill[state.focusLevel - 1] === b`). See
  `.claude/rules/keyboard-navigation.md` for `scrollChangeIntoView`.
- **`←` closes the focused drilled column** and moves focus back to the diff
  of the **parent column** — the previous drilled column, or (from level 1)
  the original top-level block. The closed child then automatically
  reappears in the Underlying-code list of that parent column (that list is
  driven by `focusedBlock()` via the `setRelated` watch, so this restores
  itself without extra code once `focusLevel` drops). Repeated `←` thus peels
  back level by level until you're back on the top-level block.
- **Only once you're already at level `0` (the top-level block) does `←`
  close the entire diff session** — the existing diff→list transition
  (`state.mode='list'`) — and only then are `state.drill`/`state.drillCursor`
  also cleared: drilled columns only have meaning within *this* diff
  session.
- **Nothing else may flip `state.mode` to `'list'` while there's drilling.**
  `ensureCode`'s "block with no navigable changes → back to list" fallback
  (meant for a restored `?mode=diff` URL) is therefore gated to the resting
  position (`state.focusLevel === 0 && state.drill.length === 0`): after a
  postApprove "Continue" that selects a **new root** and drills into its
  child, the (deduped, still in-flight) code fetch of that root can only land
  *after* the drilling — if that root has 0 of its own groups (only its
  underlying code is reviewable), the ungated fallback flipped to list mode
  while the drill stack was still standing, causing `←` to miss the peel
  branch ("← goes to the block index"). Test: `tests/drill-mode-flip.spec.mjs`.
- **`→` still opens the Underlying-code panel** of the column that currently
  has focus (`enterRelated()`, unchanged) — that's still the only way to
  drill **deeper** (Enter/click on a child within it).
- From within the panel (`relatedActive()`), `←`/`Escape` at the first
  position gives focus back to the diff of **that same** column
  (`handleRelatedKey`'s `exitRelated`) — that no longer closes a column; the
  column-by-column navigation above is a separate step that only follows
  once `relatedActive()` is `false` again.

**No flicker on a gran/change step within a focused drilled column:**
the outer `${() => state.drill.map(...)}` binding that builds the columns
deliberately does **not** subscribe to `state.drillCursor` (only to
`state.codeVersion` and `state.focusLevel`, which flip a column's `.key(...)`
— see below). If that outer closure also read `drillCursor`, every
`f`/`d`/`s`/`↑`/`↓` step would rebuild **all** open drilled columns (every
`Block()` call again, so Prism highlighting again across every column) —
exactly the same pitfall as `canStep()` for the top-level card (see
`stepChevronSlot` in `home.mjs` and the conventions.md note about it). The
`state.drillCursor[i]` read that actually matters lives in the
`activeGroup`/`hintsEnabled`/`diffActive` functions passed to
`Block(b, {...})`: those are themselves already reactive arrow.js bindings
(they're only invoked from within `Block`'s own `${…}` slots), so they
re-evaluate on their own dependency without rebuilding the column — exactly
as `state.change`/`state.gran` already did for the top-level card.

**Small opening animation on an actual "open" of a column, never on
navigation within it (`drillOpenMarker` in `home.mjs` + `.drill-enter` in
`index.html`):** a fresh `drillIntoChild` call (a real drill, or
`drillToSibling`'s sibling replacement) sets a module-level, **non-reactive**
marker `drillOpenMarker = { level, id }`. The `state.drill.map(...)` render
reads it once per column and **consumes** it right away (`if (justOpened)
drillOpenMarker = null`) — before the class string for that column is built
(a plain, non-reactive string interpolation, **not** a `${() => …}` binding:
there's nothing here to track reactively, so the "whole-value-in-one-binding"
rule doesn't apply). Only on a match does the column wrapper get the class
`drill-enter` (a short fade+slide `@keyframes` in `index.html`, with a
`prefers-reduced-motion` guard). This **must never** become a
reactive/permanent class binding: the column `.key(...)` (see above,
`foc`/`unfoc` + `codeState`) also flips on a mere focus switch
(`←`/rail click) or as soon as code comes in — neither is an "open" in the
sense of `drill-enter`, so neither should replay this animation (see below
for the mirrored animation that a focus switch *does* get). The
consume-once pattern solves this:
- If a column's `.key(...)` stays the same across a navigation step
  (`f`/`d`/`s`/`↑`/`↓` within the same column, which only touches
  `drillCursor`, not the key) — then arrow.js reuses/patches the existing DOM
  node. The class string is a static value only set on node **creation**, so
  that node never gets a new animation trigger, regardless of whether
  `drill-enter` happens to still be in its classList (a CSS animation doesn't
  repeat by itself without `iteration-count:infinite`).
- If the key does flip (code arrives, foc/unfoc) — then the marker is already
  consumed (`null`) after the first render, so that fresh node gets no
  `drill-enter` class, and thus no replay.
Test: `tests/drill-open-animation.spec.mjs` (the class is present right after
drilling; an `ArrowDown` navigation step afterwards proves via an ad-hoc
marker attribute that the DOM node is **not** remounted).

**Mirrored return animation when leaving a drilled column
(`drillReturnMarker`/`markDrillReturn` in `home.mjs` + `.drill-return` in
`index.html`):** the exact mirror image of the opening animation above, for
the reverse direction — the column that **regains** keyboard focus once a
drilled column closes. Three call sites set the marker, each right after
lowering `state.focusLevel`:
- `onKeydown`'s `←` branch (peeling back one level),
- `expandColumn` (a click on a collapsed rail, can jump back multiple levels
  in one go),
- `applyNextUnapproved`, but **only** when the common-prefix trimming
  (`common`) already covers the full target
  (`common === target.path.length`, so no further `drillIntoChild` call
  follows) — **and** only as long as the root doesn't change (`sameRoot`):
  landing on a brand-new top-level block is a fresh selection, not a
  "return" to something already open.
`markDrillReturn(level)` itself determines which column that is (`{level,
id}`, `level 0` = the top-level block via `curBlock()`, otherwise
`state.drill[level - 1]`) and sets `drillReturnMarker`. Two render passes
consume it once each, exactly the `justOpened` pattern from above:
- The drilled-columns list (`state.drill.map(...)`): next to the existing
  `justOpened` check, a `justReturned` check on the same `{level, id}` shape;
  `drillColumnCls` gets `drill-enter` *or* `drill-return` (never both — the
  two markers are set by disjoint actions).
- The top-level block-column closure: here there was no stable wrapper root
  yet to attach a non-reactive, one-time class to (`Block(b, {...})` was
  pushed directly). `inner = Block(b, {...})` is therefore wrapped in a
  `<div class="contents ..." data-testid="detail-card">` — a static,
  non-reactive class string per `.map()` iteration, exactly the pattern of
  `drillColumnCls`/the "stable element root" pitfall in `conventions.md`
  (`display:contents` removes the wrapper from layout, so no `flex` gap
  artifact) — and the existing `.key(...)` moves from `Block(...)` to this
  wrapper (the key belongs on the outermost pushed item). `justReturned` is
  only checked for `i === sel` (only the selected card can ever be the
  level-0 return target, never the look-ahead preview card).
`.drill-return` (`index.html`) is the mirror image of `.drill-enter`: the
same fade + 180ms ease-out, but `translateX(-6px)→0` (sliding in from the
left) instead of from the right — so open/return feel visually different,
within the same `prefers-reduced-motion` guard. Test:
`tests/drill-return-animation.spec.mjs` (`←` peels back and animates the
top-level card; a rail click via `expandColumn` does the same; an
`ArrowDown` navigation step afterwards proves via the same node marker
attribute that the card is not remounted).

`focusedBlock()` (the Underlying-code panel + tasks/chat) now follows
`state.focusLevel` instead of always the deepest level: `state.focusLevel ===
0 ? curBlock() : state.drill[state.focusLevel - 1]`. Stepping a column back
with `←`, the panel thus moves along with it to that column. There is still
exactly one `RelatedPanel` instance (`cs`/`rc` remain singletons).

The column `.key` encodes (besides position in the stack + code status
`load`/`code`/`err`) also whether the column **currently has focus**
(`foc`/`unfoc`) — just like the existing `sel`/`prev` key on the top-level
card — so that a focus switch always forces a fresh card (fresh `${…}`
bindings) instead of arrow.js reusing the existing node (see the pitfall in
`.claude/rules/conventions.md`). A new column scrolls itself into view
(`scrollFocusIntoView`, `<main>` scrolls horizontally) — always aligned to
the **left** (`inline:'start'`, for a drilled column too, not just the
top-level card), so the columns you came from disappear off-screen to the
left instead of cramming the new column onto the right; the same function
also scrolls the now-focused column into view on the left when stepping back,
and when leaving the `RelatedPanel` back to the diff (`onKeydown`'s
`relatedActive()` branch in `home.mjs` calls it as soon as
`handleRelatedKey` has released panel focus) — panel navigation scrolls
`<main>` horizontally sideways (`scrollIntoView` in `toTask`/`toComment`
etc.), and without this re-alignment the diff card stayed cut off off-screen
to the left after `→…→` then `←…←`. Every **focused** drilled column
(`state.focusLevel > 0`) additionally shows a small gray **‹ chevron on its
left edge** (`data-testid=drill-left-hint`, outside the card, vertically
centered) as a visual hint that there are columns off-screen to the left —
purely a cue, no click action of its own (`←` does the actual stepping
back). The chevron is baked into the column `.key` via the existing
`foc`/`unfoc` component, so it appears/disappears along with a fresh card
instead of a reused node.

**The chevron itself sits outside the `drill-column` box (`absolute
-left-3`), so `scrollFocusIntoView`'s `scrollIntoView({inline:'start'})`
would, without a countermeasure, clip most of it off behind `<main>`'s own
left edge** — that aligns the **own box** of the focused `drill-column` div
flush against `<main>`'s inner edge, so anything 12px beyond that box falls
outside the visible (`overflow-x-auto`-clipped) scrollport.
`drillColumnCls` therefore carries a static `scroll-ml-4` (1rem/16px left
scroll margin) — a CSS property that `Element.scrollIntoView()` respects
(CSSOM View spec), so no change to `scrollFocusIntoView` itself is needed.
The margin is unconditional on this class (no `${() => …}` binding needed):
this div with testid `drill-column` only renders **at all** when the column
is focused (the non-focused branch returns a `drill-collapsed` rail early),
so the scroll margin is always relevant once this element exists — no
arrow.js pitfall, `drillColumnCls` was already a plain, non-reactive string
per `.map()` iteration (the same precedent as the `drill-enter` animation
class above). Test: `tests/drill-left-hint-visible.spec.mjs` — note: a bare
`getBoundingClientRect().left >= 0` check on the chevron would **not** catch
this, because that coordinate is relative to the entire browser viewport and
`<main>` itself already sits at a positive left offset (the list/diff-mode
`left-6`/`left-[29rem]` padding), so `rect.left` stays positive even if the
chevron is fully hidden behind `<main>`'s own clip edge; the test therefore
uses an `IntersectionObserver` ratio (which does account for ancestor
`overflow` clipping).

**Look-ahead preview of the next sibling (`drillPreviewColumns`,
`data-testid=drill-preview-column`):** **below** the card of the focused
(always rightmost) drilled column — not next to it — shows a dimmed preview
card of the sibling `↓` would step to at the end
(`drillNextChange`→`drillToSibling`), before the reviewer actually navigates
there. Mirrors the top-level look-ahead preview of the next sidebar block:
only the **next** sibling (never the previous one), always visible as soon
as one exists (not only on the last change unit), connected with the same
vertical dotted `connector()` that top-level preview uses (no separate
horizontal variant — drilled columns stack their preview vertically, just
like the top-level `block-column`'s next-block card).
`resolveChildBlock` (extracted from `drillIntoChild`) resolves the sibling
descriptor to the same block-like object a real drill would push, so the
preview card shows identical, already-loaded code once promoted (via `↓`).
`drillPreviewColumns()` is called from a **nested**, array-returning
`${() => drillPreviewColumns()}` slot *inside* the focused column's own
per-item template (next to the real `Block(b, …)` card, in the same
`flex-col` wrapper) — not as a separate top-level item in
`state.drill.map(...)`'s array. That isolation is doubly load-bearing: (1)
`drillPreviewColumns()` only reads the cheap, **identity-guarded** field
`state.drillPreviewChild` — never directly `drillSiblingContext`/
`relatedChildren` (those read much broader state,
`b.approvedRows`/`state.callResolve`/`testCovers`/`relations`, and would, if
called directly within the columns closure, rebuild every open `Block()`
card on an unrelated approval/poll — the pitfall in `conventions.md`); that
calculation lives in the existing `setRelated` watch (which already runs
`relatedChildren()` anyway), and only writes to the field on a genuinely
different next-sibling id. (2) Because the slot is nested instead of a
top-level array item, a preview switch never forces a rebuild of the outer
`state.drill.map(...)` closure (and thus never of the real `Block(b)` card
above it) — an earlier version pushed the preview items as top-level array
items with a **constant** key, which did not reliably re-render on a
changing sibling target (the same "arrow.js reuses a keyed node without
re-running the bindings" pitfall, but this time colliding with an earlier
render of itself rather than a different role). Test:
`tests/drill-preview.spec.mjs`.

**Unfocused columns collapse into a narrow rail** — as soon as
`state.focusLevel` is on a drilled column (i.e. `state.drill.length > 0`),
every column that doesn't have that focus (the top-level block card when
`focusLevel > 0`, and every drilled column before the focused one — never
after, since `focusLevel` is always `state.drill.length`, so the focused
column is always the rightmost one) no longer makes sense at full diff
width: there's nothing to review in a column that doesn't own the arrow
keys, and the space can go to the column that does.
`collapsedColumnHTML(b, level, testid, drillIdx)` (`home.mjs`) then renders
that column as a narrow button (`w-14`, full height via `<main>`'s existing
flex-stretch, no separate CSS needed) with an arrow icon + a vertically
truncated label (the last `::` segment of `b.label`, i.e. the
method/class name) — style borrowed from `RelatedPanel.mjs`'s
`sidebarHintRail`. Testids: `data-testid=block-collapsed` (top-level) resp.
`data-testid=drill-collapsed` + `data-drill-idx` (drilled column, mirroring
the existing `drill-column`/`data-drill-idx`). Clicking calls
**`expandColumn(level)`**: functionally identical to pressing `←` repeatedly
until you're at that level — `state.drill`/`state.drillCursor` are truncated
to `level` and `state.focusLevel = level`, so anything drilled deeper than
the clicked level is discarded (deliberately the same semantics as the
existing `←` pop, not a "leave the child open but hide it" variant — that
would break this section's single-focus-owner model). Both render spots
branch on this with **ordinary JS ifs within their existing,
already-`focusLevel`-subscribed bindings** (the top-level `${() =>
{...}}` slot in `block-column`, and the per-item `.map()` callback in the
drilled-columns list) — no new nested reactive slot, so no new keyed-node
pitfall: the top-level slot still returns an array
(`[collapsedColumnHTML(...).key(...)]`, never a bare element — the
single↔array pitfall in `conventions.md`), and the drilled-columns list
rebuilds anyway on every `focusLevel` switch (the existing `foc`/`unfoc`
key), so the rail-vs-card choice there needs no own key trigger.
See `tests/drill-collapse.spec.mjs` (one and two levels deep).

The block-card `.key(...)` encodes **role** (`sel`/`prev`) **and** code
status (`load`/`code`/`err`), so arrow.js builds a **fresh** card as soon as
a block moves from preview→selected (↓/↑ on an already-previewed block) or
its code arrives. Without those two key components, arrow.js reuses the
keyed node (move+patch) *without* re-running the `${…}` bindings: the
`activeGroup` highlight + scroll then stayed frozen on the previous
selection, and the `null→loaded` diff render dropped out intermittently
(card stayed stuck on "loading"). The "code arrived" signal runs through
`state.codeVersion` (bumped in `ensureCode`), which **the DetailPanel
binding** subscribes to so it re-runs and flips the key (fresh diff
binding). The `setCommentScope`/`setRelated` watches still read
`curBlock().code` (needed to follow the cursor) — it's precisely their
co-subscription to `b.code` that's why the diff binding can miss the update,
so we rebuild via the key rather than adding yet another `b.code` reader.
See the arrow.js pitfalls in `.claude/rules/conventions.md`.

**An ordinary `state.change` step within the same block must not flip this
card key** (otherwise it would force a fresh `Block()` call — and thus a
visible flicker over the whole card — on every ↑/↓). The gray step chevron
(`stepChevronSlot`/`canStep`, further down) itself reads `state.change`, but
therefore lives in its **own** nested `${() => …}` slot instead of directly
in the outer array-building closure of `DetailPanel` — otherwise that read
leaks into the whole closure and every step rebuilds all `Block()` cards
with fresh `activeGroup`/`hintsEnabled`/etc. closures. See the related
arrow.js pitfall in `.claude/rules/conventions.md`. That nested slot also
sits in a **stable element root** (a `<div>` with a static `contents`
class) — not as a bare keyed `${…}` wrapper: that let the chunk `ref` go
stale as soon as the chevron toggled and corrupted the keyed reconcile of
the block column (the look-ahead preview disappeared and the tab froze on
repeated ↓/↑ through same-file blocks) — see the "bare toggling
expression" pitfall in `.claude/rules/conventions.md` and
`tests/step-preview-stability.spec.mjs`.

`RelatedPanel` is **purely a placeholder with dummy data** — no `/api`
coupling yet. Two side-by-side cards (Underlying code on the left, comment
block on the right — see the layout paragraph above):

- **Underlying code** (above, `data-testid=related-code`): the **child
  blocks** of the selected block — the blocks it's linked to (right now: the
  `Listener::handle` of an event it dispatches). Each as a small
  Prism-highlighted PHP excerpt (`data-testid=related-item`). A listener
  child carries a `listener` kind badge; a **method call** has no word badge
  but a **diff stat** (`data-testid=related-diffstat`): `+A −R` (green/red,
  the number of added/removed lines of the called definition, counted with
  `diffStat` in `Block.mjs`, git-`--stat` style), or a gray **`Unchanged`**
  badge if the call points to a file the PR doesn't change (no diff → `r.diff`
  is `null`). Such an unchanged child also gets a **gray** ring instead of
  the indigo ring when selected — there's nothing to review.
  Fed from the relations read-model via `GET /api/relations?pr=N`;
  `home.mjs` (`childrenOf`/`relatedChildren`) pulls the children from
  `state.allBlocks` and lazily loads their code. A child is **removed from
  the left list** and shown here instead; what remains stays on the left.
  `recomputeLeftList` in `home.mjs` determines the left list:
  `state.blocks` = `allBlocks` minus (a) all relation `childId`s and (b) any
  **PR block that is the definition of a resolved/found method call**
  (`resolvedCallTargetIds`) — so a function that appears as "Underlying
  code" under a parent (e.g.
  `ProcessCartAction::buildShippingAddressAttributes` called on a changed
  line) doesn't *also* show up separately in the left list. It runs on
  `loadBlocks` and again after every `loadCallResolve` (initial + the poll
  after a search action), and preserves selection by **block id** so a
  callResolve reload doesn't shift the cursor.
  See `.claude/rules/tembed-workflows.md` (section "Relations between
  blocks").
  **"loading code…" vs. "no code found":** every child descriptor carries a
  `loading` flag (set in `home.mjs`, i.e. in the `setRelated` watch chain —
  never by `RelatedPanel` itself reading `b.code`): for a **lazy** PR-block
  child (relation child/`covered_by`) that's `!kid.code` — `ensureCode`
  always sets `kid.code` to an object as soon as the `/api/code` fetch
  completes, even on an error (`{error}`) — for an **embedded**-code child
  (`method_call`/`covers`, code sits synchronously in the
  callresolve/testcovers row) hard `false`. `relatedCard` renders three-way
  based on that: code → excerpt; empty + `loading` → "loading code…"; empty +
  not loading (a completed load that turned out empty/error, or an empty
  embedded `childCode`) → the end state **"no code found"**
  (`data-testid=related-empty`, same gray style). The item key encodes that
  state too (`related:<id>:code|load|empty`) — the block-card precedent from
  `conventions.md`, otherwise the loading→code/empty transition can freeze
  on a reused keyed node. Regression test:
  `tests/related-empty-code.spec.mjs` (PR 96, embedded empty; PR 90, lazy
  load that completes empty).
  The card is a **navigable list**: `→` from the diff selects the **first**
  item (`cs.codeSel=0`); `↓`/`↑` then move through the items (clamps at
  first/last — `↑` on the first item steps back out to the diff), `←` steps
  from any item back to the diff (see
  `.claude/rules/keyboard-navigation.md`). This list is entirely
  **separate** from the comments/tasks sidebar (see above) — there is no
  more `→`/`↓` here that jumps to comments/tasks; that's only via Cmd+→
  now. The selected item gets an indigo ring (`data-active=true`). All items
  stack **vertically** at full width (no more arrow hint — that's been
  removed); the card no longer collapses to make room next to the
  comments/tasks columns (that happened previously when they were still
  part of the same column flow — no longer needed, they're now a separate,
  `position:fixed` overlay, see "Comments/tasks sidebar" below).

  **Laptop-width auto-collapse next to an open comments/tasks sidebar
  (`relatedRailActive`/`relatedRail`, `RelatedPanel.mjs`):** that sidebar is
  a separate overlay, but still competes for horizontal room once the
  screen is too narrow to show both comfortably side by side. Below
  Tailwind's `2xl` breakpoint (1536px — the same point the rest of the
  layer already uses for width scaling, e.g. `Block.mjs`'s
  `w-[70rem] 2xl:w-[82rem]`) the card therefore collapses into a narrow
  rail (`data-testid=related-collapsed`, mirroring `collapsedColumnHTML`/
  `sidebarHintRail`: icon + vertical label + the number of children) as
  soon as **two** conditions hold: the sidebar is open (`sidebarOpen()`)
  **and** the card doesn't currently have the keyboard (`cs.focus !==
  'code'`) — that last condition mirrors the existing rule for drilled
  columns (`collapsedColumnHTML`, home.mjs): only what has the keyboard
  stays fully visible. That guarantees `→` (`enterRelated`, sets
  `cs.focus = 'code'`) always lands on the fully expanded, navigable card —
  never on hidden content. Leaving the card again (`←`, `cs.focus = null`),
  it collapses again as long as the sidebar remains open and the screen is
  narrow. A click on the rail calls `enterRelated()` directly — the card
  then immediately expands again and grabs the keyboard, just like a fresh
  `→` from the diff. On a `2xl`+ screen, or as long as the sidebar is
  closed, the card always stays the full (default or grown, see below)
  card; `viewport.wide` (a `matchMedia('(min-width: 1536px)')` listener,
  mirroring `theme.mjs`'s system-preference listener) keeps that reactively
  up to date, even on a resize. The toggle between rail and full card
  lives — per the "bare toggling expression" pitfall in `conventions.md` —
  in a **stable element root** (`<div class="contents"
  data-testid=related-panel-root">`), not in the entire body of the
  template itself. See `tests/related-code-narrow.spec.mjs`.
  The card has **no fixed height cap**: it grows with its content up to the
  full available height of the block column and then scrolls internally
  (`min-h-0`, body `flex-1 overflow-auto`). The code excerpts **wrap** (no
  horizontal scroll: `whitespace-pre-wrap break-words`) — but the
  **column** itself has since grown along whenever that wrapping would
  otherwise turn out ugly for a genuinely wide code body:
  `relatedColumnWidthCls` (`RelatedPanel.mjs`) makes the width of the
  **entire** Underlying-code column (not per card) a reactive `${() =>
  …}` class binding on the `<section data-testid=related-code>` instead of
  the previous static `w-[42rem] 2xl:w-[49.2rem]` string: it takes a
  **representative non-comment** code line across all currently shown
  top-level cards (`rc.children`, excluding the `tests_group` bar — nested
  chips and the drill-preview column remain unaffected on their own fixed
  `w-72`) and turns that character count into a CSS
  `clamp(min, calc(Nch + 2rem), max)` width: the `ch` unit is the exact
  glyph width of a monospace character, so this is **purely a calculation
  on an already-known character count** — no live DOM measurement
  (`scrollWidth`/`getBoundingClientRect`) that could race with a
  render/layout pass. `min` is the existing default floor
  (`42rem`/`49.2rem`), `max` is a ceiling that deliberately stays **below**
  the full block column (`56rem`/`65rem`, instead of its
  `70rem`/`82rem` — a long single word/line otherwise let it grow to "half
  the screen width", which was reported as a bug) — `clamp()` catches
  both "no code" and "everything is shorter than the floor" for free (the
  `calc()` outcome then simply falls below the floor). **Comment lines
  deliberately don't count** (`codeGrowthChars`, a regex/state-machine scan
  that skips a leading PHPDoc block, `//`/`#` lines and intervening `*`
  continuation lines), and **it's not the longest line that counts, but the
  75th percentile** of the remaining line lengths (nearest-rank): a single
  extremely long outlier line (e.g. one long `Cache::remember(...)` call in
  an otherwise normal method) must not single-handedly push the column to
  the ceiling — that line just wraps then
  (`whitespace-pre-wrap break-words`, see above). The plain median turned
  out too aggressive the other way in practice: in a method of only 3-4
  real content lines, the loose `{`/`}` lines pull the median down to
  almost 0, even if the method itself is quite wide. The 75th percentile is
  the middle ground: it still reflects the wider half of a method's actual
  content, without being held hostage by the one longest line. A long,
  prose-like comment line wraps neatly and must never widen the column,
  only real code lines (long method chains, wide return types, …) do that.
  Only reacts to `rc.children` — the same plain snapshot `kids()` already
  reads — so this introduces no new co-subscription on the selected
  block's own `b.code` (see the stuck-on-loading pitfall in
  `conventions.md`). The symmetry with the neighboring column (see above)
  thus only holds as a **default** now, not as a guarantee. Test:
  `tests/related-code-grow.spec.mjs`.
  Any child that is itself a PR block (relation child or a method call
  whose definition changes in the PR) carries an **approval badge**
  (`data-testid=related-approval`, `done/total`, green + ✓ when fully
  approved), and the card header shows a **rollup** over the shown children
  (`data-testid=related-approval-total`, "… · X/Y approved"). A call to an
  unchanged file has no approval concept and thus no badge. The counts come
  along in the child descriptor (`approve`, filled by
  `relatedChildren`/`resolvedCallChildren` in `home.mjs` via
  `blockApproveCount`); the same rollup appears as a combined pill on the
  sidebar row — see the combined-approval explanation in
  `.claude/rules/blocks-and-ingest.md`.
  **Drill hint chips (dash to the right, recursive mini-tree growing
  RIGHTWARD):** any child whose block **itself** still has changed
  underlying code shows a short **dotted dash** to the right of its card
  toward a chip column (`data-testid=related-nested`, `w-72` — doubled from
  the original `w-36` so longer `class::method` labels fit better): one chip
  per changed (grand)child (`data-testid=related-nested-chip`) with the
  **full `class::method` label** — **wraps, is never truncated**
  (`whitespace-normal break-words`, no `truncate`; bare name if there's no
  class — the shared `blockLabel` helper in `Block.mjs`, "class::method
  everywhere"), its own **diff stat `+A −B`** (green/red, `data-testid=
  related-nested-diffstat`, `diffStat` over the lazily-`ensureCode`d kid; a
  gray **`…`** placeholder while that code is still loading — never
  "Unchanged", every chip target is by definition a changed PR block) and
  the **approval `done/total`** (`data-testid=related-nested-approval`,
  `blockApproveCount` of the block itself — deliberately not subtree;
  ✓ prefix when fully approved; hidden when `total 0`). No file line in the
  chip (the full `label · file` sits in `title`).
  **Recursive, and RIGHTWARD (not indented below):** each chip is a flex
  row (`nestedChip`, `RelatedPanel.mjs`) — the chip button itself, followed
  by, if the child itself has further changed children, its **own** chip
  column next to it via `nestedChipColumn` — the same function that renders
  the top-level column next to the card, now the **only** recursive
  building block at any depth (there's no separate "indented-below"
  `nestedSubChips` anymore). The depth cap of **2 chip levels** below the
  card remains (`NESTED_DEPTH`, `home.mjs` — every level multiplies
  `ensureCode` fetches, and looking deeper is what drilling is for); per
  level capped at **3 chips + "+N more"** (`data-testid=related-nested-more`,
  never reachable via keyboard — see below), cycle-safe via a shared `seen`
  set (the `nestedPrBlocks` pattern). Because each row can now be wider than
  its own `w-72` column (card-wide row contains a column per depth), the
  card's existing `overflow-auto` body also scrolls **horizontally** when
  needed — no separate CSS change, just a consequence of the
  rightward-growing layout. The data comes from
  `nestedChangedKids(prBlock, parentId, seen, depth)` in `home.mjs` (plain
  descriptors on `r.nested` + a recursive key signature `r.nestedSig` via
  `nestedSigOf`, built in the same descriptor builders/`setRelated` watch as
  the rest — never in a render binding, so no `b.code` race):
  `directChildBlocks` by definition only yields **PR blocks**, so an
  `Unchanged`/synthetic call target never gets a chip (a call child without
  a `prBlock` explicitly gets `nested: []`). Chips ride along on the
  descriptor, so they appear at every granularity where the child itself is
  visible (also `line`/`call`). A **click on a chip at depth d drills d+1
  levels at once** (the card child, then every ancestor chip, then the chip
  itself — sequential `drillIntoChild` steps via the same `drill` callback,
  with `stopPropagation` so the card click doesn't also drill one level
  beyond); `Enter` on the card remains the normal single-level drill.

  **Keyboard through the chip tree (`cs.chipPath`, `RelatedPanel.mjs`):** a
  second, nested cursor next to `cs.codeSel` — empty (`[]`) means the
  keyboard is on the card itself, `[i]` the i-th top-level chip, `[i,j]` its
  j-th subchip, and so on (one index per depth, mirroring the recursive
  `nested` shape of the data). Only meaningful within `cs.focus==='code'`
  (`handleRelatedKey`), spatially consistent with the rightward-growing
  chips: **`→`** descends into whatever's currently focused (card or chip)
  toward its own first nested chip (no-op without nested); **`←`** climbs
  one level back (only when `chipPath` is empty does it fall through to the
  existing "leave the panel" behavior — this is a **deliberate behavior
  change**: `←` used to *always* close the panel, regardless of chip
  focus); **`↓`/`↑`** walk through the **siblings at the current depth**
  (`chipListAt`, clamped at start/end — no flow into another level) as
  long as `chipPath` isn't empty, otherwise the existing `cs.codeSel`
  behavior over the cards; **`Enter`** drills the whole chain via
  `focusedChipChain()` (ancestors + focused chip, mirroring the click
  handler). `chipPath` resets to `[]` as soon as `codeSel` changes and on
  every `setRelated` push (the tree can rebuild, so an old depth index
  isn't trustworthy). The focus ring (`data-active` on the chip) is
  **also** scoped on `cs.codeSel` — not only on `chipPath` — because two
  different cards can happen to have the same chip tree shape (and thus the
  same path); without that extra check the "focused" chip would light up on
  **every** card with that shape at the same time (regression test: the
  last test in `tests/related-nested-chip.spec.mjs` drills three levels
  deep and verifies at each step that only the card at `codeSel` shows an
  active ring).

  arrow.js details: the card root of `relatedCard` is a flex row (card
  `min-w-0 flex-1`); the approval count is a **precomputed string**
  (`approveText`) in an always-present element, and every conditional
  sub-template (chip column, diff stat) runs through a **`${() => …}`
  function binding** — never a static template↔string ternary, which
  leaked arrow's template function (`i=>je(n,i)`) as text on chunk reuse,
  see the "static template↔string slot" pitfall in
  `.claude/rules/conventions.md`. The card `.key` in `fullCard` carries
  `r.nestedSig` so every tree change (set/approval/diff loaded) builds a
  fresh node; chip keys are the **id path** (the same id can hang under two
  parents). `data-child-id` stays on the innermost card, so the call-arrow
  overlay (which targets the **left** edge of the card) isn't affected by
  the chips on the right. The `tests_group` bar (see below) gets no chips.
  The collapsed column rails (`collapsedColumnHTML`, `home.mjs`) show, since
  this change, also the full `class::method` label via the same
  `blockLabel` helper. See `tests/related-nested-chip.spec.mjs`.
  Next to the listener children, the same card also shows the **method
  calls** the block makes, linked to their **definition** — even from
  unchanged files (`kind=method_call`, from `GET /api/callresolve`, code +
  descriptor sit in the row, so no extra code fetch). Only calls on
  **lines the PR changed** get such a row (the resolver only scans the
  changed lines, see `.claude/rules/tembed-workflows.md`); **enum cases**
  (`AddressType::BILLING`) also resolve — to their enum declaration.
  A **third** child source links a PHPUnit test to the method it tests, in
  **both directions**: `kind=covers` (a test block shows the tested method
  — diff stat/`Unchanged` badge just like `method_call`) and
  `kind=covered_by` (a tested production method shows "covered by
  TestX::testY" — the test itself, reused as an existing PR block). From
  `GET /api/testcovers`; both are **block-level** (like the listener
  children) and thus also drop out at `gran==='line'`/`'call'` (see the
  scoping/reordering paragraph below). If a test lacks a usable coverage
  annotation, the card header shows a **warning** instead of a child
  (`data-testid=related-covers-warning`, custom inline SVG + explanation —
  never an AI guess). See `.claude/rules/tembed-workflows.md` (section
  "Linking test coverage").
  **Grouping covering tests into a horizontal bar** (`groupTestChildren` in
  `home.mjs` + `testsBar` in `RelatedPanel.mjs`): as soon as a block shows,
  besides its `covered_by` children (the covering tests), **other**
  (non-test) children too, those tests collapse together into one
  horizontal row (`data-testid=related-tests-bar`: chevron + "N tests" pill
  + one compact chip per test method, `data-testid=related-tests-chip`) at
  the spot where the first test was in the ordering — so they don't push
  the actual underlying code down. Click or `Enter` on the bar **toggles**
  the expansion (`state.testsExpanded`, ephemeral — not in the URL, resets
  to closed on a block switch via `lastRelatedBlockId` in the `setRelated`
  watch callback; `state.testsExpanded` is an inline dep in that watch
  getter): expanded, the tests appear as **ordinary child cards directly
  below the bar** (the bar stays as a collapse toggle). If there are **no**
  other children (or no tests), this is a no-op — the tests render as
  ordinary cards, as before. The group item rides along **within** the
  child list itself (a synthetic `kind:'tests_group'` descriptor), so the
  panel cursor (`cs.codeSel` indexes `rc.children` 1-to-1) needs no
  separate case: `Enter`/click lands in `drillIntoChild`, which branches on
  the child (toggle instead of drilling); `orderedChildBlocks` filters it
  out — just like `covered_by`. The bar's `.key` encodes open/closed + the
  test ids (fresh node per toggle, per the keyed-node pitfall in
  `conventions.md`). Test: `tests/related-tests-group.spec.mjs` (fixture PR
  99, `testsgroup-*.json` + `materializeTestsGroupWorktrees`).
  **Call-arrow overlay (`src/callArrows.mjs`):** a **smooth indigo bezier
  arrow** runs from the changed call site in the **active navigation unit**
  (right edge of the new pane, at the height of the call-site row) to the
  corresponding **changed** child card in this card — exclusively for a
  `method_call` child whose definition is itself a PR block (an
  `Unchanged` target never gets an arrow), one arrow per matching child,
  only in diff mode and only for **the column that currently holds the
  keyboard** — the top-level selected block (`focusLevel === 0`,
  `state.gran`/`state.change`) **or** the focused drilled column
  (`focusLevel > 0`, its **own** `state.drillCursor[focusLevel-1]`
  cursor) — exactly the `approveContext()` idiom (`callArrowPairs(b)`
  guards on `b === focusedBlock()` instead of always requiring
  `curBlock()`/`focusLevel === 0`). Every drilled column is after all a
  full-fledged, navigable diff with its own change-group cursor (see
  "Column navigation" above) — so there's no reason for the arrow to go
  away as soon as the reviewer drills. The DOM side
  (`callArrows.mjs`'s `main.querySelector('[data-pane="new"]')`/
  `panel.querySelector('[data-child-id]')`) needed **no** change: a
  non-focused column (top-level or drilled) always collapses to a rail
  without `[data-pane]`, so that query automatically finds the one
  remaining `[data-pane]` block — that of the column holding the keyboard,
  at any depth.
  The scope mirrors the panel's **visibility** exactly
  (`resolvedCallChildren`'s `hideOutOfScope`), not merely
  `callScopeMethods`' bare unit-range check at every granularity: at
  `call`/`line` the panel really **hides** a child outside the active unit
  (see below), so there the arrow only points to the one active
  segment/row. At **`group` the panel hides nothing** — every
  changed-target call child stays visible, only reordered (`groupTier`) —
  so there `callArrowPairs` points to **every** such child, not only the
  children whose call site happens to fall within the active group: first
  a site within the active unit (keeps the arrow close to the cursor when
  possible), otherwise the first known call site of that child anywhere in
  the block, so a groupTier-1 card (outside the active group, but shown by
  the panel anyway) still gets an arrow. Without this fallback a visible
  card sometimes ended up without an arrow when the active group didn't
  contain the call site. **Deliberately an imperative drawing layer**, not
  a reactive template (the `updateHints`/`positionMenu` model):
  `callArrowPairs` in `home.mjs` computes the pairs in the **callback** of
  the existing `setRelated` watch (untracked — no new reactive `b.code`
  reader, so no stuck-on-loading race) and pushes them via `setCallArrows`
  to `callArrows.mjs`, which purely reads the DOM (`getBoundingClientRect`
  on the `data-row` row in `paneHTML` resp. the `data-child-id` card on
  `relatedCard` — two static attributes) and imperatively redraws one
  **statically mounted** `position:fixed` `<svg data-testid=call-arrows>`
  (top-level next to `MenuHost`, `z-[15]`: above `<main>`'s z-10, below the
  sidebar's z-20 and the command menu; `pointer-events:none`) (path
  `data-testid=call-arrow`, stroke `#6366f1` at 0.45 opacity + arrowhead
  marker). The svg is laid exactly over `<main>`'s rect on each draw and
  clips itself — arrows never draw over the pr-index/PR-info/sidebar/footer.
  Redrawing: rAF-coalesced on the watch itself, `resize`, capture
  `scroll` (including inner scrollers — the `repositionMenu` precedent) and
  a 250ms settle after every push (the 200ms width transitions, à la
  `openMenu`).
  **The `a` toggle (`state.diffViewMode`, see below) is such a width
  transition but touches none of the `setRelated` watch's dependencies
  (`state.selected`/`mode`/`gran`/`change`/…) — so the watch doesn't fire and
  `setCallArrows` isn't called again, while every card's width changes
  anyway (a fixed 60% for `'new'`, a content-based width for `'fit'`, see
  below).** Without a countermeasure, the arrow stayed drawn at the
  pre-toggle (wide) coordinates, disconnected from the now-narrower pane
  edge. `toggleDiffView` (`home.mjs`) therefore explicitly calls
  `resettleCallArrows()` (`callArrows.mjs`): the same immediate + 250ms
  settle redraw schedule as `setCallArrows`, but without changing the pairs
  themselves (they stay identical — only the geometry changes).
  A call-site row scrolled out of the diff viewport loses its arrow (the
  same visibility rule as `updateHints`); a child card scrolled out
  internally keeps an arrow **clamped** to the panel edge. Test:
  `tests/call-arrows.spec.mjs` (fixture PR 100, `arrow-*.json` +
  `materializeArrowWorktrees` in `tests/_setup.mjs`).
  The card **follows the cursor**: `home.mjs`
  (`callScopeMethods`/`findCallSites`) links every resolved call to the
  diff segment it's on. At the finest level (`gran==='call'`) the card
  shows **exactly the method of that one call** — land on `->billingAddress`
  and you see `Order::billingAddress`; a segment without a resolved call
  gives an empty card. At `gran==='line'` it scopes to the **lines of the
  selected unit**: only the calls whose call site falls within
  `[unit.start, unit.end]`. At **`line`/`call` this is a hard filter
  (hiding)** — you never see a call, listener, `covers`-/`covered_by`
  child of a line you did *not* select (`relatedChildren`'s `scoped` flag
  in `home.mjs`, exactly what "if I select a line/call I want only the
  underlying code of that line/call" asks for). Only in **list mode** (no
  diff) does it show **all** resolved calls of the block.
  **At `gran==='group'`, nothing is hidden but reordered:** a group often
  spans multiple lines/calls, so a relation/`covers`/`method_call` child
  that isn't exactly on the selected line(s) doesn't disappear — it only
  sinks below the children that are. Every relation/annotation for this
  purpose carries an **absolute source line** (recorded server-side by the
  detector that found it — `relations.Relation.Line` resp.
  `testcovers.Entry.Line`, see `.claude/rules/tembed-workflows.md`);
  `groupLineRange(b, rows)` in `home.mjs` converts the selected group unit
  to that same absolute line range (`unitLineRange`, reused unchanged) and
  `relatedChildren` sorts first on that **`groupTier`** (0 = within the
  group, 1 = outside it) before the existing `prio`/`size` sort — so within
  each tier the ordering below still applies as usual. A `covered_by` child
  (the test covering a production method) has **no** anchor point within
  the viewed block — the annotation lives in the test file, not the
  production code — and thus always sits in tier 1; its own `prio 0` still
  keeps it above a `prio 2` (unchanged) call within that tier: "at the
  bottom, but above unchanged". An LLM `found` `covers` row that escalated
  from a class-only annotation also carries no `Line` for the same reason
  (`resolve_test_covers.go` deliberately doesn't thread it through) and thus
  degrades to that same tier 1. Outside `gran==='group'` (list mode, or at
  line/call where the filter already only leaves in-scope items),
  `groupTier` is `0` everywhere — a no-op, the ordering is then exactly as
  before this reordering.
  The shown calls are (within their tier) **ordered**: first a call whose
  definition itself changes in this PR (a real child block, `prio 0`), then
  calls on a recently changed line (`prio 1`), then the rest (`prio 2`).
  **Within the same prio** the **largest** child wins (most non-empty
  lines, `codeSize` on the child source — `childCode` for a call, loaded
  `code` for a listener): so the substantial changed code sits on top and
  trivial one-liners sink below. That's load-bearing because relation
  accessors (e.g. Eloquent `Order::billingAddress`, a 3-line `MorphOne`)
  are **also** `added` PR blocks and thus also `prio 0` — they'd otherwise
  land before a genuinely changed method purely on source order. A child
  whose code hasn't arrived yet counts as `size 0` and sinks until it
  loads; equal prio+size keeps source order (stable sort). The listener
  children (block-level) drop out at `line`/`call` level. In the card
  header the **title (`class::method`) is always visible** (gets the
  first line, only truncates at extreme length); the **file path** sits
  below it on its own line and truncates if it doesn't fit.
  **Reactivity:** the list is **not** computed in `RelatedPanel`'s render
  binding but in a `watch` in `home.mjs` and pushed into the panel via
  `setRelated` — the same decoupling as `setCommentScope`. That is
  **load-bearing**: if the render binding itself read the `b.code` of the
  selected block (via `blockRows`), that would race with `home.mjs`'s diff
  render over the same `b.code` and the diff would stay stuck on
  "loading". **Equally load-bearing: the watch getter must enumerate the
  navigation state _inline_** (`state.selected`, `mode`, `change`, `gran`,
  the block lists, `callResolve`, `relations`, `curBlock().code`) — exactly
  like the `setCommentScope` watch. Only compute the children in the
  _callback_ (`() => setRelated(relatedChildren(),
  unresolvedCalls())`). Compute them in the getter itself, and all reactive
  reads are hidden inside `relatedChildren`/`unresolvedCalls`, and due to
  their early returns (empty block at load, `resolved.length === 0`,
  scope shortcuts) the crystallized run drops `state.selected` from its
  dependency set: the `watch` no longer re-subscribes and the panel
  **freezes** on the block that was selected at load time — it no longer
  follows the cursor to a different block.
  **Refresh restore of the panel cursor:** `cs.focus`/`codeSel`/`sel`/
  `threadPos` live in the URL under their own `rel` namespace
  (`bindUrlState(cs, …, { ns:'rel' })` in `RelatedPanel.mjs`), so a refresh
  puts you back on the same Underlying-code child resp. the same comment
  thread. Because the data pushes (`setRelated`/`loadComments`) clamp `cs`
  while loading — and the mirror `watch` would immediately reflect that
  into the URL — `RelatedPanel` snapshots the restored values in
  `restorePending` and reapplies them, clamped, exactly once via
  **`applyRelRestore`** once the children/comments are in (only focus if
  its target exists, then clear so later navigation stays free). See skill
  `url-state` and the URL-state section in `CLAUDE.md`.
  Calls the Go resolver couldn't pin down **automatically** start the LLM
  search — **no button anymore**: `home.mjs` calls
  `startCallSearch(focusedBlock())` in the `setRelated` watch as soon as the
  panel shows a block with `unresolved` calls (`POST
  /api/workflows/resolve_call`, deduped per caller+callKey in
  `searchRequested` so it fires once). It resolves the **entire**
  unresolved set of the block (not scoped to the selected unit), so you
  never need to navigate anywhere. While searching, the card shows
  "searching…" (`data-testid=related-searching`, also as long as there's
  still `unresolved` in the queue). A child found by an LLM carries a
  **`source: haiku/sonnet`** badge (`source`); Go-resolved children show no
  source. See `.claude/rules/tembed-workflows.md` (section "Resolving
  called … methods").
- **Tasks** — this was once a placeholder column with a dummy task list +
  chat (`ui.task`, `data-testid=task-list`/`chat`/`chat-bubble`/`new-task`).
  That placeholder no longer exists: the "Tasks" card is now the real,
  working `workflows-panel` described above (`data-testid=
  workflows-panel`, fed by `GET /api/workflows?pr=N`) — no chat, no
  `ui.task`. See also the keyboard binding further down in this section and
  `.claude/rules/keyboard-navigation.md`.

The block card keeps its fixed `w-[70rem] 2xl:w-[82rem]` width (no more
`flex-1`, and regardless of whether the block is one- or two-sided), so the
diff doesn't stretch and the panel sits snugly next to it. In `'list'` mode
`<main>` starts at `left-[29rem]` (next to the sidebar), in `'diff'` mode at
`left-6` (more room); in both cases the columns keep packing from the left.

**Exception: the `a` toggle (`state.diffViewMode`, see
`.claude/rules/keyboard-navigation.md`) shrinks EVERY visible card to 60%
width, regardless of whether it actually hides a pane.** With `viewMode
==='new'`, a card shrinks to `w-[42rem] 2xl:w-[49.2rem]` (60% of
`w-[70rem] 2xl:w-[82rem]`) — for a two-sided (`modified`) block that then
also really hides its old/left pane, but **equally so** for an already
one-sided `added`/`removed` block that has nothing to hide. This was
earlier restricted to the two-sided case (the deliberate width stability
for one-sided blocks won out then); that's been deliberately abandoned: the
reviewer wants `a` to make **everything currently visible** equally narrow,
so the layout doesn't differ per block type as long as the toggle is on.
Two separate, decoupled conditions in `Block.mjs`: `forcedNewOnly(b,
viewMode)` remains unchanged and still determines **which pane(s)**
`codeDiff` shows (only relevant for a genuinely two-sided block — a
one-sided block already showed only one side anyway); the new, simpler
`narrowed(viewMode)` (just `viewMode()==='new'`, no `singleSide` check)
determines the **width** in `Block()`'s own card `class` binding. Applies
automatically to **every** visible card (top-level selected/preview and
every drilled column), since they all share the same `Block()` component
and the same `viewMode` opt (`() => state.diffViewMode`).

**`a` cycles through a THIRD stand, `'fit'`, between `'new'` and back to
`'split'`** (`DIFF_VIEW_CYCLE` in `home.mjs`): both panes come back (like
`'split'` — `forcedNewOnly` only ever reacts to `'new'`), but the card's
width becomes **content-based** instead of the fixed `70rem`/`82rem`:
`widthCls(b, viewMode)` (`Block.mjs`) delegates to `fitWidthCls(b)` for
this stand, which sizes the card off a representative (75th-percentile,
non-comment) line length of the block's own code — `codeGrowthChars`,
moved out of `RelatedPanel.mjs` into `Block.mjs` and exported so both files
share the exact same calculation — clamped between the existing 60% floor
and the full split ceiling, so `'fit'` always sits between the other two
stands. A genuinely two-sided block uses the wider of its old/new side,
doubled (both panes render at equal width) plus a fixed gutter allowance;
an already one-sided block (only one pane ever renders, regardless of
`viewMode`) uses the single-pane variant instead, based on just that one
visible side. See `.claude/rules/keyboard-navigation.md` ("`a` — cycling
the diff view") for the full mechanism. Test: `tests/diffview.spec.mjs`.

**A look-ahead preview must never be wider/richer than the active block next
to it (`activeSingleSided`, both preview spots).** Without a
countermeasure, every card determines its width/pane choice purely from its
**own** `status` (`singleSide(b)`, now exported from `Block.mjs`) plus the
**global** `state.diffViewMode` — so a one-sided (`added`/`removed`, narrow
+ one pane) active block could sit next to a **two-sided** (`modified`)
preview block that, without the `a` toggle, simply showed its full width +
both panes (thus also the old code): wider *and* richer than what the
reviewer is currently reviewing. Both look-ahead preview spots — the
top-level `pair.forEach` in `DetailPanel` (`home.mjs`) and
`drillPreviewColumns()` — therefore compute
`const activeSingleSided = !!singleSide(<the active block>)` (top-level:
`state.blocks[sel]`; drilled-column sibling: `focusedBlock()`, the block
of the card this preview hangs directly beneath) and give **only the
preview card** an override `viewMode`:
`() => (i !== sel && activeSingleSided) ? 'new' : state.diffViewMode` resp.
`() => (activeSingleSided ? 'new' : state.diffViewMode)`. Since
`narrowed`/`forcedNewOnly` already react purely to `viewMode()==='new'`
(see above), this one override suffices to make the preview both narrow
(`narrowed`) and new-only (`forcedNewOnly`, hides the old pane) — exactly
the same lever as the `a` toggle, only applied per-render conditionally
instead of solely on the global state. **A one-way rule, deliberately:**
this never widens/enriches a one-sided preview back to two-sided if the
active block itself is two-sided — the preview may then simply stay
narrower than active, that's not a violation. Two edge cases remain
deliberately untouched: an already-one-sided preview (its own
`singleSide(b)` wins in `codeDiff`'s `effectiveOnly = only ||
(forcedNewOnly ? 'right' : null)`) just shows its own side, regardless of
the override (there's only one side to show anyway); and a one-sided
preview next to a two-sided active block simply stays narrower (no forced
widening). The active card itself never gets this override — only its own
`singleSide(b)` + the global `state.diffViewMode` determine its own
display, unchanged. **The override always forces `'new'`, never `'fit'`** —
even if the global stand is `'fit'`: forcing the narrower, fixed-width
`'new'` here is what guarantees the "never wider than active" rule holds
deterministically; `'fit'`'s content-based width could in principle exceed
the active card's width even for a one-sided active block, which would
defeat the whole point of this override. Test:
`tests/preview-matches-active-width.spec.mjs`.
