# Blocks & ingest

The first feature: turn a PR into a list of **blocks** (a block = one PHP
function/method, or the whole file if parsing fails) and show them on the left as
a navigable list. This file covers the storage, the ingest pipeline, the PHP
scanner/classifier and the display transforms applied to a block's source.

## Split out of this file

- `.claude/rules/approval.md` — reviewer approval and its counters: the granular
  `approvedRows`/`approvedCalls` model, durable persistence, the tree rollup,
  server-side `total` (`blockstats.go`), `rowHasContent`, the filler-row sweep,
  the comment-activity indicator, the per-line underlying summary, and hiding
  approved blocks.
- `.claude/rules/diff-render.md` — how a block body is rendered: line alignment
  (`blockRows`/`alignRows`/`diffLines`) and its memoization, huge-block
  trim/collapse, char diff, TRANSLATION blocks, SVG blocks.

## Storage

The `blocks` table *is* the `nodes`/function table from the graph, renamed +
extended with `class/category/end_line/status/side/pr`. The `approved` column
(0/1) is legacy — real approval state is granular and lives in the `approvals`
read model, see `.claude/rules/approval.md`. `edges` remains for the later call
graph. Schema: `.claude/templates/schema.sql`, in sync with `schemaDDL` in
`db.go`.

Several later columns were added as **light migrations** in `openDB`
(`ALTER TABLE … ADD COLUMN`, duplicate-column error ignored): `description`,
`file_deleted`, `old_file`. Each is written by **both** write paths
(`replacePRBlocks` and `upsertPRFileBlocks`) and read by `blocksByPR`, reaching
`/api/blocks` through a plain struct tag (no `MarshalJSON` special case).

## Pipeline

`gh pr view` → `git fetch` (pull-ref + develop, fallback by sha) → two detached
worktrees under `data/worktrees/pr-<pr>-{base,head}` (**absolute paths**!) →
`git diff --unified=0` → PHP scanner (`phpscan.go`, brace lexer, no external
parser) → classify (`classify.go`) → store. See skill `ingest-pr`.

### Runs as the `ingest` workflow (write boundary)

The blocks-table write and the git-worktree mutations happen inside a tembed
**Workflow Execution** (Workflow Type `ingest`, `workflows.go`), not directly from
an HTTP handler or the CLI. Two Activities:

- **`prepareWorktrees`** — gh fetch + `ensureCommits` + the two `ensureWorktree`
  calls; returns only the small `worktreeSHAs` summary (base/head SHA + changed
  file paths), not the worktree contents.
- **`scanAndStoreBlocks`** — `git diff` + PHP scan/classification +
  `replacePRBlocks`; returns only the small `ingestResult` summary, so the event
  history stays compact.

Both Activity bodies (`prepareIngestWorktrees`/`scanAndStoreIngestBlocks` in
`ingest.go`) remain ordinary, directly testable functions, now called
**exclusively** from these Activities. `TaskManager.StartIngest(ctx, pr)` starts
the Execution (signal-less, so it runs synchronously to completion) and returns
the summary.

### Incremental refresh (new commits, no full re-ingest)

Alongside the manual full pipeline, `pr_status` runs a **delta refresh** on its
poll cadence as soon as a PR's live head SHA is ahead of what was last ingested
(`pollIngestRefresh` → `PRStateSignal` → `refreshIngestDelta` Activity,
`ingest.go`). It diffs the **previously stored** head SHA (`pr_ingest` table,
`db.go`) against the new one, rescans **only the files changed since then**, and
writes them via **`upsertPRFileBlocks`** (a DELETE+INSERT scoped to those files)
instead of `replacePRBlocks`'s full per-PR swap. Every other file's blocks — and
everything hanging off their **stable** block id in the separate
comments/approvals/callresolve read models — is left alone.

**For a re-scanned file, "untouched" is not enough.** A comment's
`row_start`/`row_end` and an approval's row indices are positions in the block's
**aligned-row space**, and re-scanning rewrites that space: the rows survive, their
meaning doesn't. **Every** path that swaps blocks — `prStatusWorkflow` after a
non-skipped refresh, and `ingestWorkflow` after a full ingest, so also
"Regenereren"/`slash ingest`, which never touch `pr_status` — therefore runs a
**re-anchor pass** (`reanchorAfterRefresh` + `reanchor.go`). Full mechanism
(heartbeat cadence, the base-SHA-changed fallback to the full pipeline, the
re-anchor pass, and why relations/callresolve keep recomputing over the PR's full
current block list rather than delta-scoped): see the "Ingest refresh" section
under `pr_status` in `.claude/rules/workflows-trackers.md`.

## Running

- **CLI:** `go run . ingest <pr> [-db data/graph.db]` starts the `ingest` workflow
  headlessly (a standalone engine without server runtime — no poller resume, no
  inbox fetch, see `newTasks(..., resumeRuntime)` in `tasks_api.go`) and then
  `EnsureRelations`, just like the HTTP flow.
- **HTTP:** `POST /api/ingest {"pr":N}` (`handleIngest` → `StartIngest` →
  `EnsureRelations`).
- **Server:** `go run . [-db path] [-data dir] [-addr host:port] [-static dir]`.
  DB path also via `SLASH_DB`. The **data dir** (holding
  `worktrees/pr-<n>-{base,head}`, which `/api/code`, `/api/blockstats`,
  `/api/approvalsummary` and `/api/langsiblings` slice their diffs out of) also
  via **`SLASH_DATA`**, default `"data"` (`dataDirPath` in `main.go`, mirroring
  `dbPath`). It is configurable so the Playwright harness can point every worker
  server at its own throwaway fixture tree and never touch the live `data/` tree
  — see `.claude/rules/testing-playwright.md`.
- **The local clone** where all git/worktree operations run (`repoDir()` in
  `gh.go`) comes from **`SLASH_REPO_DIR`**, default `~/dev/plug-and-pay`; a
  leading `~` is expanded via `os.UserHomeDir()`.
- **Serve:** `GET /api/blocks?pr=N` (delta) and
  `GET /api/code?pr=N&file=..&class=..&name=..` (the old + new source of one
  block; `file` must be a stored block of that PR). How that source is aligned and
  rendered: `.claude/rules/diff-render.md`.

## `phpscan.go`: what belongs to a block

### Leading attributes (`#[...]`)

A PHP attribute right above a method/function — `#[DataProvider('m')]`,
`#[Route('/x')]`, stacked attributes, or one whose arguments span multiple lines
— counts as part of **that block**: `Block.Line` starts at the **first** attribute
line of a contiguous run, not at the `function` line.

`scanPHP` keeps a `pendingAttrLine`: every `#[` (scanned via an explicit
`skipAttribute` lexer that respects nested `[` and strings, so `#[Attr(['a','b'])]`
or a quote containing a `]` doesn't end the scan early) sets it if still empty;
modifier keywords (`public`/`protected`/`private`/`static`/`abstract`/`final`/
`readonly`/`var`) leave it intact; **any other token** (a type hint, a variable
name, `;`, a `class`/`trait`/`interface`/`enum` keyword) resets it to 0, so an
attribute on a property never leaks to a later method. The class-header sentinel
and the body scan are unchanged — only the moment `Block.Line` is captured shifts
(`scanFunction` got a `declLineOverride` parameter).

**Consequence for `classify.go`:** since `classifyFile` checks
`intersects(nb.Line, nb.EndLine)`, a change that **only** touches the attribute
line now counts as "modified". Before, such a diff fell outside every block and
the block never appeared in the review tree.

**Consequence for consumers that read "the text above the declaration"** (e.g.
`testcovers_analysis.go`'s `methodZone`, which reads `#[CoversMethod]`/`#[Test]`/
`@covers`): part of that text now sits **inside** the block.
`testcovers_analysis.go`'s `funcDeclLine` (finds the real `function` keyword
within the block) is the fix — `methodZone` uses that line, not `b.Line`, as the
zone's upper bound. **Any new detector reading the zone above a method must reuse
`methodZone`/`funcDeclLine`, never `b.Line`.**

Tests: `phpscan_test.go` (`TestLeadingAttributeIncludedInBlock`,
`TestMultilineLeadingAttributeIncludedInBlock`, `TestStackedAttributesUseFirstLine`,
`TestPropertyAttributeNotLeakedToNextMethod`), `classify_test.go`
(`TestAttributeOnlyChangeClassifiesAsModified`).

### PHPDoc description (`Block.Description`), deterministic, no AI

If a `/** ... */` PHPDoc sits directly above a method/function (two asterisks at
open — a bare `/* ... */` doesn't count), `scanPHP` extracts the **free-text
lines** (any line that, after stripping the framing and a leading `*`, doesn't
start with `@`) and joins them into one space-separated paragraph into
`Block.Description` (`model.go`). Purely textual, so no cost/latency and fully
deterministic on re-ingest.

`scanPHP` keeps its own `pendingDocText`, set whenever a `/**` is scanned
(`phpDocDescription`, only overwritten by a later non-empty PHPDoc — "last before
the declaration wins"). Unlike `pendingAttrLine` it **survives** intervening
attributes/modifiers: a PHPDoc may sit above a leading `#[...]` and must still be
attributed to that method.

**A PHPDoc also pulls `Block.Line` toward itself**, just like an attribute. (It
deliberately did not, once — but then a change touching only the PHPDoc text fell
outside `[Block.Line, EndLine]` and the block never appeared in the review tree.)
`scanPHP` tracks a separate `pendingDocLine`, set on the opening line of **every**
real `/**` PHPDoc, even a tag-only one (symmetrical with an argument-less
attribute); a bare `/* ... */` never triggers it. In the `"function"` branch,
`declLine` becomes the **earliest** non-zero of `pendingAttrLine`/
`pendingDocLine`, so the topmost line wins in either order. `EndLine` is
unchanged (docblock/attributes are always before the function).

`pendingDocText`/`pendingDocLine` reset on exactly the same triggers as
`pendingAttrLine`, so a PHPDoc above a property never leaks to a later method.
Class-level PHPDoc and the synthetic blocks (class-header sentinel,
enums/models/macros/commands in `callresolve_analysis.go`) deliberately get **no**
description and are not captured in a `Block.Line` — only a real `function`
declaration in `scanPHP` does that.

**Consequence for `funcDeclLine`:** a PHPDoc's prose can contain the word
"function", so `reFunctionKeyword` was tightened from `\bfunction\b` to
`\bfunction\b\s*&?\s*\w*\s*\(` (requires a `(` shortly after, like a real
declaration/closure) — otherwise `funcDeclLine` matched a docblock line and
corrupted `methodZone`/`onlyBareTestAttributeLinesChanged`/the data-provider
resolution. Test: `TestFuncDeclLineIgnoresFunctionWordInDocProse`
(`testcovers_analysis_test.go`).

**Display:** no new UI — `src/Block.mjs` already had a section on the card showing
`b.description` (italic "no description yet" fallback when empty, and no label in
front of it, see the PHPDoc-fold section below); only the field was never filled.
Tests: `phpscan_test.go` (`TestPHPDocDescriptionCapturedForMethod`,
`TestPHPDocDescriptionSurvivesLeadingAttribute`,
`TestPHPDocDescriptionNotLeakedAcrossProperty`,
`TestPlainBlockCommentIsNotADescription`, `TestNoPHPDocMeansNoDescription`,
`TestPHPDocPullsBlockLineLikeAttribute`, `TestPHPDocAndAttributeBothPullBlockLine`);
`classify_test.go` (`TestPHPDocOnlyChangeClassifiesAsModified`).

## `codesig.go`: display transforms on a block's source

Because `Block.Line` now includes a leading PHPDoc, `extractBlockSource`/
`blockSource` slice that doc into the displayed text. Two independent transforms
clean that up. Both are **display/counting only** and are applied at exactly two
call sites — `api.go`'s `handleCode` (feeds `/api/code`, so `Block.mjs`'s diff,
including any drilled column that is a real PR block) and `blockstats.go`'s
`blockChangedRowCount` (the approve `total`) — so diff display and approve counter
stay in lockstep, the existing Go/JS parity pattern.
**`extractBlockSource`/`blockSource` themselves stay unchanged**:
`relations.go`/`callresolve_analysis.go`/`testcovers_analysis.go` need the raw,
line-accurate text for their `matchLine`/`funcDeclLine`/`methodZone`.

### Folding PHPDoc types into the signature

`enrichSignatureWithDocTypes(text)` folds a leading PHPDoc's `@return`/`@param`
types **into the visible function signature** — as if PHP were strictly typed,
with the docblock syntax carried over literally (e.g. `array<string, mixed>|null`,
not valid native PHP; purely cosmetic, Prism just highlights it plainly) — and
removes the doc lines. An existing native `?array` return type is **replaced**; an
absent one gets `: <type>` **added** before the `{`/`;`. An `@param TYPE $name`
only replaces that one parameter's type (modifiers like `public readonly`, a
leading `#[...]`, and the `&`/`...` markers stay intact); a parameter without a
matching `@param` is untouched.

**All-or-nothing per block:** if the signature can't be rewritten with certainty,
**no type at all** is folded — never a half state.

**But the leading PHPDoc disappears either way** (`code.go`'s `enrichedCodeSide` →
`stripLeadingPhpDoc`): when folding did nothing (`removed == 0` — a free-text-only
doc, or a non-rewritable signature) the leading `/** … */` is still
**unconditionally clipped**, with the same `Start += removed-lines` correction. A
raw docblock must never remain in the displayed code — the free text already lives
on `Block.Description`. For a free-text-only doc nothing is lost; for a
non-rewritable signature with `@param`/`@return` types those types do disappear
from view — an accepted trade-off (a half/raw docblock is uglier than one missed
type). The same fallback is mirrored in `blockstats.go`'s `blockChangedRowCount`
so the `total` never counts clipped doc lines.

**Leading-only scope**, same as `trimTrailingBlankLine`: only a `/**` as the first
non-whitespace token is picked up; a bare `/* … */` is left alone.

**Two deliberate v1 scope boundaries:**

- The PHPDoc must be the **very first** thing in the sliced text — an attribute
  *before* the doc (`#[Foo]` then `/** */` then `function`) is not supported and
  the block stays unchanged. An attribute *after* the doc works fine; it stays put
  between the removed doc and the rewritten signature.
- **Multi-line signatures are supported** (parameter list or return type across
  lines, e.g. constructor property promotion) — parsing works on byte offsets, so
  `matchBracket`/`splitTopLevel` track bracket depth + quote escaping straight
  through newlines.

**The `Start` correction is load-bearing:** `enrichedCodeSide` bumps
`codeSide.Start` by exactly the number of removed lines. Without it,
`unitLineRange`/`commentTarget`/`githubFileLine` (`home.mjs`, counting absolute
lines from `c.new.start`/`c.old.start`) would shift a GitHub comment anchor or an
"Open GitHub" deep link by that many lines.

**Also applied to embedded "Underlying code" children** — a `method_call`/`covers`
child whose code is embedded in its callresolve/testcovers row (an unchanged file,
captured via `blockSource` at analysis time, see
`.claude/rules/workflows-analysis.md`). `ChildCode`/`CoveredCode` go through the
same `enrichedCodeSide(blockSource(…))` in `callresolve_analysis.go` (`method_call`
rules 1-5b/2c via `emitKind`, the enum-case rule 6, `resolveMigrationModels`,
`resolveDataProviders`), `testcovers_analysis.go` (`coverEntriesForTest`) and the
two LLM `found` paths (`resolve_call.go`'s `verifyDefinition`,
`resolve_test_covers.go`'s `resolveTestCoversWithModel`). `ChildLine`/`CoveredLine`
shift along (`code.Start`) — no frontend consumer reads them today, but they stay
in lockstep with `Code`. An enum-case/migration-model child (a synthetic
whole-class/whole-enum block) carries no leading PHPDoc by construction, so it's a
practical no-op there; the wrapper is applied anyway for uniformity. A
sibling-reused testcovers row (`reuseSiblingCovers`) copies an already-enriched
`CoveredCode` verbatim.

Test: `codesig_test.go` (single-line and multi-line signatures, constructor
property promotion, missing native return type, a tag-less doc that stays
unchanged, no-doc, attribute-before-doc unchanged, attribute-after-doc intact, a
stale `@param` name affecting only its own parameter, and `&`-by-ref vs.
intersection-type disambiguation), plus a parity test that
`blockChangedRowCount`'s result drops when only the doc is folded. The
embedded-child transformation is tested in
`callresolve_analysis_test.go`/`testcovers_analysis_test.go` and
`resolve_call_test.go`/`resolve_test_covers_test.go`.

### Trimming a blank trailing line

`trimTrailingBlankLine`, independent of the fold above. `classHeaderSentinel`
(`phpscan.go`) has no closing `}` — its `EndLine` is **derived** as
`declLine - 1` (the line before the next method declaration, itself possibly
pulled back to a PHPDoc/attribute), or the line before the class's closing `}` if
the class never gets a method. With a normal blank line between the last header
content and what follows, that blank line is sliced in as the block's **last
line**: a visibly empty highlighted row with no meaning (already uncountable via
`rowHasContent`, so purely a render artifact).

`trimTrailingBlankLine(text)` clips exactly **one** wholly-blank trailing line
(regex-free: find the last `\n`, `TrimSpace` the remainder) and reports how many
lines that was (0 or 1) — deliberately no loop, this covers the observed
one-stylistic-separator case without guessing further.

**Orthogonal to the PHPDoc fold:** it fires regardless of whether folding did
anything, and corrects the **tail** (`End`) instead of the **start** (`Start`), so
the two corrections sit independently side by side in `enrichedCodeSide` and in
`blockChangedRowCount` (a numeric no-op there, but applied so the two pipelines
don't diverge).

**Deliberately does NOT touch** `phpscan.go`'s `Block.Line`/`EndLine` or
`classify.go`'s "is this block touched by the diff" decision — pure display. A
block that only classifies as `modified` via this blank trailing line stays
visible in the review tree; only the blank row disappears from view. (Adjusting
`phpscan.go`'s `EndLine` instead was rejected: it would drop such a block out of
the review tree entirely — a far bigger behaviour change.) Safe by construction
elsewhere: a real method's `EndLine` is its own closing `}`, never blank, so this
is a no-op for nearly every block, including every embedded Underlying-code child
(same `enrichedCodeSide` wrapper).

Test: `codesig_test.go` (blank last line via trailing `\n`, whitespace-only last
line, no-op on real content/single-line/empty string, two consecutive blank lines
trimmed only once; `enrichedCodeSide` with tail trim only, no transform, and fold
+ trim combined to prove the `Start` bump and `End` lowering stay independently
correct).

## Classification (`classify.go`)

### Sort order of the left list

`categoryRank` in `recomputeLeftList` (`home.mjs`): not ingest/source order but
category priority — **ROUTE** first (the root of the
route→controller→request/resource/model hierarchy), then **CONTROLLER**, then
everything else, and **relation children after everything** (the "Onderliggende
code" section at the bottom, see `recomputeLeftList`/`state.underlyingIds` in
`.claude/rules/underlying-code.md`).

The sort happens **after** the existing filters (resolved-call targets, search
term) and is a **stable** sort, so within a rank the original order stays intact.
That is what makes it safe for `sameFileNeighbour`/`stepBlock` (the same-file
connector + `↑`/`↓` flow-through, see `.claude/rules/keyboard-navigation.md`):
those look only at the direct index neighbour in `state.blocks`, and since
`classify.go` derives the category from the file path, all blocks from one file
share a category and thus a rank — the stable sort keeps them together.
`sel`/refresh restore is unaffected (it looks up by block id/`file:line`, not
index).

### Trait blocks (`TRAIT`, keyword-based, not path-based)

A method declared directly inside a PHP `trait` body classifies as **`TRAIT`**
instead of falling through to `OTHER`/its directory's category — mirroring the
existing `INTERFACE` override. `phpscan.go`'s `scanPHP` already tracks each
`classFrame`'s `kind` (`class`/`trait`/`interface`/`enum`), so it stamps
`Block.IsTrait` (transient, `json:"-"`, alongside `Block.IsInterface`) on every
method/header block inside a `trait`; `classifyFile` overrides `Category` to
`"TRAIT"` whenever that flag is set, **regardless of path**.

**Keyword-based on purpose:** a trait file isn't confined to one directory
convention (`app/Traits/`, `packages/*/Traits/`, or none) and has no reliable
filename suffix (unlike `*Interface.php`), so a pure path rule would miss most
real traits. A narrow **path fallback** (`hasSeg(p, "Traits/")` in
`categoryRules`, placed early like the `*Interface.php` fallback) only covers the
scanner's whole-file-fallback case, where `Block.IsTrait` is never set — the same
two-layer shape as `INTERFACE`.

**Deliberately not** wired through `callresolve_analysis.go`'s
`scanTraits`/`idx.traits`: that is a separate whole-worktree regex scan used by
`build_relations` to link trait *usage* (`use HasIncludeLabel;`) to its
declaration as an Underlying-code child (see
`.claude/rules/workflows-analysis.md`) — a different life-cycle/input than
classifying an already-scanned `Block` during per-file ingest, and `phpscan.go`'s
lexer already has the `kind` it needs.

Frontend: `CATEGORY_STYLE.TRAIT` (`src/BlockList.mjs`) uses the separate "gray"
Tailwind family (distinct from `OTHER`'s `slate`/`zinc`) at a noticeably darker
shade, so the pill reads apart from `OTHER`/`TEST` by **lightness**, not hue —
colourblind-safe; the text label carries the meaning regardless. Tests:
`TestTraitMethodIsFlaggedIsTrait`/`TestClassMethodIsNotFlaggedIsTrait`
(`phpscan_test.go`), `TestTraitMethodClassifiesAsTraitRegardlessOfPath`/
`TestCategoryForTraitPathFallback` (`classify_test.go`).

The `TRANSLATION` category and its render live in
`.claude/rules/diff-render.md`.

### A bare `#[Test]`-only change does NOT count as "modified"

An added/removed/adjusted `#[Test]` (PHPUnit's argument-less marker) has no
reviewable meaning — unlike `#[DataProvider(...)]`, which should keep counting.
After the existing `intersects` check, `classifyFile` calls
`isBareTestAttributeOnlyChange(fd, oldLines, newLines, ob, nb)`, true only if
**every** changed line within the block (a) lies in the leading-attributes prefix
(before the real `function` line, via the same `funcDeclLine`) and (b) is,
trimmed, literally `#[Test]` — no arguments, no other attribute on the line. Then
`modified` goes back to `false` and the block doesn't appear at all, instead of
showing the entire untouched test method. A `#[Test]` addition **together with** a
real body change stays "modified". Tests: `classify_test.go`
(`TestBareTestAttributeOnlyChangeIsIgnored`,
`TestBareTestAttributeChangeStillModifiedWithRealEdit`).

## Truly deleted file (`file_deleted`)

"All blocks of this file are `removed`" is not a reliable signal — the blocks
table only holds *affected* blocks, so a file with one removed method still
exists. The real signal comes from the scan: `parseOneFile` (`parse_pool.go`) reads
both worktrees, and a file **absent from the head worktree** (git's
`+++ /dev/null`) is truly deleted; `classifyFile` stamps `FileDeleted` on every
removed block of that file. Persisted as column `file_deleted` (0/1) →
`fileDeleted` in `/api/blocks`.

The frontend marks it in **three** places, all rose/bold, via the shared
`removedLabel(b)` (`Block.mjs`) — "Deleted file" for `fileDeleted`, "Deleted" for a
lone removed method:

1. the **card header badge** (`data-testid=block-status-badge`, replaces the bare
   status word; one stable span with whole-value class/text function bindings);
2. the **sidebar pill** (`data-testid=block-row-removed`, `removedPill` in
   `BlockList.mjs`, a nested slot next to `approvalPill` —
   `statusInfo`/`STATUS_STYLE` unchanged);
3. the **diff banner** (`data-testid=removed-banner`) above the old-only pane in
   `codeDiff`'s `effectiveOnly==='left'` branch — only that branch was
   restructured: the outer `flex-col` holds `data-testid=code-diff`/`data-hints`,
   a nested `relative` flex-row carries the pane + scroll hints so
   `updateHints`/`syncScroll` keep working.

Tests: `classify_test.go` (detection, DB round-trip via both write paths,
migration) and `tests/removed-file.spec.mjs` (PR 98 fixture
`tests/fixtures/filedeleted-blocks.json`).

## Moved/renamed file as one block (`OldFile`/`old_file`)

A file the PR **moved** (a git-detected rename) is scanned as **one logical file**
instead of removed@oldpath + added@newpath. `detectRenames` (`gh.go`, `git diff
--find-renames --name-status` → `map[newpath]oldpath`) supplies the map; the
**full ingest** (`scanAndStoreIngestBlocksLocked`, `ingest.go`) uses it to

- include the old paths in the diff pathspec so git pairs the rename hunk under
  the new path (`diffBetweenSHAs` runs with `--find-renames`; a pathspec with only
  the new path would suppress rename detection), and
- have `parseOneFile` read the **old** source from `baseDir/oldpath` (new from
  `headDir/newpath`).

Both block sets are scanned under the **new** path, so `classifyFile`'s existing
`Class::method` symbol matching pairs them for free: present in both → one
`modified` block with a real old↔new diff, new-only → `added`, old-only →
`removed`. `File` always stays the **new** path (stable block id on the head
side); the pre-rename path lives on `Block.OldFile` (`model.go`) → column
`old_file` → `oldFile` in `/api/blocks`.

**Go/JS parity on the old side:** both `/api/code` (`handleCode`, via an `oldFile`
query param that `ensureCode` passes along) and `blockstats.go`
(`blockChangedRowCount`, via `Block.oldPath()`) read the old diff side from
`baseDir/<oldFile>` instead of `baseDir/<file>` — otherwise a moved block would
diff against an empty base path and count entirely as `added`.

**Display** (`Block.mjs`): when `b.oldFile && b.oldFile !== b.file` the card shows
the **old path (struck through) above** the new `file:line` line, in a stable
`flex-col` root (the toggling `${() => …}` slot sits inside that root — the "bare
toggling expression" pitfall, `.claude/rules/arrowjs-pitfalls.md`);
`data-testid=block-old-path`.

**Boundaries.** Best-effort: a move git doesn't recognise as a rename at its
default `-M` threshold (~50% similarity) isn't in the map and simply stays
removed+added. Scope: only the **full ingest** — the delta refresh
(`refreshIngestDelta`, `parseFiles(… nil …)`) keeps its deliberate `--no-renames`
split (`changedFileNames`), so a rename appearing mid-refresh stays removed+added
until a full re-ingest.

Tests: `classify_test.go` (`TestRenamePairsBlocks`), `blockstats_test.go`
(`TestBlockChangedRowCountReadsRenamedOldPath`), `tests/rename-file.spec.mjs` (PR
104 fixture `tests/fixtures/rename-blocks.json`).
