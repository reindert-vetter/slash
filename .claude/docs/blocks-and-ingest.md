# Blocks & ingest

The first feature: turn a PR into a list of **blocks** (a block = one PHP
function/method, or the whole file if parsing fails) and show them on the left as
a navigable list. This file covers the storage, the ingest pipeline, the PHP
scanner/classifier and the display transforms applied to a block's source.

## Split out of this file

- `.claude/docs/approval.md` — reviewer approval and its counters: the granular
  `approvedRows`/`approvedCalls` model, durable persistence, the tree rollup,
  server-side `total` (`blockstats.go`), `rowHasContent`, the filler-row sweep,
  the comment-activity indicator, the per-line underlying summary, and hiding
  approved blocks.
- `.claude/docs/diff-render.md` — how a block body is rendered: line alignment
  (`blockRows`/`alignRows`/`diffLines`) and its memoization, huge-block
  trim/collapse, char diff, TRANSLATION blocks, SVG blocks.

## Storage

The `blocks` table *is* the `nodes`/function table from the graph, renamed +
extended with `class/category/end_line/status/side/pr`. The `approved` column
(0/1) is legacy — real approval state is granular and lives in the `approvals`
read model, see `.claude/docs/approval.md`. `edges` remains for the later call
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
under `pr_status` in `.claude/docs/workflows-trackers.md`.

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
  — see `.claude/docs/testing-playwright.md`.
- **The local clone** where all git/worktree operations run (`repoDir()` in
  `gh.go`) comes from **`SLASH_REPO_DIR`**, default `~/dev/plug-and-pay`; a
  leading `~` is expanded via `os.UserHomeDir()`.
- **Serve:** `GET /api/blocks?pr=N` (delta) and
  `GET /api/code?pr=N&file=..&class=..&name=..` (the old + new source of one
  block; `file` must be a stored block of that PR). How that source is aligned and
  rendered: `.claude/docs/diff-render.md`.

## `phpscan.go`: what belongs to a block

### A `.blade.php` template is ONE whole-file block

`ScanBlocks` sends a Laravel Blade template down the same whole-file path as a
non-`.php` file (`isBladeTemplate`), **before** it ever calls `scanPHP`. A Blade
file is a template, not a class: its reviewable content is markup, `@php`/`@json`
directives and inline `<script>` blocks, none of which the block model describes.

**It needs its own check because "scanPHP found nothing" is not the signal
here.** The existing fallback only fires on **zero** blocks, and the brace lexer
happily reads the **JavaScript** function declarations inside an inline
`<script>` as PHP functions. So a Blade file yields one or more blocks that are
real code but the *wrong* code, the fallback never fires, and every changed line
outside those decoy spans belongs to no block at all — `classifyFile` emits
nothing and **the entire file disappears from the review tree, silently**.

Found on PR 13263: `resources/views/partials/scripts/fb.blade.php` scanned into
`getFBCookie` (lines 8-22) and `getUrlParameter` (24-27), both untouched by the
PR, while all 25 changed lines (`@php $deduplicationKey = match(true) …`, every
`eventStorageKey` edit) sat outside them. Nothing about the file reached the
reviewer. **Don't reintroduce this by treating "≥1 block" as proof the file was
understood.**

Deliberately narrow — the `.blade.php` suffix only, no general "if a changed
line lands outside every block, emit a whole-file block anyway" safety net. Such
a net would add a whole-file block to every PR that merely touches an import,
which is a much bigger, noisier behaviour change than the one real gap this
closes.

**Known, accepted residual gap:** a change in a real `.php` file's **preamble**
— above the class body, i.e. `namespace`/`use` imports — still belongs to no
block and stays invisible (the class-header sentinel starts at the class's
opening brace). Measured on PR 13255 this was exactly **one** changed line out
of the whole PR (`use Tests\Support\Temporal\HasWorkerDatabase;`), against 25/25
for the Blade case — hence narrow over general. Recorded here so it doesn't get
re-investigated as a new bug.

Tests: `phpscan_test.go` (`TestBladeTemplateIsOneWholeFileBlock`, which first
asserts the premise that `scanPHP` *does* return decoy blocks, plus
`TestPlainPhpFileStillScansIntoBlocks`) and `classify_test.go`
(`TestBladeTemplateChangeOutsideScriptFunctionsClassifies`, the end-to-end
"the change now surfaces" proof).

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
lines** — everything before the **first tag line** — and joins them into one
space-separated paragraph into `Block.Description` (`model.go`). Purely
textual, so no cost/latency and fully deterministic on re-ingest.

**It stops at the first `@tag`; it does not skip tag lines one by one.** That
was the original rule and it leaked badly, because only the `@param` line
itself starts with `@` — a **multi-line** tag's continuation lines don't:

```
@param array{
    tenant_ids?: list<int>|null,
    ...
} $input
  - `tenant_ids`: an explicit, hand-picked set. …
```

Every one of those lines counted as free text, so the whole raw array-shape
declaration plus the bullets documenting it were glued onto the prose and shown
as one wall of text on the block card (found on
`ImportSubscriptionStatsFlow::run`, PR 13255 — Reindert: "types mogen weg, die
zijn al verwerkt in de blokken"). Breaking at the first tag is safe because
PHPDoc puts summary/description first and the tag block after it; free text
placed *below* the tags is deliberately unsupported. Tests:
`TestPHPDocDescriptionStopsAtFirstTag`, `TestPHPDocTagsOnlyMeansNoDescription`
(`phpscan_test.go`). Note this is a **stored** column, so an already-ingested
PR only loses the type wall after a re-ingest/regenerate.

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

**Paragraph structure survives.** A blank doc line separates two paragraphs and
is kept as a **`"\n\n"`**; lines *within* a paragraph still join with a space (a
docblock hard-wraps its prose at ~110 columns, so a lone newline there is never
meant as a break). Flattening everything into one line is what made a
well-written multi-paragraph docblock read as a single dense run. The inline
tags **`{@see X}`/`{@link X}` are unwrapped to `X`** — braces and tag word are
docblock framing, not prose. Any other inline tag (`{@inheritDoc}`, …) is left
verbatim rather than guessed at. Tests:
`TestPHPDocDescriptionKeepsParagraphs`, `TestPHPDocDescriptionUnwrapsInlineRefs`.

**Display:** `src/Block.mjs`'s card strip renders `b.description` through
**`descriptionHtml`** — split on the blank line, each paragraph through the
shared `renderMarkdown` (see "Markdown rendering" in
`.claude/rules/conventions.md`), each wrapped in its own `<p>` inside a
`.markdown-body` container. The split is load-bearing: snarkdown is
deliberately minimal and turns a blank line into a bare `<br />`, never a `<p>`,
so without it the paragraph gap the Go side preserves would not survive to the
screen; a real `<p>` picks up the `.markdown-body p { margin: .4em 0 }` rule
that already exists in `index.html`. Going through `renderMarkdown` also means
the strip inherits the **XSS layer** — it was previously an escaping-free
plain-text slot fed by source-derived text — and that a PHPDoc's customary
`` `backticked` `` identifiers/command names render as inline code. Test:
`tests/block-description-markdown.spec.mjs` (fixture PR 117).
Tests: `phpscan_test.go` (`TestPHPDocDescriptionCapturedForMethod`,
`TestPHPDocDescriptionSurvivesLeadingAttribute`,
`TestPHPDocDescriptionNotLeakedAcrossProperty`,
`TestPlainBlockCommentIsNotADescription`, `TestNoPHPDocMeansNoDescription`,
`TestPHPDocPullsBlockLineLikeAttribute`, `TestPHPDocAndAttributeBothPullBlockLine`);
`classify_test.go` (`TestPHPDocOnlyChangeClassifiesAsModified`).

### `scanClassMembers`: properties/constants are NOT blocks

`phpscan.go` also exports a member splitter — it cuts a class body (in practice
the `<class-header>` region) into its `;`-terminated property/constant
declarations, reusing the same lexer primitives as `scanPHP` so a `;` inside a
string/comment/heredoc/bracket pair never ends a statement. It is used only by
`callresolve_analysis.go` (rule 9 "class members" and rule 6b "constants on a
plain class", see `.claude/docs/workflows-analysis.md`).

Deliberately **outside** the block model: a member yields a `classMember`
value, never a `Block`. It therefore has no id, no category, no approval and no
row in the block index — it exists only as an "Onderliggende code" card. Making
a member a block instead would drag classification, ids, approvals and the left
list along with it, for a unit nobody reviews on its own.

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
`.claude/docs/workflows-analysis.md`). `ChildCode`/`CoveredCode` go through the
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
`.claude/docs/underlying-code.md`).

The sort happens **after** the existing filters (resolved-call targets, search
term) and is a **stable** sort, so within a rank the original order stays intact.
That is what makes it safe for `sameFileNeighbour`/`stepBlock` (the same-file
connector + `↑`/`↓` flow-through, see `.claude/docs/keyboard-navigation.md`):
those look only at the direct index neighbour in `state.blocks`, and since
`classify.go` derives the category from the file path, all blocks from one file
share a category and thus a rank — the stable sort keeps them together.
`sel`/refresh restore is unaffected (it looks up by block id/`file:line`, not
index).

### The HTTP layer matches on `Http/<Dir>/`, not on an `app/` prefix

`CONTROLLER`/`REQUEST`/`RESOURCE` key on the `Http/Controllers/`,
`Http/Requests/` and `Http/Resources/` **segment** — deliberately without the
`app/` prefix the other rules use, because a module repeats Laravel's very same
convention under `modules/<Name>/Http/Controllers|Requests|Resources/`. With the
`app/` prefix those files fell through to the generic `modules/` → `MODULE` rule,
and because `relations.go`'s `routeControllerDetector` (and the
controller→request/resource/model detectors) filter hard on
`Category == "CONTROLLER"`, **every controller-shaped relation was silently
missing for a module PR**: a `Route::get(..., [MerchantFeedController::class,
'show'])` produced no `route_controller` edge, so the controller never appeared as
Underlying code (found on PR 12112, `modules/Sitemaps`). Don't reintroduce the
`app/` prefix here.

**`Http/Resources/`, never a bare `Resources/`:** `modules/<Name>/Resources/` is a
module's own asset/lang directory, whose lang files must keep reaching the
`TRANSLATION` rule further down. The three rules also stay **above** the
`modules/` rule (first match wins). Tests:
`TestCategoryForModuleHttpLayer` (`classify_test.go`, incl. the lang-file and
plain-module-file ordering guards) and `TestBuildRelationsRouteToModuleController`
(`relations_test.go`, the whole path → category → edge chain).

Consequence when this landed: a module controller/request/resource block changes
category, so its badge and its `categoryRank` position in the left list change
too — but only after a **re-ingest**, since `category` is stored per block row in
`graph.db`.

### Module / layer / type: three optional labels from one path

A path in this repo carries up to **three independent, each optional** pieces of
meaning, and the review tree shows them as three separate labels:

1. the **module** — `app/…` or `modules/<Name>/…`. **`app` counts as a module
   name like any other** (Reindert), so there is no special case for it;
2. the **layer** — an optional `Internal`/`Shared`/`Client` grouping *inside* a
   module;
3. the **type** — the directory saying what kind of thing this is
   (`Services/` → SERVICE, `Features/` → FEATURE, …). That one **is**
   `Block.Category`.

Two directory styles live side by side in the real repo and both must work —
`modules/Checkouts/` holds only `Client/ Internal/ Shared/ Tests/` (type one
level deeper), while `modules/Payments/` holds its type directories directly.
Plus plain Laravel structure (`config/`, `routes/`) that has no module at all.

**Only the type is derived in Go and stored.** The module and layer are derived
in the frontend straight from `b.file` (`src/blockPath.mjs`), which needs no new
column and therefore **no re-ingest** — see `src/blockPath.mjs`'s own header and
the two pills on the card header in `Block.mjs`. That split makes
`splitBlockPath` (`classify.go`) a
**parity implementation**: keep the Go and JS versions in step, or a block can
show a layer pill Go never treated as a layer.

**The layer guard is the subtle part.** `Client` is genuinely ambiguous:
`modules/Checkouts/Client/Services/Foo.php` uses it as a **layer**, while
`modules/Payments/Client/MollieClient.php` and `app/Client/OrderClient.php` hold
files directly and use it as a **type**. `splitBlockPath` requires **at least
three remaining segments** (layer / type / file) before treating a segment as a
layer, which tells the two apart from the path alone — no filesystem access,
which matters because this runs during ingest against paths, not a checkout.
Don't "simplify" this to a bare `Internal|Shared|Client` name check.

`typeDirCategory` is a **closed table**; an unknown segment yields `OTHER`,
never a label invented from whatever the directory happens to be called.
Deliberately absent from it: `Resources` (under a module that's the assets/lang
directory — the API resource is `Http/Resources/`, matched earlier), and
`Http`/`Database`/`Tests` (already covered by the earlier, more specific rules).
The generic table runs **after** every explicit rule above, so those keep
winning.

**This replaced the old `app/<Dir>/` handful plus the catch-all
`modules/` → `MODULE` rule.** That is why `app/Features/…` used to show up as
`OTHER` (Reindert's own report) and why everything in a module collapsed into one
undifferentiated `MODULE` pill. It also fixes a silent gap of the same shape as
the `Http/<Dir>/` one above: `relations.go` filters hard on
`Category == "MODEL"/"POLICY"/"LISTENER"`, which a module file could never have,
so those relations never materialised for a module PR. `MODULE` is no longer
produced at all (its `CATEGORY_STYLE` entry is harmless and stays).

Tests: `TestSplitBlockPath`, `TestCategoryForTypeDirectory` (`classify_test.go`).
Same re-ingest caveat as above — `category` is a stored column.

**Display: three pills, module and layer on the card header only.**
`src/blockPath.mjs` (a pure utility like `urlState.mjs`/`theme.mjs`) exports
`splitBlockPath(file)` → `{module, layer}` and `paletteClass(label)`.
`Block.mjs`'s `pathPills(b)` renders them right after the existing category
pill (`data-testid=block-module-pill`/`block-layer-pill`), each simply left out
when absent — so the header reads `SERVICE · Checkouts · Internal ·
CheckoutService::finish`, or just `CONFIG · services.php` for a path with
neither. Returned as a **keyed array**, never a bare element/null, so the slot
always emits the same kind (the single↔array freeze,
`.claude/rules/arrowjs-pitfalls.md`).

Deliberately **not** in the sidebar row (Reindert's own call between the
options): the block index is for scanning and its row already carries
cursor/category/label/removed/unpushed/comment-activity/approval/status, while
the card is where there is room for context.

**Colours start over instead of going neutral.** `categoryClass`'s fallback is
no longer `OTHER`'s grey but `paletteClass` — a deterministic hash into the
same Tailwind families the hand-picked `CATEGORY_STYLE` entries use, so the
much wider tag set the type table produces (FEATURE, WORKFLOW, COMMAND, DTO, …)
each gets a stable colour of its own instead of all landing on the same pill.
The module pill uses the same palette (one module always looks the same); the
layer pill is a neutral outline — three possible values, a structural detail
rather than a category. Two labels sharing a hue is fine: the **word** carries
the meaning, colour is decoration (the colourblind rule). `OTHER` itself stays
grey — it means "we don't know", which should look unremarkable.

Test: `tests/block-module-layer-labels.spec.mjs` (fixture PR 118, covering all
four path shapes).

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
`.claude/docs/workflows-analysis.md`) — a different life-cycle/input than
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
`.claude/docs/diff-render.md`.

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
