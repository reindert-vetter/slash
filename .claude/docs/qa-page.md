# The QA page (`/qa/<pr>`) and the `qa_run` workflow

Claude tests a PR by hand in the locally running Plug&Pay stack (mostly the
admin) and writes a step-by-step QA report with explanations and screenshots.
The `/qa/<pr>` page shows that report: the steps are columns that continue to
the right, and a comments dock sits at the bottom where the reviewer comments
on a step and chats with Claude about it, the same way as in the review tree.

Reviewer request, verbatim: *"ik wil net als deze artifact een pr kunnen laten
testen in de admin. met uitleg en screenshots enzo. ook moet ik daar een
comment kunnen plaatsen en chat kunnen starten zoals we in een tree doen. maak
hiervoor een totaal losse pagina die je vanaf pr-tree en pr-overview kan
genereren/openen. comments blok mag je ondering plaatsen, naar rechts moet
verder gaan in elke stap."* The example was a claude.ai artifact
("QA BUG-5341 gepauzeerde herinneringen", PR #13982). It was a step viewer:
an overview with a scenario table, then steps grouped as setup / round 1 /
round 2 / findings, each step with a notes card (eyebrow, title, status chip,
body) and evidence (screenshots, `pre`, a table).

The reviewer's answers to the plan questions:

1. **Which local stack:** the same checkout choice a chat edit uses: the
   directory where the PR branch is checked out (`prepareChatShellWorkDir`).
   If that is ambiguous, the reviewer is asked, through the same werkmap
   overlay.
2. **Browser:** Playwright MCP plus laravel-boost MCP, only for `qa_run`.
3. **What Claude may do:** whatever the example artifact did (Nova actions,
   artisan, DB updates, simulating time, queue workers). No code edits, no
   `.env` edits, no `migrate:fresh`/reseed. Whenever Claude does something
   different from what was intended, the report says so on the first page
   (`deviations`).
4. **Scenarios:** Claude derives them itself from the Jira ticket, its QA
   subtask, the GitHub diff and the PR description. The reviewer can add
   instructions before a round starts.
5. **Rounds:** each run is a new round on the same page. The next round gets
   the previous report as context.

## Pieces

| Piece | Where |
| --- | --- |
| Page shell | `qa.html` (copy of `plan.html`'s head: anti-flash, Tailwind, Prism/markdown CSS) → `src/qa.mjs` |
| Route | `api.go`: `/qa/` → `qa.html`. A path without a number → `location.replace('/pr-overview')`. |
| Workflow | `qa_run` (`qa_run.go`): one Activity, `runQARun`. Signal-less, `PriorityLow`, started with `StartWorkflowDeferLow`. |
| Prompt | `modules/claude/prompts/qa_run.md` (`claude.QARunSystemPrompt`) |
| Live progress | `qa_run_progress.go`: in-memory per PR, SSE `qa.progress` |
| Endpoints | `qa_api.go` (table below) |
| Entry points | `/`-menu item `pr-qa` "QA-test in admin" (`PR_COMMANDS`, `home.mjs`); popover item `open-qa` (`qaAction`, `overview.mjs`). Both only navigate to `/qa/<pr>`. A round is started on that page itself. Primary repo only. |

## The run (`runQARun`)

- **Checkout:** the same `acquireCheckoutWriteSlot` + `prepareChatShellWorkDir`
  as `test_run`. The difference: when the PR's werkmap choice is open, the run
  **releases the write slot** (the answer's own chat_merge Activity needs that
  slot, so holding it would deadlock) and sets `WaitingChoice`. It then waits,
  polling `checkoutChoiceOpen` every 2s for at most `qaChoiceWait` (30 min).
  Once the choice is answered, it resolves the checkout again. The page mounts
  `workDirOverlay.mjs` unchanged, with its own `sendCheckoutAction` (the same
  chat_merge `merge` Signal as the tree's checkout chip), so the question is
  asked here exactly as in the tree.
- **The claude call:** Opus, `RunChat` with `Read/Grep/Glob/Bash` +
  `mcp__playwright` + `mcp__laravel-boost`, **no Edit**. `MCPConfig` is
  `qaMCPConfig(runDir)`. The idle timeout is 20 min, heartbeat-based.
  `AddDirs` holds the screenshot dir.
- **Screenshots:** `data/qa/<pr>/<runID>/` (gitignored). The prompt makes
  Claude pass an absolute `filename` into that dir. Playwright runs with
  `--allow-unrestricted-file-access`, because without it an explicit filename
  resolves against the workspace root (the checkout).
- **The report:** the LAST ` ```json ` fence of the answer (`parseQAReport`).
  `sanitizeQAReport` bounds every field, normalizes the status to
  `ok|warn|fail|info`, and drops every image that is not a plain file name
  present in the run dir. The report is the run's **recorded workflow
  result**. There is no module and no read model: `GET /api/qa` reads the
  tembed store (`engine.Runs()` + `Input` + `Result`).
- **Determinism:** the round number and the previous round's run id are
  computed by the handler and travel in the input. The body is one Activity
  with no branching.
- **Restart:** an interrupted run re-executes its Activity on Recover, which
  means the whole QA run starts again from the beginning (accepted).
- **Cleanup:** the runs go with `deletePRWorkflowRuns`, and the screenshot dir
  with `removeQAArtifactsForPR`, inside the existing `purgePR` Activity (no new
  step in the cleanup history).

## The MCP exception (reviewer-approved, don't "fix" back)

`modules/claude` used to never load an MCP server: `coldStartArgs` passes
`--strict-mcp-config` on every call. `RunRequest.MCPConfig` adds
`--mcp-config <json>` for **qa_run only**. Together with
`--strict-mcp-config`, that call loads exactly these two servers:

- `playwright`: `npx -y @playwright/mcp@latest --headless --isolated
  --ignore-https-errors --allow-unrestricted-file-access --test-id-attribute
  data-test --viewport-size 1440x900 --output-dir <runDir>`
- `laravel-boost`: `docker compose exec -T php php artisan boost:mcp`. It runs
  in the CLI's cwd (the werkmap), so it only works while that directory's
  stack is running.

`mcp__*` names go into `--allowedTools` but are kept out of `--tools`
(`agenticToolUniverse`). `--tools` only knows built-in tools, and MCP tools
load regardless of it (verified with a manual `claude -p` run). `npx` fetches
the Playwright MCP package at runtime. That is a tool the CLI starts, not a Go
or npm dependency of slash.

Like the chat shell carve-out in `.claude/rules/workflows-write-boundary.md`,
the run's side effects in the local stack (Nova actions, DB updates, artisan)
are not recorded one by one. Only the report is.

## The page (`src/qa.mjs`)

Like `plan.mjs`, this is its own code: nothing from `home.mjs`/`Block.mjs`.
It reuses `claudeChatColumn` (fed by a small chat engine of its own, the same
shape as `plan.mjs`'s `chatView`/`chatCallbacks`), `workDirOverlay.mjs`,
`imageLightbox.mjs`, `markdown.mjs`, `theme.mjs`, `settingsLink.mjs` and
`urlState.mjs`.

- **Header:** a back link to `/pr/<pr>`, the PR title, one button per round
  (`○`/`●` plus a word: `loopt`, `mislukt`, `geen verslag`), a `n / N` counter,
  and the theme and settings buttons.
- **Columns** (`qa-columns`, horizontally scrolling):
  - **Column 0, "Overzicht"** (`qa-overview`): the live progress while running
    (status line via `claudeStatusText`, the plan, the `[slash:qa-step]` list,
    Stop) or the run's error, then the summary, the **"Afwijkingen van de
    opdracht"** block (`qa-deviations`, `!` plus words, never colour alone),
    the scenario table, the step index, and the start card (instructions +
    "Start QA-test" / "Start nieuwe ronde").
  - **Then one column per step** (`qa-step`, `w-[44rem]`): eyebrow, title,
    status chip (glyph + word), body (markdown), `pre`, table, screenshots.
    The images carry `data-md-image` inside a `.markdown-body`, so the shared
    lightbox opens them with ←/→.
  - **Live progress per round:** the progress snapshot is PR-wide, so it shows
    only on the round whose `runId` it names.
- **Comments dock** (`qa-dock`, bottom, 36vh), scoped to the focused column:
  - **Comments:** PR-wide comments (`kind:'issue'`) through the tree's own
    `task_code_comment` workflow, with `gran:'qa'`, `seg:'qa:<runId>:<step>'`
    (step 0 = Overzicht) and a body prefixed with
    `**QA ronde R · stap N — titel**`, so a reader on GitHub knows what it is
    about. "Plaats op GitHub" (Cmd+Enter) or "Alleen voor mij" (local). These
    comments also show in the review tree's comment index.
  - **Chat:** a click or Enter on a comment opens the `claude_chat`
    conversation anchored on it (`POST /api/workflows/claude_chat`, the
    `message` Signal, the `chat.progress`/`chat.message` SSE). Its **first**
    turn carries the step as invisible `context`.
- **Keyboard:**
  - **Columns:** →/← change step, ↓ enters the dock, `/` or `c` focuses the
    composer.
  - **Dock:** ↑/↓ walk the comments (↑ from the top goes back to the columns),
    Enter opens the chat on a comment (or focuses the composer), Escape closes
    the chat or leaves the dock.
  - **Order:** the lightbox and the werkmap overlay get the keyboard first.
- **URL state:** `?round=<runId>` (omitted for the newest round) and `?step=`
  (omitted at 0), via `bindUrlState`.

## Endpoints

| Endpoint | What |
| --- | --- |
| `POST /api/workflows/qa_run` | `{pr, instructions?}` → `{runId, round}`. 409 while a round is running (in-memory snapshot or a `running` run in the store). |
| `GET /api/qa?pr=N` | read-only → `{ok, rounds:[{runId, round, status, instructions, createdAt, updatedAt, result?}], progress?}` |
| `GET /api/qa/image?pr=&run=&file=` | one screenshot. The run id must match `^[0-9a-f]{24}$` and the file `qaImageFileRe`, and the run must be a qa_run of that PR before anything is joined onto the data dir. |
| `POST /api/qa/cancel` | `{pr}`: in-memory cancel (`cancelChatTurn("qarun-<pr>")`), never a Signal. Same reasoning as `/api/test-run/cancel`. |

## Tests

- `qa_run_test.go`: the last-fence parse, sanitizing (images that are missing
  or carry a path are dropped), the MCP config being valid JSON with both
  servers, and the image endpoint refusing unsafe paths.
- `tests/qa-page.spec.mjs` (mocked `/api/qa`): the deviations block on page 1,
  → to the next column, a local comment landing on its own step only, and the
  step surviving a refresh.

**Not covered by an automated test:** a real end-to-end QA run (a live Opus
run against the local admin).
