# The planning page (`/plan/<JIRA-KEY>`)

The stage **before** a pull request exists: a Jira ticket, the questions Claude
still has to sharpen the plan, and everything that has to be done — reached by
clicking a row in the **"Planning"/"Todo"** sections of `/pr-overview` (see
`.claude/docs/pr-overview.md`).

Reviewer request, verbatim: *"als je op todo of planning drukt moet je gaan
naar /plan/123. dezelfde style als een tree, maar niks hergebruiken. alleen de
eerste kolom beetje hergebruiken. ticket omschrijving en daaronder draaiende
workflow taken. 2e kolom moet de vragen zijn die je hebt om de plan te
perfectioneren. multiple choice met elke keuze ook een input veld. als ik
Navigeer over de keuzes wil ik rechts daarvan voorbeeld code zien in blokken
zoals in de tree. het kan ook onderliggende blokken hebben"*, plus *"onder de
vragen moet alles wat gedaan moet worden in een lijst met uitleg rechts daarvan
een onderliggende blokken"* and *"mogelijk ook meer dan 3 kolommen voor diepere
onderliggende code"*.

## Same style as the review tree, deliberately its OWN code

`src/plan.mjs` imports **nothing** from `home.mjs`/`Block.mjs` — those carry
the whole review-tree navigation state (comment cursors, url-state bindings,
drilling) and none of it applies here. It reuses only the shared **page-level**
utilities every page already uses (`theme.mjs`, `i18n.mjs`, `markdown.mjs`,
`urlState.mjs`, `settingsLink.mjs`) plus the vendored Prism — plus THREE
deliberate exceptions: `ClaudeChat.mjs`'s `claudeChatColumn` (the general chat,
see below), `lineDiff.mjs`'s `alignRows` (the current-vs-proposed code panes,
see below), and `RelatedPanel.mjs`'s `TasksPanel` (the "Taken" block — see "The
Taken block is the literal TasksPanel" below). This third exception is a later
addition and a step further than the first two: `claudeChatColumn`/`alignRows`
are pure, component-less template/comparison layers with no state of their
own, while `TasksPanel` really does pull in a slice of `RelatedPanel.mjs`'s own
module-private state (`taskUi`, via the exported
`markTaskRetrying`/`clearTaskRetrying`/`isRetryingRun`) — an explicit,
reviewer-requested exception to "reuses nothing from RelatedPanel.mjs", not an
oversight. It repeats the tree's *shape* (a horizontally scrolling column flow,
a card per column, one column owning the keyboard) in ~700 lines of its own.
The one thing the request called "een beetje hergebruiken" is the **first
column**: the same two-card stack as the review tree's PR-info column — the
ticket on top, the "Taken" block below it.

**Write-boundary audit (task 46):** every state-changing action on this whole
page already goes exclusively through a sanctioned `/api/workflows/...` start
(`plan`, `plan_execute`, `jira_comment`) or signal (`plan_answer` in its
various Kinds, `plan_scope`, `plan_hotfix`, the chat signal) POST, plus the
generic `/api/workflows/retry` — every other `fetch` in `src/plan.mjs` is a
read-only `GET`. No direct-write violation found; nothing needed changing for
`.claude/rules/workflows-write-boundary.md`.

## The columns

1. **The ticket** (`plan-info-column`, `w-[34rem]`) — key, title, a link to the
   issue in Jira, the description as Markdown (`renderMarkdown`), plus the
   back-link/theme/settings row. Below it, as its own `shrink-0` card, the
   **"Taken"** block: the literal review-tree `TasksPanel` (RelatedPanel.mjs),
   fed the workflow runs of THIS ticket from `GET /api/workflows?plan=KEY` —
   see "The Taken block is the literal TasksPanel" below.
2. **The questions** (`plan-questions-column`, `w-[27rem]`) — or, while the
   scope question stands, ONLY that question (see "Subtask and main task"
   below) — one card per
   question, every option a row with a `●`/`○` glyph plus the word "gekozen"
   (never colour alone, per the colourblind rule) **and its own free-text
   field**. Every question also gets one extra, always-present **last** row —
   `ownOptionRow`/`ownOptionId` (`src/plan.mjs`), reviewer request "altijd een
   laatste optie met alleen input velden" — for when the real cause isn't
   among Claude's generated options: no label/detail (there is nothing
   generated to show), just the glyph and its own free-text field, so typing
   an answer there and pressing Enter chooses it. Purely a client-side
   rendering concern: `navRows()` synthesizes it fresh on every render with id
   `<questionId>:own` (never collides with a real `q1o1`-shaped id), it is
   never part of the stored `planOption` model, and the signal endpoint
   accepts any `optionId` string (`upsertPlanAnswer`, `plan_workflow.go`) so it
   persists/reloads exactly like a real option's answer. Underneath, in the
   same scrolling column, **"Plan"** (renamed from "Wat er moet gebeuren" —
   reviewer request, freeing up horizontal room for the task titles): the task
   list, each task with its explanation, and as the **last row of the whole
   index** the action that runs the plan (see "The last action" below).
3. **The example code** (`plan-block-column`, `w-[46rem]`, `data-level=0`) — the
   blocks of whatever the cursor is on (an option or a task): a card per block
   with a file/label/language header, its explanation (`note`,
   `data-testid=plan-block-note`) and Prism-highlighted code.
4. **… and one more column per nesting level.** A block with `children` shows a
   `N onderliggende blokken →` button; `→` (or a click on it) opens those
   children as their **own** column to the right, arbitrarily deep — the
   requested "meer dan 3 kolommen voor diepere onderliggende code". Same
   drill-shaped navigation as the review tree's Underlying-code columns, but its
   own implementation: `state.path` holds one cursor index per open block
   column, so its **length IS the number of block columns**. A nested block is
   rendered by the very same `blockCard`, so **every** block carries its own
   explanation, at every level — a child's `note` says why it hangs under its
   parent (which call, which coverage, which call-site). The prompt asks for
   that per block explicitly; it used to show `"note"` only on a top-level
   block and an empty `"children":[]`, and the model then left every nested
   block's note empty (measured across all stored documents).

## The Taken block is the literal TasksPanel

Reviewer request, verbatim: *"dit blokje met workflows, mag exact hetzelfde
werken als in pr tree"*. The "Taken" card used to be its own small render
(`runRow`/`tasksCard`/`planRunStatusWord`, ~90 lines) with its own status-word
map, its own always-visible "Opnieuw plannen" button and no note/relative-time
line at all. It is now the **exact same component** the PR review tree uses —
`TasksPanel`, `buildTaskRows`, `visibleWorkflowRuns`, `workflowNote`,
`STATUS_BADGES` (all `RelatedPanel.mjs`) — imported and mounted unchanged, a
third exception to this page's "own code" rule (see above). `tasksCard()` is
now one line: `TasksPanel(state, { openRowMenu, refresh, subtitle })`.

### What this pulls in, verbatim, for free

- The two-line row (status-word badge + label + relative time, then a
  truncated note line), the 3,5-row scroll cap with "nog N meer — scroll voor
  de rest", and the ⟳ refresh button in the header — pixel-identical to the
  tree's own.
- **The merged failed/skipped view**: a genuinely failed run and a swallowed
  `planGenerate` error (see below) both render exactly like any other failed
  run in the tree (rose "⚠ mislukt" badge, the recorded message as the note),
  not a page-specific amber pill anymore.
- **`visibleWorkflowRuns`'s own visibility rule, UNCHANGED**: a run only shows
  while genuinely `running`, or stale (5+ minutes) and not `waiting`. The
  ticket's own `plan` tracker sits `waiting` almost all the time (parked on
  `WaitSignal` between questions) — exactly the same "long-lived tracker
  idling on a Signal is not actionable, just noise" case `build_relations`/
  `approve`/`pr_status` already are on the PR tree (see `workflowNote`'s own
  doc comment in RelatedPanel.mjs) — so **the "Plan" row disappears from the
  Taken block whenever it is simply waiting for the reviewer**, same as any
  idling tracker on the PR tree. This is a real, visible behavior change from
  the old always-a-"Plan"-row version, accepted deliberately as the direct
  consequence of literal reuse rather than carved out as a plan-specific
  exception.

### The shim: two client-side properties, no backend change

`buildTaskRows`/`visibleWorkflowRuns` read two properties off whatever state
object they're given — `state.workflows` and `state.pageProblems`
(`{failedRuns, logErrors}`) — neither of which exists on `GET /api/plan`'s own
shape (that's PR-tree vocabulary: `GET /api/workflows?pr=N` +
`GET /api/problems`). `plan.mjs` derives both, purely client-side, and keeps
them on its own `state` (so TasksPanel's own `${() => ...}` bindings, which
read `state.workflows`/`state.pageProblems` by property access, stay
reactive):

- **`planWorkflowsForPanel()`** → `state.workflows`: `state.runs` verbatim,
  except the ticket's own `plan` run gets `{status:'running', note:'plan
  wordt opgesteld…'}` while `busyGenerating()` is true (the tracker's own
  "generating right now, including the gap right after an answer before the
  run's stored status has visibly flipped" signal — see `busyGenerating`'s
  own doc comment). `workflowNote` (RelatedPanel.mjs) reads a run's own
  `.note` field FIRST, before its `workflow:status` table — a one-line,
  backward-compatible addition (every real `WorkflowRunView` off the Go JSON
  never carries this field, so every PR-tree call site is unaffected) added
  specifically so this override works with no other change to the shared
  function. **Also bumps `updatedAt` to now, and picks an action-specific
  note** (reviewer report, task 52, screenshot "ik zie het niet als een taak
  wat bezig is"): without the timestamp bump the row said "bezig" right next
  to its OLD `relTime` ("3 uur geleden"), reading as stale/contradictory
  rather than "started just now"; the note used to be one generic "plan
  wordt opgesteld…" for both `followupPending` and `regeneratePending`,
  now `busyGeneratingNote()` matches each action's own row wording
  (`followupWord`/`regenerateWord`) so the Taken-block row is recognizably
  the task that button just started. **If no `plan` run has been polled back
  at all yet** (the very first click on a fresh ticket), a synthetic
  `{runId:'plan-pending', workflow:'plan', status:'running', ...}` entry is
  pushed instead of silently having nothing to override — the next real poll
  replaces it with the genuine run. Test:
  `tests/plan-followup-taken-row.spec.mjs`.
- **`planProblemsForPanel()`** → `state.pageProblems`: `logErrors` is always
  `[]` (a planning ticket has no repo-wide `/api/problems` equivalent — that
  endpoint is PR-scoped). `failedRuns` holds every run genuinely
  `status === 'failed'`, PLUS — if the `plan` run isn't itself `failed` but
  `state.doc.error` is set — a synthesized failed-run entry for it
  (`{...run, status:'failed', error: state.doc.error, retryable:true,
  synthetic:true}`): `planGenerate`'s Activity swallows its own error onto the
  document instead of failing the Execution (see plan_workflow.go), so
  `run.status` alone never carries a killed/timed-out `claude -p` call. Only
  the `plan` workflow is ever `retryable:true` here. The `synthetic` tag is
  what lets `retryPlanRun` pick the right resume mechanism for this entry —
  see "Opnieuw plannen" below for why a real failed run and this one cannot
  share one endpoint. **The synthetic entry is suppressed while
  `busyGenerating()` is true** (reported bug, task 46): a follow-up round, an
  answer, or "opnieuw plannen" starts a FRESH `planGenerate` call —
  `planWorkflowsForPanel` right above already flips this same run to
  `running`/"plan wordt opgesteld…" for exactly that gap, but `state.doc.error`
  still carries the PREVIOUS attempt's error until the next poll lands, and
  `buildTaskRows` (`RelatedPanel.mjs`) always prefers a `failedRuns` entry over
  the live one for the same `runId` — so without this guard the stale
  "mislukt" row kept hiding the running task for as long as the new attempt
  was in flight, and the follow-up-questions badge ("vragen worden bedacht…")
  never showed up as a Taken-block task at all, even though the generation
  itself already runs entirely inside the existing `plan` tracker via the
  sanctioned `plan_answer` Signal (`kind:"followup"`) — no separate workflow
  was needed, only this client-side fix. Unaffected: `retryPlanRun`'s own "↻
  opnieuw gestart" row never sets `busyGenerating()` (it uses the separate
  `taskUi.retrying`/`markTaskRetrying` mechanism, `RelatedPanel.mjs`), so a
  manual retry click keeps rendering from this same branch throughout. Test:
  `tests/plan-retry.spec.mjs` ("a fresh generation hides the stale error
  row").
- **`syncTaskPanelState`** (a `watch`, inline deps per
  `.claude/rules/arrowjs-pitfalls.md`) recomputes both on every change to
  `state.runs`/`state.doc.error`/`state.generating`/`state.scopePending`/
  `state.hotfixPending`/`state.followupPending` — not just a fresh poll, but
  every optimistic local flag that flips `busyGenerating()` before the next
  poll would otherwise notice.
- **Retry bookkeeping moved to the shared spot**: the old page-local
  `state.retryingRuns` map is gone (`dropSettledRetrying` went with it and had
  to come back — see "Opnieuw plannen" below); `retryPlanRun`
  now calls `markTaskRetrying`/`clearTaskRetrying` (RelatedPanel.mjs, the same
  functions `home.mjs`'s own `retryFailedRun` uses), and the ticket column's
  own Enter-menu guard (`planCommands`, "only offer 'Opnieuw plannen' when
  not already retrying") reads the new `isRetryingRun(runId)` export — a
  read-only peek at the same module-private `taskUi.retrying`, added
  alongside the two existing write-only exports.
- **`TasksPanel` gained one new, optional `actions.subtitle`** (default
  "workflow-runs · deze PR"): the PR-tree wording is wrong on a page with no
  PR, so `plan.mjs` passes `t('workflow-runs · dit ticket')`.

### Deliberately simplified: no anchored row menu

The tree's own `openTaskRowMenu` opens a whole native, cursor-anchored context
menu (retry / open comment / ignore / hide / copy error) — built on
`home.mjs`'s general `openMenu('task', {native:true, ...})` machinery. This
page's Taken block only has ONE possible action (retry the ticket's own failed
`plan` run — nothing here is ever a `task_code_comment` run with an "open the
comment" option, nothing is ever ignorable/hideable in the same sense), and
this page's own menu machinery is deliberately anchor-less (see "Opnieuw
plannen — retrying a failed plan run" below). Standing up a second, matching
anchored-menu subsystem for exactly one item was judged not worth it:
`openPlanTaskRowMenu(row)` just calls `retryPlanRun(row.runId, synthetic)`
directly when `row.retryable && !row.retrying`, no menu opens at all. A row
with nothing to do (any other status, or already retrying) is inert on click,
same as before.

### Accepted gap: a ticket with a `plan` run in the API response but the run isn't found yet

`buildTaskRows` on an entirely empty `state.workflows`/`state.pageProblems`
(both `[]`) renders the tree's own generic "Geen taken." — the old page had
its own placeholder here (`noRunsRow`) that kept showing "plan wordt
opgesteld…"/the doc error even with zero runs at all. In practice `state.runs`
already contains the `plan` tracker's own run within moments of the tracker
existing (`ensureTracker` starts it immediately), so this only matters for the
first instant of a brand-new ticket, or a hand-built test fixture that sets
`generating:true` with `runs:[]` (see `tests/plan-phase-busy.spec.mjs`, which
asserts the PHASE card, not this block, so it is unaffected). Not fixed —
literal reuse means literal behavior, including this edge.

### No focus keyboard-navigation into this block (yet)

The PR tree's Taken rows are their own keyboard stop (`state.taskFocus`, ↓ from
the description walks in — see "Walking into the Taken block" in
`.claude/docs/keyboard-navigation.md`). `plan.mjs` does not wire this up:
`TasksPanel(state, actions)`'s `actions.focusState` is left `undefined`, so no
row ever shows the focus ring and ↓/↑ from the ticket card does not enter this
list. Out of scope for this change (not requested, and this page's own
keyboard model — `state.col`/`state.cur` — has no equivalent "sub-cursor within
column 0" concept yet); a future request to add it would extend `state.col0Focus`
the same way the Jira-opmerkingen column already does.

## The context a plan is built on: comments and already-merged work

Two reviewer requests, verbatim: *"hier moeten we kijke naar de hoofdtaak en
andere subtaken en wat er er allemaal gemerged is wat ermee te maken heeft. als
dat meer dan 3 prs zijn, moet je de 3 meest relevante prs vinden"* and *"met
het inplannen moet je ook kijken naar de comments die zijn gegeven in de jira
tickets, hoofd en sub"*.

- **The Jira comments come back for free.** `modules/jira`'s `Issue` asks for
  one more field (`--fields …,comment`) and flattens each body with the same
  `adfText` a description uses, newest `maxIssueComments` (20) kept, in
  chronological order. `adfText` learned two node types a comment carries and a
  description usually does not: a **mention** (its text lives in `attrs.text`,
  so "@Dennis Sloove" used to vanish) and a `hardBreak`. So this ticket's own
  comments (`doc.comments`) and — because the parent is already read for its
  description — the main task's (`doc.relatedComments`) cost **no extra call**.
- **The rest of the family costs one Activity**, `planLoadContext`
  (`plan_context.go`), which reads the comments of the subtasks/siblings
  (`maxPlanContextIssues`, 5) and searches GitHub for the merged PRs.
  `doc.siblings` is filled by `planLoadIssue` from the parent's own `subtasks`
  field, so a subtask knows its siblings without a second lookup.
- **Which PRs**: one `gh pr list --state merged --search "<KEY> in:title,body"`
  per family key (`planRelatedKeys`, bounded by `maxPlanSearchKeys`).
  `in:title,body` rather than a bare term — a free-text search matches fuzzily
  and drags in PRs of unrelated tickets (measured).
- **"De 3 meest relevante" is a pure Go decision, not a second Claude call**
  (`rankPlanRelatedPRs`): a PR found via THIS ticket's key beats one found via
  the main task, which beats one found via a subtask — `planRelatedKeys`'
  output order IS that tier — and within a tier the most recently merged wins;
  a PR found twice counts once, under its best tier. Then `maxPlanRelatedPRs`
  (3). Deterministic, testable, replay-stable, and the relevance question here
  is genuinely about which ticket a PR belongs to, which we know exactly. The
  three survivors then get their changed-file list (`gh pr view --json files`,
  capped at `maxPlanPRFiles`), which is what makes the context concrete: where
  the earlier work landed.
- **Both reach the prompt** (`planPrompt`): an "OPMERKINGEN…" section per group
  with the rule that a comment which walks the description back outranks the
  description itself (exactly the PROD-254 case: *"-- hoeft dus niet. het moet
  gewoon blijven werken"*), and an "AL GEMERGED WERK DAT HIERBIJ HOORT" section
  with the instruction to build on it rather than re-invent it.
  `planExecutePrompt` carries a shorter form of the PR list (title, URL, up to
  `planExecuteMaxPRFiles` files).
- **The PR list is visible on the page** — a small card in the first column
  (`data-testid=plan-related-prs`, one `plan-related-pr` link each with the key
  it was found via), so the context the plan was built on is checkable.
- **Replay:** `planLoadContext` is a NEW Activity in the middle of the body, so
  it is gated on `doc.loadsContext`, a flag `planLoadIssue` sets. An Execution
  recorded before this existed has no such flag and replays straight past the
  call — the same positional-history rule `askBase` documents
  (`.claude/rules/workflow-determinism.md`). It also sits AFTER both gates on
  purpose: it costs a handful of `acli`/`gh` calls, and the page's own start
  POST (which runs inline until the first block) must not wait for them.

## Referenced tickets outside this one's own family

Reviewer request, verbatim: *"als het goed is moet PROD-254 dan rekening
houden met PROD-216. kan je ervoor zorgen dat je achterhaalt wat de branch is
waar PROD-216 al iets in heeft gedaan? waarschijnlijk zit dat in een subtaak,
soms ook in een description."* Follow-up answers: every Jira link AND every
bare key-shaped mention counts (not just an official link), and the branch is
looked for in BOTH the PR/branch text on GitHub and the Jira text itself.

This is deliberately a SEPARATE mechanism from "Comments and merged work"
above: that section is about THIS ticket's own family (main task + subtasks +
siblings); this one is about a DIFFERENT ticket that family merely points at —
PROD-216 is not PROD-254's parent or subtask, it is named in a link or in
free text.

- **`modules/jira`'s `Issue` gained `Links []IssueLink`** — Jira's official
  `issuelinks` field (`--fields …,issuelinks`), distinct from the
  parent/subtasks hierarchy field. Each entry names the OTHER issue on
  whichever side (`outwardIssue`/`inwardIssue`) is actually present, phrased
  from THIS issue's own point of view (`type.outward`/`type.inward` picked to
  match) — so the page can say "PROD-254 relates to PROD-216" without caring
  which side Jira itself stored it on. A malformed entry (neither side
  present) is dropped.
- **`collectPlanReferencedKeys(doc, linksByKey)`** (`plan_context.go`)
  collects every OTHER key the family points at: the official `Links` of this
  ticket and (if this is a subtask) its main task — read once in
  `planLoadIssue`, since `Issue()` is already called for both, and carried on
  the document as `doc.links`/`doc.parentLinks` purely to reach
  `planLoadContext` without a second call — PLUS a bare Jira-key-shaped regex
  match (`planKeyMentionPattern`) over the family's own description/comments.
  The family's own keys (`planRelatedKeys`) are excluded, and an official
  link's own relation phrase wins as the Reason over a duplicate bare
  mention of the same key. Bounded by `maxPlanReferencedIssues` (3).
- **`resolvePlanReferencedIssue`** enriches one referenced key with its own
  title/url (`Issue()`) and — best-effort — the branch it already has work
  on: **a GitHub PR wins over a Jira-text guess.** `findBranchViaGH` is
  `searchMergedPRs`'s sibling with `--state all` instead of `--state merged`
  (already-started, not-yet-merged work still counts as "al iets gedaan") and
  asks for `headRefName`; an OPEN PR wins over a closed/merged one, then the
  most recently updated. Only when GitHub finds nothing does the Jira-text
  heuristic run: `branchMentionPattern`/`findBranchInText` looks for a
  slash/dash/dot-delimited token containing the key (case-insensitive — a
  branch name is often lowercased) in the referenced ticket's own
  description+comments, then — the reviewer's own hint that the work often
  sits one level down — up to `maxPlanReferencedSubtaskTextReads` (2) of its
  own subtasks.
- **Never presented as fact.** A Jira-text match is a HEURISTIC — Jira has no
  fixed convention for stating a branch name — so both `renderPlanIntent`'s
  "Related tickets" section and the page's own `plan-referenced-issue` rows
  word it as a guess ("vermoedelijk … ongeverifieerd") whenever
  `branchSource` is anything other than a `pr:#N` reference; only a real PR's
  own `headRefName` is stated plainly.
- **Reaches BOTH the human-readable intent and the actual generation
  prompt** — `doc.referenced` is rendered in `renderPlanIntent`'s own
  "## Related tickets" section AND threaded into `planPrompt`'s
  "GERELATEERDE TICKETS" block with an explicit instruction to plan in line
  with that other ticket's existing work rather than duplicate or ignore it —
  this is what makes generation actually "rekening houden met" the other
  ticket, not just a cosmetic note in intent.md.
- **Visible on the page**: a small card in the first column
  (`data-testid=plan-referenced-issues`, one `plan-referenced-issue` link
  each — key, title, reason, branch line), right under the existing
  `plan-related-prs` card.
- **Replay**: filled inside the EXISTING `planLoadContext` Activity (the same
  one "Comments and merged work" describes), so no new Activity and no new
  replay-gating flag — everything here runs as ordinary Go code inside an
  Activity body, which is not subject to the workflow-determinism rule at all
  (only the workflow FUNCTION's own control flow is,
  `.claude/rules/workflow-determinism.md`).

## The "Intentie" field: shown, and editable

Reviewer request, verbatim: *"in taak description eerste kolom moet de
intentie zichtbaar zijn, maar dat moeten we ook kunnen aanpassen. intentie kan
je halen uit jira taak en is een taak wat te maken heeft met de hoofdtaak."*

- **No new generation** — the existing, always-generated `intent.md`
  (`renderPlanIntent`, see "Three stages, three files" above) IS the intent
  text; `GET /api/plan` now also returns it as a top-level `intent` field
  (`payload["intent"] = renderPlanIntent(doc)`), computed at read time next to
  `artifacts`, never stored twice.
- **Editable, but wholesale, not per-section** — `doc.intentOverride` (a new,
  `omitempty` field on `planDoc`, absent/empty for every document before this
  existed) replaces the auto-generated document ENTIRELY once set; merging a
  free-form edit back into the Problem/Constraints/… sections would be
  brittle, so `renderPlanIntent` just returns the override verbatim when it is
  non-empty.
- **No new Signal name** — tembed can only `WaitSignal` on one name at a time
  (the same reason `planAnswerFollowup`/`planAnswerChat`/`planAnswerTask`
  exist), so the edit rides on the EXISTING `plan_answer` Signal with
  `kind:"intent"` (`planAnswerIntent`): `doc.IntentOverride =
  strings.TrimSpace(sig.Text)`, then the ordinary `planSave` Activity (which
  already rewrites the artifact files on every save, so intent.md on disk
  reflects the override immediately). An empty `Text` clears the override.
  Triggers no regeneration, same as `planAnswerTask`.
- **Frontend** (`intentField`, `plan.mjs`): renders as one uncontrolled
  `<textarea data-testid=plan-intent-section-body>` PER SECTION of intent.md
  (see "A sectioned, GitHub-style editor" below) in column 0, each seeded via
  a plain (non-`() =>`) static `value=`-equivalent (element CONTENT here,
  since a `<textarea>`'s default value is its text content) — same "seed
  once, save on blur" pattern as `plan-task-note`. Keyed on the loading state
  (`'intent:' + (loading ? 'pending' : 'ready')`) rather than on
  `state.intentText`/`doc.updatedAt`, so it remounts (and re-seeds) exactly
  ONCE, right after the first real load — remounting on every later poll
  would wipe an in-progress edit. A REMOTE edit from another tab while this
  one is open is a known, accepted gap, same as `plan-task-note`.
  `sendIntentOverride(text)` posts the Signal; a `data-testid=plan-intent-reset`
  button appears only while `doc.intentOverride` is set, clearing it (empty
  text) to revert to the auto-generated one.
- **Bug, found and fixed alongside the retry fix above**: `tasks_api.go`'s
  `plan_answer` handler validates which Kinds may arrive with an empty
  `questionId` (`followup`/`chat`/`comment`/`task` only) and never added
  `intent` to that list, so **every** intent edit was rejected outright with
  `400 invalid plan answer` before it ever reached the workflow —
  `sendIntentOverride` always failed silently. Only looked like it worked
  because `tests/plan-intent-sections.spec.mjs` mocks the signal route at the
  Playwright level rather than exercising the real Go handler. Fixed by
  adding `planAnswerIntent` (and `planAnswerRetry`, see above) to the allowed
  Kinds; verified against the real handler (not a mocked route) with a live
  `POST /api/workflows/<runId>/signals/plan_answer` round trip.

### A sectioned, GitHub-style editor: headings are fixed, only the text below them is editable

Reviewer request, verbatim: *"maak intentie hoger en toegankelijker om aan te
passen. misschien dat de markdown titels niet aangepast kan worden, alleen de
description daaronder, meer github markdown editor ofzo."* `parseIntentSections`
(`plan.mjs`) splits the seed text on every markdown heading line (`#`..`######`)
into `{heading, body}` pairs; `intentField` renders each `heading` as a plain,
non-editable `<div data-testid=plan-intent-heading>` and only the `body` below
it as its own `<textarea data-testid=plan-intent-section-body>`
(`intentSectionBody`) — so intent.md's own H1 title and every `##` section
name can be READ but never accidentally retyped, only the prose under them
can. A section with no heading at all (the leading segment before intent.md's
own first `#`, normally empty) is rendered the same way, just without the
label above it.

**One edit still saves the WHOLE document, not just that section.** Every
section's own `@blur` handler (`intentSectionBody`'s `save`) walks EVERY
sibling `[data-testid=plan-intent-section-body]` inside the shared
`data-testid=plan-intent-sections` container — reading each one's LIVE current
`.value`, never the `sections` array snapshot taken at mount time — pairs each
with its own (unchanged) heading, read back off that same field's own
`data-section-heading` attribute (also not a snapshot, see the bug below), and
reconstructs the document via `buildIntentFromSections` (heading + blank line +
body, joined with a blank line between sections) before calling
`sendIntentOverride` once.
Deliberately not a per-section override on the document: `doc.intentOverride`
stays the single wholesale field described above, so nothing on the backend
needed to change — this is purely a frontend editing affordance on top of it.
The reconstructed text does not byte-for-byte preserve the original's blank-line
layout, which is accepted: once an override exists the document is no longer
regenerated from scratch anyway.

**"Hoger" (taller), literally:** stacking one heading + textarea per section
(instead of the previous single 6-row textarea for the whole document) makes
the block noticeably taller on its own, satisfying the reviewer's separate
"the field's bottom edge should move down, the top stays where it is" request
— no page layout change was needed for this, the wrapping card already had no
fixed/max height.

Test: `tests/plan-intent-sections.spec.mjs` ("a heading is a fixed label, only
the text below it is editable, and an edit saves the whole document").

**Bug, fixed afterwards: an empty intent left NO field at all, and generated
text never showed up on its own.** `parseIntentSections('')` returns an empty
list, so the block rendered zero textareas — in stage 1 (intent), where writing
the intent IS the job, there was nothing to type into, and the placeholder the
old single textarea always carried was gone with it. `intentSections()` is the
fix: the same parse, but never empty — one heading-less `{heading: null, body:
''}` section stands in, the honest equivalent of that old empty field. Two
arrow.js-shaped follow-ons came with it, both straight out of
`.claude/rules/arrowjs-pitfalls.md`:

- the list is now its own `${() => intentSections().map(...)}` FUNCTION
  binding instead of a static `.map()` of a mount-time snapshot inside the
  conditional template (the "fifth variant"), so a section that only exists
  after a later poll actually appears;
- `intentSectionBody`'s `.key()` carries the section's own CONTENT next to its
  position, because a keyed node is reused WITHOUT re-running its bindings —
  with a position-only key the first field kept showing the empty text it
  mounted with even once the generated intent had arrived. A poll bringing
  back the same text keeps the same key, so an edit in progress is still never
  clobbered; only genuinely changed text re-seeds.

The same staleness is why `save` reads each heading off the field's own
`data-section-heading` rather than a captured array: that array goes stale the
moment the list grows, and a blur would then rebuild intent.md with the wrong
headings. Test: `tests/plan-intent-sections.spec.mjs` ("an empty intent still
offers one field, and generated text arrives without a reload").

### Where it sits, and when it can be typed in, depends on the phase

Follow-up request: *"laat mij intentie in 2e kolom zien als je nog in stap 1
zit, als je in stap 2 zit, dan mag het zoals nu, maar alleen editbaar als je
enter erop drukt"*. ONE component, two placements, decided by
`intentInQuestionsColumn()` on top of `planPhaseNow()` — the frontend mirror of
`planPhase` (`plan_artifacts.go`): it prefers the server's own
`state.artifacts.phase` and falls back to the same "nothing generated yet is
stage 1" rule, so a response without an `artifacts` block still lands on a real
phase.

- **Phase `intent` (stage 1)** — the field renders at the TOP of the questions
  column (`questionsColumn`, `data-intent-place="questions"`), as its own card,
  never collapsed and directly typable. Writing the intent IS stage 1's work,
  so nothing stands between the reviewer and the caret; column 0 shows no
  intent block at all in this phase.
- **Phase `specs`/`plan` (stage 2+)** — the historical spot under the ticket
  description (`data-intent-place="ticket"`), still collapsing while the
  questions column has the keyboard (see "The questions column doubles in
  width…" below), and **read-only until Enter unlocks it**
  (`state.intentEditing`, `data-locked`): click/Tab focuses, `Enter` (never a
  newline — the handler `preventDefault`s its own key) unlocks, `Escape` and
  blur lock it again. By then the reviewer is answering questions, and a stray
  keystroke in a passed stage should not silently rewrite the intent. The state
  is carried by a WORD next to the label ("vergrendeld — Enter om te bewerken"
  / "bewerken", `data-testid=plan-intent-lock-label`), never by a colour, per
  the colourblind rule.

The `readonly` attribute is bound as the plain, undecorated name with a
function binding returning `'true'`/`false` — not `?readonly=`/`.readonly=`,
which this vendored arrow.js does not support (see
`.claude/rules/arrowjs-pitfalls.md`). The component's `.key()` now carries the
placement too (`intent:<place>:<ready|pending>`), so each spot keeps its own
one-time seed. Test: `tests/plan-intent-phase.spec.mjs`.

### A dedicated Jira-opmerkingen column next to the ticket

Reviewer request, verbatim: *"als je dat selecteerd, alleen dan opmerkingen
rechts daarvan zien (ook als je pr description selecteerd hebt)"* — a NEW
column (`intentCommentsColumn`, `data-testid=plan-intent-comments-column`,
inserted in `App()` between `plan-info-column` and `plan-questions-column`)
that shows ONLY the Jira-opmerkingen (it reuses `commentsPanel()` verbatim, the
same component the questions column's own first row renders) once the
reviewer clicks into either the ticket description
(`data-testid=plan-description`) or the intent field's own section body
(`intentSectionBody`, only while `place === 'ticket'` — the `'questions'`
placement already sits directly above `commentsPanel()` in that same column,
so it needs no extra column of its own).

`state.col0Focus` (`'description' | 'intent' | null`, ephemeral/local, not
URL-persisted — same category as `state.descExpanded`) records which of the
two was clicked last; `intentCommentsColumnVisible()` gates the column on
`state.col === 0 && (state.col0Focus === 'description' || state.col0Focus ===
'intent')`, so moving the keyboard away from column 0 (a click on the
questions column, a block column, `→`/`←`) hides it again immediately rather
than leaving it stale. The ticket card's own outer `@click` resets
`col0Focus` to `null` (selecting the card in general, without either specific
sub-block); the description block and each section body's own `@click`
`stopPropagation()` first — the same nested-click ordering rule as
`overview.mjs`'s popover close button
(`.claude/rules/arrowjs-pitfalls.md`) — so their own, more specific
`col0Focus` write is never immediately overwritten by the card's own bubbling
handler. Both of those handlers also set `state.col = 0` — the section body's
own click did not at first, so clicking the intent field from a block column
set `col0Focus` but never satisfied `intentCommentsColumnVisible()`'s own
`state.col === 0`, and the column silently stayed away.

**ONE panel at a time.** The questions column renders `commentsPanel()` behind
its own `${() => intentCommentsColumnVisible() ? [] : [commentsPanel()]}`
binding (a stable `contents` root, like the two `intentField`/
`intentToSpecsHint` slots above it), so it stands down while the dedicated
column is up. Rendering both put the same panel twice on screen side by side,
and — worse — gave the single-composer machinery two
`plan-comment-reply-input` fields, of which
`openCommentReply`/`sendCommentReply`'s `document.querySelector` only ever
sees the FIRST (the dedicated column comes earlier in the DOM), so a reply
typed into the questions column's copy was never read back.

Test: `tests/plan-intent-sections.spec.mjs` ("selecting the ticket description
or the intent field shows a dedicated Jira-opmerkingen column, hidden
otherwise" — which also asserts the panel count stays 1).

### Both plan Claude calls run on Opus, with their own 5-minute timeout

Reviewer request: *"ik wil dat je opus gebruikt voor het plannen"* — applied to
BOTH of this page's calls, `planGenerate` (the questions + task list) and
`planChatReply` (the ticket chat). They also pass
`Timeout: planClaudeTimeout` (5 minutes, `plan_workflow.go`), a per-call
override of `modules/claude`'s own `contextTimeout`: that 90s default was sized
for a ~30s single-purpose completion, while these two send a whole Jira ticket
plus its comments and the related issues' comments as one prompt. Without the
override the run was SIGKILLed mid-answer and the page showed the raw
`claude -p (claude-sonnet-5): signal: killed`. Deliberately per-call rather
than a raised global default (`RunRequest.Timeout`, honoured by both `Run` and
`RunChat`), so a hung claude in every other, genuinely short call site still
cannot sit on a workflow run for minutes.

### A malformed-JSON answer gets ONE automatic retry before it is swallowed

Reported bug (task 46): the "mislukt" row read `plan: parse answer: invalid
character 'n' after object key` — Go's `encoding/json` error for a key whose
colon is missing (reproduced exactly in `TestPlanGenerateRetriesOnceOnMalformedJSON`,
`plan_workflow_test.go`, via `{"questions":[{"question" niet:"test"}], ...}`).
Claude's JSON generation is probabilistic, especially across the deeply nested
`blocks`/`children` tree `planPrompt` asks for, so a single dropped colon or
unescaped quote is usually NOT reproducible on an immediate second try. The
`planGenerate` Activity (`plan_workflow.go`) now calls Claude and
`parsePlanAnswer` up to twice with the SAME prompt before giving up; only if
BOTH attempts fail to parse does the existing fallback apply unchanged — the
error lands on `doc.Error`, the Execution itself still succeeds (never
`failed`), and the reviewer's existing "Opnieuw plannen" action (see below)
still resumes it. This is plain Go code inside one Activity, not the workflow
body, so — like `planLoadContext` — it needs no replay-determinism flag
(`.claude/rules/workflow-determinism.md`). `planPrompt` also gained one
explicit JSON-escaping rule (colon after every key, `\"`/`\n` escaped inside a
text/code value, no trailing comma) to reduce how often this happens at all,
though it cannot eliminate it — hence the retry.

### A cleared `doc.Error` never actually reached the stored document — the sticky-error bug

Reported bug (task 50), verbatim: *"ik kan nog steeds niet plan opstellen, ook
taken heeft een plan mislukt"* — reproduced against a REAL ticket (STAT-1117)
by reading its tembed event history (`data/workflows.db`) and its stored
document (`data/plan.db`) directly, not guessed: the last-completed
`planGenerate` Activity's own recorded JSON payload carried NO `error` key at
all (a genuine success — fresh questions, fresh tasks), yet the persisted
document still showed a `parse answer` message from THREE attempts earlier,
word for word, with the newer `tasks`/`updatedAt` sitting right next to it.

**Root cause:** `planDoc.Error` was `json:"error,omitempty"`. Every
`ExecuteActivity(name, input, &doc)` call in `planWorkflow` decodes an
Activity's JSON result INTO the ALREADY-POPULATED workflow-level `doc` —
tembed's `decode` (`tembed/workflow.go`) is a plain
`json.Unmarshal(payload, out)`, and `encoding/json` never clears a
destination field whose key is simply ABSENT from the incoming JSON. A
successful `planGenerate` explicitly sets `doc.Error = ""` on its own LOCAL
copy before marshaling, but `omitempty` then drops the key entirely from that
JSON — so the WORKFLOW's `doc.Error`, still holding whatever an EARLIER failed
attempt had set, was never touched by the successful call's result and stayed
stuck forever (until the process restarts and the run replays from a fresh
`var doc planDoc`). Every OTHER field a workflow ever resets to zero
(`NeedsScope`, `NeedsHotfix`, `IntentOverride`, …) is assigned directly on the
workflow's own `doc` in the workflow body, never round-tripped through an
Activity's decoded output, so none of them share this gap — `Error` was the
only field bitten by it.

**Fix:** drop `omitempty` from `Error` (`json:"error"`), so a successful
generation's response always carries an explicit `"error":""`, which
`json.Unmarshal` DOES apply. One line, no schema-consumer impact (every
reader, Go and JS, already treats a missing key and an empty string the
same way). Test: `TestPlanGenerateSuccessClearsAStaleError`
(`plan_workflow_test.go`) — programs a failing generation, then a genuinely
successful retry, and asserts `doc.Error` is empty afterward; reverting the
`omitempty` removal makes it fail exactly as STAT-1117 did live.

**Practical consequence:** a "mislukt" Taken-block row could be, and often
was, stale — the plan may already have regenerated cleanly one or more times
since. The busyGenerating() masking fix above (task 46) only suppressed the
row WHILE a fresh generation was running; it never addressed the row
surviving a generation that had already finished successfully. Both fixes
together are what makes the Taken block's "mislukt" row trustworthy: present
only while the LATEST attempt is truly still broken.

### The first-pass call is split in two: "questions", then "tasks"

Reviewer decision (task 50, "ja, splits de call"): a single combined answer
(up to `maxPlanQuestions` questions AND up to `maxPlanTasks` tasks, each with
their own nested example-code blocks) could run into the model's own
output-length limit and come back truncated (`plan: parse answer: unexpected
end of JSON input`) — confirmed against STAT-1117's own workflow history,
where this happened on 3 of ~9 real generations, and where the once-blind
retry-once fix above cannot help against a genuinely oversized answer that
hits the SAME limit again on the immediate retry.

**`planGenerateFresh(w, &doc)`** (`plan_workflow.go`) replaces what used to be
one `planGenerate` call with `Mode:"all"`: it runs `Mode:"questions"` (asks
for the clarifying questions only, `Tasks` explicitly left `[]`) and, only if
that call succeeded (`doc.Error == ""`), follows it with the EXISTING
`Mode:"tasks"` call (the same one an ordinary answer already regenerates from
— no new machinery there). Each of the two calls still gets its own
retry-once from the fix above, so a fresh plan can now survive up to 4 raw
`claude -p` attempts before failing outright (2 per call) — deliberately
accepted extra cost for a smaller, less truncation-prone answer per call.

Three call sites now share this one helper, all of which start from a
document with no questions yet — each also has its own OLD, single-call
fallback for a document recorded before the split existed (see
"`SplitGenerate`: the split had to be replay-safe too" right below):

- the very first generation (`planWorkflow`'s own body, after `planLoadContext`);
- `planAnswerRegenerate` ("Plan opnieuw opstellen" — discards the current
  plan first, then calls `planGenerateFresh` exactly like a brand-new
  document);
- `planAnswerRetry` when `planRetryMode(doc) == "questions"` (no questions
  exist yet — the very first call never got that far) — still a pure
  function of `len(doc.Questions)` (plus, now, `doc.SplitGenerate`) and still
  bounded to `"questions"`/`"tasks"` (an answer-triggered regeneration, where
  the questions must stay put) — or `"all"` for a pre-split document.

**`planPrompt`'s per-mode switch** (`plan_prompt.go`) gained a `"questions"`
case (the SAME question-generation rules `"all"` still uses, plus an explicit
"Laat `tasks` leeg" instruction only for `"questions"`) and the whole
task-detail checklist block (the `location`/`conditions`/`config`/… fields,
~14 lines) is now SKIPPED entirely for `mode` `"questions"` or `"followup"` —
both already say "tasks leeg" and previously still received the full
task-instructions wall right after, wastefully (and slightly
self-contradictorily) bloating the smaller call's own prompt. `"all"` itself
is UNCHANGED (still gets the full checklist, still asks for both questions and
tasks at once) — kept alongside `"questions"`, not replaced by it, for the
same replay-safety reason. The universal block-formatting rules (nesting,
`note`, `code`/`lang`, Dutch prose) are unaffected — every mode's questions
still need example-code blocks with the same shape.

Test: `TestPlanGenerateFreshSplitsQuestionsAndTasksIntoTwoCalls`
(`plan_workflow_test.go`) — asserts exactly 2 Claude calls for a fresh plan,
in order, each carrying the right "leeg"/checklist instructions; the two
existing malformed-JSON tests above were updated to reflect that a failed
first call now logs as `(questions)` and, per `planGenerateFresh`'s own early
return, never reaches a second (`tasks`) call at all.

### `SplitGenerate`: the split had to be replay-safe too — a full server outage, and how it was found

Reported incident (task 51), right after the split above first shipped: a
FRESH `go run .` restart stopped answering ANY request at all — not just the
plan page, `curl` to `/` itself timed out. Root cause, confirmed by reading
the LIVE `data/workflows.db`/`data/plan.db` directly (not guessed) and by
sending `kill -QUIT` at the hung process to capture a real goroutine dump:
tembed matches a run's history POSITIONALLY
(`.claude/rules/workflow-determinism.md`), and `planGenerateFresh` issues a
DIFFERENT number of `ExecuteActivity` calls than the original single
`Mode:"all"` call it replaced. Every plan Execution recorded BEFORE the split
existed still had the OLD, single-call shape in its own history — so
replaying one of them against the NEW code (as `engine.Recover()` does for
every `waiting`/`running` run at startup) walked straight off the end of that
history and re-executed a REAL, live `planGenerate` Activity — a genuine
`claude -p` subprocess, caught mid-call in the goroutine dump
(`os/exec.(*Cmd).Start`/`watchCtx`). `Recover()` runs SYNCHRONOUSLY inside
`newTasks`, itself called BEFORE `http.Serve` starts consuming the
already-bound listener (`main.go`) — so that one blocked subprocess call
answered NOTHING, for anyone, until it finished or timed out.

**Fix: `planDoc.SplitGenerate`** (`plan_workflow.go`), the exact same
replay-safety shape this file already documents for `AskBase`/`LoadsContext`/
`StartsProgress` — set to `true` by `planLoadIssue` for every FRESH document,
absent (`false`) on every document recorded before it existed. Each of the
three `planGenerateFresh` call sites now branches on it: `true` → the new
two-call sequence; `false` → the EXACT original single
`ExecuteActivity("planGenerate", Mode:"all")` + one `planSave` shape, byte-for-
-byte what that position in an old run's history already recorded.
`planRetryMode` gained the same branch (`"questions"` vs `"all"` when no
questions exist yet, `SplitGenerate` decides which) for the SAME reason:
STAT-1117's own history shows its very first `planAnswerRetry` Signal arrived
while `doc.Questions` was still empty — precisely the shape that hung the
server, since a wrongly-chosen `"questions"` retry issues MORE
`ExecuteActivity` calls than that history segment ever recorded.

**Verified against the real incident, not just synthetic tests**: copied the
live `data/workflows.db`+`data/plan.db` (the actual STAT-1117 history) into a
scratch data dir, ran the FIXED binary against it with
`SLASH_CLAUDE=off SLASH_JIRA=off SLASH_GITHUB=off`, and confirmed `curl /`
answers within ~3s (matching the pre-incident baseline) on a cold start, that
sending the SAME kind of `plan_answer` "retry" Signal that originally hung the
server completes instantly and leaves the server responsive, and that a
second fresh restart (replaying the now slightly longer history) is equally
fast.

**Second, independent safety net — `planGenerate`/`planChatReply` are now
`PriorityLow`** (`engine.SetActivityPriority`, `workflows.go`, the exact
mechanism `pr_status`'s `generatePRSummary` already uses): the `plan` workflow
itself stays `Normal` priority (its fast steps — load, save, the gates — still
recover synchronously and quickly), but if replay ever reaches a live,
unrecorded call to either of these two real `claude -p` activities, `Recover()`
now DEFERS that one run to its background drain instead of blocking the
synchronous startup phase at all. This does not replace the `SplitGenerate`
fix (the root cause is closed either way), but it means a FUTURE bug of this
same shape — or simply a legitimately slow call still in flight when the
process was killed — can no longer take the whole server down with it.

Regression test: `TestPlanWorkflowReplaysAPreSplitHistoryWithoutHanging`
(`plan_workflow_test.go`) hand-builds a pre-split history (a `tembed.Store`
populated directly via `CreateRun`/`AppendEvent`, no `splitGenerate` key
anywhere) ending on exactly STAT-1117's own seq8 shape — a `plan_answer`
Signal with `kind:"retry"` while `doc.Questions` is still empty — then calls
`engine.Recover()` under a hard timeout and asserts it returns promptly, the
one live call it correctly makes uses mode `"all"` (never `"questions"`), and
the run ends up parked `waiting` again. Confirmed to actually catch the
regression: reverting `planRetryMode`'s `SplitGenerate` branch alone (leaving
everything else fixed) makes this test fail.

## Follow-up questions: sharpening the plan further

Reviewer request, verbatim: *"maak het mogelijk om vervolg vragen te genereren
om je plan te perfectioneren"*.

The index's flat nav list gets one more kind of row between the questions and
"Plan" (the task list — see "The columns" above): **`FOLLOWUP_ROW_ID =
'followup'`**
(`data-testid=plan-followup`, its state in words via
`plan-followup-state` — never a colour on its own). `Enter`/click sends it.

- **It rides on the EXISTING `plan_answer` Signal** with `kind:"followup"`
  (`planAnswerFollowup`), because tembed can only `WaitSignal` on one name at a
  time — the same one-signal-with-a-kind convention `ReactionSignal`/
  `PRStateSignal` follow. An empty `kind` (every signal recorded before this
  existed) is an ordinary answer, so no history changes meaning. The signal
  handler in `tasks_api.go` accepts an empty `questionId` **only** for this
  kind.
- **The tracker generates, appends, and then rebuilds the task list** — an
  explicit reviewer decision: a follow-up round ends with the same regeneration
  an answer triggers, so the plan never lags behind its own questions.
  `planGenerate` mode **`followup`** asks for new questions only (the prompt
  lists the ones already asked as off-limits and tells it to leave `tasks`
  empty), `appendPlanQuestions` **appends** them and renumbers only the new ones
  (`q6`, `q6o1`, …) — the reviewer's stored answers hang off the existing ids,
  so those may never move — dropping a literal repeat and capping the total at
  `maxPlanQuestionsTotal` (15). Then mode `tasks` + save, exactly like an
  answer.
- The row only exists once there IS a plan to sharpen (a question or a task),
  so a still-generating page does not park the default cursor on it.
- **The action itself (`plan-followup-state`/`plan-regenerate-state`) is a
  real `<button>`**, not a plain status `<span>` (reviewer report, task 52,
  screenshot: "dit ziet er niet uit als een knop, erop drukken heeft geen
  zin") — styled with the app's own primary-button classes (solid indigo,
  white text, `hover:`/`disabled:` states), `disabled` while
  `busyGenerating() || state.saving` so it visibly greys out instead of
  silently no-opping a click. Its own `@click` calls `e.stopPropagation()`
  first (per the nested-click ordering rule in
  `.claude/rules/arrowjs-pitfalls.md`) before doing exactly what the row's own
  click already did; the rest of the card (title/description) stays clickable
  via that same row-level handler.
- **A failed signal is now visible** (task 54, reviewer report: "Plan
  opstellen doet hier niets" on a live ticket — the click DID fire both
  requests and the button DID show its busy word correctly, confirmed with a
  network-intercepted repro; end-to-end driving of the real flow found no
  reproducible backend failure either, questions/tasks/a draft-PR all
  completed cleanly). `sendFollowup`/`sendRegenerate` used to swallow a
  non-2xx response (or a thrown fetch) in an empty `catch` with zero trace —
  neither a console error nor anything on screen, so a genuine transport-level
  failure (as opposed to the tracker's own generation failing, which already
  surfaces via `state.doc.error`/the Taken block's failed-run row) would have
  read as "the button does nothing". `state.followupError`/
  `state.regenerateError` (plain local strings, cleared at the start of the
  next attempt) now render as a small `⚠ …` line under the card's own
  description on a non-`res.ok` response or a caught exception —
  deliberately **not** routed through `state.doc.error`/the Taken block's
  retryable failed-run row: that row's own "retry" resends a swallowed
  GENERATION error the tracker itself recorded (`kind:"retry"`), which is the
  wrong mechanism for a signal that may never have reached the tracker at
  all.

### A second button right below it: "Plan opnieuw opstellen" (discard and regenerate)

Reviewer request, verbatim: *"hier moeten 2 knoppen komen: vervolgvragen
genereren of plan opstellen. huidige plan moet dan weg en worden vervangen
met een nieuwe"*, confirmed (when asked whether this should be a second
button bolted onto the follow-up card or its own row) to be *"eigen rij
eronder"* — its own card, own keyboard stop, directly under `followupCard`.

- **`REGENERATE_ROW_ID = 'regenerate'`** (`data-testid=plan-regenerate`, state
  word via `plan-regenerate-state`) is built exactly like `FOLLOWUP_ROW_ID`
  above — same gate ("only once there IS a plan"), same `navRows()`
  neighbourhood (pushed right after the follow-up row), same
  card shape (`regenerateCard`/`regenerateWord`, `sendRegenerate`). It is
  deliberately **not** a second button inside `followupCard` itself: every
  other action on this page (an option, a task, the execute row, follow-up
  itself) is its own `navRows()` stop with its own cursor, and this stays
  consistent with that rather than being the one exception.
- **A NEW `plan_answer` Signal Kind, `planAnswerRegenerate` ("regenerate")**
  (`plan_workflow.go`) — same one-signal-multiplexed-by-Kind convention as
  `followup`/`task`/`retry`/…, added to the allowed empty-`questionId` Kinds in
  `tasks_api.go`. Unlike every other Kind on this Signal, it does **not**
  preserve anything of the existing document: the pure `resetPlanForRegenerate`
  clears `Questions`/`Answers`/`Tasks`/`TaskStates`/`Error` **and** (widened for
  BUG-5463, *"alsof er nog niks is gekozen"*) the general chat transcript
  (`Chat`) and the manual "Intentie" override (`IntentOverride`) — both reflect
  discussion/choices about this same plan draft, so a genuine "start over"
  clears them too. It then runs `planGenerate` with **`Mode:"all"`** (or, for a
  `SplitGenerate` document, the same two-call `planGenerateFresh` the very
  first generation uses) — then saves. `planPhase` (`plan_artifacts.go`) is
  derived purely from those fields, so the page falls back to stage
  `intent`/`specs` on its own with no separate phase-reset logic needed. The
  ticket-level context (Jira comments/related PRs/referenced issues, and the
  scope/hotfix answers) is untouched — only the plan CONTENT restarts, not the
  whole tracker; see "Restarting the whole tracker" right below for the one
  thing this Signal structurally cannot do.
- **`state.regeneratePending`** is the same "the signal runs its work inline,
  so the stored document hasn't caught up yet" local flag
  `followupPending`/`scopePending`/`hotfixPending` already are, folded into
  `busyGenerating()` so the Taken block's "plan wordt opgesteld…" row (see
  "The Taken block is the literal TasksPanel" above) covers this action too.
- **Distinct from "Opnieuw plannen" in the ticket's own Enter-menu**
  (`planCommands`, `retryPlanRun`): that one resumes a run that is genuinely
  `failed` or swallowed an error, IN PLACE, from wherever it left off
  (`planRetryMode`) — this button is for a HEALTHY plan the reviewer simply
  wants to throw away and redo from scratch. Two different problems, two
  different mechanisms; neither replaces the other.

Test: `tests/plan-regenerate.spec.mjs`.

### Restarting the whole tracker: re-asking the branch/hotfix question

Follow-up reviewer request (BUG-5463, "alsof er nog niks is gekozen. even
helemaal opnieuw beginnen"): besides the plan content, the branch/hotfix
answer itself should also be askable again — but literally "alleen branch
keuze": the Jira "In Progress" transition that answering it originally
triggered must NOT be undone.

This cannot be a Signal at all: `planNeedsBaseQuestion`'s `WaitSignal(
SignalPlanHotfix, …)` sits **structurally before** the `plan_answer` loop in
`planWorkflow`'s own body (see the top of `plan_workflow.go`), and tembed
matches a run's history **positionally**
(`.claude/rules/workflow-determinism.md`) — a signal aimed at an already-
running Execution can never rewind it to a `WaitSignal` it already passed.
The only way to re-ask it is to throw away the whole Execution and start a
genuinely fresh one.

- **`TaskManager.RestartPlanBranch(key)`** does exactly that: it starts a
  tiny one-shot Execution, `plan_restart_branch`
  (`planRestartBranchWorkflow`/`WorkflowPlanRestartBranch`), whose single
  Activity (`deletePlanRunForRestart`) calls `engine.DeleteRun` on the
  ticket's `plan-<key>` run — the same delete-via-Activity shape
  `deleteIgnoredRun`/`ignoreRunsWorkflow` already use for the "negeer" half of
  the failed-tasks popup, so this stays inside
  `.claude/rules/workflows-write-boundary.md` (DeleteRun is only ever called
  from a workflow Activity in this codebase). It skips (reports
  `deleted:false`) rather than deletes when the run is unknown or genuinely
  `tembed.StatusRunning` right now — a live generation must not be torn out
  from under itself. `RestartPlanBranch` then calls the ordinary `StartPlan(
  key)` (the same direct "start an Execution" call `handlePlanStart` already
  makes from a handler) — since the old run is gone, `StartWorkflowID`'s
  idempotent-reuse-by-ID no longer finds anything and creates a genuinely
  fresh run, replaying `planLoadIssue` → the hotfix gate → … from scratch.
- **The Jira status is deliberately left alone by construction, not by a
  special case**: `jiraStartProgress` (the Activity that moves the ticket to
  "In Progress") is already best-effort/idempotent — see its own doc comment,
  "the ticket is already In Progress … none of them are worth failing a plan
  the reviewer is waiting for" — so answering the hotfix question again on
  the fresh Execution simply no-ops against Jira instead of reverting
  anything. No code needed to skip it.
- **Administrative, not (yet) a UI button**: exposed as
  `POST /api/workflows/plan_restart_branch {key}` (`handlePlanRestartBranch`,
  `plan_api.go`) for this kind of one-off reset — nothing in `plan.mjs` calls
  it. A future request for a "opnieuw beginnen, ook de branchkeuze"-button
  would wire this endpoint in next to `plan-regenerate`, reusing the same
  `busyGenerating()`-style pending flag.
- Test: `TestRestartPlanBranchReAsksTheHotfixQuestion` (`plan_workflow_test.go`)
  — drives a real plan Execution through the hotfix gate and a chat message,
  restarts it, and asserts the fresh run (same deterministic `plan-<key>` run
  ID) is parked back on `NeedsHotfix` with the old answer and chat gone.

## Every if, every config: what a task must name

Reviewer request, verbatim: *"elke if statement moet in de plan, elke config
ook"*, plus the checklist agreed with it. `planTask` therefore carries a
concrete half next to its explanation, each field optional and only rendered
when the model filled it in (`data-testid=plan-task-detail`,
`data-detail=<field>`; the LABEL carries the meaning, per the colourblind
rule):

| field | what |
| --- | --- |
| `location` | the module or `/app` directory it lands in |
| `conditions` | EVERY if/branch/condition, in words |
| `config` | EVERY config/env var/setting, with value and default |
| `migration` | data migration / schema change |
| `endpoints` | new or changed endpoints/routes |
| `errors` | error handling of this step |
| `rollout` | feature flag / rollout and how to roll back |
| `edgeCases` | empty, zero, large, several at once |
| `outOfScope` | what explicitly is NOT part of this task |

Bounded on our side (`maxPlanDetailItems` 8, `maxPlanDetailLen` 300 —
`normalizePlanDetails`), carried into `planExecutePrompt` by
`writePlanTaskDetails`, so the run that implements the plan is held to the same
concreteness.

**Deliberately NO `tests` field, and no questions about tests** — an explicit
reviewer decision: the plan does not name which test belongs to which task and
must not make the reviewer choose about it. Both rules are stated in
`planPrompt`.

**No research task, and no task conditional on another task's outcome.**
`plan_execute` hands the WHOLE task list to ONE agentic pass
(`planExecutePrompt`), so there is no moment between two tasks at which
"alleen als taak 1 uitwijst dat…" could still be decided — such a task reaches
the executor as a condition nobody resolves. An open uncertainty therefore
belongs in the intent/specs stage (a question), and a task must name the
assumption it picked in its own explanation/`conditions` instead. Observed on
BUG-5463: the reviewer answered a question WITH a question ("is dit nodig?
checken we niet bij het versturen…"), and the next task generation turned that
into a "vaststellen of…" task plus a second task conditional on its outcome.
**Granularity, next to it:** the only bound is `maxPlanTasks` (12), so
`planPrompt` also says that a small but separately checkable step stays its own
task — tasks are not merged into a vague heading, and not split per file
either. Eight tasks for one subtask is the normal, intended shape (the
intent → spec → plan chain above is modelled on a playbook of small,
independently verifiable steps); combining them would only make the plan
vaguer, since it never reduces the number of runs, branches or PRs.

## A checkbox and an own field per task, and the current code next to the proposal

Reviewer decisions (task 22+26 of `todo/plan-page-workflow.md`): **een checkbox
per taak, default aan** — uitvinken laat de taak óók uit de hergeneratie
verdwijnen; **een invoerveld per taak** dat alleen meereist naar het uitvoeren
en géén hergeneratie triggert; en **de huidige code naast de voorgestelde
code**, in de blok-weergave van de review-tree, gelezen uit **de eigen
werkmap**.

### The checkbox and the field: one more `plan_answer` Kind

- **State lives on the document**, `planTaskState{Key, Title, Off, Note}` in
  `doc.TaskStates` — keyed by **`planTaskKey(title)`** (lowercased, whitespace
  runs collapsed), deliberately **not by the task id**: an id is positional
  (`t1`..`tn`, assigned in `parsePlanAnswer`) and every regeneration renumbers
  the whole list, so an id-keyed state would silently land on a different task.
  A row only exists while it DEVIATES from the default, so "checked, no note"
  stores nothing at all.
- **Kind `"task"`** (`planAnswerTask`) on the EXISTING `plan_answer` Signal —
  the same one-signal-multiplexed-by-Kind convention `followup`/`chat`/
  `comment` already use, for the same reason (tembed can only `WaitSignal` on
  one name at a time). Payload: `taskTitle` + `taskOff` + `taskNote`
  (`taskId` travels for readability only, nothing matches on it). The Signal
  handler in `tasks_api.go` accepts an empty `questionId` for this Kind too,
  but demands a real `taskTitle`.
- **The workflow branch SAVES and nothing else** — `upsertPlanTaskState` (pure,
  folded from the recorded Signal like `upsertPlanAnswer`) then one `planSave`,
  then `continue`. No regeneration: the field must not cost a minutes-long
  Claude call per keystroke, and unchecking takes effect at the next
  regeneration anyway. Because it is a pure Signal-payload branch and **no new
  Activity**, the deterministic `plan-<KEY>` Run ID needs no `askBase`-style
  flag here (contrast `planLoadContext`).
- **"Uitvinken laat de taak óók uit de hergeneratie verdwijnen"** is
  `mergePlanTasks(fresh, prev, states)`, applied inside the `planGenerate`
  Activity: a freshly generated list keeps only the tasks that are still
  ticked, and the unchecked ones are **re-appended from the previous list** so
  their row (and its checkbox) stays on the page and can be ticked again — a
  checkbox that deletes its own row would be a delete button. Ids are
  renumbered across the result. `planPrompt` additionally lists the unchecked
  titles under "TAKEN DIE DE REVIEWER HEEFT UITGEVINKT", so the model does not
  spend a slot re-proposing one.
- **Only ticked tasks are executed.** `planExecutePrompt` skips an unchecked
  task (numbering follows what is kept, so the prompt never shows a gap) and
  carries the reviewer's own field as "Aanvulling van de reviewer (volg dit)";
  `planTaskTitles` (the PR body) does the same, and `planHasEnabledTask` stops
  a run where everything is unchecked with a note instead of an empty draft PR.
- **Frontend** (`src/plan.mjs`): `taskRow` gains a real checkbox
  (`data-testid=plan-task-check`, the plain `checked="${() => …}"` binding —
  never a `?`/`.` prefix, see `.claude/rules/arrowjs-pitfalls.md`) and an
  uncontrolled field (`plan-task-note`, saved on `Enter`/blur, same shape as
  `plan-option-input`: a reactive `value=` binding would fight the caret).
  `taskPending`/`dropSettledTaskPending` are the same local-pick-wins overlay
  `answerFor`/`dropSettledPending` are.
  **`Enter`/`Space` on a task row toggles the checkbox** (an agreed default);
  the field is reached by clicking/Tabbing into it, exactly like an option's.
  Saving the note shows the same shared **"opslaan…"** word `state.saving`
  already drives for an option/scope/hotfix row (`state.saving === task.id`
  around `sendTaskState`'s fetch) — a reviewer-requested audit ("overal waar
  acties plaatsvinden loading/status zichtbaar") found this one, and the
  Intentie field's own save (see "The 'Intentie' field" below), had none at
  all before.
  **The state-in-words label next to the checkbox (`plan-task-state`,
  "meenemen"/"overslaan") was removed** (reviewer request: it crowded the row
  and gave the title less room) — the checkbox's own checked/unchecked glyph
  plus the title's strikethrough when off already carry the same meaning
  without it, so the colourblind rule still holds with nothing to read. The
  row's leading number (`${row.ti + 1}.`) got a fixed width
  (`w-5 text-right`, was unbounded) so a two-digit task number no longer shifts
  every title one character to the right relative to a one-digit one.

### The current code next to the proposed code

- **`GET /api/plan/current?key=KEY&file=path`** (`plan_current_code.go`) —
  read-only, so no workflow (`.claude/rules/workflows-write-boundary.md`): it
  opens one file for reading inside a checkout the reviewer already has and
  writes nothing, not even the sticky-werkmap row. The werkmap is the one
  `plan_execute` would implement the plan in: the plan's own sticky
  `plan_checkout` row first (read, never written), else the first candidate of
  the shared `listCheckoutCandidates` ladder. That resolution is cached in
  memory per plan key for `planCurrentDirTTL` (5 min) — the same operational
  carve-out the heartbeat map has: not the source of truth (the ladder is), and
  gone after a restart. Without it every block card would pay for a handful of
  `git` calls.
- **The path is validated twice**: `planCurrentFilePattern` (repo-relative
  segments of word chars/dot/dash, never absolute, never `..`) and, after the
  join, a `filepath.Rel` re-check against the directory — it reaches the
  filesystem, so it is never trusted. The answer is bounded at
  `planCurrentMaxBytes` (256 KB) and the pane renders at most
  `maxCurrentLines` (400) lines, saying in words that it was cut.
- **`found:false` is an ordinary ok answer**, not an error: it is what the page
  renders as the word **"nieuw bestand"** (`plan-block-new-file`, an agreed
  default), and it is also the answer when there is no werkmap at all.
- **Three stands in `blockCodeBody`** (`src/plan.mjs`): a title that is not a
  file path at all → the proposed code alone, as before; the file exists → two
  panes side by side (`plan-block-split`, `plan-block-current` /
  `plan-block-proposed`) with "Huidige code" and "Voorgestelde code" as their
  headers; the file does not exist → the proposed code plus "nieuw bestand".
- **`alignRows` is genuinely reused from the review tree.** It (and
  `diffLines`, and — since task 43 below — `tokenize`/`diffChars`/`markChars`)
  moved verbatim out of `src/Block.mjs` into **`src/lineDiff.mjs`**, which
  Block.mjs now imports (and re-exports `markChars` from, since `Footer.mjs`
  already imported it from `Block.mjs`) — so the plan page gets the tree's own
  alignment and char-diff machinery without importing that whole card
  (BlockList, translationDiff, columnWidth, shortcut hints…). This is the
  SECOND deliberate exception to this page's "same style, own code" rule, next
  to `claudeChatColumn`.
- **Deliberately NOT rendered as a two-sided del/ins diff.** A plan block is a
  ~25-line SKETCH of one function while the current code is the whole file, so
  every unmatched file line would show up as a "removal" the plan never asked
  for. `newProposedLines` therefore uses the alignment only to mark, in the
  PROPOSED pane, the PART of each line the file does not have yet — a `+`
  glyph in the gutter still carries the row-level "this line changed" (the
  tint is decoration, per the colourblind rule), which is the question a
  reviewer actually has: which of these lines is new?
- **A partially-changed line only tints/underlines its new fragment**
  (reviewer request, task 43: *"het kan ook zijn dat een gedeelte van een line
  nieuw is"*). `alignRows` pairs a genuinely modified line as one del row + one
  ins row; `newProposedLines` token-diffs that pair (`newRangesInRight`, using
  the shared `tokenize`/`diffChars` from `src/lineDiff.mjs`) instead of
  marking the whole proposed line new, so e.g. an existing call that only
  gained one new argument highlights just that argument. A row with no
  counterpart at all (pure `ins`) is still new in full, and a paired row that
  differs only in whitespace (a re-indent) stays unmarked — same as before.
  `codeLinesHTML` renders this via `markChars` (walks the Prism-highlighted
  HTML by plaintext char offset, wrapping only the marked ranges), tinting
  **and underlining** the new fragment — the underline is the shape/word-
  adjacent, non-colour cue the colourblind rule requires next to the tint
  (same pairing as the `@`-mention highlight, `src/mentions.mjs`); the row-level
  `+` glyph is unaffected, still shown whenever a line has any new range.

## Subtask and main task

Reviewer request, verbatim: *"als het een subtaak betreft, kijk dan ook naar de
hoofdtaak. als het een hoofdtaak is, en er zijn subtaken, vraag dan of je de
hoofdtaak wil oppakken of de subtaak voordat je de rest laat zien"*.

`modules/jira`'s `Issue` now also reads the two link fields around an issue —
`ParentKey`/`ParentTitle` and `Subtasks []IssueRef` (`--fields
summary,description,parent,subtasks`; `parent` is absent entirely for an
ordinary issue, `subtasks` is `[]`). `Search` is untouched: it never asks for
them. Both sides land on the document (`parentKey`/`parentTitle`/
`parentDescription`/`subtasks`).

- **A subtask is planned WITH its main task in view.** `planLoadIssue` does one
  extra `Issue(parentKey)` for the parent's own description (the `parent` field
  carries only a summary) — best-effort, a failure there costs the context, not
  the tracker. `planPrompt` then opens with a `HOOFDTAAK <key>: <title>` section
  plus that description (capped at 3000 bytes), and the rule that the plan
  covers **only** the subtask. The first column shows the same relation as a
  link (`data-testid=plan-parent-link` → `/plan/<PARENTKEY>`) with the parent's
  description underneath (`plan-parent-description`).
- **A main task WITH subtasks is asked what is being planned, before anything
  else is shown.** The tracker saves the document with `needsScope:true` and
  parks on the **`plan_scope`** Signal (`{choice:"parent"}`) *before*
  `planGenerate`. The gate sits in the WORKFLOW rather than only in the page on
  purpose: `planGenerate` is a minutes-long Claude call, and it must not be paid
  for a main task the reviewer immediately trades for a subtask.
- **Column 2 then shows only the scope card** (`data-testid=plan-scope`, one
  `plan-scope-option` row per choice): "De hoofdtaak zelf" plus every subtask
  (key — title, its Jira status in words). `navRows()` returns exactly those
  rows while `needsScope()` holds, so the questions, the task list and the
  execute action are not built at all — literally "voordat je de rest laat
  zien" — and `↑`/`↓`/`Enter` walk them like any other row.
- **Every choice names its ASSIGNEE** (task 24, reviewer request: show the
  assignee "overal", "ook bij eigen tickets"): `scopeRow` renders
  `assigneeMark(assignee, assigneeAvatar, 'h-5 w-5')` (`src/avatar.mjs`,
  shared with `/pr-overview`'s issue rows — see
  "Every issue row names its ASSIGNEE, on the LEFT" in
  `.claude/docs/pr-overview.md`; this page uses the INLINE shape, the overview
  rows the `stacked` one, same renderer) for
  the main-task choice as well as for every subtask, since deciding what to
  plan partly means seeing who is already on it. Unassigned is a circle with a
  **question mark** plus the words "Niet toegewezen" — shape + word, never
  colour (the colourblind rule).
  **Where the subtask assignees come from:** Jira's own `subtasks` field
  carries only summary/status/priority/issuetype per link, **never an
  assignee** (verified against the live payload), so `planLoadIssue` pays for
  **one** extra read — `jira.IssuesByKey(ctx, keys)`, a single `key in (…)`
  search over the subtask + sibling keys it already has
  (`fillPlanSubtaskAssignees`). Every key passes the same `keyPattern` gate
  `Issue()` uses before it reaches the argv entry: this is the one non-constant
  JQL in `modules/jira`, and that validation is what keeps it safe
  (`TestIssuesByKeyRejectsUnusableKeys`). The ~2-6s it costs was weighed and
  accepted. It runs INSIDE the existing `planLoadIssue` Activity, never as a
  new Activity of its own — `plan-<KEY>` is a deterministic Run ID and an
  extra Activity in the workflow body would wedge the replay of every existing
  Execution (`.claude/rules/workflow-determinism.md`).
- **The ticket card names it too** (`data-testid=plan-assignee-row`,
  "Toegewezen aan" + the same mark), fed by the document's own
  `assignee`/`assigneeAvatarUrl` — which `Issue()` now reads for every issue,
  so it needs no extra call. Deliberately NOT on the `plan-parent-link` chip:
  the reviewer explicitly left that one out of scope.
- **`scopeCard` renders only the SCOPE rows of `navRows()`.** That list also
  carries the Jira-comments row (`COMMENTS_ROW_ID`, present whenever the
  ticket has comments), which has no `subtask` of its own — before this filter
  `scopeRow` threw on it on every single render, and invisibly, because LOCAL
  PATCH 5 catches a throwing reactive effect and only `console.error`s it (see
  `.claude/rules/arrowjs-pitfalls.md`). Found while verifying task 24 against
  a real ticket, fixed in the same change.
- **Picking a subtask sends no Signal at all**: it is plain navigation to
  `/plan/<SUBKEY>`, which has its own tracker. Only "the main task" is
  signalled, which releases this tracker into its first generation.
- **The choice is definitive per plan** (an explicit reviewer decision): it is
  one Signal in the workflow's history, and there is no way back to the
  question. The subtask always still has its own page.
- `GET /api/plan` reports `generating:false` while `needsScope` — the tracker IS
  running, but it is waiting for the reviewer, and "plan wordt opgesteld…" would
  be a lie that never resolves. The page keeps its own `state.scopePending` for
  the gap right after the answer (the generation runs inline in that very
  request, so the stored document still reads as unanswered), the same
  local-pick-wins overlay `answerFor` uses for an answer.


## Which branch does this go out from?

Reviewer request, verbatim: *"is het een bug, vraag dan eerst of het een hotfix
is vanuit master of niet"*, followed by *"Het kan namelijk ook vanaf een andere
branche zijn, 3e keuze moet een drop down zijn waarbij eigen branches bovenaan
staan, met search input"* and, later, *"ook andere soorten Jira tickets moeten
die vraag krijgen"*.

**Every** ticket is asked one more thing before anything is generated — the
second gate, straight after the scope question, so only ever one of the two is
on screen. It started as a bug-only question; the three choices are unchanged
now that every type gets it, so a story can still go out as a hotfix from
`master` (an explicit reviewer decision — the same question, not a narrower
one).

- **The trigger is a flag on the recorded document, not the issue type.**
  `planLoadIssue` sets `askBase` on every ticket it really managed to read (a
  failed Jira read has no plan to build either way, so it is not parked on a
  branch question), and `planNeedsBaseQuestion(doc)` is what the workflow
  branches on. It is deliberately `doc.AskBase || planIsBug(doc.IssueType)`,
  because tembed matches history **positionally**
  (`nthOf`, `tembed/workflow.go`) and the `plan` Run ID is deterministic, so
  every still-living tracker replays this decision on every later Signal:
  - an Execution recorded **before** the question existed for its type has no
    `askBase` and is not a bug, so it keeps skipping the gate exactly as its
    history says — inserting the extra `planSave` + `WaitSignal` there would
    shift every later Activity by one and park the tracker forever on a signal
    its history never carries, silently refusing every further `plan_answer`;
  - an Execution from the **bug-only** era has the gate in its history and no
    `askBase`, which is why `planIsBug` stays in the condition. `modules/jira`'s
    `Issue` asks for `issuetype` (`--fields …,issuetype`) — it previously only
    came back from `Search` — and `planIsBug` matches the lowercased name
    *containing* "bug", so "Bug", "Bugfix" and a renamed "Bug (productie)" all
    count.
  - a fresh run has both, which is still one gate.
- **The gate sits in the WORKFLOW**, exactly like the scope gate and for the
  same two reasons: `planGenerate` is a minutes-long Claude call that must not
  be paid before the answer is in, and the answer changes what the plan should
  *contain* — a hotfix goes straight to production, so `planPrompt` (and
  `planExecutePrompt`) tell the model to keep it small and risk-free, no
  refactor and no meeliftende verbeteringen (phrased around "dit ticket", not
  around "de bug", since any type can be a hotfix). The tracker saves the document
  with `needsHotfix:true` plus the two named branches (`defaultBranch`,
  `hotfixBranch`) and parks on the **`plan_hotfix`** Signal.
- **Three choices** (`navRows()` returns exactly those while `needsHotfix()`
  holds, `data-testid=plan-hotfix-option`, `data-hotfix-target=yes|no|other`):
  "Ja, hotfix — master", "Nee, gewoon — develop", and "Vanaf een andere
  branch…". Glyph plus a word, never a colour on its own.
- **`hotfixCard` renders only the HOTFIX rows of `navRows()`** — the same
  filter `scopeCard` already needed (see its own bullet above), for the exact
  same reason: `navRows()` always puts the Jira-comments row
  (`COMMENTS_ROW_ID`) first, even while this gate stands. Before this filter,
  that row rendered a SECOND time through `hotfixRow` too — with no `target`
  of its own it fell into `hotfixRow`'s fallback branch and rendered as a
  phantom "Vanaf een andere branch…" row — and because its id was literally
  `COMMENTS_ROW_ID` (the actual default cursor), that phantom row lit up with
  the exact same selection ring as the real Jira-opmerkingen block. Reviewer
  report: "er zijn nu 2 dingen geselecteerd, vreemd". Regression test:
  `tests/plan-hotfix-gate.spec.mjs`.
- **The third choice is a dropdown with a search field**
  (`branchPicker`, `data-testid=plan-branch-picker`/`plan-branch-search`/
  `plan-branch-option`): it unfolds inside the row rather than answering, and
  the answer follows once a branch is picked. It reads **`GET /api/branches`**
  once (`plan_branches.go` — one `git for-each-ref` in the primary repo's own
  local clone, read-only, so no workflow: nothing durable is touched), and the
  search itself filters that one list **client-side** — the list is bounded
  (`maxBranchList`, 300) so an instant field beats a round trip per keystroke.
  **The reviewer's own branches sort to the top** (`parseBranchRefs`: last
  commit's author e-mail equals the clone's `git config user.email`, marked
  with the word "van jou" next to git's own relative date), newest first within
  each group. `origin/HEAD` and anything outside the ref allow-list are never
  offered.
- **`resolvePlanBase`** folds the Signal into `(hotfix?, baseBranch)` — pure,
  so replay reproduces it: a picked branch wins over the flag, an
  unrecognisable one falls back to the ordinary base branch rather than to a
  branch that may not exist. The branch is validated against
  `planBranchRefPattern` **twice** (the Signal handler in `tasks_api.go` and
  the workflow itself), because it reaches `git`/`gh` as an argument
  (`.claude/rules/conventions.md`).
- **The answer drives `plan_execute`**, not just the prompt: `planBaseBranch`
  is computed ONCE in the workflow body and travels on both Activity arguments
  (`planExecuteAgentArg.Base` → `planExecutePRArg.Base`, the same
  never-re-resolve discipline as `Dir`), so the werkmap ladder looks for a
  checkout free on THAT branch, `git checkout -B <branch> origin/<base>` cuts
  from it and `gh pr create --base` opens the draft PR against it.
- **The choice stays visible after the gate closes** — a pill in the first
  column (`data-testid=plan-base-branch`, "⚡ Hotfix vanaf master" / "◆ Vanaf
  develop") and, on the execute card, the branch line reading
  `<branch> → <base>` (`data-testid=plan-execute-branch`).
- `GET /api/plan` reports `generating:false` while `needsHotfix`, same as for
  `needsScope`, and the page keeps its own `state.hotfixPending` for the gap
  right after the answer.
- **An Execution started before this gate applied to its type replays past it
  untouched** — see the trigger bullet above for the full mechanism
  (`.claude/rules/workflow-determinism.md`).

### The branch question also starts the work (Jira → In Progress)

Reviewer request: *"als je in todo een branch hebt aangemaakt (eerste vraag),
moet het naar in planning en in jira naar in progress"*. Answering this
question means the work has begun, so the ticket moves to **In Progress** in
Jira right there.

- **It is the ONE write into Jira this tracker does**, and it goes the
  sanctioned way: a workflow **Activity** (`jiraStartProgress`, body
  `TaskManager.startJiraProgress`) calling the module's own write method
  `jira.Client.Transition` — `acli jira workitem transition --key K --status
  "In Progress" --yes` (`modules/jira/transition.go`). Never from an HTTP
  handler or the UI (`.claude/rules/workflows-write-boundary.md`). `acli`
  rather than REST because the documented REST route needs the numeric
  *transition id* of the target status, i.e. two round trips plus a name→id
  match that differs per project workflow.
- **`/pr-overview` needs no flag of its own.** Its planning lane is exactly
  `status = "In Progress"` (see `.claude/docs/pr-overview.md`), so the row
  climbs out of the todo lane by the rule that put everything else there.
  `startJiraProgress` additionally Signals the `jira_issues` tracker a
  `"refresh"`, so that happens now instead of at its next 5-minute tick.
- **Best-effort on purpose: the Activity never returns an error.** Every way
  it can fail is either "nothing to do" or "not ours to fix" — the ticket is
  already In Progress, its project's workflow has no such transition from
  where it is, or `acli` is not logged in — and none of them are worth
  failing a plan the reviewer is waiting minutes for. The reason is logged and
  reaches the UI through `GET /api/problems`.
- **A pre-existing Execution replays past it untouched.** The call is gated on
  `doc.StartsProgress`, which `planLoadIssue` sets on the document it records —
  the same positional-history rule `AskBase`/`LoadsContext` follow, and the
  reason this is not simply unconditional: tembed matches history positionally
  and the plan Run ID is deterministic, so an extra Activity in an already-run
  Execution's history would park the tracker on a signal it never carries
  (`.claude/rules/workflow-determinism.md`).
- Tests: `TestStartJiraProgressMovesTheTicket` /
  `TestStartJiraProgressSurvivesARefusedTransition` (`jira_issues_test.go`,
  next to the lane rule the transition feeds). Verified live against the test
  ticket **PAYM-813** (To Do → In Progress → back to To Do).

## Keyboard

`←`/`→` move between columns (`state.col`: 0 = ticket, 1 = questions, 2 + n =
the n-th block column); `←` on the ticket column leaves to `/pr-overview`.
`↑`/`↓` move the cursor within the focused column — in column 2 over **one flat
list** whose FIRST row is the Jira-opmerkingen block (only while the family has
any comment — see "The comments block is a stop of its own in the → chain"
below), then every option of every question, then every task, so `↓` walks from
the comments block, through the last option, straight into the task list
exactly as the column reads.
`Enter`/`Space` on an option chooses it (with whatever is typed in its field);
on the comments block it hands `↑`/`↓` to the individual comments (`←` leaves
that mode again, without changing `state.col`); on a gate row (scope or
hotfix) it answers that question — the hotfix question's third row only
unfolds its branch dropdown, whose own search field owns the keyboard while it
is focused;
on the last row (the execute action) it arms and then starts the execution;
in a block column it drills. A keydown while an input has focus is left alone
(`Escape` blurs it), and `Enter` inside the field answers with that text.

Which column owns the keyboard is spelled out **in words** in its header
(`◆ actief`, `data-testid=column-active`), never by a colour alone.

## Enter on the ticket column opens a small menu

Reviewer request, verbatim: *"enter op pr description blok moet een menu
geven om bijvoorbeeld jira ticket te kunnen openen"*. `Enter` on column 0 (the
ticket) opens `CommandMenu.mjs` — the exact review-tree component reused
as-is (see command-palette.md) — with a tiny, fixed, submenu-less list
(`PLAN_COMMANDS`): "Open in Jira" (`state.doc.url`, falling back to
`JIRA_BASE + state.key` before the document has loaded) and "Terug naar
overzicht". Deliberately not `PR_COMMANDS`' full menu: this page has no
GitHub PR yet, no approve/review actions, nothing that menu offers beyond
those two — plus, conditionally, "Opnieuw plannen" (see below).

### "Opnieuw plannen" — retrying a failed `plan` run

Reviewer request: *"er moet een retry knop komen om opnieuw te plannen"*.
Offered in two places, both driving `retryPlanRun(runId, synthetic)`
(`plan.mjs`):

- **A click on the failed run's row in the "Taken" list** retries it —
  `openPlanTaskRowMenu(row)` calls `retryPlanRun(row.runId, !!(row.run &&
  row.run.synthetic))` when `row.retryable && !row.retrying`, no menu; see
  "The Taken block is the literal TasksPanel" above for why this stays a
  direct call instead of a matching anchored-menu subsystem. Only the
  ticket's own `plan` tracker run is ever `retryable` (not `plan_execute` or
  anything else), and only while it is really `failed` or the
  swallowed-generation-error case (see above) — a running/waiting/completed
  row is inert on click.
- **The ticket column's own Enter-menu** (`PLAN_COMMANDS` above) gains the
  same "Opnieuw plannen" item, but only when `planCommands()` finds a
  `plan` entry in `state.pageProblems.failedRuns` at OPEN time (genuinely
  failed OR the synthetic swallowed-error case — reading the merged
  `pageProblems` view rather than `state.runs` directly is what makes the
  synthetic case reachable from here too, see the bug below) — resolved
  once, not as a reactive label, so an already-open menu keeps showing what
  it opened with even if the run resolves itself a moment later (the next
  open re-evaluates). This is why `resolvePlanCommands` reads `ms.commands`
  rather than the fixed `PLAN_COMMANDS` constant directly — same "ONE list
  both the render and the ↑/↓/Enter index into" rule as
  `resolveOverviewCommands` (`overview.mjs`).

**Two different resume mechanisms hide behind one function, chosen by
`synthetic`** (reported bug, fixed): `planGenerate`'s Activity never fails the
Execution on a bad Claude answer (a timeout, or `parsePlanAnswer`'s JSON parse
failure) — it records the reason onto `doc.Error` and returns success, so the
tracker's own run status stays whatever it already was (almost always
`waiting`, parked back on the `plan_answer` `WaitSignal`) and **never**
becomes `failed`. `planProblemsForPanel` still shows this as a "mislukt" row
(tagging it `synthetic: true`, since its `run.status` was never genuinely
`failed`), but the generic, sanctioned `POST /api/workflows/retry`
(`TaskManager.RetryRun`, `.claude/docs/tembed-endpoints.md` — the same
endpoint the review tree's own `retryFailedRun`/the global failed-tasks dialog
use) **requires the run to actually BE `failed`** and refuses with
`"run is waiting, not failed"` otherwise. Before this fix `retryPlanRun`
always went through that one endpoint, so clicking "Opnieuw plannen" on a
swallowed generation error silently failed (only `console.error`'d, invisible
without debug mode) and left the reviewer with **no way at all** to make a
parse-error'd plan try again — the questions/task list stayed stuck forever.
`retryPlanRun`'s `synthetic` branch instead sends the `plan_answer` Signal's
**`"retry"` Kind** (`planAnswerRetry`, `plan_workflow.go`) — no payload beyond
the Kind itself, handled inline in the workflow's main loop exactly like
`followup`/`task`/`intent` above: it re-runs `planGenerate` with the mode
`planRetryMode(doc)` picks (`"all"` when `len(doc.Questions) == 0` — the very
first generation never produced anything — else `"tasks"`, matching the exact
choice `planWorkflow` itself already makes between its own first call and
every later regeneration), then saves, then waits again. Because this rides
on the SAME Signal name the reviewer's real answers use, it needs no new
Execution and no replay-gating flag. Test:
`tests/plan-retry.spec.mjs` ("retry a swallowed generation error (run still
waiting)").

`markTaskRetrying`/`clearTaskRetrying`/`isRetryingRun` (`RelatedPanel.mjs`, the
shared spot — see "The Taken block is the literal TasksPanel" above) mark a run
busy the moment the click fires, so the row/status word flips to "↻ opnieuw
gestart" immediately instead of still reading "mislukt" until the next
3-second poll notices — same reasoning as `home.mjs`'s own `retryFailedRun`.

**That mark needs plan-page-local settling after all** (`dropSettledRetrying`,
`plan.mjs`, called from `loadPlan` next to `dropSettledPending`). Dropping it
along with the page's own retry map was a bug: `taskUi.retrying` is SHARED
state that nothing clears on its own, and the review tree only gets away with
that because `/api/problems` replaces a resumed failure with a run under a NEW
Run ID, so the marked row disappears entirely. Both retry mechanisms here
resume IN PLACE, so the Run ID never changes — the row stayed "↻ opnieuw
gestart" forever, inert on a second click (`openPlanTaskRowMenu` bails on
`row.retrying`) and dropped from the ticket column's Enter-menu (`planCommands`'
`isRetryingRun` gate), so a retry that hit the same parse error again could
never be repeated until the tab was reloaded. `dropSettledRetrying` clears the
mark as soon as a freshly loaded document shows the retry actually ran: the
problem row is gone, or the run's own `updatedAt` moved past what it was at the
click (`planRetryStamps`, a plain non-reactive Map next to it — a Signal round
trip always bumps `updatedAt`, since the engine flips the run
running→waiting around it). Test: `tests/plan-retry.spec.mjs` ("a retry that
runs into the same error can be retried again").

Its own tiny menu machinery in `plan.mjs` (`menu`/`ms`/`openPlanMenu`/
`closeMenu`/`runCommand`) mirrors home.mjs's at the scale this page needs: no
submenus, no native (right-click) variant, no per-anchor positioning math —
the popover (`planMenuOverlay`) is a fixed backdrop plus an absolutely
positioned box under the ticket card, not repositioned on scroll/resize the
way the tree's list-row-anchored menu is. Same `ms`-swap discipline as the
tree (`.claude/rules/arrowjs-pitfalls.md`): `ms` is replaced wholesale on
every open, so a just-closed instance's bindings never fire against a freed
slot. `↑`/`↓`/`Enter`/`Escape` are handled in `onKeydown`'s own
`if (menu.open) {...}` branch, checked before `isEditableFocused()` so it
takes priority. Mouse entry point: `plan-menu-button` in `ticketCard`'s
"Weergave" row (next to the back link, chat button, theme and settings
buttons).

## The general chat about this ticket (`/`)

Reviewer request, verbatim: *"ik wil de algemene chat openen door / te
drukken. precies zoals in de tree. die mag je hergebruiken"* — an explicit,
one-off exception to this page's own "same style, own code" rule (see the
top of this file): the review tree's Claude chat component
(`ClaudeChat.mjs`'s `claudeChatColumn`, a pure template layer with no
reactive state of its own) is reused **unchanged**. What is NOT reused is
`RelatedPanel.mjs`'s chat ENGINE behind it — that engine is keyed on a real
GitHub PR number (SSE progress, cancel, checkout/werkmap, the `comments`
module's `pr INTEGER NOT NULL` column with every handler rejecting `pr <= 0`)
and this page exists **before** a PR does. Following the reviewer's own
answer to that exact question ("aan jira ticket die ook in de url staat"),
the conversation is instead keyed on the **Jira key**, on the SAME per-ticket
document every answer already lives on.

- **Backend**: `planChatMessage{Role, Body, CreatedAt}` — a new, deliberately
  minimal shape (no kind/model/noShell/options: none of the tree's retry
  ladder, agentic tool use, or inline questions apply to one blocking Claude
  call) — lives on `planDoc.Chat`, alongside `Questions`/`Tasks`/`Answers`.
  One more `Kind` on the EXISTING `plan_answer` Signal, `"chat"`
  (`planAnswerChat`, the same one-signal-multiplexed-by-Kind convention
  `"followup"` already uses): the reviewer's message (`Text`) is appended to
  `doc.Chat`, saved, then `planChatReply` — ONE Claude call
  (`m.claude.RunChat`, no tools, plain prose — never JSON, unlike
  `planGenerate`) — answers it and is appended too. `planChatPrompt`
  (`plan_prompt.go`) shares `writePlanContext` with `planPrompt` (extracted
  from it) so the chat discusses the exact same ticket/comments/merged-work/
  answers-so-far facts the plan itself was built from, plus the current
  questions/tasks and the transcript itself. `trimPlanChat` bounds the
  transcript (`maxPlanChatMessages`, 40), dropping the oldest first.
- **The chat must keep working while a gate stands.** The scope
  (`SignalPlanScope`) and hotfix (`SignalPlanHotfix`) gates each `WaitSignal`
  on their OWN name, and tembed can only wait on one name at a time — a
  ticket freshly opened for planning is, in practice, ALMOST ALWAYS sitting
  on the hotfix gate (every issue type is asked it now, see "Which branch does
  this go out from?" above), so requiring every gate to be answered first
  would leave the chat unusable exactly when a reviewer is most likely to
  reach for it. `PlanScopeSignal`/`PlanHotfixSignal` therefore ALSO carry the
  same `Kind`/`Text` pair `PlanAnswerSignal` does; `handlePlanChat` (the one
  body shared by all three call sites) runs on a `Kind:"chat"` message and the
  workflow simply `WaitSignal`s again afterwards — a loop around each gate's
  own wait, not a new concurrency primitive. The frontend's `sendChatMessage`
  picks the right signal name itself (`chatSignalName`: `needsScope()` →
  `plan_scope`, `needsHotfix()` → `plan_hotfix`, otherwise `plan_answer`) —
  same reasoning as `answerFor`'s "local pick wins" overlay: the reviewer's own
  message is echoed onto `state.doc` optimistically before the round trip
  lands.
- **Frontend**: `chatView()`/`chatCallbacks()` (`plan.mjs`) are
  `claudeChatColumn`'s own two arguments — getters + plain callbacks, see
  `ClaudeChat.mjs`'s file header. `retryAllBusy`/`queued` stay stubbed to their
  inert value on purpose: this page's chat still has no retry ladder or
  queueing (a single blocking call per message, never an agentic multi-tool
  turn). `openPlanChat`/`closePlanChat` (`state.chatOpen`) gate a fullscreen
  overlay (`planChatOverlay`) that mirrors the tree's own
  `generalChatOverlay.mjs` shape (backdrop click / Escape closes it) —
  ephemeral, not in the URL or `localStorage`, exactly like that overlay. `/`
  always opens it, from any column, mirroring the tree's own "`/` always opens
  the PR menu" rule; mouse entry point: `plan-chat-button` in `ticketCard`'s
  "Weergave" row.
- **Remaining accepted gap**: no cancel, no retry, no werkmap/code-edit
  capability — this chat can only talk, never touch code (that is what "Plan
  uitvoeren" is for). A hiccup (`SLASH_CLAUDE=off`, or the CLI erroring) still
  appends a fixed assistant line saying so, rather than leaving the
  reviewer's own message answered by nothing.

### A reply landing below the fold never scrolled into view

Reviewer report (`data/review-shots/task53-reactie-niet-in-conversatie.png`,
"reactie hierop zie ik niet in mijn conversatie verschijnen"): the persisted
transcript was actually complete (checked directly against
`data/plan.db`'s stored `planDoc.Chat`) — the reply just never came into
view. Two separate gaps, both because `plan.mjs` is its OWN chat
implementation and had copied `ClaudeChat.mjs`'s presentation without also
copying two small pieces of `RelatedPanel.mjs`'s chat ENGINE that make it
usable inside a fullscreen overlay:

- `planChatOverlay()` called `claudeChatColumn(...)` without
  `{ inOverlay: true }`, so the thread kept the tree-only `max-h-[38vh]` cap
  instead of filling the overlay's own real, bounded height — a big dead gap
  between a short conversation and the composer (exactly the "large empty
  area" in the screenshot). `generalChatOverlay.mjs`'s `GeneralChatCard`
  already passes this option for the same reason; `plan.mjs` just hadn't.
- `claude-chat-thread` scrolls **itself**, never an ancestor (see "`claude-
  chat-thread` scrolls itself to the bottom, not an ancestor" in
  `.claude/docs/claude-chat-panel.md`) — `RelatedPanel.mjs`'s
  `scrollClaudeThreadToBottom()` is the only thing that ever moves that
  scrollTop, and `plan.mjs` never had an equivalent of its own. A reply
  overflowing the thread therefore just sat below the fold forever, reading
  as "the reply doesn't appear" even though it was fully rendered in the DOM.

**Fix**: `scrollPlanChatThreadToBottom()` (`plan.mjs`) is a small, trimmed
local copy of `scrollClaudeThreadToBottom` — no `claudePos`/`pinned` guard,
since this chat has no turn-by-turn `↑` navigation and `chatView().pinned()`
is hard-coded `true` anyway. Called from every place new content can land:
`sendChatMessage` (right after the optimistic echo, and again once the
Signal round trip's refetch lands), the `chat.progress`/`chat.message` SSE
handlers and `loadChatProgressResync` in `ensurePlanChatEvents`, and
`openPlanChat` (so reopening an already-running conversation lands on its
latest turn, not the top). Test: "a reply landing below the fold still
scrolls into view" (`tests/plan-chat.spec.mjs`), same forced-`max-height`
technique as `tests/claude-chat-panel.spec.mjs`'s "a just-sent Claude message
scrolls into view…".

### Live progress (reviewer request: "ik wil daar ook progress zien net zoals in claude chat in een pr")

The "no streaming" line above used to be part of the accepted-gap list — it no
longer is. The reviewer explicitly asked for the SAME live-progress experience
the PR review tree's own chat has (a status line, a streamed partial answer),
not merely a busy indicator, so this chat now reuses the tree's live-progress
machinery outright rather than reinventing a plan-specific version of it:

- **`chat_progress.go`/`eventbus.go` needed NO change at all.** Both were
  already generic per-**conversation-id** machinery (`chatProgress`,
  `startChatProgress`/`advanceChatProgress`/`finishChatProgress`/
  `chatProgressSink`, the `chat.progress`/`chat.message` SSE events) — `repo`/
  `pr` only matter for the PR-scoped bookkeeping this chat never touches
  (`runningChatProgressForPR`, `markChatFilesPending`), so a plan turn simply
  passes `""`/`0` for both. `GET /api/chat/progress?commentId=...` (the SSE
  resync read) already accepts any string id too.
- **The one real gap was `m.claude.Run`**, which has no `OnEvent`/streaming
  support at all (confirmed by reading `modules/claude/claude.go`) — only
  `m.claude.RunChat` streams. `planChatReply` (`plan_workflow.go`) therefore
  switched from `Run` to `RunChat`, wrapped with
  `startChatProgress("", 0, convID)` / `defer finishChatProgress("", 0, convID)`
  and `OnEvent: chatProgressSink("", 0, convID, &checkoutDir)` — the exact
  same three calls `runOneClaudeTurn` (`chat_workflow.go`) makes, just with an
  always-empty `checkoutDir` (this call gets no `Tools`, so `ChatEventTool`
  never fires and the edited-files bookkeeping stays untouched). No
  `SessionID` is passed — `planChatPrompt` already reconstructs the whole
  transcript as text on every call, so the CLI needs no session memory across
  turns; each call is a fresh, independent `RunChat` session.
  `publishChatChanged("", 0, convID)` is called once the reply (or the
  Claude-unavailable fallback) is appended, so the frontend's `chat.message`
  handler refetches instead of trusting a pushed payload — same rule as every
  other SSE consumer (`.claude/docs/server-events.md`).
- **`planChatConversationID(key) = "plan:" + key`** (`plan_workflow.go`) is the
  conversation id this rides under — prefixed so it can never collide with a
  real GitHub comment id (always numeric). `src/plan.mjs`'s `chatConvId()`
  mirrors it verbatim; the two sides agree without reading each other's code.
- **Frontend wiring reuses two existing shared, component-less modules
  outright**: `events.mjs` (`ensureEvents`/`onEvent`/`onEventsResync` — the
  one multiplexed SSE stream) and `claudeTurns.mjs` (`setTurnProgress`/
  `turnProgress`/`lastTurnProgressAt` — the per-conversation snapshot store
  the tree's own chat also reads). `ensurePlanChatEvents()` (`plan.mjs`,
  called once next to `setInterval(loadPlan, POLL_MS)`) calls `ensureEvents()`
  with no `pr` (this page has none — the broadcast connection, since
  `eventbus.go`'s `publish` never scopes a `pr:0` event to one PR) and filters
  every handler on `ev.key === chatConvId()`, so an unrelated event from
  another open tab (a review-tree turn, another ticket's chat) is simply
  ignored. `chatView()`'s `progress`/`elapsed` now read `turnProgress(...)` for
  real (a small local `state.chatTick` + `syncPlanChatTicker` drive the 1s
  heartbeat, mirroring `RelatedPanel.mjs`'s module-private `cc.tick`/
  `syncChatTicker`) — `claudeChatColumn`'s existing status line/partial-answer
  bubble (`claudePartialBubble`, `ClaudeChat.mjs`) therefore render for real
  here too, with **no change needed in `ClaudeChat.mjs` itself**.
- **The verified bug this landed alongside**: `sendChatMessage` echoes the
  reviewer's message onto `state.doc.chat` optimistically and then awaits the
  BLOCKING Signal POST (`handlePlanChat` runs the whole reply inline, which
  can take many seconds) — but `loadPlan`'s 3s poll kept running meanwhile and
  used to overwrite `state.doc` (chat included) with whatever the server still
  had stored, i.e. without the just-sent message, the moment a poll landed
  before the blocking POST returned. Reported verbatim: *"ik typ hier iets,
  maar de chat is opeens weg"* (`data/review-shots/task7-ticket-chat-gone.png`
  — the overlay back to "Nog geen gesprek…"). Fix, in `loadPlan`: keep the
  locally-echoed `chat` array for as long as the server's own reports FEWER
  messages than already shown — a plain length comparison, not object
  equality, safe because `sendChatMessage` refuses a second send while
  `state.chatBusy` (never two messages in flight for one ticket at once). The
  moment the server catches up (chat.message push, `sendChatMessage`'s own
  post-Signal refetch, or an ordinary poll) its version wins again, `chatBusy`
  or not. Regression test: `tests/plan-chat.spec.mjs` ("the reviewer's own
  message survives a poll tick…" — delays the signals response past one poll
  tick via `page.route`, without touching the Go side at all, to make the race
  deterministic).

### The generation AND the execution stream their output too ("ik wil heel uitgebreid zien wat er nu gebeurd. dus llm moet output doorstreamen enzo")

The chat above was the first of this page's three Claude runs to stream; the
other two — **drafting** the plan (`planGenerate`, `plan_workflow.go`) and
**executing** it into a draft PR (`runPlanExecuteAgent`, `plan_execute.go`) —
still reported a single word (`bezig…` / `draait…`) for the minutes they run,
which is what the reviewer's screenshot
(`data/review-shots/task55-draft-pr-live-output-streamen.png`) is about. Both
now ride the exact same machinery, so nothing plan-specific was invented:

- **Two more conversation ids**, mirrored verbatim in `src/plan.mjs`
  (`genConvId`/`execConvId`): `planGenerateConversationID(key) =
  "plangen:" + key` and `planExecuteConversationID(key) = "planexec:" + key`.
  `repo`/`pr` stay `""`/`0`, exactly like the chat.
- **`Run` → `RunChat`** in both, the same one-gap fix as `planChatReply`:
  `Run` cannot stream at all. Both keep their own timeout behaviour unchanged
  (`RunChat` computes `contextTimeout`/`agenticTimeout` identically, and
  `planGenerate` still passes `planClaudeTimeout`), and `planGenerate` still
  feeds `parsePlanAnswer` a `strings.TrimSpace`d answer, since `Run` used to
  trim its own output.
- **Two additive fields on `chatProgress`** (`chat_progress.go`), both
  `omitempty`, both ignored by the review tree's own chat:
  - `Label` — WHICH run this snapshot is, in words, set once via
    `setChatProgressLabel`: `"plan uitvoeren"`, or
    `"plan opstellen — " + planGenerateLabel(mode)`. The generation needs it
    because one generation walks through several PASSES (`planGenerateFresh`:
    questions, then tasks), each its own Activity and therefore its own
    snapshot — without a label the pane would be an anonymous stream of text.
  - `Steps` — the GROWING log of tool calls (where `Tool`/`Detail` only ever
    hold the current one), capped at `maxChatProgressSteps` (80, oldest
    dropped). **Opt-in**: `chatProgressSink` keeps its exact old behaviour and
    delegates to the new `chatProgressSinkLogging(..., keepSteps)`, which only
    these two runs pass `true` — the whole snapshot travels over SSE on every
    frame, and the tree's chat renders only the one status line. `appendChatStep`
    absorbs the CLI's double announcement of a tool block (name first,
    arguments once they streamed in): the second one fills the entry already
    there instead of logging the same call twice.
- **`livePane(convId)`** (`src/plan.mjs`) renders one snapshot in four layers:
  the label + `bezig`/`klaar` (a WORD, never a colour on its own), the status
  line via **`claudeStatusText`** imported from `ClaudeChat.mjs` (so "Claude
  leest X · 42s" reads identically wherever it appears), the step log, the
  streamed text, and the edited files. Mounted twice: in the questions column
  above the questions (`plan-generate-live`) and inside `executeCard` under its
  button (`plan-execute-live`). Every binding reads the snapshot FRESH through
  a local `cur()` rather than closing over one — a keyed node is reused without
  re-running its bindings, so a captured snapshot would freeze the pane on
  whichever frame mounted it (`.claude/rules/arrowjs-pitfalls.md`).
- **The streamed text is Markdown for the execution, preformatted for the
  generation** (`livePartialHTML`). The generation's answer is one big JSON
  document by construction, and Markdown ate its braces/quotes into
  emphasis — verified live against PAYM-813, before and after.
- **`planConvIds()`** is the single list of the three conversations this page
  watches, so the SSE filter, the resync read (`loadChatProgressResync` now
  reads all three, so a tab opened mid-run catches up) and the 1s
  elapsed-seconds ticker cannot drift apart. Only the chat's own thread
  auto-scrolls via `scrollPlanChatThreadToBottom`; the two panes scroll
  themselves (`scrollLivePaneToBottom`, `data-live-scroll`).
- **One wart, deliberately handled rather than lived with**:
  `finishChatProgress` hands a run's `EditedFiles` to `markChatFilesPending`
  (`chat_edit_pending.go`), which is PR-scoped — for the execution that means
  an entry under `prKey{"", 0}` nothing ever reads. `runPlanExecuteAgent`
  therefore `defer`s `clearChatPendingFiles("", 0)` **before** it defers
  `finishChatProgress`, so LIFO order runs the clear last.

Tests: `TestChatProgressStepLogIsOptIn`, `TestChatProgressLabel`,
`TestPlanGenerateLabelPerMode` (`chat_progress_test.go`) — the log's cap and
de-duplication, the label, and the two conversation ids matching their
frontend mirrors. The panes themselves were verified live against PAYM-813
(a real follow-up generation: label per pass, seconds counting up, JSON
streaming in, then `klaar`, zero page errors).

### Never two selections visible at once

Reviewer report, verbatim (with screenshot
`data/review-shots/task18-double-selection.png`): *"ik zie hier 2 dingen
selectie, ik wil dat maximaal 1 blok en/of inner selectie hebben"*. The row
cursor ring (`optionRow`/`scopeRow`/`hotfixRow`/`taskRow`/`executeCard`/
`followupCard` — six identical copies of the same `state.cur === id ? ring :
idle` ternary) stayed visible even while column 0 (the ticket card) had
genuinely moved the keyboard away from it: a `←` back to the ticket left both
the ticket's own `CARD_FOCUS` border AND the previously-focused row's ring on
screen at once. Fix: every one of the six now also requires
`state.col !== 0` before showing the ring — the doc comment above `optionRow`
("the cursor row keeps its ring while the keyboard is in a BLOCK column")
still holds for `state.col >= 2`, this only closes the `state.col === 0` gap.
`data-cursor` itself is untouched (still tracks the raw cursor identity, used
by `scrollCurIntoView`'s selector) — only the visible ring is gated.

### One `Enter` chooses AND advances; the free-text field auto-focuses only while ARROWING

Reviewer request, verbatim (first pass): *"als ik een antwoord selecteer
binnen een vraag, moet de input gelijk actief zijn zodat ik kan typen. als ik
enter druk, moet ik gelijk naar de volgende vraag springen."* First
implementation made `Enter` on an option row focus its own free-text field
(`focusOptionInput`), requiring a SECOND `Enter` inside that field to actually
advance. Follow-up report (screenshot `task44-volgende-vraag-na-keuze.png`):
*"als ik heb gekozen, moet ik de volgende vraag zien"* — landing on "chosen +
field focused" wasn't enough; tightened, verbatim, to *"Eén enter = door. Die
automatische focus moet zijn als je er gewoon over heen gaat met pijltjes,
maar als je nog niet enter hebt gedaan"*. Final shape:

1. **`↑`/`↓` (`moveRow`) auto-focuses the free-text field of whichever option
   row the cursor lands on** (`syncOptionFocus`, called from `moveRow` only —
   never from `advanceToNextQuestion`): a `requestAnimationFrame`-deferred
   `querySelector` + `.focus()` + `.select()` on that option's own
   `data-testid=plan-option-input` field (`focusOptionInput`, unchanged),
   so the reviewer can start typing immediately without an extra click/Tab.
   Leaving an option row for a different KIND of row blurs a still-focused
   option field, so a stale caret never lingers behind (see "Never two
   selections visible at once" above).
2. **`Enter` chooses and immediately advances**, whether pressed on the
   option row itself (`onKeydown`, `state.col===1 && kind==='option'`) or
   inside that row's own now-focused free-text field
   (`optionInputKeydown`, shared by `optionRow`/`ownOptionRow`'s
   `@keydown` — previously two near-identical inline handlers): both call
   `sendAnswer` then `advanceToNextQuestion()` — `moveRow`'s sibling that
   walks `navRows()` forward past every remaining row sharing the current
   option's `q.id`, landing on the next QUESTION's first option (or the
   follow-up/task/execute row at the end of the list).
3. **Because the field can now have real DOM focus while just arrowing
   through options** (point 1), `optionInputKeydown` also re-implements
   `ArrowUp`/`ArrowDown` (→ `moveRow`) itself — the document-level
   `onKeydown` bails out entirely once an editable element has focus
   (`isEditableFocused()`), so without this arrowing would freeze solid the
   instant the first option's field took focus.
4. **`ArrowLeft`/`ArrowRight` inside that field**, follow-up clarification:
   *"escape eerst behalve als er niks getyped is"* — an EMPTY field still
   lets `←`/`→` step columns (`stepLeft`/`stepRight`, blurring first so
   keyboard control fully returns to the document-level handler, same as
   `Enter`); a field that already has typed text keeps ordinary caret
   movement, and `Escape` (the existing `isEditableFocused()` branch in
   `onKeydown`) is what hands `←`/`→` back — same precedent as the
   "Intentie" field's own "Escape locks it again".

### Column 0 slides out of view, and the example-code column follows the cursor

Reviewer request, verbatim: *"wat ik selecteer moet altijd in beeld zijn. als
ik in de vragen index blokken ben, wil ik de eerste pr overview niet meer
zien, het mag dan buiten beeld naar links toe. als ik dan naar links ga, wil
ik eerste kolom weer zien"*, plus the follow-up: *"ook verticaal navigeren,
moet de blok in beeld zijn, als ik eerste antwoord selecteer, moet ook gelijk
het blok worden gezien als dat het geselecteerd is en volledig in beeld
zijn."*

`stepRight`/`stepLeft` already called `scrollFocusIntoView()` (the
`behavior:'smooth'` scroll-into-view — see below) for every column transition
EXCEPT the very first one, ticket (0) ↔ questions (1): that one used to just
flip `state.col` with no scroll at all, so the ticket card never animated away
and could sit on screen wasting width once the reviewer moved on, and `←`
back to it wasn't guaranteed to bring it back into view either. Both
directions now call `scrollFocusIntoView()` too, so every `state.col` change
scrolls its `data-column-focused` column flush against `<main>`'s left edge —
which is what pushes the ticket card off-screen once you leave it, and what
brings it back on `←`.

The vertical half is a separate gap: `moveRow` (↑/↓ within column 1) can
change WHICH option/task's example code the block column shows without
`state.col` ever leaving `1`, so `scrollFocusIntoView` (which only reacts to a
`state.col` change) never ran for it — `scrollCurIntoView` only keeps the
cursor row itself in view, vertically, within column 1. `moveRow` now also
calls the new `scrollBlockPreviewIntoView()`, which brings
`[data-testid="plan-block-column"][data-level="0"]` into view with
`inline:'nearest'` (not `'start'`) whenever the new cursor has blocks — nearest
so it never hides column 1 itself while the keyboard is still there, unlike
`scrollFocusIntoView`'s deliberate `'start'` alignment for an actual
column-focus change.

### `scrollCurIntoView` fits the WHOLE question card, not just the cursor's own option row

Reviewer report, verbatim (screenshot `task45-vraagblok-volledig-in-beeld.png`):
*"als ik naar de volgende input ga, dan is alleen de eerste vraag volledig
zichtbaar, maar niet de laatste. laat dat hele blokje volledig zichtbaar
zien."* `scrollRowIntoView` (which `scrollCurIntoView` calls with
`[data-cursor="true"]`) only ever computed the bounding box of the cursor's
own row — landing on a NEW question's first option kept that one option
visible, but left the rest of that question's card (its own title/why line,
and every other option below the cursor) cut off at the bottom, while the
PREVIOUS question's card still occupied the top of the scrollable area. Fix:
`scrollRowIntoView` now resolves the cursor's closest
`[data-testid="plan-question"]` ancestor and fits THAT whole element instead,
falling back to the row itself when there's no such wrapper (scope/hotfix/
task/followup/action/comments rows have none) or when the whole card is
taller than the viewport (that longer-than-the-screen case is exactly what
already produced the old, row-only behaviour, and stays unchanged for it).
Shared by every `scrollCurIntoView` caller (`moveRow`,
`advanceToNextQuestion`), so a question switch via either `↑`/`↓` or `Enter`
gets the same fix.

### `focusColumn1` — every click back to column 1 must re-anchor the scroll, or the browser silently reveals column 0

Reviewer report, verbatim (no screenshot, two separate but likely related
complaints): *"input 'Eigen antwoord' laat opeens ook eerste kolom zien, echt
vreemd. het moet fundamenteel beter"* and, possibly the same symptom
mis-described, *"als ik begin te typen in 'eigen antwoord' kan is het gelijk
submitted, pas submitten als ik enter druk"*.

**Root cause, reproduced with a real (not JS-dispatched) mouse click, not
guessed:** every option/scope/hotfix/task/comments row's own `@click` handler
(and the questions column's own background `@click`) used to just assign
`state.col = 1` directly — one of ~15 near-identical inline assignments
scattered across `plan.mjs`. That assignment is not a no-op the way it looks:
the questions column's own width class flips between `w-[27rem]`/`w-[62rem]`
on `state.col === 1` (see "The questions column doubles in width…" below), so
clicking any such row from a DEEPER column (an open block/example-code view,
`state.col >= 2`) drops that block column AND doubles column 1's width in the
same tick — a real, large layout-width change with **no** corresponding
`scrollFocusIntoView()` call (unlike `stepRight`/`stepLeft`'s own `state.col`
change, which always calls it). The browser then silently CLAMPS the now-stale
`scrollLeft` to the new, smaller total scroll width — which is what actually
moved column 0 back into view, with nothing in the app ever deciding to show
it. Measured live (mocked fixture, a real `page.mouse` click, not
Playwright's element-based `.click()` which pre-scrolls its target and would
have hidden the effect): `scrollLeft` dropped from 504 to 316 purely from
clicking a different option's own field while a block column was open.
A raw JS-dispatched `click` event, and a real click while `state.col` was
already `1`, both produced ZERO shift — confirming it's this specific
`state.col`-change-without-re-anchor path, not something inherent to focusing
an input or to the "eigen antwoord" row specifically (every option row's
`@click` had the same gap; "eigen antwoord" was just the one the reviewer
happened to click).

**Fix**: one shared `focusColumn1()` helper — sets `state.col = 1` and calls
`scrollFocusIntoView()` only when the value actually changed — replacing every
one of those ~15 raw assignments (left `stepRight`/`stepLeft`'s own,
already-correct assignments untouched, since those already call
`scrollFocusIntoView()` right after). Structural fix, not a per-symptom patch:
a future click handler now has one correct helper to call instead of a raw
assignment it could just as easily forget to pair with a scroll re-anchor.

**The literal "submits on typing" claim was not reproduced.** `sendAnswer` —
the only place an answer actually reaches the tracker — is called exclusively
from `Enter` (`optionInputKeydown`'s own branch, or `onKeydown`'s Enter-on-row
branch), never from an `@input`/keystroke handler; typing several characters
into "eigen antwoord" with the network route intercepted produced zero
signals until `Enter`. The leading theory is that the `focusColumn1` jump
above, triggered by the CLICK used to get into the field before typing,
read as "something happened the instant I started" even though nothing was
actually saved. Left unresolved rather than guessed away: **both** the real
`sendAnswer` call and a genuine `focusColumn1` column jump now write a
`logAction` line to the debug-mode recording (`plan-answer-submit` /
`plan-col-jump`, `.claude/docs/debug-mode.md`) so a future real occurrence —
reported with debug mode on — leaves an actual line in
`data/debug-log.jsonl` to read back, instead of staying unfalsifiable.
**Debug mode itself was never wired into this page at all** before this
change (`initDebugLog()` is called from `home.mjs`/`overview.mjs`/
`settings.mjs`, but `plan.mjs` never called it) — found while adding those two
`logAction` calls, since neither would ever have reached the log otherwise.
Now called once at bootstrap, same as the other three pages.

### The questions column doubles in width, and the Intentie block collapses, while column 1 has the keyboard

Reviewer request, verbatim: *"in planning mag 2e kolom dubbel breed en intent
inklappen als ik in vragen kolom zit"*. Two small, purely `state.col`-driven
effects, no URL state of their own (derived, not navigational):

- **`questionsColumn`**'s outer `<div>` class became a whole-value function
  binding (`.claude/rules/arrowjs-pitfalls.md`'s mixed-literal-and-dynamic
  rule) instead of a static width: `w-[62rem]` while `state.col === 1`, back to
  `w-[27rem]` for every other column (originally `w-[31rem]`/exactly double
  `w-[62rem]`; narrowed on reviewer request — task 43, "kolom 2 mag iets
  smaller" — to make room for the wider example-code column below, so the two
  widths are no longer an exact double).
- **`intentField`**'s textarea hides while `state.col === 1`
  (`data-collapsed` on the block's own wrapper, `plan-intent-collapsed-label`
  showing the word **"ingeklapt"** next to the header — never a colour alone,
  per the colourblind rule). The header row (label + the reset button, when an
  override is active) stays visible either way. Both the label and the
  textarea are nested `${() => ...}` bindings in their own stable `contents`
  root, so the outer `intent:ready`/`intent:pending` key (and thus the
  textarea's one-time seed, see `intentField`'s own doc comment) is untouched
  by a `col` change.
- **`state.col` defaults to `1`** (the questions column already owns the
  keyboard on a fresh load), so the Intentie field is collapsed **by
  default** and only expands once the reviewer focuses column 0 (click the
  ticket card, or `←`) — `tests/plan-referenced-intent.spec.mjs`'s two
  editing tests click `plan-ticket-card` first for exactly this reason.

### The wide questions column stays wide once you step into a block/example-code column too

Reviewer follow-up, verbatim (with two screenshots): *"normaal goed selectie
van iets in kolom 2 #43 / als ik chat selecteer is kolom 2 smal"*. Read
literally the two screenshots show `state.col === 1` (an option/task itself
focused — wide, "normaal goed") versus `state.col >= 2` (its own
example-code column focused, e.g. "Voorbeeldcode bij de taak" — narrow,
reported as jarring). Verified live (a real key-driven walk into a task's
block column against BUG-5463): opening/closing the general chat overlay
(`state.chatOpen`) itself never touches `state.col` at all — the narrowing
the reviewer saw is purely `questionsColumn`'s own width condition losing its
`=== 1` match the moment a block column takes the keyboard, which is exactly
what task 43 (see above) had deliberately arranged. The "chat" in the
reviewer's own words is this page's informal name for that
column — an example-code card's own explanatory `note` reads like Claude
talking you through the code, which is the block column, not the ticket-wide
chat overlay.

**Fix**: the width condition widened from `state.col === 1` to `state.col >= 1`
— column 2 now stays at `w-[50rem]` whenever the keyboard is anywhere to its
right (a block column at any nesting level), narrowing to `w-[22rem]` only
while column 0 (the ticket) has the keyboard. This is a deliberate,
reviewer-approved partial reversal of task 43's own narrowing (which existed
specifically to make room for an open block column) — the reviewer now wants
that room ceded from column 0's side instead. `data-column-focused` and the
"actief" badge (`columnHeader`'s own `focused` argument) are untouched —
still exactly `state.col === 1`, since those describe which column literally
owns the keyboard, not its width.

### The scroll-into-view animation now also matches the review tree

The `scrollFocusIntoView` above already animated (`behavior:'smooth'`) every
column transition it was called for — this is the "prachtige animatie" a
reviewer asked to also see in the review tree (`src/home.mjs`'s own
`scrollFocusIntoView`, used when stepping across drilled Onderliggende-code
columns): that one used to jump instantly (no `behavior` = `'auto'`). Fixed by
adding the same `behavior:'smooth'` there — see
`.claude/docs/keyboard-navigation.md`.

## URL state

`bindUrlState` (the shared helper): `cur` (the cursor's stable **id** —
`q1o2`/`t3`, never a raw index, see `.claude/rules/conventions.md`), `col`, and
`path` (the drill path, joined with `.`, omitted while only one block column is
open). So a refresh or a shared link reopens the same question, the same option
and the same drilled block column.

## The last action: run the plan → a draft PR

Reviewer request, verbatim: *"als laatste actie in de index wil ik het in
kunnen zetten naar een draft pr, dan moet het plan uitvoeren"* — the closing
link of the chain todo → planning → needs your review → **draft PR**.

While it runs, the card shows a **live pane** — the streamed answer text, the
log of tool calls and the elapsed seconds — see "The generation AND the
execution stream their output too" above; the run reports nothing else about
itself until it finishes.

The index's flat nav list (`navRows`) therefore ends in a third kind of row
next to `option`/`task`: one **action** row (`EXEC_ROW_ID = 'exec'`,
`data-testid=plan-execute`), rendered as the last card under "Wat er moet
gebeuren". It only exists once there IS a task list — without that guard a
still-loading page would park the default cursor on the execute row instead of
on the first question, and the workflow refuses an empty plan anyway. It
carries no example code, so `curBlocks` yields nothing for it and `→` opens no
block column.

Because pressing it pushes a branch and opens a PR, **the first `Enter`/click
only arms it** (`state.confirmExec`, the button then reads "Zeker weten? Druk
nog een keer"); moving the cursor away disarms it again. Its state is always
spelled out in WORDS (`nog niet uitgevoerd` / `draait…` / `klaar` /
`draft-PR klaar` / `mislukt`), never a colour on its own — the colourblind
rule.

### The `plan_execute` workflow

`plan_execute.go`, Workflow Type **`plan_execute`** — read that file's own
header for the full reasoning; the essentials:

- **Always the primary repo** (`plug-and-pay/plug-and-pay`), an explicit
  reviewer decision: a plan hangs off a Jira ticket, which carries no repo, and
  the page deliberately offers no repo choice. The **base branch** is not fixed
  though — `develop` normally, `master` for a bug marked as a hotfix, or
  whatever branch the reviewer picked (`planBaseBranch`, see "Bug and hotfix"
  above).
- **The reviewer's own werkmap, exactly like the review tree** — reviewer
  request, verbatim: *"voor het uitvoeren moet je een werkmap gebruiken net als
  bij de tree"*. It used to build its own disposable worktree at
  `data/worktrees/plan-<KEY>`, which put the plan's work somewhere the reviewer
  never looks; `resolvePlanWorkDir` (`plan_execute.go`) now runs
  `listCheckoutCandidates` — **the very same selection ladder**
  `chat_checkout.go` uses for a write turn: `chatCheckoutDirs` from
  `settings.json` first, the bounded home scan only when that yields nothing,
  matched exactly on the repo slug (never a fork). The plan branch
  (`planBranchName(key, title)` → `paym-813-<slug>`, the key up front so
  `git branch` and the session-rename hook still find it, the slug from a
  strict allow-list because it reaches `git`/`gh` as an argument) is created
  **in that directory** with `git checkout -B <branch> origin/<base>`.
  Three deliberate differences from the tree's own use of that ladder, all
  forced by "there is no PR yet":
  - **`headRef` is the BASE branch.** The plan's branch does not exist
    anywhere, so "already on the target branch" cannot mean anything; asking
    for the base branch makes a checkout sitting on `develop` count as
    `OnTargetBranch` (and win via `prioritizeOnTargetBranch`), while a checkout
    on another, already-merged branch still qualifies as `MergedIntoBase` —
    both being the ladder's own notion of "genuinely free".
  - **A dirty candidate is skipped, never asked about.** This run is about to
    put a fresh branch in that directory; dragging the reviewer's uncommitted
    work onto it (or into the draft PR's commit) is not a guess worth making.
    Same for a directory another PR's chat already claims
    (`checkoutDirClaimsByOtherPRs`, asked with `pr` 0 — never a real PR number,
    so every claim counts as somebody else's) — **unless that claim is
    stale**. `activeCheckoutClaims` filters the raw claims through
    `prIsDone` (a PR's own `pr_status` tracker recorded it merged/closed —
    `prStatusWorkflow`, `workflows.go`, returns right after that Signal, so
    its run is `completed`; no extra `gh` call needed) and actively releases
    a stale one via `checkoutSetOff` as it finds it. Reviewer report (task
    56): *"ik kom elke keer niet een stap verder"* — a claim used to be
    released only by an explicit reviewer "uit" or by another PR taking the
    directory over, **never** by the original PR simply finishing, so a
    directory a long-merged PR once used stayed reported as busy forever. A
    PR this app has no `pr_status` data for at all (a synthetic/unknown
    number) is deliberately left as "still open" — never wrongly releasing a
    claim there is no data about. Same fix applied to `reusablePlanWorkDir`'s
    own claim check just below. Test:
    `TestResolvePlanWorkDirIgnoresAndReleasesAStaleClaim`
    (`plan_execute_test.go`).
  - **Nothing usable → a reviewer-facing note, never a worktree fallback**
    (`checkoutDiscovery.reason()`, or "configure `chatCheckoutDirs` / clone one").

  **The same werkmap per plan, and then the same one as the chat.** Reviewer
  request, verbatim: *"per plan naar dezelfde map, sync met als de chat een
  aanpassing moet maken vanuit de tree"*. Two halves, both in
  `plan_execute.go`:
  - **Sticky per plan key.** The chosen directory is remembered in
    `plan_checkout` (`chat_checkout_store.go`, the same `chat_checkout.db`,
    keyed by the Jira key — the same cache-hint carve-out as the per-PR row,
    see `.claude/docs/pending-push.md`), and `reusablePlanWorkDir` returns to
    it before the ladder is ever run. It has to bypass the ladder's own
    classification on purpose: after an attempt the directory sits on the plan
    branch with a commit `origin/<base>` does not have, which
    `listCheckoutCandidates` can only read as somebody else's unfinished work
    (`diag.Busy`) — so without this memory a second attempt landed in a
    *different* checkout, or in none at all. What it does re-check is that the
    directory still exists, is still a clean checkout of this repo, and has not
    been taken over by another PR; anything else falls back to the ordinary
    ladder.
  - **Handed to the tree once the draft PR exists.** `adoptPlanCheckoutForPR`
    writes that same directory into the PR's own `chatCheckoutAssignment`
    (in-memory **and** the durable mirror) the moment `gh pr create` returns a
    number. So the chat that has to make a change from the tree starts in the
    werkmap the plan was implemented in — no ladder run, the checkout chip
    right away, and the directory counts as claimed
    (`checkoutDirClaimsByOtherPRs`) so no other PR's chat takes it. The write
    slot needed nothing: `checkoutWriteSlotKey` already keys on `"dir:"+dir`.
  - **A second execution is refused once the branch has an open PR**
    (`planBranchHasOpenPR`, one `gh pr list --head`, best-effort — a `gh` that
    cannot answer never blocks a run). Because the plan now returns to the same
    werkmap, a re-run would `checkout -B` the branch back onto `origin/<base>`,
    discarding the first attempt's commit, and its push would be refused as a
    non-fast-forward anyway. The run stops before the Claude call and the
    execute card says so in words, with the existing draft PR linked.
  The run takes the same **per-directory write slot** every other
  checkout-mutating operation takes (`acquireWriteTurnSlot("dir:"+dir)`, see
  `chat_write_gate.go`/`checkoutWriteSlotKey`), re-checks dirtiness after that
  wait, and afterwards **leaves the werkmap on the plan branch** — so once the
  draft PR exists, the tree's own ladder finds this very directory already on
  that PR's head branch and the review continues in the same werkmap. The
  chosen directory travels from the agent Activity to the PR Activity on their
  own recorded result/input (`planExecuteResult.Dir` → `planExecutePRArg.Dir`),
  never re-resolved, and reaches the page as `exec.dir`
  (`data-testid=plan-execute-dir`, under the branch line).
- **Three Activities in a fixed order**: `planExecuteLoad` (read the stored
  document), `planExecuteAgent` (werkmap + ONE agentic Opus run with
  `Read/Grep/Glob/Edit/Bash` — the same shell carve-out a chat turn has, see
  `.claude/rules/workflows-write-boundary.md` — then commit), and
  `planExecuteOpenPR` (`git push -u` + `gh pr create --draft`). The last one is
  split off deliberately: a failed push or a `gh` hiccup is retried without
  paying for the whole Claude run again.
- **Claude edits, Go commits.** The run is told not to commit; `planExecuteAgent`
  stages and commits whatever it left behind, so "did it actually commit?" is
  never a question and the PR's URL is parsed off `gh`'s own stdout rather than
  scraped from the model's prose. A run that DID commit through its own Bash
  tool is recognised too (`planBranchAheadOfBase`), so the two can't fight.
- **No deterministic Run ID**, unlike the `plan` tracker: a plan may be executed
  more than once, and each attempt is simply another run. `RunsForPlan` finds
  every one of them by the `key` on their input, so they appear in the page's
  own "Taken" card for free (label `plan_execute` → "Plan uitvoeren",
  `src/workflowLabels.mjs`). A second start while one is still running is
  refused with 409, the precedent `handleTestRunStart` sets.
- **The result lives in the workflow's own history** (`engine.Result`), read
  back by `PlanExecution` as the `exec` field of `GET /api/plan` —
  deliberately NOT written into the plan document, which the `plan` tracker
  holds in memory and rewrites on every answer, so a shared row would clobber
  one or the other.
- Started with `StartWorkflowDeferLow` + `SetWorkflowPriority(…, PriorityLow)`
  so the POST returns immediately and the minutes-long run drains in the
  background (same as `test_run`/`comment_batch`).

## The `plan` workflow (one tracker per ticket)

`plan_workflow.go` + `plan_prompt.go`, Workflow Type **`plan`**, Run ID
**`plan-<KEY>`** — deterministic, so a repeated `POST /api/workflows/plan` is an
idempotent reuse (the page fires it on every load).

1. `planLoadIssue` — the ticket via `modules/jira`'s `Issue` (title +
   description). A failure yields a document carrying the reason, never a failed
   tracker.
2. `planGenerate` (mode `all`) — ONE **Opus** call, context-only (no tools),
   answering with one JSON object: the questions with their options and example
   blocks, plus the task list. Ids (`q1`, `q1o2`, `t3`) are assigned **on our
   side** from the position in the answer — a model reproduces "the second
   option" reliably and an identifier not at all, and the reviewer's stored
   answers hang off those ids. Caps: `maxPlanQuestions`/`maxPlanOptions`/
   `maxPlanTasks`.
3. `planSave` — the whole document into `modules/plan`.
3b. `planLoadContext` (only when `doc.loadsContext`, see the context section
   above) — the family's Jira comments plus the three most relevant merged PRs.
4. Then a loop on the **`plan_answer`** Signal (`{questionId, optionId, text}`):
   fold the answer into the document (`upsertPlanAnswer`, pure — one answer per
   question, an empty option clears it), **save it first**, then regenerate the
   task list (mode `tasks`, which leaves the questions alone so they can't move
   under the reviewer's hands mid-answer) and save again.

Determinism (`.claude/rules/workflow-determinism.md`): every side effect is an
Activity, the answers are folded from the recorded Signals in history order, the
Activity order per iteration is fixed, and the document's timestamp comes back
from an Activity rather than from the workflow body's own clock.

**Why the answer is saved before the regeneration:** the regeneration is a
minute-long Claude call, and `SignalWorkflow` runs a turn inline, so until it
lands the page would otherwise keep polling a document that does not know about
the choice just made. On top of that the page keeps its own `state.pending`
overlay (`answerFor`/`dropSettledPending` in `plan.mjs`): the local pick wins
until the stored document reports exactly the same one — an event/read is never
the source of truth (`.claude/docs/server-events.md`).

## Three stages, three files (intent → spec → plan)

Reviewer request, verbatim: *"op de planning/tijdens de planning heb je 3
stages: intent (die kan je zelf genereren vanuit de jira tickt (en hoofdtaak
als het om een subticket gaat), daarna specs en daarna plan. Kijk wat standaard
is van claude, maar volgens mij moet je intent.md spec en plan.md ofzo maken.
check dat even goed. dat mag dan in een losse directory die mag worden
weggegooid als de pr is gemerged (even gitignored in een dir (misschien heb je
al een data dir of zoiets)"*.

**The file names are the convention, not our invention.** `intent.md` →
`spec.md` → `plan.md` is the artifact chain of **Anthropic's own AI-Native SDLC
Playbook** (claude.com / Claude Academy): *"each stage ends by writing one to
version control (including intent.md, spec.md, plan.md, the diff and its tests,
the PR with its review findings, and the incident record) and the next stage
begins by reading it"*, with intent.md's own template covering *"problem,
proposed outcome, affected users and systems, constraints, and open questions"*.
GitHub's spec-kit uses the same middle and last name (`specs/<feature>/spec.md`
→ `plan.md` → `tasks.md`) but has no intent stage at all, so the playbook is the
one that matches the reviewer's own three stages one-for-one. **Our own
choices**, on top of that: the DIRECTORY (the playbook keeps intent in a
committed `intent/` folder; these files are derived and disposable, so they live
in gitignored `data/plans/<KEY>/` next to `data/worktrees/`), and the mapping of
each file onto what this page already has.

| phase | file | what it holds |
| --- | --- | --- |
| `intent` | `intent.md` | the ticket itself: problem (the description), proposed outcome, affected users and systems (the main task, the subtasks, the merged PRs), constraints (the base branch / hotfix, the assignee), open questions (the family's Jira comments). Generated straight from the document — **no Claude call at all**, which is exactly the "die kan je zelf genereren" half of the request; a subtask's own intent carries its **main task** and that parent's description. |
| `specs` | `spec.md` | the WHAT: every generated question with its options as a checklist (`- [x]` on the picked one), the reviewer's own typed addition, `**Still open**` for an unanswered one, plus the scope/branch decisions. |
| `plan` | `plan.md` | the HOW: every task with its concrete fields (`location`/`conditions`/`config`/…, an empty one omitted exactly as the page omits it), its checkbox state in words (`meenemen`/`overslaan`), the reviewer's own field, and its example-code blocks (nested `<details>`, each keeping its own note at every level). |

**The phase is derived, never stored** (`planPhase`, `plan_artifacts.go`), so it
can never drift out of sync and no existing document needs a migration:
`intent` while nothing is generated, `specs` while a generated question is
still unanswered, `plan` once every question is answered and there are tasks.
Deliberately keyed on the ANSWERS rather than on "are there tasks": mode `all`
generates questions AND tasks in one call, so a content-only rule would jump
straight from `intent` to `plan` and the middle stage — the one the reviewer
actually spends the planning in — would never be visible.

Which files EXIST is a second, separate rule (`planHasPhaseContent`): intent.md
always, spec.md once there are questions, plan.md once there are tasks. So an
intent-only plan really has one file (three stubs would make the stages
unreadable on disk), and plan.md appears as the current draft while the spec is
still being sharpened — the page says exactly that, with the word **concept**.

**A fourth state, "bezig": the phase right after the current one, while
Claude is actually generating it.** Reviewer report (screenshot): the phase
card kept reading `1. intent … nu` while Claude was already generating specs
— indistinguishable from "nothing is happening yet" for the `specs` row,
which still said `nog niet`. `phaseRow` (`plan.mjs`) now derives a `busy`
flag scoped to exactly the phase ONE AHEAD of `current` (`i === at + 1`,
`busyGenerating()` true — the transition can never skip ahead or lag behind
more than one phase) and shows it with a fourth glyph plus the word **bezig**
(`data-phase-state="busy"`) — never colour alone, same rule as the other
three states. This mirrors `planWorkflowsForPanel`'s own `busyGenerating()`
read for the "Plan" run row's `plan wordt opgesteld…` note (see "The Taken
block is the literal TasksPanel" above) — same signal, two places it needed to
be visible.

**Column 2 spells out the intent → specs step in words, no button.**
Reviewer request: *"in kolom 2 moet het duidelijk zijn hoe ik van intent naar
specs ga"*. There is deliberately no manual "generate specs" action — the
transition already happens automatically (the gate answered, if any, then
`planGenerate Mode:"all"` runs inline, see `planWorkflow` above) — so
`intentToSpecsHint()` (`plan.mjs`) just says so, directly under the intent
field while stage 1 is active (`intentInQuestionsColumn()`):
"Specs worden automatisch gegenereerd zodra de intentie compleet is.", or,
while `busyGenerating()`, "Specs (de vragen hieronder) worden nu gegenereerd
vanuit deze intentie…" (`data-testid=plan-intent-to-specs-hint`).

- **Written inside the `planSave` Activity**, not as an Activity of its own.
  That is the whole replay story: the `plan` Run ID is deterministic
  (`plan-<KEY>`) and tembed matches history positionally, so an extra
  `ExecuteActivity` in the body would park every existing Execution on a step
  its history does not carry — the trap `askBase`/`loadsContext`/
  `startsProgress` each needed their own flag for
  (`.claude/rules/workflow-determinism.md`). `planSave` is already called at
  exactly the moments a phase advances (after the issue loaded, at each gate,
  after every generation), so riding along inside it needs **no flag and
  changes no history at all**. It is still a write inside an Activity, so the
  write boundary holds (`.claude/rules/workflows-write-boundary.md`).
  Best-effort: the files are derived from the document that was just stored, so
  a disk hiccup is logged and costs a regenerable file, never the plan.
- **Every write is atomic** (temp file + `chmod 0644` + rename, in the same
  directory), so a crash or a full disk never leaves a half-written artifact or
  a stray temp file behind, and a reader never sees a truncated file.
- **The key is validated against `planKeyPattern` before it is joined onto a
  path** — it reaches the filesystem, so it is never trusted
  (`.claude/rules/conventions.md`).
- **On the page**: its own card in the first column (`data-testid=plan-phase`,
  `data-phase-current`), one row per phase (`plan-phase-row`,
  `data-phase-state=done|now|todo`) with a `✓`/`◆`/`○` **shape** plus the
  **word** `klaar`/`nu`/`nog niet` (or `concept`), the file name, and the
  directory underneath (`plan-phase-dir`). Never a colour on its own — the
  colourblind rule. Fed by `GET /api/plan`'s new read-only `artifacts` field
  (`{dir, phase, files:[{phase, file, path, exists}]}`, `planArtifactsView`),
  whose `exists` is read off disk so a directory cleanup already removed stops
  being claimed the moment it is gone.

### Thrown away with the PR (and swept if it never got one)

- **`plan_execute` drops a `.pr` marker** in the directory the moment
  `gh pr create` returns a number (next to `adoptPlanCheckoutForPR`). Not a
  `.md` file (it is bookkeeping, not an artifact) and deliberately not a field
  on the plan document — the tracker holds that document in memory and rewrites
  it on every answer, so a `plan_execute` write into it would clobber one or the
  other, the same reasoning the `exec` field already records.
- **`purgePR` removes the directory** whose marker names that PR
  (`removePlanArtifactsForPR`, counted as `planArtifactsRemoved`). That is the
  reviewer's own "mag worden weggegooid als de pr is gemerged", riding on the
  **existing** merged-and-`cleanupMergedAge` gate rather than becoming a second
  cleanup mechanism — and inside the existing Activity, so the `cleanup`
  workflow's own history is unchanged. Idempotent, like every other purge step.
- **A directory that never reached a PR is swept on its OWN age**
  (`sweepPlanArtifacts`, `planArtifactAge` 30 days, `planArtifactsSwept`) — an
  abandoned plan, or a run that broke halfway, would otherwise be the one thing
  in `data/` nobody ever cleans. Same shape as the `test_run` residue sweep: one
  unconditional Activity per cleanup pass, about the directory's own age and
  never about a PR. It is appended as the **last** step of `cleanupWorkflow`, so
  every existing position in that workflow's history stays put. A directory WITH
  a marker is left alone however old it is — its PR may still be open, and
  `purgePR` owns it either way.
- **`data/plans/` is gitignored**, with the reasoning in `.gitignore` itself.

Tests: `plan_artifacts_test.go` — the phase transitions (including the
half-answered case that must NOT read as `plan`), the separate file-existence
rule, the three renderers really carrying three different things (the main task
of a subtask, an unanswered question, a nested block's note, an unchecked task,
an omitted empty field), the key validation, the per-PR removal leaving another
PR's directory alone and being idempotent, the age sweep skipping a fresh plan
and one with an open PR, and `planArtifactsView`. Verified live against the real
`PAYM-813` ticket through all three stages — screenshots
`task28-phase-1-intent.png` (only intent.md, "nu" on stage 1),
`task28-phase-2-specs.png` (intent klaar, specs nu, plan.md as `concept`) and
`task28-phase-3-plan.png` (both questions answered, stage 3) in
`data/review-shots/`.

## Storage

`modules/plan` — one row per issue key holding the whole document as **JSON**
(`data/plan.db`), deliberately not a normalised question/option/block schema:
the document is written and read as a whole, nothing queries across documents,
and the block nesting is arbitrarily deep. `Save` is called only from the
`planSave` Activity; `Get` backs the read-only endpoint
(`.claude/rules/workflows-write-boundary.md`).

## Endpoints

| Endpoint | What |
| --- | --- |
| `GET /plan/<KEY>` | the static shell (`plan.html`, same anti-flash/theme/Prism/markdown blocks as `index.html`). A path that isn't a Jira key or a bare number → `location.replace('/pr-overview')`. |
| `GET /api/plan?key=KEY` | read-only → `{ok, key, doc, runs, generating, exec?, artifacts?, intent}` (`exec` = the newest `plan_execute` attempt of this ticket; `artifacts` = the three-phase file view; `intent` = the CURRENT intent.md text, auto-generated or `doc.intentOverride`, computed at read time — see "The 'Intentie' field" above). An unknown ticket answers ok with an empty document, never an error. |
| `POST /api/workflows/plan` | `{key}` → `{runId}`; starts or idempotently reuses the tracker. |
| `POST /api/workflows/plan_execute` | `{key}` → `{runId}`; the index's last action — implement the plan on a fresh branch and open a draft PR. 409 while one is already running. |
| `POST /api/workflows/{runID}/signals/plan_answer` | `{questionId, optionId, text}` — one answer; `{kind:"followup"}` — generate follow-up questions and rebuild the task list; `{kind:"chat", text}` — one general-chat message; or `{kind:"task", taskTitle, taskOff, taskNote}` — one task's checkbox/field (the only shapes allowed without a `questionId`). |
| `GET /api/plan/current?key=KEY&file=path` | read-only → `{ok, found, file, dir?, code?, truncated?}` — what that file looks like right now in the plan's own werkmap, shown next to a block's proposed code. `found:false` is an ordinary answer (the page's "nieuw bestand"). |
| `GET /api/branches` | read-only → `{ok, branches:[{name, own, updated}]}` — the primary repo's remote branches, the reviewer's own first, for the hotfix question's dropdown. |
| `POST /api/workflows/{runID}/signals/plan_hotfix` | `{hotfix, branch?}` — a bug's base branch: the hotfix branch, the ordinary one, or a branch picked from the dropdown (validated against the ref allow-list); or `{kind:"chat", text}` — a chat message while this gate stands (see "The general chat" above). |
| `POST /api/workflows/{runID}/signals/plan_scope` | `{choice:"parent"}` — plan the main task itself (a subtask choice is plain navigation, not a Signal); or `{kind:"chat", text}` — a chat message while this gate stands. |
| `GET /api/workflows?plan=KEY` | the ticket's own runs (the same read as `?pr=N`, filtered on the input's `key` instead — so a later per-ticket workflow lands in the "Taken" card for free). |

## Accepted gaps (deliberate, don't "fix" by accident)

- **An existing plan document has no assignee until it is regenerated.** The
  assignee fields land on the document from `planLoadIssue`, whose result is
  already RECORDED in the history of every Execution that ran before them, so
  a replay hands back the old document — the ticket card and the scope
  question then show "Niet toegewezen" for a ticket that does have an
  assignee. The same accepted gap every earlier plan-document field has (it is
  now the fifth); the fix is a fresh plan for that ticket, not a migration.
- **A plan execution has no per-task live progress** — only the run's own
  status (via the "Taken" card and the `exec` field) and, at the end, the draft
  PR or a short note. Deliberately no `test_run`-style marker/progress
  plumbing: the run is one agentic pass, not a list of known items.
- **The agentic run is bounded by the module's own `agenticTimeout`** (10
  minutes, `modules/claude`) — the same ceiling every other agentic workflow
  has, but since task 56/57 it is a **heartbeat**, not a fixed deadline from
  the call's start: `RunChat`'s `HeartbeatContext` (`modules/claude/
  heartbeat.go`) resets the 10-minute clock on every stream-json line the CLI
  produces (any sign of life — a reviewer-confirmed "elk teken van leven"
  scope, not just a recognized tool-step frame), so a plan execution that is
  genuinely still working — editing files, running tests, minute after
  minute — is never killed just for taking a while; only a truly wedged run
  (no output at all for 10 straight minutes) still hits the ceiling. Reviewer
  report: a real BUG-5463 execution doing substantial, real work (several
  file edits, `php artisan test` runs) got SIGKILLed mid-implementation by
  the old fixed timeout. Since `HeartbeatContext` lives in `RunChat` itself,
  every other caller (`chat_workflow.go`, `code_warning.go`,
  `comment_batch.go`, `test_run.go`, this file's own `planChatReply`) gets
  the same heartbeat for free — see its own doc comment for the primitive
  and `.claude/docs/workflows-analysis.md`/`workflows-test-run.md` for where
  `agenticTimeout` is otherwise mentioned. A plan too big even for a
  genuinely-progressing 10 minutes of heartbeats lands whatever it got to;
  the PR is a draft precisely because the result still needs a human.
- **The werkmap is chosen AUTOMATICALLY; the plan page has no werkmap
  overlay.** The tree asks (`checkoutStageChooseDirectory`,
  `src/workDirOverlay.mjs`) because a chat turn has a conversation to ask in;
  on `/plan/<KEY>` the first usable candidate simply wins, deterministically
  (registry before home scan, on-the-base-branch before merely-merged) — an
  explicit reviewer decision, taken when the werkmap switch was built. A
  second, interactive round trip on this page was judged not worth it: when
  nothing is usable the run says why, in words, on the execute card.
- **The werkmap is left on the plan branch** after a run, and a failed attempt
  leaves it there too. That is deliberate (the follow-up PR review continues in
  the same directory), but it does mean a plan executed against a checkout the
  reviewer was using for something else moves that checkout — which is exactly
  why only a genuinely free, clean candidate is ever taken.
- **A plan cannot be re-executed onto the same branch** (see above): once its
  draft PR is open, a new attempt is skipped with a note instead of moving the
  branch. Genuinely wanting a fresh run means closing that PR (or renaming the
  ticket, which changes the branch name).
- **The plan's werkmap is only claimed against other PRs once the draft PR
  exists.** While an execution is still running there is no PR number to claim
  under, so the guarantee during the run is the per-directory write slot, plus
  the fact that a directory on the plan branch is never offered to another
  PR's chat automatically.
- **A task's checkbox/field is keyed by its TITLE, so a rephrased title loses
  it.** That is the price of not keying on a positional id (see above): a
  regeneration that renames "Voeg de checkbox toe" to "Checkbox per taak
  toevoegen" reads as a new task — ticked, no note. Deliberate: the alternative
  (an id) would silently move the state onto a DIFFERENT task, which is worse
  than losing it.
- **Existing plan documents get `taskStates` no more retroactively than any
  other new field** — the document is written and read as a whole and there is
  no backfill. Here that costs nothing: an absent state IS the default (every
  task ticked, no notes), so an older plan behaves exactly as before. Fourth
  time this shape is recorded as an accepted gap.
- **The current-code pane reads the werkmap, not the base branch.** A checkout
  sitting on somebody else's branch (or with uncommitted work) is shown as it
  is — for a read that is arguably the most truthful picture, and unlike
  `resolvePlanWorkDir` this endpoint therefore never refuses a dirty or
  claimed directory. With no local checkout at all, every block simply reads as
  "nieuw bestand".
- **The proposal is never diffed against the file two-sidedly** (see above), so
  the page never says which existing lines a plan REPLACES — only which of the
  proposed lines are new. A plan block is a sketch; the real diff is the draft
  PR.
- **No Jira update.** Executing the plan does not transition the ticket.
- **The related-PR search is a heuristic on the issue key.** A PR that never
  names its ticket in the title or body is not found, and one that only
  mentions it in passing can be. The ranking then only orders what the search
  returned — deliberately, since the alternative (a Claude pass over every
  candidate) costs a minutes-long call for context, not for the plan itself.
- **The three most relevant PRs are picked deterministically**, so "relevant"
  means "belongs to a closer ticket, merged more recently" — not "touches the
  same code". Good enough for context; anything smarter needs the model.
- **A document from before this context existed keeps its empty comment/PR
  fields**: the document is written and read as a whole and there is no
  backfill, and an Execution recorded before `planLoadContext` existed replays
  straight past that Activity forever (that is the point of the
  `loadsContext` flag). Such a plan only gains the context if its ticket gets a
  fresh tracker.
- **Follow-up questions cannot be taken back either.** Appending is the only
  operation: a question the reviewer finds useless is simply left unanswered,
  and the total is capped at `maxPlanQuestionsTotal` rather than pruned.
- **The concrete task fields are only as good as the model.** Nothing verifies
  that EVERY if or config really is listed; the prompt demands it and the page
  renders whatever came back (an empty field is omitted, never shown as
  "n.v.t.").
- **A main task whose reviewer picked a SUBTASK keeps a tracker parked on the
  scope question**, forever, until someone opens that main task's plan page
  again and answers it. It costs one waiting Execution per ticket and no Claude
  call, which is exactly the point of the gate.
- **The hotfix branch is a CONSTANT** (`planHotfixBranch = "master"`,
  `plan_execute.go`), not a field on the repo registry: a plan only ever runs
  against the primary repo, so a registry field would be surface nothing else
  uses.
- **The branch dropdown reads the local clone, and does not fetch first.** A
  branch pushed seconds ago is only offered once something else fetched it into
  `repoDirFor("")` — a read endpoint deliberately does not fetch a clone the
  ingest pipeline shares.
- **The hotfix choice cannot be taken back either**, for the same reason as the
  scope choice: it is one Signal in the history, and it already steered the
  generated plan.
- **`issueType` is now only kept for replay.** It no longer decides anything for
  a new run (`askBase` does), but it must keep deciding it for a bug-only-era
  Execution, so neither the field nor `planIsBug` can be dropped.
- **The scope choice cannot be taken back** (see above). Reversing it would have
  to invalidate a plan that was already generated from it.
- **Whether the model nests its blocks is up to the model.** The prompt asks for
  it explicitly and the UI supports any depth, but a small ticket legitimately
  comes back one level deep.
- **A document stored before the per-block-note rule keeps its empty nested
  notes.** The document is written and read as a whole, and there is no
  backfill: an existing plan only gains explanations on its nested blocks once
  it is regenerated (a new `plan` run, or the `tasks` regeneration an answer
  triggers — which rewrites the task blocks, not the question blocks).
- **A language the vendored Prism doesn't carry** (e.g. `markdown`) renders as
  escaped plain text with the language word still in the header — the same
  fallback as a fenced block in a comment (`.claude/rules/conventions.md`).

Tests: `plan_workflow_test.go` (the task checkbox/field fold plus
`mergePlanTasks` — an unchecked task never comes back from a regeneration but
keeps its re-tickable row, ids renumbered, the off-list reaching the prompt —
and `planExecutePrompt` skipping an unchecked task while carrying the
reviewer's own field; `plan_current_code_test.go` (a traversal, a missing file
and a directory all read as not-found, and the file pattern refusing an
absolute/shell-ish path); id numbering + caps, junk rejected, the
hotfix gate's pure decisions — `planNeedsBaseQuestion` on a pre-gate, a
bug-only-era and a fresh document (the replay safety), `planIsBug` on every
issue-type spelling and
`resolvePlanBase`/`planBaseBranch` on all three choices including a branch git
would read as a flag — the hotfix constraint reaching both prompts, and
`parseBranchRefs` putting the reviewer's own branches first while dropping
`origin/HEAD`, the
per-question answer fold, the regenerate prompt carrying the fixed choices, a
nested block's note surviving the trim at every level, the parent/subtask
context in the prompt, plus the four things this page's own concreteness rests
on: `planRelatedKeys`' tier order, `rankPlanRelatedPRs` picking the three most
relevant (own ticket first, newest within a tier, deduplicated),
`appendPlanQuestions` numbering a follow-up round AFTER the existing ids
without moving them, and the prompt carrying the comments, the merged work and
the "elke if / elke config" rules while asking nothing about tests,
and the general chat: `planChatPrompt` carrying the ticket/questions/tasks
context plus the transcript ending on the reviewer's own last message, and
`trimPlanChat` keeping the newest messages within `maxPlanChatMessages`),
`modules/jira/jira_test.go` (the `parent`/`subtasks` payload shape,
`issuetype` reaching `Issue.Type`, and the `comment` field reaching
`Issue.Comments` — including a mention's own text and the newest-20 cap),
`plan_execute_test.go` (the branch name stays git-safe and bounded, the
execute prompt carries the fixed choices and every task's nested example code
capped per block, the PR URL parsed off `gh`'s stdout, and — against
`chat_checkout_test.go`'s own throwaway repo fixtures — that
`resolvePlanWorkDir` picks a clean registered checkout on the base branch,
refuses a dirty one by name, leaves a directory another PR claims alone,
returns to the SAME werkmap on a second attempt while the ladder itself
already refuses it, and that `adoptPlanCheckoutForPR` hands that werkmap to
the PR's chat in memory, durably and as a claim) and
`modules/plan/plan_test.go` (the document round trip). Verified in the running
app; screenshots in `data/review-shots/plan-page.png` (a chosen option with two
block columns open) `plan-page-tasks.png` (the task list with its own
nested block column), `plan-scope-question.png` (a main task asking which of its
six subtasks — or itself — is being planned) `plan-subtask-parent.png` (a
subtask's plan, with the main task linked in the first column),
`plan-hotfix-question.png` (a bug being asked which branch it goes out from),
`plan-branch-question-story.png` (the same question on a Story, now that every
type gets it)
`plan-hotfix-branch-dropdown.png` (its third choice unfolded: the search
field with the reviewer's own branches on top) and
`task12-plan-concrete-tasks.png` (the merged-work card in the first column, the
follow-up-questions row, and a task with every concrete field filled in).
`task22-task-checkboxes.png`/`task22-task-unchecked.png` (a task's checkbox,
its state in words, the strikethrough title and the reviewer's own field) and
`task26-current-vs-proposed.png`/`task26-new-file.png` (the two panes, with the
`+` gutter on the lines the file does not have yet — and the "nieuw bestand"
stand).
`tests/plan-ticket-menu.spec.mjs` (Enter on the ticket column opens the menu,
its "Open in Jira" item, Escape, the mouse entry point) and
`tests/plan-chat.spec.mjs` (`/` opens the overlay, a sent message round-trips
through the Signal — against a freshly opened ticket, which in this harness
means the chat is answered while the tracker still sits on the hotfix gate,
exercising the gate-tolerant carve-out above — the mouse entry point, and the
backdrop click).

## Jira-opmerkingen: lezen, beantwoorden, @-mentions

Read-only backend: `plan_comments.go`'s `PlanComments` reads this ticket's own
comments plus the main task's and every subtask's (`planCommentFamily`, self
first, then parent, then subtasks, deduplicated), served from an in-memory
per-key cache good for `planCommentsTTL` (24h — the reviewer's own "een dag
mag" instruction), single-flighted so two tabs on the same ticket don't each
pay for `1+maxCommentIssues` `acli` calls. `GET /api/jira/comments?key=KEY[&refresh=1]`
serves the panel; `GET /api/jira/users?q=…` answers the `@`-mention picker
(`modules/jira/comments.go`'s `Users`, a short-lived per-query cache). Both
read `CanPost`/`CanMention` off whether the Atlassian API token
(`SLASH_JIRA_EMAIL`/`SLASH_JIRA_TOKEN`, `jiraCredsFromEnv`) is configured —
reading comments works via `acli` regardless, but posting/searching needs the
token, since `acli` has no comment-post or user-search command at all.

Posting a reply is its own one-shot Workflow Type, `jira_comment`
(`jira_comment.go`), started via `POST /api/workflows/jira_comment
{key, body, mentions}` — deliberately NOT another Kind on the `plan`
tracker's `plan_answer` Signal (unlike the general chat), because the tracker
can be sitting on the scope/hotfix gate when a reply is posted, and a Signal
aimed at a name it isn't currently waiting on would just sit unconsumed.
`modules/jira/comments.go`'s `BuildCommentADF` turns the typed body plus the
picked `Mention`s into a real Atlassian Document Format document (longest
mention text wins on overlap), posted via the Jira Cloud REST API (`acli` has
no write endpoint for this) on the same `SLASH_JIRA_EMAIL`/`SLASH_JIRA_TOKEN`
credentials as the notification feed. Mentions are only ever what the
reviewer typed and picked — never automatic. After a successful post the
Activity calls `invalidatePlanComments(key)` so the panel's own cache doesn't
keep serving a list that predates the new comment.

A posted reply also feeds back into the plan: the page sends a THIRD
`plan_answer` Signal Kind, `planAnswerComment` (`plan_workflow.go`), which
re-reads the whole family's comments onto the document
(`planRefreshComments` Activity — replacing, never appending, so a re-read
never duplicates) and, if a task list already exists, regenerates it
(`planGenerate` with `Mode:"tasks"`) — the reviewer's own instruction that a
new comment must feed the task list exactly like an answer does.

Scope, deliberately: reading + replying + mentions only. No drafts, no
reactions, no resolve/ignore, no AI-generated titles — unlike the review
tree's PR-comment panel, which has all of those; a smaller, read-mostly
feature was the explicit ask here.

**The frontend (task 23b of `todo/plan-page-workflow.md`).** `commentsPanel()`
in `src/plan.mjs` sits at the very TOP of the questions column
(`questionsColumn()`, kolom 2), above the question cards — per the reviewer's
own instruction. It does NOT reuse the review tree's `BlockList.mjs` component
(that component carries the whole review-tree's block/approval model); the
panel is its own small set of functions (`commentGroupCard`, `commentRow`,
`commentReplyComposer`, `commentMentionPicker`) built the same way every other
card on this page is,
consistent with this page's own header comment ("nothing is imported from
home.mjs/Block.mjs/RelatedPanel.mjs").

- **Reading:** `loadComments(refresh)` calls `GET /api/jira/comments` once at
  page load (`state.comments`, no polling — the day-long server cache means a
  poll would just re-ask for the same answer) and again with `refresh:true`
  right after a reply is posted, or from the panel's own "Ververs" button
  (`data-testid=plan-comments-refresh`). Each group (`planCommentGroup`)
  renders as its own card: the ticket key (linking out to Jira), a relation
  WORD next to it (`COMMENT_RELATION_WORD`: "dit ticket"/"hoofdtaak"/"subtaak"
  — never a colour alone, the colourblind rule), the title, a comment count,
  and every comment (`avatarHTML` + author + `relativeTime` + `renderMarkdown`
  body, reusing the exact shared helpers the rest of the app uses for this).
  A comment's own body is always shown in FULL — never clamped, whatever its
  length (see "Collapsed by default: a HEIGHT fold, over the whole list, never
  per comment" below for why not, and what folds instead).
- **Replying:** one composer open at a time (`state.commentReplyKey`, the
  same single-cursor discipline the rest of the page follows), a plain
  UNCONTROLLED `<textarea>` (`data-testid=plan-comment-reply-input`, same
  shape as `ClaudeChat.mjs`'s composer — a reactive `value=` binding would
  fight the caret while typing) posted via `sendCommentReply` →
  `POST /api/workflows/jira_comment`. The "Beantwoorden" toggle
  (`data-testid=plan-comment-reply-toggle`) only renders when
  `state.comments.canPost` is true; without a token the panel says so in
  words instead ("Antwoorden vereist een Jira API-token…").
- **@-mentions:** `onCommentReplyInput` watches the text typed so far for a
  trailing, unresolved `@word` (anchored to the END of the string, not the
  real caret — this composer, like every other one on this page, is typed
  top-to-bottom) and, after a 200ms debounce, looks it up via
  `GET /api/jira/users?q=…` (`commentMentionTimer`). A match shown in
  `commentMentionPicker()` (avatar + display name) is only ever ADDED by the
  reviewer clicking it (`pickCommentMention`) — never inferred — which
  replaces the trailing `@word` in the DOM textarea with the full
  `@Display Name` and appends `{accountId, text}` to `state.commentMentions`,
  exactly the `jira.Mention` shape `BuildCommentADF` expects. A mention whose
  text the reviewer later edits away simply contributes nothing when posted
  (see `BuildCommentADF`'s own doc comment) — no cleanup needed here.
- **Feeding back into the plan:** right after a successful post,
  `sendCommentReply` sends the plan tracker's OWN third `plan_answer` Signal
  Kind, `"comment"` (`planAnswerComment`), exactly as `.claude/docs` above
  already documents — this is the piece that actually makes a new comment
  regenerate the task list.
- **Jira avatars needed a second allowed host on the avatar proxy.**
  `avatar.mjs`'s `avatarHTML` always routes an `avatarUrl` through
  `GET /api/avatar` (`avatar_proxy.go`), which used to allow only
  `avatars.githubusercontent.com`. A Jira comment/user's `AvatarURL` is served
  from Atlassian's own CDN
  (`avatar-management--avatars.us-west-2.prod.public.atl-paas.net`), so
  without this the proxy 400'd on every Jira avatar and the fallback-on-error
  wiring silently degraded every one of them to an initials circle. Fixed by
  turning the single `avatarAllowedHost` constant into a small
  `avatarAllowedHosts` allowlist map (exact host match, same as before — no
  wildcarding, so this can't become an open proxy/SSRF vector). Verified
  against the real `PAYM-813` ticket: the proxy request for a real Jira
  avatar now returns 200 and the `<img>` actually loads (`naturalWidth` > 0),
  where it previously 400'd. Tests:
  `TestHandleAvatarAllowsJiraAvatarHost` (the new host is reachable),
  the extended `TestHandleAvatarRejectsDisallowedHost` (a look-alike host
  that merely contains the Atlassian host as a substring is still rejected —
  the allowlist is an exact map-key match, not a suffix/contains check).
- **Not covered by an automated test:** the reply composer and mention
  picker's full round trip (they need a configured Jira API token, which the
  Playwright harness's `SLASH_JIRA=off` fixture doesn't guarantee is absent —
  see `tests/plan-comments.spec.mjs`'s own header comment). Verified by hand
  instead against the real `PAYM-813` ticket: opening the composer, typing an
  `@` mention, picking a suggestion, sending, and seeing the new comment
  reappear in the panel after the automatic refresh — all with zero console
  errors.

### The comments block is a stop of its own in the → chain

Reviewer request, verbatim: *"als ik naar rechts ga, wil ik eerst jira
opmerkingen blok volledig selecteren, als ik enter druk, wil ik tussen de
opmerkingen heen kunnen navigeren"* — this reverses an earlier, deliberate
choice (see the "23b" section above's original wording, now corrected): the
panel was built as `state.col`/`navRows()`-agnostic ("replying is a
mouse/typing action, not something to walk with ↑/↓"). It is now a genuine
stop, reusing the review tree's own "a block is a stop, Enter hands ↑/↓ to a
nested list" shape (the methodes-kolom/`tcol`, see
`.claude/docs/test-class-grouping.md`) rather than inventing a new mechanism.

- **`COMMENTS_ROW_ID` (`'comments'`) is the FIRST entry `navRows()` returns**,
  whenever the family has any comment at all (`commentFlatList().length`,
  guarded the same way the follow-up row only appears "once there is
  something") — pushed before the scope/hotfix gate branches even `return`,
  since `commentsPanel()` itself already renders unconditionally, independent
  of that gate. A plain `→` (or `←` back from a block column) therefore lands
  on it before anything else, exactly like a plain `→` already lands on the
  first option/scope/hotfix row when there is no comment at all — no special
  case needed, `navRows()`'s existing "cursor walks the flat list" machinery
  does this for free.
- **`commentFlatList()`** flattens every group's comments into ONE ordered
  list, the same shape `navRows()` itself flattens options into — so ↓ walks
  from one ticket's last comment straight into the next ticket's first one.
  Each entry's id (`commentId(groupKey, c, i)`) is the SAME
  group-key + comment-id/created/index shape `commentRow`'s own `.key()`
  already used — never a raw index (`.claude/rules/conventions.md`).
- **`state.commentsFocused`/`state.commentCursor`** mirror `testColumnFocused`/
  `classMethodSel`: `commentsActive()` (`isCommentsRowSelected() &&
  state.col === 1 && state.commentsFocused`) is the single source of truth
  both the keyboard and the rendering read, exactly like the tree's
  `isTestColumnActive()` — so a stale `commentsFocused` left over after the
  cursor moved to an unrelated row (any of the many inline `@click`
  assignments across option/task/scope/hotfix/followup/exec rows, none of
  which explicitly clear it) can never hijack `↑`/`↓`: the moment `state.cur`
  no longer equals `COMMENTS_ROW_ID`, `commentsActive()` is false regardless.
  `clampCursor()` additionally resets `commentsFocused`/`commentCursor`
  outright once the comments row (or the specific comment) genuinely stops
  existing.
- **Enter on the block (`row.kind === 'comments'`) calls `enterCommentsFocus()`**,
  which focuses the first not-yet-invalid comment (or the previously active
  one, if it still exists) and hands `↑`/`↓` to `moveCommentCursor`, clamped
  at the family's first/last comment — no wraparound, no cross-block
  fall-through, mirroring `moveRow`'s own clamp. `←` (not `Escape` — this
  block has no submenu-style overlay) calls `exitCommentsFocus()`, which
  drops back to the block-level selection WITHOUT changing `state.col` —
  exactly like the methodes-kolom's own `←` stays on stop 2b. `→` is a no-op
  while focused: there is no nested column to reach from inside a comment.
- **Two selection levels, told apart in words, never ring colour alone**
  (the colourblind rule): the panel's own header carries a badge
  (`data-testid=plan-comments-state`) reading **"◆ blok geselecteerd"**
  while the whole card carries the ring, or **"◆ opmerking actief"** once
  `commentsActive()` — mirroring `columnHeader`'s own "◆ actief" word. The
  two rings are mutually exclusive by construction
  (`isCommentsRowSelected() && !commentsActive()` for the card,
  `commentsActive() && state.commentCursor === id` for a row), so only one
  shows at a time (the "never two selections visible at once" rule, commit
  `27ce93c`). **The per-row "● actief" word badge next to a comment's author
  line is gone** (reviewer request, task 48: "'actief' kan weg omdat het al
  duidelijk is door die border") — the ring/border was always the SHAPE cue
  next to that word (belt and suspenders), and stays as the row's only "here"
  indicator now that the word is removed; nothing lost for the colourblind
  rule, since a border/ring is a shape, not a colour.

### Collapsed by default: a HEIGHT fold, over the whole list, never per comment

Reviewer request, task 48b — a correction of an earlier, wrong reading of
"opmerkingen inklappen" (task 48 above had built a PER-COMMENT text clamp/
toggle, since reverted): *"ik bedoel niet verticaal inklappen, nee comments
moeten horizontaal inklappen tot 2,5 laatste comments"*, then, asked which of
two concrete readings was meant (a horizontal card carousel, or a vertical
list whose visible HEIGHT folds): *"paneel smal, laatste ~2,5: de lijst
blijft verticaal, maar het opmerkingen-paneel staat standaard smal ingeklapt
en toont alleen de laatste ~2,5 comments (volledige tekst); Enter/klik klapt
het volledig open"* — with the explicit addition **"maar breedte blijft
altijd hetzelfde"** (the column's width never changes) and **over the WHOLE
flattened list**, not per ticket/group.

- **`commentsListExpanded()` reuses `commentsFocused` itself** — no new state
  field. The exact same action that already hands `↑`/`↓` to the individual
  comments (`enterCommentsFocus`: Enter on the block, or a click on one
  comment) is what reveals the full history, and leaving that mode
  (`exitCommentsFocus`, `←`) is exactly when it should fold back down.
- **`COMMENTS_COLLAPSED_CLS`** (`'max-h-[260px] justify-end
  plan-comments-fade-top'`, applied to the `data-testid=plan-comments-list`
  wrapper around every `commentGroupCard`) caps the list's height at roughly
  2.5 short comments — necessarily an APPROXIMATION, an individual comment's
  real height varies with its text, exactly as imprecise as the reviewer's
  own "~2,5" — and bottom-anchors the content (`flex flex-col justify-end`)
  so the NEWEST comments (rendered last, at the bottom of the flattened list)
  stay visible and the OLDER ones scroll out of view at the top. A `max-h`
  rather than a fixed height, so a short list that already fits inside that
  budget is never padded with blank space above it.
- **`.plan-comments-fade-top`** (`plan.html`) softens the cut edge — the
  mirror of the existing `.code-fence-fade-bottom` mask (same "there's more,
  hidden this way" cue), just fading the OPPOSITE edge (top, since content is
  bottom-anchored here). A plain alpha mask, not colour, so no dark-mode
  variant needed, same as the original.
- **`plan-comments-expand-hint`** — a small button under the (possibly)
  clipped list naming the same unfold action in WORDS ("Toon alle
  opmerkingen (Enter)"), never relying on the fade alone (the colourblind
  rule) — clicking it calls `enterCommentsFocus()` directly, same as
  clicking any individual comment does. Hidden once expanded, and also
  hidden below `COMMENTS_COLLAPSE_HINT_MIN` (3) comments in the whole
  flattened list — "never offer an affordance for a fold that can't
  plausibly be hiding anything", the same reasoning `planCommands`'
  conditional "Opnieuw plannen" item already follows.
- **A comment's own body is never text-clamped any more, at any width** —
  `commentRow` always renders the full `renderMarkdown` output; the earlier
  `COMMENT_BODY_TRUNCATE_AT`/`commentBodyCollapsible`/`line-clamp-3`
  machinery (task 48's own per-comment expand toggle, and the original
  pre-task-47 clamp it was itself layered on) is gone outright. The visible
  content NOW gets exactly as tall as its text needs; only the outer list's
  overall HEIGHT folds.
- **Visual trade-off, accepted rather than engineered around**: because the
  fold is a plain CSS height clip over the WHOLE list rather than a
  per-comment data slice, a collapsed view can cut a `commentGroupCard`
  (one ticket's own bordered card, header + comments) off mid-height when
  its comments straddle the visible/hidden boundary — an earlier group's
  header can end up invisible while its last comment(s) still show. Given
  "over de hele lijst heen" (across the whole list, not per group) was the
  explicit scope, and the fade + expand-hint already communicate "there's
  more", this was accepted as the simplest correct implementation rather than
  reflowing per-group boundaries around the fold.

Test: `tests/plan-comments.spec.mjs` ("the comments panel folds to the last
~2.5 comments" — collapsed-by-default, Enter/click-to-expand, the expand-hint
button, and a short list showing no hint at all).
- **Mouse**: a click on the panel's own background runs `selectCommentsRow()`
  — the same block-level selection a plain `→` already lands on
  (mouse-navigation.md rule 1). A click directly on one comment
  (`commentRow`'s own `@click`, `e.stopPropagation()` first so it doesn't also
  re-run the panel's own click) calls `enterCommentsFocus(id)` and jumps
  straight to it, focused — a mouse-only shortcut (rule 2), still reachable
  via `→` then `Enter` then `↓` in several keyboard steps. Every other
  interactive element inside the panel (the "Ververs" button, "Beantwoorden",
  the composer, a mention suggestion) is left exactly as it was; nothing there
  needed a `stopPropagation()` add, since bubbling into `selectCommentsRow()`
  only sets selection state and never fights with any of them.
- **The initial default-cursor race.** `clampCursor()` only defaults
  `state.cur` when the current value doesn't match any row at all, and it is
  called from `loadPlan()` (not from a `watch`, see that function's own doc
  comment on why). On a genuinely cold cache `GET /api/jira/comments` can cost
  several `acli` calls (`plan_comments.go`), so the very FIRST `loadPlan()`
  resolution can beat it and default the cursor onto the first question
  before the comments block even exists in `navRows()`. The page's own
  bootstrap therefore does `Promise.all([ensureTracker().then(loadPlan),
  loadComments()]).then(clampCursor)` — one extra, explicit `clampCursor()`
  call once BOTH initial reads have settled, deterministic regardless of
  which finished first. Harmless once the reviewer has genuinely navigated
  elsewhere: `clampCursor()` never moves a `state.cur` that is still found
  among the (now longer) row list.
- **Not reused for the reply composer/mention picker** — those stay exactly
  the mouse/typing surfaces they always were; only the READING/walking half
  of the panel gained a keyboard cursor.

Test: `tests/plan-comments.spec.mjs` ("→ selects the whole block first;
Enter walks the individual comments; ← leaves it" — mocks
`GET /api/jira/comments` directly at the HTTP layer with a real two-comment
fixture, since the Playwright harness's `Fake` Jira client always answers a
comment-less issue and this is a purely frontend nav-chain change). Verified
by hand against the real `PAYM-813` ticket too — screenshots
`task27-jira-comments-block-selected.png` (block-level ring, "blok
geselecteerd") and `task27-jira-comments-navigating.png` (the per-comment
ring, "opmerking actief", the block-level ring gone) in `data/review-shots/`.
The same file's "the comments panel folds to the last ~2.5 comments" describe
block covers the HEIGHT fold (task 48b) — see "Collapsed by default" above.
