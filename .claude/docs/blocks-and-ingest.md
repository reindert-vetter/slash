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

`gh pr view` → `git fetch` (pull-ref + develop, fallback by sha) →
**`git merge-base`** → two detached worktrees under
`data/worktrees/pr-<pr>-{base,head}` (**absolute paths**!) →
`git diff --unified=0` → PHP scanner (`phpscan.go`, brace lexer, no external
parser) → classify (`classify.go`) → store. See skill `ingest-pr`.

#### The base side is the MERGE BASE, not `baseRefOid`

`gh pr view --json baseRefOid` reports the **current tip** of the base branch,
not the commit the PR branched off. Checking the base worktree out at that tip
makes the ingest's `git diff base head` a **two-dot** diff, which reports
everything develop received *after* the branch point — inverted, as a
**deletion**, because the PR's head simply doesn't have it yet. Reviewer-reported
symptom (PR 13613, `resources/admin/src/locales/nl.json`): a translation key
another PR added to develop showed as a red removed line in a PR about something
else entirely, and Claude could not find that key anywhere in the head worktree.
Measured on that PR: `git diff --stat baseRefOid..head` said 9 insertions **and 2
deletions**, `merge-base..head` said 9 insertions and **none**. GitHub's own
"Files changed" uses the merge base (a three-dot diff), which is why this only
ever disagreed with the UI over there.

`mergeBaseSHA` (`gh.go`) therefore resolves the base **after** `ensureCommits`
(the merge base is only computable once both commits are local) in
`prepareIngestWorktreesLocked`, so the merge base is what the base worktree,
`detectRenames`, `diffBetweenSHAs`, `saveIngestSHAs` and thus every aligned-row
space (`reanchor.go`, `blockstats.go`) all see. Best-effort: any git failure
(unreachable commit, shallow clone) returns the base unchanged rather than
failing the ingest, and re-resolving is idempotent — the merge base is an
ancestor of head. Test: `TestMergeBaseSHAPinsTheBranchPoint`
(`ingest_merge_base_test.go`), which asserts the phantom deletion is present in
the two-dot diff and gone from the three-dot one.

#### `commitExists` can say yes and the diff still fails: `fatal: bad object`

Reported on plug-and-pay PRs 13535/13628, against a partial-clone checkout of
`~/dev/plug-and-pay`: `ensureCommits`' `commitExists` (`git cat-file -e
<sha>^{commit}`) found both SHAs reachable, yet the LATER `git diff`
(`diffBetweenSHAs`) or `git diff --name-status` (`detectRenames`) still failed
with `fatal: bad object <sha>`. Not reproduced live in this session — setting
up a genuinely flaky partial clone on demand wasn't practical — so treat this
as a defensive fix from code analysis, not a confirmed root cause. Most likely
explanation: a partial clone's promisor remote resolves a missing object
on-demand at the moment it's first read, so `commitExists`' own `cat-file -e`
can trigger (and succeed at) exactly that lazy fetch — which only proves the
object was reachable at that instant, not that it stays resolvable for the
`git diff` moments later.

Fix is defensive, not preventive: `diffBetweenSHAs`/`detectRenames`
(`gh.go`) each retry once via `retryAfterRefetch` — an explicit
`git fetch origin <sha>` for both base and head, the same per-SHA fallback
`ensureCommits` already uses — whenever the underlying git command's error
matches `isBadObjectErr` (`strings.Contains(err.Error(), "bad object")`). A
genuinely missing/invalid SHA still fails the same way as before, just after
one extra (equally failing) fetch attempt. Test:
`TestIsBadObjectErr`/`TestDiffBetweenSHAsSurfacesErrorAfterRetryingAGenuinelyMissingObject`
(`gh_bad_object_test.go`).

### Runs as the `ingest` workflow (write boundary)

The blocks-table write and the git-worktree mutations happen inside a tembed
**Workflow Execution** (Workflow Type `ingest`, `workflows.go`), not directly from
an HTTP handler or the CLI. Two Activities:

- **`prepareWorktrees`** — gh fetch + `ensureCommits` + `mergeBaseSHA` + the two
  `ensureWorktree` calls; returns only the small `worktreeSHAs` summary
  (base/head SHA + changed file paths), not the worktree contents. The base SHA
  it reports is the **merge base**, see above.
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

The delta's own base is normalized to the **merge base** too
(`refreshIngestDelta` resolves it right after its `ensureCommits`, before the
`baseSHA != prevBase` comparison that falls back to a full ingest). It has to
be: `pollIngestRefresh` signals the raw `baseRefOid`, so without it every commit
landing on develop would read as a moved base and force a needless full
re-ingest. With it, that fallback fires only on a real **rebase** or a
base-branch **merge into the head** — exactly what it is for. Idempotent for the
caller that already passes the stored (already-resolved) base,
`refreshTreeAfterLanding` in `chat_merge.go`. A PR ingested before this existed
still holds a `baseRefOid` in `pr_ingest`, so it takes one full fallback and is
normalized from then on.

**A delta may never WIDEN the PR's file set.** The delta is
`prevHead..headSHA`, so a reviewer merging the **base branch into his own
branch** (a `Merge remote-tracking branch 'origin/develop'` commit landing on the
head) makes that diff list every file develop touched meanwhile — hundreds of
files that are not part of the PR at all, each stored as PR blocks and then
explained, AI-warned about and waiting to be approved. Measured on PR 13535:
GitHub reported 15 changed files, the blocks table held **108**, with blocks from
Accounting/Themes/Notifications the PR never touched. The base-SHA guard below
does not catch this on its own — `refreshTreeAfterLanding` (`chat_merge.go`)
deliberately pins the recorded base so a landing stays a fast delta, and the
poller's own `headSHA == prevHead` skip fires before the base check, so once
widened a PR stayed widened forever.

`refreshIngestDelta` therefore intersects its file set with the PR's **own**
changed files (`prLocalChangedFilePaths`) and prunes blocks already stored
outside that set (`pruneBlocksOutsidePRFiles`, `db.go`), so a widened PR heals
itself on the next refresh instead of needing a manual "Regenereren". Best-effort:
a local diff failure (a SHA somehow not fetched) means no filter and no prune
rather than a failed refresh, and an **empty** file list is treated as "we don't
know", never as "this PR has no files". Side effect worth knowing: a rename's
OLD path — which the `--no-renames` delta lists so its stale rows get deleted —
is not in this set either (`changedFileNames` also runs `--no-renames`), so its
blocks are pruned rather than kept as a loose removed side; that matches what a
full ingest stores for a rename.

#### A delta refresh must not depend on `gh` for its own widening guard

(Its base is the PR's **own** target branch — `baseRefName`, threaded as
`PRStateSignal.BaseRef` / `meta.BaseRefName` — not the repo default: for a PR
targeting another feature branch, diffing against develop counted every file
of that branch as a PR file. Empty still falls back to `baseBranchFor(repo)`.)

`prLocalChangedFilePaths` computes the PR's file set purely from **local git**
— `changedFileNames(baseSHA, headSHA)`, the already-resolved **merge base**
against head, the same three-dot comparison GitHub's own "Files changed" tab
is built on (see "The base side is the MERGE BASE" above). It used to be
`prChangedFilePaths` → `fetchPRMeta`, a **fresh `gh pr view --json files`**
call made at refresh time — the exact same source a full ingest scans, which
sounds equally authoritative, but isn't: GitHub's own `files` list can still
be **computing right after a push** and briefly under-report, the same kind
of race the `ghFilesPageSize` truncation guard elsewhere in this file already
works around. A refresh that happened to land in that window silently
dropped every just-pushed file from `filterToPRFiles`'s result (one
`log.Printf("... skipped")`, no error) — and then still saved the new
`headSHA` as `prevHead` regardless, so the very next poll saw
`headSHA == prevHead` and skipped the refresh entirely. Nothing about that
file ever surfaced again until a manual "Regenereren" (full ingest, which
takes a **fresh** `gh pr view` and no longer races against the delta's own
narrower timing window).

Found on PR 13810 (`app/Events/Subscriptions/SubscriptionStateEvent.php`,
reviewer: "waarom zie ik ... niet aangepast, maar wel op github"): the
recorded ingest's own event history
(`data/workflows/170b90296c40222e39a1b196.events.jsonl`) showed a full ingest
had run against an OLDER head with only 16 files in `meta.Files`; a later
delta refresh advanced `pr_ingest` to the PR's current head (confirmed via
`git diff` between the stored base/head SHAs, which already contained the
file) without ever adding 13 of the meanwhile-touched files, including this
one — because whichever `gh pr view` snapshot that refresh queried had not
yet caught up with the just-landed commits. A **local** merge-base..head diff
cannot lag like that: `baseSHA`/`headSHA` are already fetched into the clone
by the time `refreshIngestDelta` gets here (its own `ensureCommits` ran
first), so the diff is exact and instantaneous, no network involved. Tests:
`TestPRLocalChangedFilePathsUsesLocalGitOnly`,
`TestRefreshIngestDeltaKeepsAJustPushedFile` (`ingest_delta_test.go`) —
the latter reproduces the PR 13810 symptom end to end with a throwaway local
git fixture (`setupChatShadowRepo`), deliberately needing **no** `gh`
stub/fake at all: that absence is exactly what the fix buys.

**A filtered file never holds the recorded head back.** For a while
`refreshIngestDelta` deliberately skipped `saveIngestSHAs` whenever
`filterToPRFiles` dropped anything, so the next poll would "retry". With a
local-git filter that retry can never turn out differently: a delta file
missing from merge-base..head is identical at the merge base and the head,
so it is provably not part of the PR. On PR 13810 one submodule pointer
(`modules/Ai`), set back to its base value inside the delta, made every poll
tick redo the same delta + reanchor + `buildRelations` + `code_warning` and
publish a fresh `blocks.changed`, forever. Reviewer decision: always save the
head. Test: `TestRefreshIngestDeltaSavesHeadEvenWhenSomethingWasFiltered`.

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

### `scanClassMembers` + `splitClassHeaderMembers`: every property/constant IS its own block

`phpscan.go` exports a member splitter — it cuts a class body (in practice the
`<class-header>` region) into its `;`-terminated property/constant
declarations, reusing the same lexer primitives as `scanPHP` so a `;` inside a
string/comment/heredoc/bracket pair never ends a statement. `scanClassMembers`
also tracks the leading `#[...]` attribute run and `/** ... */` PHPDoc directly
above each declaration, exactly like `scanPHP` does for a function
(`pendingAttrLine`/`pendingDocLine`/`pendingDocText`), and reports them as
`classMember.BlockLine`/`.Doc`.

`splitClassHeaderMembers` then **replaces** every coarse `<class-header>` block
with one block per member plus, when anything is left above the first of them
(the class's `use Trait;` statements), a residual `<class-header>` block
covering just that. So a member is an ordinary `Block`: its own id, category,
diff, **approval** and row in the block index. Reversed on explicit request —
"header moet opgedeeld worden in losse blokken die per stuk goedgekeurd moeten
worden" — after the older "a member never becomes a Block" rule left a changed
constant unapprovable on its own and, once its cards hung off a sibling method,
put its changed rows in no approval counter at all.

Each member block spans `BlockLine..EndLine`, so its attributes ride along **as
code** in its own diff ("attributes moet je ook als code erboven laten zien")
while the PHPDoc's free text becomes `Block.Description` ("neem description mee
als blok description") — and is therefore stripped from the displayed code by
the same `stripLeadingPhpDoc` that already does this for a method.

Deliberate boundaries:

- **No overlap**, so no line is counted or approved twice: the residual header
  stops one line before the first member block starts. A residual holding only
  blank lines is dropped, so the common class whose header is nothing BUT
  constants/properties has **no `<class-header>` row at all** any more.
- Content between two members that belongs to neither (a blank line, a loose
  `use Trait;` after the first constant) belongs to no block — the same
  pre-existing hole as the blank lines between two methods.
- A member whose `Class::Name` symbol another block in the same file already
  owns (a method named exactly like a constant — legal PHP, vanishingly rare)
  is left inside the header instead, because `extractBlockSource`/`blockstats`
  resolve a block by that symbol and would otherwise read the wrong one.
- **`scanBlocksRaw` is the unsplit view**, and the callresolve analysis uses it
  wherever it wants a header region as ONE text: rule 9
  (`resolveClassMembers`), rule 6b (`classConstDecl`) and the `symbolIndex`
  itself, so no member block ever enters the call-resolution index. Everything
  dealing in STORED blocks (the ingest pipeline via `parse_pool.go`,
  `/api/code`, `blockstats`, `blockmove`) must use `ScanBlocks`, or a member
  block's own symbol will not resolve. Same split for
  `extractBlockSource`/`blockSource` vs `extractBlockSourceRaw`/`blockSourceRaw`
  (`code.go`).

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

### An edited PHPDoc stays visible as code instead of being folded away

Reviewer request: a PHPDoc that was actually *edited* between old and new
should read as a real code change, not disappear into the fold/strip above.
`enrichedCodeSides(oldCS, newCS)` (`codesig.go`) is the paired sibling of
`enrichedCodeSide`: when a block already carried a leading PHPDoc on **both**
old and new, and that raw doc text (`leadingPHPDocRaw`, `strings.TrimSpace`d)
actually differs, the doc is left fully visible as ordinary code on **both**
sides instead of being folded/stripped — only `trimTrailingBlankLine` still
applies. It also reports `docChanged`, which `api.go`'s `handleCode` adds to
`/api/code`'s JSON (`"docChanged"`) so `Block.mjs` can hide the separate
`Block.Description` strip for that block (`b.code.docChanged` in the
description-toggle condition) — the same text is already visible in the diff,
so showing it twice would be redundant.

**Deliberately narrow scope:** this only fires when BOTH sides already have a
leading PHPDoc. A PHPDoc that was newly added, fully removed, or belongs to a
block that was itself added/removed keeps the ordinary fold/strip behavior —
that is a different kind of change than "an edit to an existing PHPDoc" and
was out of scope for this request.

**Used at both places `enrichedCodeSide` used to be called on an old/new
pair** — `api.go`'s `handleCode` and `blockstats.go`'s `blockAlignedRows` —
so the diff display and the approve-counter total (`blockChangedRowCount`)
stay in lockstep: a changed PHPDoc now counts toward the approve total like
any other visible changed line. The single-side call sites (the embedded
"Underlying code" children above, which have no old/new pair to compare)
keep calling `enrichedCodeSide` directly, unchanged.

Test: `codesig_test.go` (`TestEnrichedCodeSidesKeepsDocVisibleWhenDocChanged`,
`TestEnrichedCodeSidesFoldsWhenDocUnchanged`).

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

## `tsscan.go`: TypeScript function/class splitting

Reviewer request: "ook ts files wil ik opslitsen (net als php) voor nu te
beginnen met functions" — a `.ts` file used to always go down `ScanBlocks`'
generic non-`.php` fallback (`wholeFileBlock`), so the whole file was ONE
block regardless of how many functions it touched (found on PR 13538,
`modules/Pages/…/google/tag-manager/v2.ts`: 8 changed functions all glued
into one giant "modified" block). `ScanBlocks` now dispatches `.ts` to
`scanTS` (`tsscan.go`), a lighter sibling of `phpscan.go` — same pragmatic
style (regex + brace/paren counting over a source with strings/comments
blanked out first, not a real parser), deliberately much smaller scope.

A class's own methods are ALSO split out (added later, see "Class
splitting" below, PR 13885) — the original v1 landed with "no classes/methods
at all" as an explicit boundary; that boundary is gone, only the
free-function scope description below still says "v1" for the two original
shapes.

### What counts as a block (v1: two shapes, both requiring a `{ ... }` body)

1. `function name(...) { ... }` — optionally `export`/`export default`/
   `async`, optional generator `*`.
2. `const|let|var name = (...) => { ... }` — optionally `export`/`async`.

Both must be **top-level** (brace-depth 0 — `scanTSFunctions` walks the whole
masked file counting `{`/`}`, so a nested top-level region that isn't one of
these two shapes, e.g. a `declare global { interface Window { ... } } ` block,
is correctly walked through without derailing the depth count) and must have a
real **block body**. An **expression-bodied arrow** — `=> x.foo`,
`=> ({ ... })` — is deliberately **out of v1 scope**: `skipToTSBodyOpen` looks
for the first `=>` at the declaration's own nesting depth and requires the
very next non-whitespace character to be `{`; anything else means no block at
all, silently (same "silently nothing" precedent as several PHP callresolve
rules) — the file still gets its OTHER, block-bodied functions split out, it's
only that one expression-bodied function whose diff stays invisible unless a
sibling change happens to fall inside a block-bodied function's own span.
Measured on PR 13538: 9 of the file's changed/added top-level functions are
block-bodied and get their own block (including `firePurchaseEvent` and
`trackEvents`, see the callresolve section below); `isPaid`,
`buildPurchaseItems`, `buildPurchaseEvent` (all expression-bodied) don't.

**A leading JSDoc IS pulled into the block, like PHP's PHPDoc** (reviewer
request, "trek het gelijk met PHP"; this reverses the original v1 "no JSDoc
inclusion" boundary). `tsBlockWithJSDoc` (`tsscan.go`) is used for every
top-level function/arrow and every class member: when the declaration is
directly preceded — only whitespace in between — by a `/** ... */` that opens
its own line (`tsLeadingJSDoc`), `Block.Line` moves up to that `/**` and the
doc's prose becomes `Block.Description` via the very same `phpDocDescription`
(JSDoc and PHPDoc share the delimiter and the "prose first, `@tags` after"
shape). The class splitter's residual `<class-header>` stops before a member's
doc, so no line belongs to two blocks. Display then goes through the existing
PHP path: `enrichedCodeSide` clips the leading doc (its text is on the card's
description strip instead), and `enrichedCodeSides`' "doc edited on both sides
stays visible as code" rule applies unchanged. One difference, by design: a TS
block **never gets the `@return`/`@param` type fold** — its signature already
has real types and a JSDoc `@return {T}` is not PHPDoc syntax to splice in.
`enrichedCodeSideFor`/`enrichedCodeSidesFor(file, …)` (`code.go`/`codesig.go`)
skip only that fold for a `.ts` file; `/api/code`, `blockstats` and
`resolveTSCalls`' embedded child snapshots all use the file-aware variant. A
plain `/* */` or `//` comment is never pulled in; a decorator between the doc
and the declaration breaks the "directly above" rule (the doc then stays out).

**A block never starts on the blank line above its declaration.**
`reTSMethodDecl`/`reTSComputedMethodOpen` used `\*?\s*` between the optional
generator `*` and the name, and `\s*` also matches a newline: an unmodified
method's match started on the empty separator line above it. When a PR inserts
a new method right above an untouched one, git's diff marks exactly that blank
line as the added one, so the untouched method classified as "modified" with an
identical old/new body — a card with no diff rows, no row navigation and no
code preview in the chat (PR 13885, `#refreshOrCreateCookie`). Both regexes now
use `\*?[ \t]*`. Tests: `TestScanTSUnchangedMethodAfterAddedMethodIsNotModified`,
`TestScanTSClassMethodJSDocPulledIntoBlock` (`tsscan_test.go`),
`TestEnrichedCodeSideForTSClipsJSDocWithoutTypeFold` (`codesig_test.go`).

**Masking pass (`maskTSStringsAndComments`)**: every `'...'`/`"..."` string,
`` `...` `` template literal (the ENTIRE run up to the next unescaped
backtick — including any `${...}` interpolation content, deliberately left
fully opaque, same simplification PHP's heredoc handling makes) and comment
(`//`, `/* */`) is replaced with same-length spaces (newlines kept), so a
brace/paren character inside any of those never confuses the depth counting
that follows. Byte offsets between the masked copy and the original are
therefore identical, which is what lets `Block.Line`/`EndLine` be read
straight off the ORIGINAL source via `tsLineAt`.

**Finding a match's actual body**: after a regex match (which always ends
right at the parameter list's opening `(`), `matchTSParen` finds the matching
`)` by simple paren-depth counting (destructured params, default object/array
values, nested callback-parameter parens don't throw this off — they're just
more `(`/`)` characters). `skipToTSBodyOpen` then scans forward from there,
treating `(`/`[`/`<` as one combined "nesting" counter (so a generic return
type like `Promise<void>` or an array type like `number[]` doesn't hide the
real `{`/`=>`/`;` sitting at the declaration's own level) until it finds the
body open (or gives up — see the expression-body case above). `matchTSBrace`
then finds the matching `}` the same way `matchTSParen` finds its `)`.
Capped at `tsDeclScanCap` (4000 bytes) past the parameter list — mirrors
`ARG_LIST_MAX_ROWS`'s reasoning on the frontend (`home.mjs`): a return
type/annotation this long is pathological, and hitting the cap only ever
costs a missed block, never a wrong one.

**Deliberate v1 boundaries, not bugs — don't "fix" these without a fresh
request:**

- No `.tsx`/`.js`/`.mjs` — only `.ts`.
- No left-side type annotation on a top-level const/let/var arrow
  (`const x: Handler = (...) => {...}` is not detected — the arrow regex
  requires only whitespace between the name and `=`).
- No cross-file anything (see the callresolve section below).

Tests: `tsscan_test.go` (both declaration shapes, the expression-body
exclusion, a nested function not becoming its own top-level block, an
unrelated top-level `{ ... }` region like `declare global` not derailing the
depth count, strings/comments/template literals not confusing brace counting,
the whole-file fallback when nothing matches, and the `ScanBlocks` dispatch
itself).

### Class splitting (PR 13885): methods, generators, computed names, arrow fields

Reviewer request: a call from inside a TS class method (`this.#adoptHandedOverIds(params)`,
`resources/analytics/src/analytics.ts`, PR 13885) should surface the called
private method as "Onderliggende code" — impossible while the whole class was
one block. `scanTSFunctions` now also matches a top-level `class Name ... { }`
(`reTSClassDecl`, body found via the existing `skipToTSBodyOpen`/`matchTSBrace`
so an `extends X<T> implements Y` clause is skipped correctly) and recurses
into its body via `scanTSClassMembers`.

**Three member shapes**, mirroring `splitClassHeaderMembers`'s PHP precedent
(`.claude/docs/blocks-and-ingest.md`'s own `scanClassMembers` section above):
every recognised member becomes its own `Block` with `Class` set to the class
name (so `Block.symbol()`/`ID()` and the frontend's generic `x.class + '::' +
x.name` title composition need no change), and everything between the class's
opening brace and its first recognised member (field declarations, comments)
becomes ONE residual `<class-header>` block (`classHeaderSentinel`, reused
verbatim from `phpscan.go`) — "a part that can't be split goes in one block".
A class with **zero** recognised members contributes nothing at all, as if it
hadn't been detected as a class (same "silently nothing" precedent as an
expression-bodied top-level arrow).

1. **A method**, including a getter/setter (`get`/`set` as a modifier) and a
   generator (`*name(...) {...}`/`async *name(...) {...}`) — `reTSMethodDecl`.
   Anchored at the member's own physical **line start** (`(?m)^[ \t]*...`) so
   a call expression inside a method body (`this.init()`) is never mistaken
   for a declaration — a real member signature is always the first token on
   its line, a call site never is. A hand-picked `tsReservedWords` set
   additionally excludes a bare `if (`/`while (`/etc. from matching the same
   "name immediately followed by `(`" shape.
2. **A computed-name method** — `[<expr>](...) {...}` — `reTSComputedMethodOpen`
   finds the opening `[`, the new `matchTSBracket` (the bracket-counting
   sibling of `matchTSParen`) finds its matching `]`, and the block's `Name`
   becomes the bracket's own (trimmed) source text wrapped in brackets, e.g.
   `[Symbol.iterator]` — a deliberately literal, readable choice over
   inventing a synthetic name. Two computed members with differently
   formatted but equivalent expressions (whitespace aside) would collide —
   an accepted v1 edge case. A computed **field** (no `(` right after `]`,
   e.g. a TS index signature `[key: string]: number`) is correctly left
   unrecognised.
3. **A field assigned an arrow function** — `name = (...) => {...}`, optional
   modifiers and a single-line type annotation — `reTSFieldArrowDecl`, split
   into its own block just like a method (reviewer decision: WEL splitsen,
   unlike the top-level const-arrow's "no left-side type annotation"
   boundary above — a class field never has a `const`/`let`/`var` keyword to
   begin with, so the two aren't the same shape). A type annotation
   containing a real `=>` (e.g. a function type) is a known v1 gap: the
   regex's `[^\n=]*` stops at the first `=`, which would be the `=>` inside
   such a type — not observed in this codebase's style, accepted rather than
   solved with backtracking.

**Not pulled into a member's own span:** a decorator line (`@Foo()`) directly
above a member — unlike PHP's attribute pull, it sits in the header (if
before the first real member) or, between two members, in the same
documented "belongs to no block" gap `phpscan.go`'s own class-header
splitting accepts.

Tests: `tsscan_test.go` (`TestScanTSClassSplitsIntoMethodsAndHeader` — the
concrete analytics.ts shape: getter/constructor/method/private-method plus the
header block; `TestScanTSClassGeneratorAndComputedMethod`;
`TestScanTSClassArrowFieldMethod`; `TestScanTSClassWithNoMethodsEmitsNothing`).

### `resolveTSCalls` (TypeScript, same-file, Go-only) — the "Onderliggende code" link

Splitting the file into blocks alone does not make one call another's
"Onderliggende code" — that link is `resolve_call`'s job
(`.claude/docs/workflows-analysis.md`), and that whole machinery
(`buildSymbolIndex`, every numbered rule) is PHP-only, worktree-wide,
regex-on-PHP-syntax. `resolveTSCalls` (`tscallresolve_analysis.go`) is a
small, deliberately narrower TypeScript sibling: it re-scans the CALLER's own
file with `scanTSFunctions` to get its top-level function AND class-method
names, filters the caller's changed lines (`changedNewLines`/`fc.keepChanged`,
the same line-scoping every PHP rule uses — "only a call on a changed line
produces a child"), and for every OTHER same-file function/method whose name
appears as a call on those changed lines, emits a plain `callresolve.Entry`
(`Status: StatusResolved`, empty `Kind` → normalises to `method_call`,
`CallKey` = the bare name, `ChildClass` = the callee's own class, `""` for a
top-level function). See "Resolving (also unchanged) called methods" in
`.claude/docs/workflows-analysis.md` for the full mechanism and why no
frontend change was needed to scope/show it (`ChildClass` was already fully
generic downstream — `modules/callresolve`, `/api/callresolve`, `home.mjs`'s
`childClass ? childClass + '::' + childMethod : childMethod` block-id
composition — it was simply always `""` before class support existed).

**Deliberately loose, name-only matching — NOT scoped to the caller's own
class** (reviewer decision, extending the existing precedent rather than
narrowing it): a call resolves against ANY same-named function/method in the
file, top-level or on any class, same as two same-named top-level functions
already only ever resolved to whichever one `scanTSFunctions` happens to
return last for that name (`byName`, a `map[string]Block` — a real, accepted
limitation, not something this change fixes). Finding the **caller's own**
body is unambiguous even so: a separate `bySym` map, keyed on the full
`Class::Name` symbol (or bare `Name` for a top-level function), is used only
for that lookup, so a same-named method on an unrelated class can never be
mistaken for the caller's own definition (and thus never mis-slices its
changed-line text).

**A private method's call site needs its own regex shape.** `this.#foo(` has
`.` then `#` — both non-word characters — right before the name, and `\b`
never matches between two non-word characters. `reTSCallName` therefore skips
the leading `\b` for a name starting with `#`; a plain name keeps it (guards
against matching a stray suffix of a longer identifier).

Tests: `tscallresolve_analysis_test.go`
(`TestResolveTSCallsPrivateMethodSameClass` — the concrete analytics.ts
`this.#adoptHandedOverIds(params)` case;
`TestResolveTSCallsMatchesSameNameAcrossClasses` — the deliberately loose
match).

## Classification (`classify.go`)

### Sort order of the left list

`recomputeLeftList` (`home.mjs`) sorts by `rank(b)`, built right before the
sort call. Three bands, ascending: ordinary (non-TEST) blocks first — see
"most underlying blocks first" below — then TEST (fixed `2.39`), then
**relation children after everything** (rank `3`, the "Onderliggende code"
section at the bottom, see `recomputeLeftList`/`state.underlyingIds` in
`.claude/docs/underlying-code.md`). A comment-index item sits in its own
sub-bands around these (`-2` mentioned, `2.4` orphan/PR-wide, `2.5`
line-anchored — see `commentBlockItem`'s own doc comment).

The sort happens **after** the existing filters (resolved-call targets, search
term) and is a **stable** sort, so within a rank the original order stays
intact. That is what makes it safe for `sameFileNeighbour`/`stepBlock` (the
same-file connector + `↑`/`↓` flow-through, see
`.claude/docs/keyboard-navigation.md`): those look only at the direct index
neighbour in `state.blocks`, so an ordinary block's rank is deliberately keyed
on its **file**, never on the block itself — see below. `sel`/refresh restore
is unaffected (it looks up by block id/`file:line`, not index).

**Historical note:** this used to be a fixed Laravel-hierarchy category
priority (ROUTE first, then CONTROLLER, then everything else ordered by how
much of that category was still left to approve). Both the fixed
ROUTE/CONTROLLER tiers and the "most left to approve" heuristic were dropped
(2026-08-25, reviewer request: "ik wil daar niet meer naar kijken, kijk naar
de aantal onderliggende blokken") in favor of the ranking below. TEST always
sorting last is the one part of the old behavior that was kept unchanged.

### Ordinary blocks sort by "most underlying blocks first", per FILE, TEST always last

Reviewer request: "kijk naar het aantal onderliggende blokken. hoe meer, hoe
verder naar boven" — for every ordinary (non-TEST) block. TEST still always
sorts last regardless of its own count, unchanged from before.

`recomputeLeftList` computes this per recompute call, right before building
`rank`:

- **`fileUnderlyingCount`** sums, per **file** (not per block, and not per
  category — the fixed ROUTE/CONTROLLER tiers are gone), `nestedPrBlocks(b)
  .length` over every ordinary top-level block in that file (excluding
  "Onderliggende code" children — rank 3 — and excluding TEST). `nestedPrBlocks`
  is the same helper `subtreeApproveCount` uses for the sidebar pill: it walks
  the full recursive "Onderliggende code" subtree (children, their children,
  …), not just direct children.
- **Grouped per FILE, not per individual block**, for the same reason the old
  category grouping kept a file's blocks together: `sameFileNeighbour`/
  `stepBlock` only look at the immediate index neighbour in `state.blocks`, so
  ranking every block individually could split one file's own functions apart
  whenever they differ in underlying-block count — silently breaking that
  navigation. Summing per file and sorting FILES (blocks within a file keep
  their existing stable relative order) keeps a file's blocks contiguous.
- Deliberately **not** deduplicated across files: a descendant shared by
  several top-level blocks can be counted more than once, in more than one
  file's sum. Accepted — unlike the old `categoryRemaining`'s own-block-only
  choice (which existed specifically to avoid inflating a real number shown to
  the reviewer, see "Combined approval per tree" in `.claude/docs/approval.md`
  and the PR 13255 overcounting bug referenced there), this only drives a
  ranking, never a displayed total.
- **`fileOrder`** sorts those file paths descending by `fileUnderlyingCount` —
  a stable `Array.prototype.sort`, so two files tied on their count keep their
  existing relative order (no alphabetical tie-break).
- **`fileRank(file)`** maps an ordinary file onto a fractional value in
  `(0, 2.3)` — the file with the most underlying blocks gets the lowest
  fractional value, so the ascending sort below puts it first — safely below
  the comment ranks (2.4/2.5) and "Onderliggende code" (3). **TEST gets a
  fixed `2.39`**, i.e. it never competes on its own count and always sorts
  last, regardless of how many underlying blocks it has.
- A file with **zero** underlying blocks (the common case — most files have
  no relation children at all) sorts naturally to the bottom of this band,
  still **above** TEST.

**This only reshuffles at the existing `recomputeLeftList` trigger points**
(the initial load, `loadRelations`/`loadCallResolve`/`loadTestCovers`, and the
`indexComments()` watch — which also fires on the comments panel's own ~5s
poll tick, see `RelatedPanel.mjs`). Since the ranking no longer depends on
approval state at all, approving a block never moves anything in this band —
a stronger guarantee than before (the old count-based ranking specifically
avoided reshuffling on the approve path by not calling `recomputeLeftList`
there, see `toggleBlockApproval`/`toggleApprove`/`toggleCallApprove`; that
same omission still holds, it's just no longer load-bearing for this reason).
Test: `tests/index-category-order.spec.mjs` (PR 125,
`materializeCategoryOrderWorktrees` in `_setup.mjs` — four top-level blocks,
each with a known, distinct number of relation children via
`categoryorder-relations.json`: WORKFLOW=3, PROVIDER=2, CONFIG=1, TEST=5, TEST
deliberately the highest of the four to prove it still sorts last).

**This left-list order is a display grouping only — it is deliberately NOT
what a fresh open lands on.** `applyDefaultUnapprovedSelection` (`home.mjs`)
picks the first not-yet-approved ORDINARY block by `(file, line)` — plain
file order — rather than by this array's order, so "open a just-generated PR"
lands on the first block of the first-changed file, not on whichever file
happens to have the most underlying blocks, and (reversed 2026-08-20,
explicit reviewer request) ahead of any unresolved PR-wide comment item too —
a comment only wins the fresh-open pick when there is no unapproved ordinary
block at all. See `defaultSelectionRank`'s own doc comment in `home.mjs` for
the tie-break and the full reversal note.

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

Consequence when this landed: a module controller/request/resource block
changes category, so its badge changes too — but only after a **re-ingest**,
since `category` is stored per block row in `graph.db`. (The left-list
POSITION no longer depends on category at all — see "Sort order of the left
list" above — only the badge does.)

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

### A changed raster image is detected on BYTES, not on diff hunks

`git diff` reports only `Binary files a/x.png and b/x.png differ` for an image,
so `fd.changedNew`/`changedOld` are empty and a MODIFIED image's whole-file
block was dropped as unchanged — a changed `.png`/`.jpg`/… simply never reached
the review tree (an added/removed one did: `fileAdded`/`fileDeleted` come from
file existence in the worktrees, not from the diff). `classifyFile` therefore
also sets `modified` when `binaryImageChanged` — `isImagePath(path)` (the
`imageContentTypes` allowlist in `image_asset.go`) and the two sides' full
contents differ, which it already has in hand as `oldSrc`/`newSrc`.

That block deliberately **skips** the bare-`#[Test]` check above: that check
asks "is every CHANGED line a bare `#[Test]`?", which a file with zero changed
lines in the diff satisfies vacuously — it would drop the very block
`binaryImageChanged` just rescued. Tests: `image_asset_test.go`
(`TestClassifyFileSurfacesModifiedImage`).

### A raster image's "source" is one generated line, not its bytes

`extractBlockSource` (`code.go`) returns `imagePlaceholderSide`
(`image_asset.go`) for an image extension:
`binaire afbeelding (PNG, 12.4 kB, sha 1a2b3c4)`. It is the single place both
`/api/code` and `blockstats` read a side from (see "blockstats" in
`.claude/docs/approval.md`), so this one substitution keeps the whole row space
consistent: **one row, one Space to approve a changed image**, instead of the
hundreds of mojibake rows the raw bytes produced, and the AI passes
(`explain_code`/`code_warning`, via `blockSource`) get that line rather than
binary noise. The **sha is load-bearing** — without it both sides would carry
identical text, `alignRows` would see one unchanged context row and there would
be nothing to approve.

The image itself is served separately by `GET /api/image` and rendered by
`Block.mjs`'s `imageSlot`; the full picture (endpoint guards, the three `a`
stands, the overlay) lives in "IMAGE blocks" in
`.claude/docs/diff-render.md`.

### A changed submodule pointer (gitlink) has no readable file to diff

A git submodule is recorded as a **gitlink** (mode `160000`) — the path is a
**directory** in the worktree, not a file. `parseOneFile`'s ordinary
`os.ReadFile(baseDir/path)`/`os.ReadFile(headDir/path)` therefore fails on
**both** sides with "is a directory", which used to be misread as "absent in
base and head" (the same signal `fileAdded`/`fileDeleted` use for a real
add/delete) — both `oldBlocks`/`newBlocks` stayed empty and the change
silently never reached the review tree, with no error anywhere. Found on PR
13810 (reviewer: "ik zie de aanpassing niet van een andere submodule hash
aanpassing, dat wil ik wel zien").

`git diff` itself already carries the two commit hashes as an ordinary hunk
(`-`/`+` "Subproject commit `<sha>`" lines) preceded by an
`index <old>..<new> 160000` line — no `Binary files ... differ` shortcut like
an image gets. `parseUnifiedDiff` (`classify.go`) captures that: an
`index ... 160000` line sets `fileDiff.submodule`, and the following `-`/`+`
lines are captured verbatim into `oldCommitLine`/`newCommitLine` (in addition
to marking the changed line, as usual). `parseOneFile` (`parse_pool.go`)
checks `fd.submodule` **before** touching the filesystem at all: it builds
`oldSrc`/`newSrc` directly from those two captured lines (empty means "no old/
new commit" → a newly added/removed submodule) and scans/classifies exactly
like any other file from there. Since a gitlink path has no `.php`/`.ts`
extension, `ScanBlocks` falls through to its ordinary whole-file-block
default — no submodule-specific block shape, category, or frontend change
needed; it shows up like any other whole-file block, old/new text
`Subproject commit <sha>`. Tests: `classify_test.go`
(`TestParseUnifiedDiffCapturesSubmoduleCommitLines`,
`TestSubmoduleCommitChangeProducesModifiedBlock` — the latter uses a real
directory at the submodule's path in both worktrees to reproduce the original
"is a directory" failure).

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

**Display** (`Block.mjs`): the card shows the **old path above** the new
`file:line` line, marked `- oud` / `+ nieuw`. That stack is shared with the
moved/renamed BLOCK below and lives in `blockOldPathLine(b)` — see "Moved or
renamed block" for the markup and the arrow.js constraint. It used to be a
strikethrough on the old path only; the two markers replaced it so a moved file
and a moved method read identically (and like a diff).

**Boundaries.** Best-effort: a move git doesn't recognise as a rename at its
default `-M` threshold (~50% similarity) isn't in the map and simply stays
removed+added. Scope: only the **full ingest** — the delta refresh
(`refreshIngestDelta`, `parseFiles(… nil …)`) keeps its deliberate `--no-renames`
split (`changedFileNames`), so a rename appearing mid-refresh stays removed+added
until a full re-ingest.

Tests: `classify_test.go` (`TestRenamePairsBlocks`), `blockstats_test.go`
(`TestBlockChangedRowCountReadsRenamedOldPath`), `tests/rename-file.spec.mjs` (PR
104 fixture `tests/fixtures/rename-blocks.json`).

## Moved or renamed block (`blockmove.go`)

A method the PR **renamed** — or **moved** to another file/class — is stored as
**one** block, not as a loose `removed` + `added` pair. Without this the
reviewer gets two half-stories ("this code is gone", "this code is new") and no
diff of what actually changed inside the body, which is the only interesting
part of a rename.

`classify.go` cannot do this. It pairs old and new blocks on `symbol()` alone, so
a changed name is by definition two blocks; and it runs **per file** (one worker
per file, `parseFiles`), so it can never see a method that landed elsewhere.
Detection therefore runs **once, PR-wide**, over the finished block list —
`matchMovedBlocks` in **`blockmove.go`**, called from `parseFiles` just before the
stable sort, so **both** ingest paths (full ingest and delta refresh) get it.

### How a pair is found

Over the PR's unmatched `removed` × `added` blocks, in three widening steps so a
large PR can't turn ingest into an O(n·m·lines²) crawl:

1. **Size bound**, implied by the threshold rather than chosen: with
   `sim = 2·eq/(n+m)` and `eq ≤ min(n,m)`, a pair can only reach 0.75 when
   `max ≤ (2/0.75 − 1)·min` = 5/3·min. More lopsided → rejected without reading a
   line (`moveSizeRatio`).
2. **Multiset bound**: the number of shared whitespace-normalized lines, ignoring
   order, is a hard ceiling on the LCS — so a pair failing 0.75 here can never
   pass the real comparison. Exact-safe pruning, O(n+m), and it removes nearly
   everything in practice.
3. **The real similarity**, `2·eq/(n+m)` over `diffLines` (the same
   whitespace-insensitive LCS the diff itself uses), threshold
   **`moveSimilarity` = 0.75**. Capped at **`moveMaxPairs` = 2000** comparisons,
   taken in upper-bound order — hitting the cap means a rename goes undetected,
   never that a wrong pair is made.

Bodies are compared with blank and brace-only lines dropped, and a body under
**`moveMinLines` = 5** compared lines never takes part: two unrelated trivial
accessors sharing a one-line body otherwise score a perfect match.

**Conservative on purpose** — a false pair *hides* a genuinely removed method
behind a coincidentally similar new one, which is worse than missing a rename.
Measured on PR 13394: `getIndexCommissionsForPartner` → `getAsPartner` scores
0.82 and pairs; its sibling `getIndexCommissionsForTenant` → `getAsTenant`
scores 0.743 and deliberately does **not**. Raising the threshold is cheap;
lowering it is what needs evidence.

Everything is deterministic — no AI, no clock, and every ordering (candidates,
scored pairs, greedy assignment) breaks ties on block id, never on map iteration
order. A re-ingest must produce the same blocks, or a block id moves out from
under the comments and approvals hanging off it.

### What a pair becomes

The **new** block survives, `Status = modified`, gaining the old block's identity
in `OldFile`/`OldClass`/`OldName`/`OldLine` (`model.go` → columns
`old_class`/`old_name`/`old_line`, light `ALTER TABLE` migrations like
`old_file`). `Class`/`Name`/`Line` stay the head ones, so the block id keeps
living on the head symbol. The old block is **dropped** — its "Verwijderd" row
disappears from the startpoints, and anything keyed to its block id (approvals,
comments) is orphaned. That is accepted: the code is presented anew as an
old-vs-new diff.

`mergeMovedBlock` takes the old block's **`oldPath()`**, not its `File`: inside a
git-renamed file both sides already carry the new path in `File` and the
pre-rename one in `OldFile`. `FileDeleted` is deliberately **not** inherited —
the whole point is that this code did not disappear.

`Block.oldSymbol()` mirrors `Block.oldPath()`, and the two together are what make
the old side readable: `/api/code` (`oldFile`/`oldClass`/`oldName` query params,
sent by `ensureCode` in `home.mjs`; `oldClass` is only honoured together with
`oldName`) and `blockAlignedRows` (`blockstats.go`) read the base worktree at the
pre-move path AND symbol. Miss either and the old side comes back empty and the
whole body counts as one big addition.

### Display

`Block.mjs` exports three helpers, all reused by `BlockList.mjs`:

- **`movedLabel(b)`** — the word: "Hernoemd" when the name changed, "Verplaatst"
  for a pure move. Null for every other block, *including* a bare git-detected
  file rename (no `oldName`), which keeps reading as its plain status word. The
  word carries the meaning; the badge colour is decoration (the reviewer is
  colourblind). Shown as the card's status badge and as `movedPill`
  (`data-testid=block-row-moved`) in the startpoint list.
- **`blockOldLabel(b)`** — the pre-move `Class::method`, stacked as `- oud` above
  the card title's `+ nieuw` (`data-testid=block-old-label`). Null when the
  symbol is unchanged. A cross-file move that keeps its name but changes class
  still shows it — the class *is* the change.
- **`blockOldPathLine(b)`** — the pre-move `path:line`, stacked as `- oud` above
  the card's `+ nieuw` path (`data-testid=block-old-path`). Covers both sources
  of a move: a git file rename (`oldFile` alone) and a method-level move
  (`oldLine`, plus `oldFile` when it landed in another file).

Both stacks are a `${() => …}` slot inside a **stable** `flex-col` element root,
never a bare toggling expression — the pitfall in
`.claude/rules/arrowjs-pitfalls.md`. The `+` prefix on the new line is a plain
string binding (`(blockOldLabel(b) ? '+ ' : '') + b.label`), so no extra
conditional template is involved.

### Boundary: the delta refresh sees only its own files

`refreshIngestDelta` rescans only the files changed since the last ingest, so
`matchMovedBlocks` only sees those files' blocks. A move whose source **and**
target are both in that delta pairs normally (the usual case — a move touches
both files). If only the target is, the old `removed` block stays in the DB as a
loose row until a full "Opnieuw genereren", because `upsertPRFileBlocks` is
scoped to the rescanned files and never touches the source file's rows.

Tests: `blockmove_test.go` (same-file rename, cross-file move, best-of-several
candidates, a below-threshold pair staying split, the tiny-method guard, and the
old side read through `blockAlignedRows`) and `tests/block-moved.spec.mjs` (PR
122 fixture `tests/fixtures/blockmove-blocks.json` +
`materializeBlockMoveWorktrees`).
