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
2. **The questions** (`plan-questions-column`, `w-[31rem]`) — one card per
   question, every option a row with a `●`/`○` glyph plus the word "gekozen"
   (never colour alone, per the colourblind rule) **and its own free-text
   field**. Underneath, in the same scrolling column, **"Wat er moet
   gebeuren"**: the task list, each task with its explanation.
3. **The example code** (`plan-block-column`, `w-[40rem]`, `data-level=0`) — the
   blocks of whatever the cursor is on (an option or a task): a card per block
   with a file/label/language header, an optional note, and Prism-highlighted
   code.
4. **… and one more column per nesting level.** A block with `children` shows a
   `N onderliggende blokken →` button; `→` (or a click on it) opens those
   children as their **own** column to the right, arbitrarily deep — the
   requested "meer dan 3 kolommen voor diepere onderliggende code". Same
   drill-shaped navigation as the review tree's Underlying-code columns, but its
   own implementation: `state.path` holds one cursor index per open block
   column, so its **length IS the number of block columns**.

## Keyboard

`←`/`→` move between columns (`state.col`: 0 = ticket, 1 = questions, 2 + n =
the n-th block column); `←` on the ticket column leaves to `/pr-overview`.
`↑`/`↓` move the cursor within the focused column — in column 2 over **one flat
list** of every option of every question followed by every task, so `↓` walks
from the last option straight into the task list exactly as the column reads.
`Enter`/`Space` on an option chooses it (with whatever is typed in its field);
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
| `GET /api/plan?key=KEY` | read-only → `{ok, key, doc, runs, generating}`. An unknown ticket answers ok with an empty document, never an error. |
| `POST /api/workflows/plan` | `{key}` → `{runId}`; starts or idempotently reuses the tracker. |
| `POST /api/workflows/{runID}/signals/plan_answer` | `{questionId, optionId, text}` — one answer. |
| `GET /api/workflows?plan=KEY` | the ticket's own runs (the same read as `?pr=N`, filtered on the input's `key` instead — so a later per-ticket workflow lands in the "Taken" card for free). |

## Accepted gaps (deliberate, don't "fix" by accident)

- **The plan is not turned into anything else yet** — no commit, no PR, no Jira
  update. Answering sharpens the task list; acting on it is still the reviewer's
  own job.
- **Whether the model nests its blocks is up to the model.** The prompt asks for
  it explicitly and the UI supports any depth, but a small ticket legitimately
  comes back one level deep.
- **A language the vendored Prism doesn't carry** (e.g. `markdown`) renders as
  escaped plain text with the language word still in the header — the same
  fallback as a fenced block in a comment (`.claude/rules/conventions.md`).

Tests: `plan_workflow_test.go` (id numbering + caps, junk rejected, the
per-question answer fold, the regenerate prompt carrying the fixed choices) and
`modules/plan/plan_test.go` (the document round trip). Verified in the running
app; screenshots in `data/review-shots/plan-page.png` (a chosen option with two
block columns open) and `plan-page-tasks.png` (the task list with its own
nested block column).
