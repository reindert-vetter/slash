# HTTP endpoints around the workflow engine

Companion to `.claude/rules/tembed-workflows.md` (what each workflow *does*);
this file is the endpoint surface. The hard rule from
`.claude/rules/workflows-write-boundary.md` shapes it: **writing is only
possible by starting an Execution or sending a Signal** — every other endpoint
is a `GET` over a read model.

Handlers live in `tasks_api.go` (workflow + read models) and `api.go`
(blocks/code/ingest). Page routes and the inbox/overview endpoints are in
`.claude/rules/pages-and-routing.md`.

## Starting an Execution (the write path)

One handler per Workflow Type, all `POST /api/workflows/<type>`. A **long-lived
tracker** (pr_status, approve, task_snooze, task_inbox) is *ensured*: the
handler reuses the existing Execution for that PR/repo and returns its Run ID,
which the UI then signals. A **one-shot** type runs synchronously to completion
(no `WaitSignal` in its body) and returns its result or an error.

| Endpoint | Body | Kind | Notes |
|---|---|---|---|
| `/api/workflows/task_code_comment` | `CodeCommentInput` | one per comment | Run ID == the comment id. |
| `/api/workflows/pr_status` | `{pr}` | tracker | Returns as soon as stage 1 (basics) is recorded — the summary/statuses drain in the background (`StartWorkflowDeferLow`). |
| `/api/workflows/approve` | `{pr}` | tracker | Returns `runId`; the UI signals `set`. |
| `/api/workflows/task_snooze` | — | tracker (per repo) | Returns `runId`; the UI signals `snooze`. |
| `/api/workflows/task_inbox` | — | tracker (per repo) | Only re-ensures when no Run ID exists yet (ensuring spawns a poller goroutine). |
| `/api/workflows/resolve_call` | `{pr, callerId, callerFile, callerClass, callerName, calls}` | one-shot | Idempotent Run ID per request. |
| `/api/workflows/resolve_test_covers` | `{pr, testId, testFile, testClass, testName, classes}` | one-shot | |
| `/api/workflows/explain_code` | `{pr, blockId, file, label, gran, unitKey, codeHash, code, context}` | one-shot | Idempotent Run ID (`explainRunID`). |
| `/api/workflows/code_warning` | `{pr}` | one-shot | Manual "Diepgravend onderzoek"; re-running supersedes. |
| `/api/workflows/submit_review` | `{pr, event, body}` | one-shot | 400 on invalid input *before* any `gh` call (`validateSubmitReview`; a `REQUEST_CHANGES` needs a body), 502 if the submit itself fails. |
| `/api/workflows/ready_for_review` | `{pr, reviewers?}` | one-shot | 400 on a non-positive pr or invalid login (`validateReadyForReview`, which also trims+dedups). |
| `/api/workflows/cleanup` | — | one-shot | Never accepts a body: the retention cutoff is always server-side. Force-purging specific PRs is CLI-only (`slash cleanup -force`). |
| `/api/ingest` | `{pr}` | one-shot | Starts the `ingest` workflow and then `EnsureRelations`; 200 only once both finished. See `.claude/rules/blocks-and-ingest.md`. |

**Adding a signal-less type also means adding its name to the reserved-name
guard** in `handleWorkflows` (`tasks_api.go`) — that handler owns
`/api/workflows/`, so without the guard `/api/workflows/<newtype>` would be
parsed as a Run ID.

## Signals

All through one generic route, `POST /api/workflows/{runID}/signals/<name>`.
A workflow can only `WaitSignal` on one name at a time, so several distinct
requests deliberately ride along **as variants of one signal payload** rather
than as their own signal names.

| Signal | Payload | Target | Variants riding along |
|---|---|---|---|
| `reply` | `{author, body, done}` | `task_code_comment` | `body == "/resolve"` + `done` = resolve (never posted as text). |
| `delete` | `{author?}` | `task_code_comment` | Handler builds a `ReactionSignal{Action:"delete"}` — i.e. it *is* the reply signal underneath. |
| `set` | `ApprovalSignal{blockId, rows, calls}` | `approve` | `{file, viewed}` instead = GitHub "Viewed" checkbox (`Viewed != nil`). |
| `snooze` | `{taskId, until}` or `{taskId, clear}` | `task_snooze` | `until` is an absolute ms expiry computed client-side (keeps the workflow clock-free). |
| `refresh` | — | `pr_inbox` / `task_inbox` | |
| `rebuild` | — | `build_relations` | |

**Not reachable from the UI, by design:** the `reanchor` and `avatar` actions
on `ReactionSignal` — the generic reply handler decodes only
`author`/`body`/`done` and drops `action`/`anchor`, so only a backend Activity
can move a comment's anchor. A Playwright spec therefore can't drive that state
through the API; use `slash seed -comments <json>`.

`state` (pr_status) has no endpoint at all — it comes from the pollers only.

## Operational (stateless, allowed outside a workflow)

| Endpoint | Does |
|---|---|
| `POST /api/workflows/{runID}/heartbeat` | Marks a run as actively viewed → fast poll cadence. In-memory only, lost on restart. |
| `GET /api/ingest/progress?pr=N` | In-memory ingest stage (`worktrees`/`scan`/`relations`) for the generate button. |

Both are carve-outs from the write boundary because they touch nothing durable
— see `.claude/rules/workflows-write-boundary.md`.

## Read models

| Endpoint | Reads |
|---|---|
| `GET /api/workflows/{runID}` | Run status. |
| `GET /api/workflows?pr=N` | **All** runs of that PR (no trailing slash, so a different pattern than `/api/workflows/`): `RunsForPR` filters `engine.Runs()` on the `pr` field of each run's stored input — a per-repo tracker has no such field and therefore never appears. Newest-updated first. A `task_code_comment` run also carries a `comment` ref (`{file,label,gran,line,rowStart,rowEnd,snippet}`, parsed back out of its own immutable input) and a `code_warning` run a `warningsFound` count (from its stored result). Feeds the "Taken" card. |
| `GET /api/comments?pr=N` \| `?path=<prefix>` | Comments + reactions; the `path` form is the hierarchical prefix search (see `.claude/rules/tembed-workflows.md`). |
| `GET /api/approvals?pr=N` | Approved rows/call segments per block. |
| `GET /api/relations?pr=N` | Parent→child block relations. |
| `GET /api/callresolve?pr=N` | Resolved/searching call targets incl. their embedded code. |
| `GET /api/testcovers?pr=N` | Test↔method coverage rows. |
| `GET /api/explanations?pr=N` | Footer AI descriptions. |
| `GET /api/pr?pr=N` | `prmeta` (title/url/body/author/diffstat/headRef/summary/jira*/reviewDecision/checks*/reviewers). `{ok:false}` until stage 1 ran; a field of a not-yet-run stage is at its zero value. |
| `GET /api/tasks` | Task-inbox read model. |
| `GET /api/tasksnoozes` | `{taskId, until}` — expiry is checked client-side, `List` does not filter. |
| `GET /api/problems` | `{failedRuns, logErrors}` — failed runs (repo-wide) + mirrored glue log lines. |
| `GET /api/me` | The authenticated GitHub user (`gh api user`, cached for the process lifetime). |
| `GET /api/names?logins=a,b` | Login → real name + avatar. See `.claude/rules/pages-and-routing.md`. |
| `GET /api/reviewers` | Collaborators sorted most-used-first. |
| `GET /api/inbox`, `/api/inbox/status`, `/api/prs*` | See `.claude/rules/pages-and-routing.md`. |
| `GET /api/blocks`, `/api/code`, `/api/blockstats`, `/api/approvalsummary`, `/api/langsiblings` | See `.claude/rules/blocks-and-ingest.md`. |
