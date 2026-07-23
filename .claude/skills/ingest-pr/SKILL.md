---
name: ingest-pr
description: Ingest a GitHub PR into blocks — fetch the PR, set up base/head worktrees, parse the changed PHP files into functions/methods, classify them as added/removed/modified, and store them in the SQLite blocks table. Use when adding to or debugging the PR→blocks pipeline (ingest.go, phpscan.go, classify.go, gh.go, parse_pool.go).
---

# Ingesting a PR into blocks

The ingest pipeline turns a PR into a list of **blocks** (a block = one PHP
function/method, or the whole file if parsing fails). The data lands in the
`blocks` table of the SQLite DB and is served as a delta via
`GET /api/blocks?pr=N`.

## Pipeline (see `ingestPR` in `ingest.go`)

1. **Meta** — `fetchPRMeta` (`gh pr view <pr> --repo plug-and-pay/plug-and-pay
   --json files,baseRefOid,headRefOid,baseRefName`). The SHAs from the meta
   are the source of truth; both base and head are taken from this so the
   diff and worktrees stay consistent (no head drift).
2. **Fetching commits** — `ensureCommits`: `git fetch origin refs/pull/<pr>/head`,
   `git fetch origin develop`, and as a fallback `git fetch origin <sha>`
   (GitHub allows fetch-by-sha). Hard-fails if a SHA remains unfindable.
3. **Worktrees** — `ensureWorktree` creates (idempotently: first `worktree
   remove --force`) two detached worktrees under
   `data/worktrees/pr-<pr>-{base,head}`. **Absolute paths** are mandatory:
   `git -C <repo> worktree add <dir>` resolves a relative `<dir>` against the
   repo dir, not against our CWD.
4. **Diff** — `diffBetweenSHAs` runs
   `git diff --unified=0 <base> <head> -- <files>`. `--unified=0` gives
   exactly the changed lines.
5. **Parsing (concurrent)** — `parseFiles` (worker pool `min(NumCPU,8)`): per
   file, the old version comes from the base worktree, the new one from the
   head worktree, both through `ScanBlocks`. A scanner panic is caught →
   whole-file fallback.
6. **Classifying** — `classifyFile`: match blocks on `Class::method`. Only in
   new = `added`; only in old = `removed` (`side='old'`); in both and the span
   touches a changed line = `modified`; otherwise skip. The category tag
   comes from the path (`categoryFor`).
7. **Storing** — `replacePRBlocks`: one transaction,
   `DELETE FROM blocks WHERE pr=?` followed by a bulk INSERT (idempotent
   re-ingest).

## Invoking

- Headless: `go run . ingest <pr> [-db data/graph.db]` (or the built binary).
- Via the bridge: `POST /api/ingest` with body `{"pr": 12903}`.

## Hard rules

- Only Go built-ins + `modernc.org/sqlite`. No extra dependency without
  discussion.
- `exec.CommandContext` with **separate args** + a context timeout
  (`ingestTimeout`); never a shell string with user input. See `runGit`/
  `fetchPRMeta` in `gh.go`.
- Parameterized SQL (`?`); never string concatenation.
- Serve deltas (`WHERE pr=?`), never the whole table.

## The PHP scanner (`phpscan.go`)

Single-pass lexer with contexts (code/comment/string/heredoc). Braces are
only counted in code context. Edge cases that are covered (and that
`phpscan_test.go` guards): anonymous closures (`function(){}` — count toward
depth, no block of their own), arrow functions (`fn() =>`), heredoc/nowdoc,
`#[Attributes]` vs. `#` comment, abstract/interface methods
(`function foo();`), and anonymous migration classes
(`return new class extends Migration`). On brace imbalance or non-PHP →
whole-file fallback. Extending the scanner? Add a test in `phpscan_test.go`.
