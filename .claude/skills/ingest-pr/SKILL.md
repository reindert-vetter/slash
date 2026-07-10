---
name: ingest-pr
description: Ingest a GitHub PR into blocks — fetch the PR, set up base/head worktrees, parse the changed PHP files into functions/methods, classify them as added/removed/modified, and store them in the SQLite blocks table. Use when adding to or debugging the PR→blocks pipeline (ingest.go, phpscan.go, classify.go, gh.go, parse_pool.go).
---

# PR ingesten tot blocks

De ingest-pipeline maakt van een PR een lijst **blocks** (een block = één
PHP-functie/method, of het hele bestand als parsen faalt). De data landt in de
`blocks`-tabel van de SQLite-DB en wordt als delta geserveerd via
`GET /api/blocks?pr=N`.

## Pipeline (zie `ingestPR` in `ingest.go`)

1. **Meta** — `fetchPRMeta` (`gh pr view <pr> --repo plug-and-pay/plug-and-pay
   --json files,baseRefOid,headRefOid,baseRefName`). De SHAs uit de meta zijn de
   bron van waarheid; base én head worden hieruit genomen zodat diff en worktrees
   consistent zijn (geen head-drift).
2. **Commits ophalen** — `ensureCommits`: `git fetch origin refs/pull/<pr>/head`,
   `git fetch origin develop`, en als fallback `git fetch origin <sha>`
   (GitHub staat fetch-by-sha toe). Hard-fail als een SHA onvindbaar blijft.
3. **Worktrees** — `ensureWorktree` maakt (idempotent: eerst `worktree remove
   --force`) twee detached worktrees onder `data/worktrees/pr-<pr>-{base,head}`.
   **Absolute paden** zijn verplicht: `git -C <repo> worktree add <dir>` rekent een
   relatief `<dir>` af t.o.v. de repo-dir, niet t.o.v. onze CWD.
4. **Diff** — `diffBetweenSHAs` draait `git diff --unified=0 <base> <head> -- <files>`.
   `--unified=0` geeft precies de gewijzigde regels.
5. **Parsen (concurrent)** — `parseFiles` (worker-pool `min(NumCPU,8)`): per file
   oude versie uit de base-worktree, nieuwe uit de head-worktree, beide door
   `ScanBlocks`. Een scanner-panic wordt opgevangen → whole-file fallback.
6. **Classificeren** — `classifyFile`: match blocks op `Class::method`. Alleen in
   nieuw = `added`; alleen in oud = `removed` (`side='old'`); in beide en de span
   raakt een gewijzigde regel = `modified`; anders overslaan. Category-tag komt uit
   het pad (`categoryFor`).
7. **Opslaan** — `replacePRBlocks`: één transactie, `DELETE FROM blocks WHERE pr=?`
   gevolgd door bulk-INSERT (idempotente re-ingest).

## Aanroepen

- Headless: `go run . ingest <pr> [-db data/graph.db]` (of het gebouwde binary).
- Via de bridge: `POST /api/ingest` met body `{"pr": 12903}`.

## Harde regels

- Alleen Go built-ins + `modernc.org/sqlite`. Geen extra dependency zonder overleg.
- `exec.CommandContext` met **losse args** + context-timeout (`ingestTimeout`);
  nooit een shell-string met user-input. Zie `runGit`/`fetchPRMeta` in `gh.go`.
- Geparametriseerde SQL (`?`); nooit string-concatenatie.
- Serveer deltas (`WHERE pr=?`), nooit de hele tabel.

## De PHP-scanner (`phpscan.go`)

Single-pass lexer met contexten (code/comment/string/heredoc). Braces tellen
alleen in code-context. Edge-cases die gedekt zijn (en `phpscan_test.go` bewaakt):
anonieme closures (`function(){}` — tellen mee voor depth, geen eigen block),
arrow-functies (`fn() =>`), heredoc/nowdoc, `#[Attributes]` vs `#`-comment,
abstracte/interface-methods (`function foo();`), en anonieme migration-classes
(`return new class extends Migration`). Bij brace-onbalans of niet-PHP → whole-file
fallback. Breid je de scanner uit? Voeg een test toe in `phpscan_test.go`.
