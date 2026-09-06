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

`src/plan.mjs` imports **nothing** from `home.mjs`/`Block.mjs`/
`RelatedPanel.mjs` — those carry the whole review-tree state (comment cursors,
url-state bindings, watches) and none of it applies here. It reuses only the
shared **page-level** utilities every page already uses (`theme.mjs`,
`i18n.mjs`, `markdown.mjs`, `urlState.mjs`, `workflowLabels.mjs`,
`settingsLink.mjs`) plus the vendored Prism, and it repeats the tree's *shape*
(a horizontally scrolling column flow, a card per column, one column owning the
keyboard) in ~700 lines of its own. The one thing the request called "een beetje
hergebruiken" is the **first column**: the same two-card stack as the review
tree's PR-info column — the ticket on top, the running workflow tasks below it —
rebuilt rather than imported.

## The columns

1. **The ticket** (`plan-info-column`, `w-[34rem]`) — key, title, a link to the
   issue in Jira, the description as Markdown (`renderMarkdown`), plus the
   back-link/theme/settings row. Below it, as its own `shrink-0` card, the
   **"Taken"** list: the workflow runs of THIS ticket, from
   `GET /api/workflows?plan=KEY` (a `plan wordt opgesteld…` chip while one is
   running). Explicitly not every running run repo-wide — only what belongs to
   this plan.
2. **The questions** (`plan-questions-column`, `w-[31rem]`) — or, while the
   scope question stands, ONLY that question (see "Subtask and main task"
   below) — one card per
   question, every option a row with a `●`/`○` glyph plus the word "gekozen"
   (never colour alone, per the colourblind rule) **and its own free-text
   field**. Underneath, in the same scrolling column, **"Wat er moet
   gebeuren"**: the task list, each task with its explanation, and as the
   **last row of the whole index** the action that runs the plan (see "The last
   action" below).
3. **The example code** (`plan-block-column`, `w-[40rem]`, `data-level=0`) — the
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


## Bug and hotfix: which branch does this go out from?

Reviewer request, verbatim: *"is het een bug, vraag dan eerst of het een hotfix
is vanuit master of niet"*, followed by *"Het kan namelijk ook vanaf een andere
branche zijn, 3e keuze moet een drop down zijn waarbij eigen branches bovenaan
staan, met search input"*.

A **bug** is asked one more thing before anything is generated — the second
gate, straight after the scope question, so only ever one of the two is on
screen:

- **The trigger is the ticket's own issue type.** `modules/jira`'s `Issue` now
  also asks for `issuetype` (`--fields …,issuetype`) — it previously only came
  back from `Search`, so a plan page could not tell a bug from a story — and
  `planLoadIssue` carries it onto the document as `issueType`. `planIsBug`
  matches the lowercased name *containing* "bug", so "Bug", "Bugfix" and a
  renamed "Bug (productie)" all count.
- **The gate sits in the WORKFLOW**, exactly like the scope gate and for the
  same two reasons: `planGenerate` is a minutes-long Claude call that must not
  be paid before the answer is in, and the answer changes what the plan should
  *contain* — a hotfix goes straight to production, so `planPrompt` (and
  `planExecutePrompt`) tell the model to keep it small and risk-free, no
  refactor and no meeliftende verbeteringen. The tracker saves the document
  with `needsHotfix:true` plus the two named branches (`defaultBranch`,
  `hotfixBranch`) and parks on the **`plan_hotfix`** Signal.
- **Three choices** (`navRows()` returns exactly those while `needsHotfix()`
  holds, `data-testid=plan-hotfix-option`, `data-hotfix-target=yes|no|other`):
  "Ja, hotfix — master", "Nee, gewoon — develop", and "Vanaf een andere
  branch…". Glyph plus a word, never a colour on its own.
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
- **An Execution started before this gate existed replays past it untouched**:
  its recorded `planLoadIssue` result carries no `issueType`, so `planIsBug` is
  false and no new `WaitSignal` is ever reached
  (`.claude/rules/workflow-determinism.md`).

## Keyboard

`←`/`→` move between columns (`state.col`: 0 = ticket, 1 = questions, 2 + n =
the n-th block column); `←` on the ticket column leaves to `/pr-overview`.
`↑`/`↓` move the cursor within the focused column — in column 2 over **one flat
list** of every option of every question followed by every task, so `↓` walks
from the last option straight into the task list exactly as the column reads.
`Enter`/`Space` on an option chooses it (with whatever is typed in its field);
on a gate row (scope or hotfix) it answers that question — the hotfix
question's third row only unfolds its branch dropdown, whose own search field
owns the keyboard while it is focused;
on the last row (the execute action) it arms and then starts the execution;
in a block column it drills. A keydown while an input has focus is left alone
(`Escape` blurs it), and `Enter` inside the field answers with that text.

Which column owns the keyboard is spelled out **in words** in its header
(`◆ actief`, `data-testid=column-active`), never by a colour alone.

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
    so every claim counts as somebody else's).
  - **Nothing usable → a reviewer-facing note, never a worktree fallback**
    (`checkoutDiscovery.reason()`, or "configure `chatCheckoutDirs` / clone one").
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
2. `planGenerate` (mode `all`) — ONE Sonnet call, context-only (no tools),
   answering with one JSON object: the questions with their options and example
   blocks, plus the task list. Ids (`q1`, `q1o2`, `t3`) are assigned **on our
   side** from the position in the answer — a model reproduces "the second
   option" reliably and an identifier not at all, and the reviewer's stored
   answers hang off those ids. Caps: `maxPlanQuestions`/`maxPlanOptions`/
   `maxPlanTasks`.
3. `planSave` — the whole document into `modules/plan`.
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
| `GET /api/plan?key=KEY` | read-only → `{ok, key, doc, runs, generating, exec?}` (`exec` = the newest `plan_execute` attempt of this ticket). An unknown ticket answers ok with an empty document, never an error. |
| `POST /api/workflows/plan` | `{key}` → `{runId}`; starts or idempotently reuses the tracker. |
| `POST /api/workflows/plan_execute` | `{key}` → `{runId}`; the index's last action — implement the plan on a fresh branch and open a draft PR. 409 while one is already running. |
| `POST /api/workflows/{runID}/signals/plan_answer` | `{questionId, optionId, text}` — one answer. |
| `GET /api/branches` | read-only → `{ok, branches:[{name, own, updated}]}` — the primary repo's remote branches, the reviewer's own first, for the hotfix question's dropdown. |
| `POST /api/workflows/{runID}/signals/plan_hotfix` | `{hotfix, branch?}` — a bug's base branch: the hotfix branch, the ordinary one, or a branch picked from the dropdown (validated against the ref allow-list). |
| `POST /api/workflows/{runID}/signals/plan_scope` | `{choice:"parent"}` — plan the main task itself; anything else is rejected (a subtask choice is plain navigation, not a Signal). |
| `GET /api/workflows?plan=KEY` | the ticket's own runs (the same read as `?pr=N`, filtered on the input's `key` instead — so a later per-ticket workflow lands in the "Taken" card for free). |

## Accepted gaps (deliberate, don't "fix" by accident)

- **A plan execution has no per-task live progress** — only the run's own
  status (via the "Taken" card and the `exec` field) and, at the end, the draft
  PR or a short note. Deliberately no `test_run`-style marker/progress
  plumbing: the run is one agentic pass, not a list of known items.
- **The agentic run is bounded by the module's own `agenticTimeout`** (10
  minutes, `modules/claude`) — the same ceiling every other agentic workflow
  has. A plan too big for that lands whatever it got to; the PR is a draft
  precisely because the result still needs a human.
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
- **No Jira update.** Executing the plan does not transition the ticket.
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

Tests: `plan_workflow_test.go` (id numbering + caps, junk rejected, the
hotfix gate's two pure decisions — `planIsBug` on every issue-type spelling and
`resolvePlanBase`/`planBaseBranch` on all three choices including a branch git
would read as a flag — the hotfix constraint reaching both prompts, and
`parseBranchRefs` putting the reviewer's own branches first while dropping
`origin/HEAD`, the
per-question answer fold, the regenerate prompt carrying the fixed choices, a
nested block's note surviving the trim at every level, the parent/subtask
context in the prompt),
`modules/jira/jira_test.go` (the `parent`/`subtasks` payload shape, and
`issuetype` reaching `Issue.Type`),
`plan_execute_test.go` (the branch name stays git-safe and bounded, the
execute prompt carries the fixed choices and every task's nested example code
capped per block, the PR URL parsed off `gh`'s stdout, and — against
`chat_checkout_test.go`'s own throwaway repo fixtures — that
`resolvePlanWorkDir` picks a clean registered checkout on the base branch,
refuses a dirty one by name, and leaves a directory another PR claims alone) and
`modules/plan/plan_test.go` (the document round trip). Verified in the running
app; screenshots in `data/review-shots/plan-page.png` (a chosen option with two
block columns open) `plan-page-tasks.png` (the task list with its own
nested block column), `plan-scope-question.png` (a main task asking which of its
six subtasks — or itself — is being planned) `plan-subtask-parent.png` (a
subtask's plan, with the main task linked in the first column),
`plan-hotfix-question.png` (a bug being asked which branch it goes out from)
and `plan-hotfix-branch-dropdown.png` (its third choice unfolded: the search
field with the reviewer's own branches on top).
