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

## Follow-up questions: sharpening the plan further

Reviewer request, verbatim: *"maak het mogelijk om vervolg vragen te genereren
om je plan te perfectioneren"*.

The index's flat nav list gets one more kind of row between the questions and
"Wat er moet gebeuren": **`FOLLOWUP_ROW_ID = 'followup'`**
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

## Enter on the ticket column opens a small menu

Reviewer request, verbatim: *"enter op pr description blok moet een menu
geven om bijvoorbeeld jira ticket te kunnen openen"*. `Enter` on column 0 (the
ticket) opens `CommandMenu.mjs` — the exact review-tree component reused
as-is (see command-palette.md) — with a tiny, fixed, submenu-less list
(`PLAN_COMMANDS`): "Open in Jira" (`state.doc.url`, falling back to
`JIRA_BASE + state.key` before the document has loaded) and "Terug naar
overzicht". Deliberately not `PR_COMMANDS`' full menu: this page has no
GitHub PR yet, no approve/review actions, nothing that menu offers beyond
those two.

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
  (`m.claude.Run`, no tools, plain prose — never JSON, unlike
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
  `ClaudeChat.mjs`'s file header. Every field the tree's richer engine needs
  (streaming `progress`, `retryAllBusy`, `queued`, scroll-pinning, …) is
  stubbed to its inert value on purpose: this page's chat is a single
  blocking call per message, never an agentic multi-tool turn, so nothing in
  `claudeChatColumn`'s template ever tries to render a control this page
  cannot back (no retry ladder, no cancel, no werkmap). `openPlanChat`/
  `closePlanChat` (`state.chatOpen`) gate a fullscreen overlay
  (`planChatOverlay`) that mirrors the tree's own `generalChatOverlay.mjs`
  shape (backdrop click / Escape closes it) — ephemeral, not in the URL or
  `localStorage`, exactly like that overlay. `/` always opens it, from any
  column, mirroring the tree's own "`/` always opens the PR menu" rule; mouse
  entry point: `plan-chat-button` in `ticketCard`'s "Weergave" row.
- **Accepted gap**: no streaming, no cancel, no retry, no werkmap/code-edit
  capability — this chat can only talk, never touch code (that is what "Plan
  uitvoeren" is for). A hiccup (`SLASH_CLAUDE=off`, or the CLI erroring) still
  appends a fixed assistant line saying so, rather than leaving the
  reviewer's own message answered by nothing.

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

### Choosing an option focuses its own input; Enter there jumps to the next question

Reviewer request, verbatim: *"als ik een antwoord selecteer binnen een vraag,
moet de input gelijk actief zijn zodat ik kan typen. als ik enter druk, moet
ik gelijk naar de volgende vraag springen."* Two-step flow:

1. `Enter` on an option row (`onKeydown`, `state.col===1 && kind==='option'`)
   calls `sendAnswer` as before, then `focusOptionInput(optionId)` — a
   `requestAnimationFrame`-deferred `querySelector` + `.focus()` + `.select()`
   on that option's own `data-testid=plan-option-input` field, so the reviewer
   can start typing immediately instead of needing an extra click/Tab.
2. `Enter` inside that field still saves the typed text (`sendAnswer`) and
   blurs, but now also calls `advanceToNextQuestion()` — `moveRow`'s sibling
   that walks `navRows()` forward past every remaining row that still shares
   the current option's `q.id`, landing on the next QUESTION's first option
   (or the follow-up/task/execute row at the end of the list) instead of the
   next option of the SAME question `moveRow(1)` would give.

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
2. `planGenerate` (mode `all`) — ONE Sonnet call, context-only (no tools),
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
| `POST /api/workflows/{runID}/signals/plan_answer` | `{questionId, optionId, text}` — one answer; `{kind:"followup"}` — generate follow-up questions and rebuild the task list; or `{kind:"chat", text}` — one general-chat message (the only shapes allowed without a `questionId`). |
| `GET /api/branches` | read-only → `{ok, branches:[{name, own, updated}]}` — the primary repo's remote branches, the reviewer's own first, for the hotfix question's dropdown. |
| `POST /api/workflows/{runID}/signals/plan_hotfix` | `{hotfix, branch?}` — a bug's base branch: the hotfix branch, the ordinary one, or a branch picked from the dropdown (validated against the ref allow-list); or `{kind:"chat", text}` — a chat message while this gate stands (see "The general chat" above). |
| `POST /api/workflows/{runID}/signals/plan_scope` | `{choice:"parent"}` — plan the main task itself (a subtask choice is plain navigation, not a Signal); or `{kind:"chat", text}` — a chat message while this gate stands. |
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
- **A plan cannot be re-executed onto the same branch** (see above): once its
  draft PR is open, a new attempt is skipped with a note instead of moving the
  branch. Genuinely wanting a fresh run means closing that PR (or renaming the
  ticket, which changes the branch name).
- **The plan's werkmap is only claimed against other PRs once the draft PR
  exists.** While an execution is still running there is no PR number to claim
  under, so the guarantee during the run is the per-directory write slot, plus
  the fact that a directory on the plan branch is never offered to another
  PR's chat automatically.
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

Tests: `plan_workflow_test.go` (id numbering + caps, junk rejected, the
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
own instruction — and is `state.col`/keyboard-nav-agnostic: it is not part of
`navRows()`/the cursor chain, only a scrolling card above it, since replying
is a mouse/typing action, not something to walk with ↑/↓. It does NOT reuse
the review tree's `BlockList.mjs` component (that component carries the whole
review-tree's block/approval model); the panel is its own small set of
functions (`commentGroupCard`, `commentRow`, `commentReplyComposer`,
`commentMentionPicker`) built the same way every other card on this page is,
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
