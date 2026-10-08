# The QA page (`/qa/<pr>`) and the `qa_run` workflow

Claude tests a PR by hand in the locally running Plug&Pay stack (mostly the
admin) and writes a step-by-step QA report with explanations and screenshots.
The `/qa/<pr>` page shows that report one step at a time (like the example
artifact), and a comments dock sits at the bottom where the reviewer comments
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
  Claude pass an absolute `filename` into that dir, and asks for MANY of them
  (at least one per step with something visible in a browser, before/after).
  `qaRunDir` is **always absolute**: the server's data dir is the relative
  `"data"`, but Claude runs with the PR checkout as cwd, so a relative dir put
  every screenshot inside that checkout (PR 14116 round 1: 10 shots made, all
  dropped by the sanitizer, and staged in the plug-and-pay repo). Playwright runs with
  `--allow-unrestricted-file-access`, because without it an explicit filename
  resolves against the workspace root (the checkout).
- **The report:** the LAST ` ```json ` fence of the answer (`parseQAReport`).
  `sanitizeQAReport` bounds every field, normalizes the status to
  `ok|warn|fail|info`, and drops every image that is not a plain file name
  present in the run dir. An optional per-step `compare` (`before`/`after`,
  each a `mermaid` source and/or an `image` plus `caption`) goes through
  `sanitizeQACompare`: the image follows the same rules, a mermaid source over
  `qaMaxMermaid` (4000) is **dropped** rather than cut (a truncated diagram
  never parses), an empty side becomes nil. The prompt asks for a mermaid
  before/after step ("Wat verandert er") whenever the diff changes backend
  behaviour, and for a UI screenshot pair as `compare`. The report is the run's **recorded workflow
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

## The checkout guard (`qa_checkout_guard.go`)

Reviewer rule: *"qa mag geen bestanden toevoegen of aanpassen, behalve als je
het daarna weer terugzet"*. The prompt says so (`qa_run.md`, "Je voegt GEEN
bestanden toe…"), and `runQARun` enforces it, inside its Activity:

- right after the checkout is resolved, `snapshotQACheckout` records `HEAD`,
  the porcelain status (`--untracked-files=all`) and the content of every
  file that was already dirty (the user's own open work, ≤ 8 MB);
- a deferred `restoreQACheckout` (also after a cancel or failure, before the
  write slot is released) removes what the run added (untracked or staged
  new, plus the empty dirs it leaves), restores what it changed or deleted
  from `HEAD`, and puts a pre-existing dirty file it touched back to its
  snapshotted content. A pre-existing dirty directory/submodule (like
  `modules/Ai`) is never touched; a moved `HEAD` is reported, not reset;
- what was put back lands on the result (`restored`, `restoreNotes`) and as
  the first line(s) of the report's `deviations`. A round without a report
  shows it on its Overzicht (`qa-restored`).

Test: `qa_checkout_guard_test.go` (a temp git repo).

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

Nothing from `home.mjs`/`Block.mjs`. The comments dock **is the review tree's
own comment + Claude block** (`RelatedPanel.mjs`), not a copy — reviewer
request: *"is het eigenlijk ook niet handig als je de comment en chat blok
hergebruikt hierin, zodat alles features aanwezig zijn zoals afbeelding
uploading enzo"*. Also reused: `workDirOverlay.mjs`, `imageLightbox.mjs`,
`markdown.mjs`, `codeCopy.mjs`, `dictation.mjs`, `CommandMenu.mjs`,
`theme.mjs`, `settingsLink.mjs`, `urlState.mjs`.

### The stage: the artifact look

Reviewer request (round 2): *"laat de qa pagina veel meer lijken op de
artifact. gebruik mermaid diagrammen om voor en na situaties beter te
begrijpen als in de backend dingen zijn aangepast. je mag zelf komende vragen
beantwoorden wat het meest logisch zijn"* — reference screenshot
`data/review-shots/task8-qa-artifact-look.png`. The earlier columns that
continued to the right are gone (and with them the Enter "full height" toggle).

- **Header** (one line, wraps when needed): a back link to `/pr/<pr>`, the
  report's `kicker` + `title` (else the PR title), the **dot strip**
  (`qa-strip`/`qa-dot`: Overzicht + one dot per step, grouped by the report's
  group labels; each dot carries the status GLYPH and a title, the current one
  is filled and larger — never colour alone), the round buttons
  (`○`/`●` plus `loopt`/`mislukt`/`geen verslag`), `←` `n / N` `→`
  (`qa-prev`/`qa-counter`/`qa-next`), theme and settings.
- **The stage** (`<main data-testid=qa-stage>`, scrolls vertically) shows ONE
  page, always as a keyed array of one:
  - **Page 0, "Overzicht"** (`qa-overview`): the live progress while running
    (status line via `claudeStatusText`, the plan, the `[slash:qa-step]` list,
    Stop) or the run's error, then the summary, the **"Afwijkingen van de
    opdracht"** block (`qa-deviations`, `!` plus words), the scenario table,
    the step index, and the start card.
  - **A step** (`qa-step`): eyebrow · title · status chip (glyph + word) · a
    `⇄ Voor/na` chip when it has a `compare` · the comment count on one row,
    then one of three layouts (picked through a function binding in a stable
    `contents` wrapper, arrowjs-pitfalls.md):
    1. **compare** — `Voorheen` | `Nu` side by side (`qa-compare`,
       `qa-compare-side[data-side]`, the words carry the meaning), then the
       notes card (body, `pre`, table) and any extra screenshots. A missing
       `before` says "Bestond nog niet".
    2. **screenshots** — the artifact's two panes: notes left (26rem),
       evidence right (screenshots side by side, `pre`, table).
    3. **text only** — one notes card (max-w-4xl) with `pre` and table.
    Screenshots carry `data-md-image` inside a `.markdown-body`, so the shared
    lightbox opens them with ←/→ (the compare pair's two images cycle together).
  - **Mermaid** (`src/mermaidLoader.mjs`): `diagramHTML(src)` for an
    `.innerHTML` binding. The vendored bundle (`src/vendor/mermaid.min.js`, see
    `conventions.md`) is injected as a classic `<script>` only when a diagram
    is first shown. `securityLevel:'strict'`, `htmlLabels:false`, theme
    `dark`/`default` from `theme.pref` (cache key = mode + source, so a theme
    switch re-renders). Renders are serialized; a placeholder shows until the
    reactive `diagrams.tick` repaints. A source that does not parse shows
    "! Diagram kon niet getekend worden" plus the source (`qa-diagram-error`).
  - **Live progress per round:** the progress snapshot is PR-wide, so it shows
    only on the round whose `runId` it names.
  - **A round that just ended:** the snapshot flips to "not running" a moment
    before the run's result is recorded, so the reload it triggers can still
    read the round as running. The page reloads again 2s later and keeps
    polling while any round is `running` (it used to say "loopt" forever
    after a Stop).
- **Comments dock** (`qa-dock`, bottom), scoped to the shown step.
  - **What is mounted:** the same composition as the tree's
    `comments-and-related` column: `InlineComments` + `ClaudeChatPanel` in one
    `comment-claude-row`, `CommentClaudeFooter`, the shortcut bar and
    `CodePreviewPanel`, inside a `data-testid=detail-panel` wrapper
    (`exitRelated` only blurs a field inside that). They render against
    `rpState`, the tree's state shape reduced to what that block reads (the
    PR, one synthetic block so its "is there something to anchor on" guards
    pass, column widths). So everything the tree's block does works here:
    pasting/dragging images (also before the first turn), drafts, F5
    dictation, retry/"ook andere", cancel + cleanup choice, edit a message,
    queue/steer, question options, code previews with Kopieer, the "Andere
    chats in deze PR" footer, resolve/delete/edit, mentions and real names.
  - **The QA scope:** a watch pushes `setCommentScope({ qa: true, seg })` per
    step; `recomputeView` then shows the comments whose `seg` is
    `'qa:<runId>:<step>'` (step 0 = Overzicht). qa.mjs's `commentTarget()`
    returns a target with `qa: true`, `kind: 'issue'`, `gran: 'qa'`, that seg,
    `label` = `QA ronde R · stap N — titel`, `bodyPrefix` (that label in bold)
    and `context` (`stepContext()`). Three small `t.qa` branches in
    RelatedPanel use it: `placeComment` posts a PR-wide comment with the
    prefix (so a reader on GitHub knows which step), `ensureClaudeAnchorForNew`
    creates the local placeholder anchor as `kind:'issue'`, and
    `claudeContextBlock` sends the step as the first turn's invisible context.
    The label must stay stable: the placeholder is found again by
    `draftKeyFor` (file/label/gran/rows/seg). These comments also show in the
    review tree's comment index.
  - **Placing a comment:** Enter on the filled composer (or its "Plaats…"
    button) opens a QA-only menu: "Plaats op GitHub" or "Alleen voor mij"
    (`opts.local`). The tree removed its local option; the QA page keeps it.
    Like the tree, placing hands the keyboard back to the stage. A reply on
    a still-local thread opens the tree's own publish menu (GitHub only).
  - **Menus:** `CommandMenu.mjs` with the tree's own lists from
    `commentCommands.mjs` (see "The shared comment/Claude menus" in
    `command-palette.md`). `qaCommandHost`: after a resolve/delete/publish the
    keyboard stays in the dock, no Ignore item (no index here).
  - **Collapsed** to one bar (`qa-dock-bar`) exactly while RelatedPanel does
    not own the keyboard (`dockOpen() = relatedActive()`); the block stays
    mounted (it runs its own comment poll), only CSS-hidden. ↓ (or a click on
    the bar) opens it: the first open comment (`enterCommentsOrRelated`), or
    the new-comment composer with the Claude column next to it
    (`startComment`) on a step without comments. `/`/`c` open the composer.
  - **"Andere chats in deze PR":** `setClaudeTaskJump` jumps to a QA
    conversation's round/step and selects it; any other conversation opens in
    the review tree.
- **Keyboard:** the stage owns →/← (step) and ↑/↓ (scroll; ↓ at the bottom
  opens the dock). While the block owns the
  keyboard, `onKeydown` routes exactly like `home.mjs`'s relatedActive branch
  (`handleRelatedKey` for the arrows/Escape unless the caret can still move,
  via `editableKeys.mjs`; Enter opens the comment/Claude menu, sends the
  highlighted question option, toggles a code preview). Order: dictation,
  lightbox, werkmap overlay, the open menu, then the rest.
- **URL state:** `?round=<runId>` (omitted for the newest round) and `?step=`
  (omitted at 0), via `bindUrlState`; RelatedPanel adds its own `rel.*`
  cursor params, so a refresh lands on the same comment/turn.

## Endpoints

| Endpoint | What |
| --- | --- |
| `POST /api/workflows/qa_run` | `{pr, instructions?}` → `{runId, round}`. 409 while a round is running (in-memory snapshot or a `running` run in the store). |
| `GET /api/qa?pr=N` | read-only → `{ok, rounds:[{runId, round, status, instructions, createdAt, updatedAt, result?}], progress?}` |
| `GET /api/qa/image?pr=&run=&file=` | one screenshot. The run id must match `^[0-9a-f]{24}$` and the file `qaImageFileRe`, and the run must be a qa_run of that PR before anything is joined onto the data dir. |
| `POST /api/qa/cancel` | `{pr}`: in-memory cancel (`cancelChatTurn("qarun-<pr>")`), never a Signal. Same reasoning as `/api/test-run/cancel`. |

## Tests

- `qa_run_test.go`: the last-fence parse, sanitizing (images that are missing
  or carry a path are dropped), the before/after `compare` bounds, the MCP config being valid JSON with both
  servers, and the image endpoint refusing unsafe paths.
- `tests/qa-page.spec.mjs` (mocked `/api/qa`): the deviations block on page 1,
  → to the next step, a local comment ("Alleen voor mij") landing on its own
  step only with the tree's comment menu, the step surviving a refresh, the
  lazy local anchor of a first Claude turn carrying the step context plus the
  tree's Claude menu, the collapsed dock, and the dot strip/←→ buttons plus a
  `compare` step rendering two mermaid SVGs (and a broken diagram's message).

**Not covered by an automated test:** a real end-to-end QA run (a live Opus
run against the local admin).
