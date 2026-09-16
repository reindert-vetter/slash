// Per-worker isolated server. Each Playwright worker gets its own seeded SQLite
// DB (and, since newTasks puts the workflow/comments/relations/... DBs next to
// it, its own copy of ALL write state) plus its own Go server on its own port.
// The read-only base/head worktrees under tests/.tmp/data (TEST_DATA_DIR,
// materialized by globalSetup and passed to every worker via -data) stay
// shared — the live data/ tree is never touched. This removes the
// cross-worker write races (comment/workflow SQLite contention) and page-load
// contention that made the suite flaky under a single shared server, and lets us
// scale workers freely.
//
// The harness forces both SLASH_GITHUB=off and SLASH_CLAUDE=off on every
// worker server, regardless of the invoking shell's environment — the suite
// must never touch the real network. Without a forced SLASH_CLAUDE=off, a
// worker started from a shell that hadn't exported it would shell out to the
// real `claude` CLI for the automatic call-resolution search (resolve_call),
// which stalls/times out and made comment-flow specs (e.g.
// repro-live-comment.spec.mjs) fail non-deterministically depending on how the
// suite happened to be invoked. No spec exercises a non-Fake claude client —
// the LLM-resolved paths are covered via seed fixtures (see
// tests/fixtures/callresolve.json) — so forcing the Fake everywhere is safe.
//
// The binary is built once by globalSetup (_setup.mjs); here we only seed + spawn.
// Spec files import { test, expect } from './_fixtures.mjs' instead of
// '@playwright/test' so every page.goto() targets this worker's own server via the
// baseURL override below.
import { test as base, expect, request as apiRequest } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { TEST_DATA_DIR } from './_setup.mjs'

const BIN = path.resolve('tests/.tmp/slash')

// APPROVAL_RESET_PRS — the fixture PRs whose stored approvals the auto
// `_cleanApprovals` fixture below wipes before every test: the shared main
// anchor (12903) plus every small fixture PR some spec approves (95's tree,
// 102's Shift+range selection, 106's drilled line-skip, 107's translation
// keys, 108's fresh-open default, 110's test-class grouping, 112's line
// underlying-summary/list-mode-children continuation, see
// findnextunapproved-list-mode.spec.mjs).
// Add a PR here as soon as a new spec approves anything on it durably.
const APPROVAL_RESET_PRS = [95, 102, 106, 107, 108, 110, 112, 125, 12903]

// seed replicates the seed passes the old webServer command ran: the main
// blocks fixture (PR 12903), the relations/callresolve fixtures (PR 90/91),
// the testcovers fixtures (PR 92/93/94), the tree-descent fixture (PR 95,
// see _setup.mjs's materializeTreeWorktrees + postapprove-tree.spec.mjs), and
// the empty-child-code fixture (PR 96, related-empty-code.spec.mjs), the
// deleted-file fixture (PR 98, removed-file.spec.mjs), and the tests-group
// fixture (PR 99, related-tests-group.spec.mjs).
// Everything lands next to the DB (tests/.tmp/w<n>/), so the worker is isolated.
// SEED_ENV points every `slash seed` invocation at the throwaway test data tree,
// so the repo registry it reads is TEST_DATA_DIR/settings.json (materialized by
// _setup.mjs) and never the developer's live data/settings.json. Without this a
// fixture block carrying a "repo" would be resolved against the wrong registry.
const SEED_ENV = { ...process.env, SLASH_DATA: TEST_DATA_DIR }

function seed(db) {
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/blocks.json'], { stdio: 'ignore', env: SEED_ENV })
  // The SECOND repo's fixture PR (plug-and-pay-ops#12) — its blocks carry a
  // "repo", so they land under that repo's key (see tests/tree-multi-repo.spec.mjs).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/ops-blocks.json'], { stdio: 'ignore', env: SEED_ENV })
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/relations-blocks.json',
      '-relations',
      'tests/fixtures/relations.json',
      '-callresolve',
      'tests/fixtures/callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/testcovers-blocks.json',
      '-testcovers',
      'tests/fixtures/testcovers.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/tree-blocks.json',
      '-relations',
      'tests/fixtures/tree-relations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // PR 101 — drill-listener-array-dispatch.spec.mjs's LOCAL PATCH 4 regression
  // fixture (see materializeDrillChurnWorktrees, tests/_setup.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/drillchurn-blocks.json',
      '-relations',
      'tests/fixtures/drillchurn-relations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Footer AI-explanation fixture (PR 97, footer-explanation.spec.mjs): a
  // block whose change introduces an if-statement (worktrees materialized in
  // _setup.mjs) plus pre-seeded explanations, so the footer renders the AI
  // description without an LLM run (a fixture row's empty codeHash matches
  // any hash — see loadExplanations/updateFooter in home.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/explain-blocks.json',
      '-relations',
      'tests/fixtures/explain-relations.json',
      '-explanations',
      'tests/fixtures/explanations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // MAX_EXPLAIN_LINES range fixture (PR 116, footer-explanation-range.spec.mjs):
  // one block with three separate 2-row change groups, split by 3-row
  // unchanged filler runs each (worktree materialized in _setup.mjs,
  // materializeExplainRangeWorktrees) — a Shift+ArrowDown range merging two
  // groups stays at/under the 10-row cap (seeded here, so the footer shows the
  // AI text with no LLM run), merging all three goes over it (deliberately NOT
  // seeded — footerUnitInfo must skip the request entirely, not just show a
  // "genereren…" placeholder for a row that happens to be missing).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/explainrange-blocks.json',
      '-explanations',
      'tests/fixtures/explanations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Orphaned-anchor fixture (PR 970600, comment-orphan-anchor.spec.mjs): one
  // block plus two seeded comments — one whose label no longer matches any block
  // and is marked anchorState 'orphan' by the re-anchor pass (see reanchor.go),
  // one still pinned to the surviving block. Seeded rather than driven through
  // the API because anchor_state is deliberately unreachable from the UI (the
  // reply signal handler drops action/anchor), and on its own 97xxxx PR number so
  // its comment count can't disturb another spec's assertions.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/orphan-blocks.json',
      '-comments',
      'tests/fixtures/orphan-comments.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Orphaned CHAT-ONLY-anchor fixture (PR 970602,
  // claude-other-tasks-orphan-jump.spec.mjs): one block plus one seeded
  // comment that is BOTH orphan (anchorState 'orphan', its label matches no
  // block, same as the PR 970600 fixture above) AND a bare, never-taken-over
  // Claude-chat anchor (its body is exactly CLAUDE_ANCHOR_PLACEHOLDER — "Chat
  // over deze regel" and nothing else ever typed). That combination is a
  // separate case from the orphan-blocks.json fixture above: such a comment
  // is EXCLUDED from indexComments/commentBlockItem (isChatAnchorPlaceholder,
  // see .claude/docs/claude-chat-panel.md's "A third dead end") and used to
  // get NO row anywhere at all — worse than the PR 970600 case, which at
  // least always got an ordinary 'comment:' row. Its own PR number, separate
  // from 970600/970601, so this spec's assertions can't be disturbed by (or
  // disturb) either of those.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/orphan-chatanchor-blocks.json',
      '-comments',
      'tests/fixtures/orphan-chatanchor-comments.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Stale-anchor (unpinned) fixture (PR 970601,
  // comment-stale-anchor-fold.spec.mjs): one block with three separate
  // change groups (worktree materialized in _setup.mjs,
  // materializeStaleAnchorWorktrees) plus one seeded comment marked
  // anchorState 'unpinned' — the row it hung on could no longer be
  // re-found by the re-anchor pass (reanchor.go), same reasoning as the
  // orphan fixture above for why this is seeded rather than driven through
  // the API. Its own PR number, separate from 970600, so this spec's
  // comment count/hint assertions can't be disturbed by the orphan fixture's
  // comments or vice versa.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/staleanchor-blocks.json',
      '-comments',
      'tests/fixtures/staleanchor-comments.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Empty-code fixture (PR 96, related-empty-code.spec.mjs): a resolved call
  // whose embedded childCode is empty — must render "geen code gevonden"
  // immediately, never "code laden…".
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/emptycode-blocks.json',
      '-callresolve',
      'tests/fixtures/emptycode-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Tests-group fixture (PR 99, related-tests-group.spec.mjs): a production
  // method with TWO covering tests (covered_by children) AND a resolved call
  // (a non-test child) — drives the horizontal tests bar in the
  // Onderliggende-code panel. Worktrees materialized in _setup.mjs
  // (materializeTestsGroupWorktrees) so the diff is keyboard-navigable.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/testsgroup-blocks.json',
      '-testcovers',
      'tests/fixtures/testsgroup-testcovers.json',
      '-callresolve',
      'tests/fixtures/testsgroup-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Call-arrow fixture (PR 100, call-arrows.spec.mjs): a caller with two
  // adjacent changed call lines — one resolves to a changed PR block (arrow),
  // one to an unchanged file (no arrow). Worktrees materialized in _setup.mjs
  // (materializeArrowWorktrees) so the diff is keyboard-navigable.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/arrow-blocks.json',
      '-callresolve',
      'tests/fixtures/arrow-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Line-summary per-line-anchoring fixture (PR 112,
  // line-underlying-summary.spec.mjs): a caller whose one change-group spans
  // two adjacent call lines, each resolving to a DIFFERENT changed PR block
  // — proves the two calls get their own independent per-line badge instead
  // of collapsing onto the group's first line. Worktrees materialized in
  // _setup.mjs (materializeLineSummaryWorktrees).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/linesummary-blocks.json',
      '-callresolve',
      'tests/fixtures/linesummary-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Migration→model / model-usage fixture (PR 101, migration-model.spec.mjs): one
  // caller with two class-level callresolve children (kind model_usage and
  // migration_model) — both must render a bare model-name label ("ProductGroup",
  // not "ProductGroup::") and a "model" badge, never the Class:: template used by
  // a regular method_call child.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/migrationmodel-blocks.json',
      '-callresolve',
      'tests/fixtures/migrationmodel-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Translation fixture (PR 107, translation.spec.mjs): a changed lang block
  // (resources/lang/nl/checkout.php → the changes-only key overview + the en
  // companion card) plus a caller with four resolved translation children (two
  // keys × nl/en, one en value deliberately missing). Worktrees materialized in
  // _setup.mjs (materializeTranslationWorktrees).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/translation-blocks.json',
      '-callresolve',
      'tests/fixtures/translation-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Translation-scroll fixture (PR 111, translation-scroll.spec.mjs): its own
  // lang block with 20 changed keys — dedicated PR number so it can grow
  // without disturbing PR 107's exact 3-key content assertions above.
  // Worktree materialized in _setup.mjs (materializeTranslationScrollWorktrees).
  execFileSync(
    BIN,
    ['seed', '-db', db, '-from', 'tests/fixtures/translationscroll-blocks.json'],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Enum-value translation fixture (PR 129,
  // related-translation-enum-scope.spec.mjs): a backed enum method whose
  // trans('includes.orders.' . $this->value) call resolves (via
  // resolveEnumValueTranslations, callresolve_analysis.go) to a translation
  // child whose FULL key never appears literally in the caller — only its
  // static prefix does. Worktree materialized in _setup.mjs
  // (materializeEnumTranslationWorktrees).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/enumtranslation-blocks.json',
      '-callresolve',
      'tests/fixtures/enumtranslation-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Deleted-file fixture (PR 98, removed-file.spec.mjs): one block whose whole
  // file was deleted by the PR (fileDeleted: true) plus a loose removed method
  // in a file that still exists — drives the "Verwijderd bestand"/"Verwijderd"
  // markers (card badge, sidebar pill, diff banner).
  execFileSync(
    BIN,
    ['seed', '-db', db, '-from', 'tests/fixtures/filedeleted-blocks.json'],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Moved/renamed-block fixture (PR 122, block-moved.spec.mjs): one method
  // renamed within its file and one moved to another file/class — both stored
  // as a SINGLE block carrying its pre-move identity in oldFile/oldClass/
  // oldName/oldLine, exactly as blockmove.go's PR-wide detection emits them
  // during a real ingest. Worktrees: materializeBlockMoveWorktrees.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/blockmove-blocks.json'], {
    stdio: 'ignore',
    env: SEED_ENV,
  })
  // Shift+arrow range-select fixture (PR 102, range-select.spec.mjs): two
  // same-file blocks — `execute` changes four contiguous lines (worktree
  // materialized in _setup.mjs, materializeRangeSelectWorktrees) so a
  // Shift+ArrowDown/ArrowUp multi-line selection has something real to
  // select/approve, and `other` is its same-file neighbour, used to prove the
  // range clamps at the block boundary instead of flowing into it.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/rangeselect-blocks.json'], {
    stdio: 'ignore',
  })
  // Onderliggende-code column-width fixture (PR 103, related-code-grow.spec.mjs):
  // one caller whose resolved child has a single very long CODE line (must grow
  // the column beyond its narrow default), and one caller whose child has an
  // equally long PHPDoc COMMENT line but only short code (must NOT grow it —
  // comment lines are excluded from the width calculation, see
  // codeGrowthChars/relatedColumnWidthCls in RelatedPanel.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/growcode-blocks.json',
      '-callresolve',
      'tests/fixtures/growcode-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Renamed-file fixture (PR 104, rename-file.spec.mjs): two blocks of a file
  // the PR moved (git-detected rename), each carrying oldFile (the pre-rename
  // path) alongside file (the new path) — drives the old-above-new stacked
  // path display in the block card. No worktrees needed (the path badge reads
  // b.oldFile/b.file directly).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/rename-blocks.json'], {
    stdio: 'ignore',
  })
  // Look-ahead-preview-width fixture (PR 105,
  // preview-matches-active-width.spec.mjs, Task 29): a one-sided `added`
  // block (selected, index 0) followed by a two-sided `modified` block (the
  // look-ahead preview, index 1) — worktrees materialized in _setup.mjs
  // (materializePreviewWidthWorktrees) so the preview's diff genuinely has
  // both an old and a new side to (correctly) hide.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/previewwidth-blocks.json'], {
    stdio: 'ignore',
  })
  // Drilled-column same-block-skip fixture (PR 106,
  // drill-approve-line-skip.spec.mjs): mold of the PR-95 tree fixture, but the
  // event_listener child has TWO adjacent changed lines (worktrees
  // materialized in _setup.mjs, materializeDrillLineSkipWorktrees) so
  // approving the first line via the palette, while a drilled Onderliggende-
  // code column owns the keyboard, has a second not-yet-approved line to jump
  // to WITHOUT the postApprove menu appearing in between.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/drilllineskip-blocks.json',
      '-relations',
      'tests/fixtures/drilllineskip-relations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Fresh-open default-selection fixture (PR 108,
  // fresh-open-default-selection.spec.mjs): two independent top-level blocks,
  // each with one real changed line (worktrees materialized in _setup.mjs,
  // materializeDefaultSelWorktrees) — its own PR number so it doesn't share
  // mutable approval state with PR 95 (which postapprove-tree.spec.mjs leaves
  // fully approved without cleanup).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/defaultsel-blocks.json'], {
    stdio: 'ignore',
  })
  // SVG-preview fixture (PR 109, svg-preview.spec.mjs): a changed `.svg` file
  // (worktrees materialized in _setup.mjs, materializeSvgWorktrees) — drives
  // Block.mjs's svgSlot, which renders old/new <img> previews INSTEAD of the
  // raw text diff for an .svg block. A second block carries a hostile
  // `<script>`/`onload=` payload to prove that preview never executes it.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/svg-blocks.json'], {
    stdio: 'ignore',
  })
  // Image-preview fixture (PR 130, image-preview.spec.mjs): a MODIFIED and an
  // ADDED raster image (worktrees materialized in _setup.mjs,
  // materializeImageWorktrees) — drives Block.mjs's imageSlot, which renders
  // the picture itself (via GET /api/image) instead of a text diff, and gives
  // the `a` split/unified/fit stands their image-shaped meaning (side by side
  // / stacked at 50% opacity / only the new one).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/image-blocks.json'], {
    stdio: 'ignore',
  })
  // Test-class-grouping fixture (PR 110, test-class-grouping.spec.mjs): two
  // TEST-category classes — TriggersIndexTest (two methods) and
  // SettingsStoreTest (a single method, proving a class is grouped even with
  // just one changed method — see testClassRowItem/recomputeLeftList in
  // home.mjs) — plus a plain non-test StoreHelper block (the methodes-kolom's
  // class-edge ↑/↓ exit lands on it, one row further in the index) —
  // worktrees materialized in _setup.mjs, materializeTestClassGroupWorktrees.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/testclassgroup-blocks.json'], {
    stdio: 'ignore',
  })
  // Comment-activity fixture (PR 970500, underlying-comment-activity.spec.mjs):
  // a parent action linked via an event_listener relation to a child listener
  // — exercises the sidebar's "there's an open comment somewhere in the
  // underlying code" indicator (state.commentActivity, commentActivityPill in
  // BlockList.mjs), which rolls up a comment anchored on the CHILD onto the
  // PARENT row (nestedPrBlocks). Its own PR number, per the
  // APPROVAL_RESET_PRS note above: a spec that places/resolves comments needs
  // a PR nobody else touches, so an exact count assertion never depends on
  // scheduling order.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/commentactivity-blocks.json',
      '-relations',
      'tests/fixtures/commentactivity-relations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Test-caller-hides-target fixture (PR 113, test-call-target-visible.spec.mjs):
  // one changed ACTION block plus one changed TEST method that resolved-calls
  // it. Regression for resolvedCallTargetIds/testCallTargetIds in home.mjs: a
  // resolved call whose CALLER is a TEST block must not hide the (changed,
  // reviewable) target from the index the way an ordinary production-to-
  // production call does — it stays visible, under the "Onderliggende code"
  // heading, mirroring the existing testCoverTargetIds exemption.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/testcallhide-blocks.json',
      '-callresolve',
      'tests/fixtures/testcallhide-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Footer-tasks-no-comment-nav fixture (PR 127,
  // claude-task-footer-no-comment-nav.spec.mjs): a parent block
  // (FooterTasksParentAction::run) linked via a relation to a child
  // (FooterTasksChildService::assist), so the parent has a real
  // "Onderliggende code" card to walk into — no worktree needed (same shape
  // as the comment-activity fixture below: RelatedPanel renders/keyboard-
  // navigates a related child regardless of whether real diff content
  // exists). The parent deliberately carries NO comment of its own, so →→
  // from it reaches cs.focus==='code' with codeSel===0 directly (no
  // 'comment'/'claude' stop in between) — the case ↑ from there must still
  // reach "Ook bezig elders" (enterFooterTasks) whenever another conversation
  // is running/recently finished elsewhere in the PR. Its own PR number per
  // the APPROVAL_RESET_PRS note above.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/footertasks-blocks.json',
      '-relations',
      'tests/fixtures/footertasks-relations.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Split-class-header fixture (PR 114, related-class-header-sibling.spec.mjs):
  // ImportSubscriptionStatsFlow is the main shape — a residual <class-header>
  // block, a changed method `run`, and BATCH_SIZE as its own member BLOCK
  // (splitClassHeaderMembers, phpscan.go) that `run` references, so the member
  // must lose its index row and render as a real block child while the header
  // keeps its own row. LonelyHeaderFlow is the no-block counterpart: an
  // UNCHANGED constant, which is no block and stays a read-only leaf card.
  // NoCardsFlow is a changed header PLUS a changed sibling with NO
  // class_member: callresolve row at all — a header is never hidden any more.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/classheader-blocks.json',
      '-callresolve',
      'tests/fixtures/classheader-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Class-member group/line scoping fixture (PR 115,
  // related-class-member-scope.spec.mjs): a class-member card attached to a
  // sibling method with two separate changed groups, only one of which
  // actually uses the constant — see materializeClassMemberScopeWorktrees
  // (tests/_setup.mjs) for the exact diff shape.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/scopemember-blocks.json',
      '-callresolve',
      'tests/fixtures/scopemember-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // PHPDoc-description fixture (PR 117, block-description-markdown.spec.mjs):
  // one block whose `description` carries a TWO-paragraph docblock summary
  // with a backticked identifier — the shape phpDocDescription now produces
  // ("\n\n" between paragraphs, see .claude/docs/blocks-and-ingest.md). Drives
  // the card's `block-description` strip, which renders that through
  // renderMarkdown instead of as one plain-text run. No worktrees needed (the
  // strip reads b.description directly, like the rename fixture's path badge).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/description-blocks.json'], {
    stdio: 'ignore',
  })
  // Module/layer-label fixture (PR 118, block-module-layer-labels.spec.mjs):
  // four blocks covering every shape of the module/layer/type path split
  // (src/blockPath.mjs, mirroring classify.go's splitBlockPath) — app as an
  // ordinary module name, an old-style flat module path, a new-style
  // module/layer/type path, and a plain-Laravel path with neither. No
  // worktrees needed (the pills read b.file directly, like the rename
  // fixture's path badge).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/modulelabel-blocks.json'], {
    stdio: 'ignore',
  })
  // Declaration-reference-unit fixture (PR 120, signature-ref-unit.spec.mjs):
  // a `status: "added"` block whose own declaration line is byte-identical in
  // base and head — see materializeSignatureRefWorktrees (tests/_setup.mjs)
  // for why that combination is real and reachable.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/signatureref-blocks.json'], {
    stdio: 'ignore',
  })
  // class_ctor:/class_method: group/line scoping fixture (PR 121,
  // related-class-ref-entry-points-scope.spec.mjs): a `Foo::class` reference's
  // entry-point cards attached to a caller with two separate changed groups,
  // only one of which actually carries the reference — see
  // materializeScopeClassRefWorktrees (tests/_setup.mjs) for the exact diff
  // shape (mirrors the scopemember fixture above).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/scopeclassref-blocks.json',
      '-callresolve',
      'tests/fixtures/scopeclassref-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // class_method: entry-point scoping fixture for rule 2b-bis's own origin
  // (PR 128, related-new-object-first-method.spec.mjs): a plain
  // `new Foo(...)` with no chained call, mirroring the scopeclassref fixture
  // above but for the `new Foo(` literal instead of `Foo::class` — see
  // materializeNewObjectFirstMethodWorktrees (tests/_setup.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/newobjfirstmethod-blocks.json',
      '-callresolve',
      'tests/fixtures/newobjfirstmethod-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Duplicate-call-target fixture (PR 124, related-duplicate-call-target.spec.mjs):
  // two different call keys of one caller resolving to the very same definition —
  // rule 6c-bis's `class_method:Foo` entry point next to the real `->m()` call —
  // once with the real call resolved by Go and once only by an LLM, so both
  // branches of callRowRank (home.mjs) are exercised. See
  // materializeDupTargetWorktrees (tests/_setup.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/duptarget-blocks.json',
      '-callresolve',
      'tests/fixtures/duptarget-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
  // Additions-only diff-view fixture (PR 123,
  // diffview-additions-only.spec.mjs): one `modified` block whose diff has no
  // removed/replaced line at all (worktrees materialized in _setup.mjs,
  // materializeAdditionsOnlyWorktrees) — home.mjs's allChangesAreAdditionsOnly
  // auto-jumps such a block's INITIAL diff-view stand to 'unified' instead of
  // the default 'split', which used to waste its entire empty old/left pane.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/additionsonly-blocks.json'], {
    stdio: 'ignore',
  })
  // "Most underlying blocks first, TEST always last" left-list ordering
  // fixture (PR 125, tests/index-category-order.spec.mjs) — worktrees
  // materialized in _setup.mjs's materializeCategoryOrderWorktrees.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/categoryorder-blocks.json',
      '-relations',
      'tests/fixtures/categoryorder-relations.json',
    ],
    { stdio: 'ignore' },
  )
  // Relation + callresolve pointing at the SAME target fixture (PR 131,
  // related-relation-callresolve-dup.spec.mjs): DiscountController::store
  // reaches DiscountResource::toArray both via a relation edge AND via three
  // callresolve callKeys that all resolve to it. See
  // materializeRelationCallresolveDupWorktrees (tests/_setup.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/relationcallresolvedup-blocks.json',
      '-relations',
      'tests/fixtures/relationcallresolvedup-relations.json',
      '-callresolve',
      'tests/fixtures/relationcallresolvedup-callresolve.json',
    ],
    { stdio: 'ignore', env: SEED_ENV },
  )
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('error', () => resolve(false))
  })
}

async function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await canConnect(port)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server on port ${port} did not start within ${timeoutMs}ms`)
}

export const test = base.extend({
  // Worker-scoped: one seeded DB + server per worker, torn down at worker exit.
  _server: [
    async ({}, use, workerInfo) => {
      const i = workerInfo.workerIndex
      const dir = path.resolve('tests/.tmp', `w${i}`)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const db = path.join(dir, 'test.db')
      seed(db)

      const port = 4200 + i
      // -data points every worker at the throwaway test data tree
      // (tests/.tmp/data) that globalSetup materialized, so a run never reads
      // — let alone writes — the live data/ tree. See TEST_DATA_DIR in
      // _setup.mjs for why that split exists.
      const proc = spawn(BIN, ['-db', db, '-data', TEST_DATA_DIR, '-addr', `127.0.0.1:${port}`, '-static', '.'], {
        env: {
          ...process.env,
          SLASH_GITHUB: 'off',
          SLASH_CLAUDE: 'off',
          SLASH_INBOX: 'tests/fixtures/inbox.json',
          // SLASH_JIRA=off avoids shelling out to the real `acli` CLI (not
          // installed in CI, and this must never touch the network) for the
          // pr_status tracker's Jira lookup and the code_warning/prmeta jira
          // submenu.
          SLASH_JIRA: 'off',
          // Embedded Claude chat (claude_chat workflow): programs the Fake's
          // RunChat replies so tests/claude-chat-panel.spec.mjs can exercise a
          // plain reply and a "question with choices" turn deterministically.
          // The script is walked with a cursor PER SESSION (see
          // claude.Fake.SetChatTurns), so every conversation starts at turn 1
          // — this one Fake is shared by every chat spec on the worker, and a
          // single consuming queue let whichever spec came second start at
          // turn 2 or 3 depending on the scheduler.
          SLASH_CLAUDE_CHAT_TURNS: 'tests/fixtures/claude-chat-turns.json',
          // summarize_chat (tests/claude-empty-composer-menu.spec.mjs, "Comment
          // hiervan maken" on an embedded Claude conversation): a plain string,
          // not a JSON fixture — there is only ever one canned summary needed.
          // Keyed by SystemPrompt (claude.Fake.SetOutputForPrompt, tasks_api.go),
          // so this can never leak into pr_status's own Haiku summary Activities,
          // which share ModelHaiku but carry their own distinct SystemPrompt.
          SLASH_CLAUDE_CHAT_SUMMARY: 'Claude legt uit dat de `total()` aanroep het orderbedrag optelt, en dat er geen bijzonderheden zijn.',
        },
        stdio: 'ignore',
      })
      try {
        await waitForServer(port)
        await use({ port })
      } finally {
        proc.kill('SIGKILL')
      }
    },
    { scope: 'worker' },
  ],

  // Override Playwright's baseURL so every page.goto('/pr/…') hits this worker's
  // own server.
  baseURL: async ({ _server }, use) => {
    await use(`http://127.0.0.1:${_server.port}`)
  },

  // Count in-flight fetches in the page itself, so appReady can wait for "the
  // app's own loads have landed" without Playwright's `networkidle` — which is
  // unreachable here (see appReady's own comment: the SSE stream never ends).
  // A counter around window.fetch sees exactly the app's XHR-ish traffic and,
  // by construction, nothing of EventSource — the one thing that has to be
  // ignored. Installed via addInitScript so it is in place before any module
  // script runs, on every document the test navigates to.
  page: async ({ page }, use) => {
    // The global failed-tasks dialog (src/failedTasks.mjs) opens over ANY page
    // as soon as GET /api/problems reports a failure in the last four days —
    // and with SLASH_GITHUB=off a worker's own store can easily hold one, on
    // top of the specs that stub that endpoint on purpose. A modal backdrop
    // would then swallow the keyboard of nearly every spec in the suite, so
    // it is pre-snoozed here (the same localStorage key its own "Negeer 5
    // minuten" button writes) — one suite-wide default with an opt-out,
    // exactly like the keepDescription wrapper below. A spec that means to
    // exercise the dialog itself calls enableFailedTasksPopup(page) before
    // navigating.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('failedTasksSnoozeUntil', String(Date.now() + 60 * 60 * 1000))
      } catch (err) {
        // storage blocked — nothing to suppress, and nothing to do about it
      }
    })
    await page.addInitScript(() => {
      window.__pendingFetches = 0
      const orig = window.fetch
      window.fetch = function (...args) {
        window.__pendingFetches++
        return orig.apply(this, args).finally(() => {
          window.__pendingFetches--
        })
      }
    })

    // A genuinely fresh /pr/<id> open (no ?sel= at all) now lands on stop 1
    // (the PR-description column, state.showDescription) instead of the
    // block-index — see loadBlocks' `!hadSelParam` branch in home.mjs. Almost
    // the entire suite predates that and drives the keyboard assuming the
    // block-index already owns it right after page.goto(), so wrap goto()
    // here — the ONE place nearly every spec funnels through — to press the
    // same → a reviewer would to skip past stop 1, restoring the pre-existing
    // default for every caller. A spec that means to exercise stop 1 itself
    // (or a fresh-open regression test) passes `{ keepDescription: true }`,
    // stripped before it reaches the real goto (Playwright's own goto()
    // rejects unknown options).
    const origGoto = page.goto.bind(page)
    page.goto = async (url, options = {}) => {
      const { keepDescription, ...gotoOptions } = options
      const result = await origGoto(url, gotoOptions)
      if (!keepDescription) {
        let path, search
        try {
          const u = new URL(page.url())
          path = u.pathname
          search = u.searchParams
        } catch {
          path = ''
          search = new URLSearchParams()
        }
        if (/^\/pr\/\d+/.test(path) && !search.has('sel')) {
          const info = page.getByTestId('pr-info-column')
          const appeared = await info
            .waitFor({ state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false)
          if (appeared) {
            // The block-search box grabs the keyboard ambiently on load (a
            // requestAnimationFrame right after mount, see leaveSearchBox's own
            // comment) — while it's focused, ArrowRight is handled by the
            // search-box branch of onKeydown (enters the diff), not the
            // earlier-in-the-chain showDescription branch, so it must be left
            // first. Same two-rAF-then-Escape idiom as leaveSearchBox, inlined
            // here to avoid a circular import (leaveSearchBox lives in this
            // same module).
            const box = page.locator('#block-search')
            if (await box.count()) {
              await page.evaluate(
                () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
              )
              await page.keyboard.press('Escape')
            }
            await page.keyboard.press('ArrowRight')
            await info.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
          }
        }
      }
      return result
    }

    await use(page)
  },

  // Auto, test-scoped: reset the shared fixture state (stored approvals, plus
  // the shared anchor PR's comments) before every test.
  //
  // The worker DB lives for the whole worker (one seed per worker, see above),
  // so an approval is DURABLE across tests AND across spec files that happen
  // to land on the same worker. Several specs deliberately approve block 1
  // (CreatePaymentAction::execute) of the shared main fixture — the palette
  // approve tests, postapprove-menu, review-submit-menu,
  // selected-reveal-hidden, sidebar-skip-approved, comment-revokes-approval —
  // and a FULLY approved top-level block is hidden from the sidebar by default
  // (state.showApproved, BlockList.mjs). Any later test that clicks
  // `[data-idx="1"]` then times out on a row that no longer exists, which read
  // as broad, unrelated flakiness across a dozen specs (whichever ones the
  // scheduler happened to run after an approving one). Several specs already
  // carried their own clearBlockApproval() helper precisely because of this;
  // doing it here once makes every spec order-independent instead, without
  // each having to know which of its neighbours approve what.
  //
  // Every fixture PR a spec ever approves is reset (APPROVAL_RESET_PRS), not
  // just the main one: PR 95 has exactly the same collision (drill-approve
  // approves its tree, postapprove-tree then wants both of its rows visible),
  // and that is precisely the hazard fresh-open-default-selection.spec.mjs
  // worked around by claiming its own PR 108. No spec seeds approvals outside
  // a test body (no beforeAll does), so resetting per test can't undercut
  // anyone's setup.
  //
  // Writes go through the sanctioned path — the approve workflow's `set`
  // Signal with an empty set removes the row (see workflows-write-boundary.md).
  _cleanApprovals: [
    async ({ _server }, use) => {
      const base = `http://127.0.0.1:${_server.port}`
      const ctx = await apiRequest.newContext({ baseURL: base })
      try {
        // Comments on the shared anchor PR go too: a PR-WIDE comment
        // (kind !== '') becomes a synthetic, navigable row in the "Start"
        // sidebar (commentBlockItem/recomputeLeftList, home.mjs), so one left
        // behind by an earlier spec shifts every row count and [data-idx]
        // position on 12903 for whatever runs next. Deleting goes through the
        // comment's own workflow `delete` Signal (its Run ID *is* the comment
        // id), i.e. the sanctioned write path.
        //
        // Only the shared anchor needs this: a spec that seeds comments on its
        // own synthetic PR (the 97xxxx range, see the note above) is already
        // isolated from every other spec by that PR number, and each such spec
        // was verified to still pass on a second run against its own leftovers
        // (every comment spec green under --repeat-each=2). Resetting all of
        // them here would cost a per-PR fetch on all ~290 tests for a race
        // nothing actually exhibits.
        const cs = await ctx.get('/api/comments?pr=12903')
        const comments = cs.ok() ? await cs.json() : []
        if (Array.isArray(comments)) {
          for (const c of comments) {
            await ctx.post(`/api/workflows/${c.id}/signals/delete`, { data: {} })
          }
        }
        for (const pr of APPROVAL_RESET_PRS) {
          const res = await ctx.get(`/api/approvals?pr=${pr}`)
          const rows = res.ok() ? await res.json() : []
          if (!Array.isArray(rows) || !rows.length) continue
          const start = await ctx.post('/api/workflows/approve', { data: { pr } })
          const { runId } = await start.json()
          for (const r of rows) {
            await ctx.post(`/api/workflows/${runId}/signals/set`, {
              data: { blockId: r.blockId, rows: [], calls: [] },
            })
          }
        }
      } catch {
        // Best-effort: a failed reset must never fail the test that follows.
      }
      await ctx.dispose()
      await use()
    },
    { auto: true },
  ],
})

export { expect }

// SEEDED_PR_BASE — the start of the dynamically allocated synthetic PR range.
// Deliberately above every hardcoded fixture number in use (the small 90-112
// worktree fixtures, the shared anchor 12903, and the handful of block-backed
// 97xxxx fixtures listed in SEED_PR_LITERAL_ALLOWLIST below), and far enough
// below them in spirit that a reader can tell at a glance that a 971xxx number
// was handed out by seededPr() rather than typed by hand.
const SEEDED_PR_BASE = 971000

// seededPrs maps "this exact test attempt (+ slot)" to the number it was given.
// Module-level and therefore PER WORKER PROCESS, which is exactly the scope
// that matters: a worker owns its own SQLite DB and its own server (see the
// worker fixture above), so two workers handing out the same number can never
// see each other's rows. Within a worker the tests run sequentially, so a plain
// insertion counter is already collision-free — no hashing, no registry.
const seededPrs = new Map()

// seededPr hands a test its own synthetic PR number for data it SEEDS at
// runtime (a placed comment, a started workflow) rather than reads from a
// pre-seeded fixture.
//
// Why this exists instead of a hand-picked literal: the worker DB lives for the
// whole worker, and comments have no reset hook (`_cleanApprovals` only wipes
// the shared anchor 12903 — see its own comment for why). So a number typed
// into two different spec files silently leaks one spec's comments into the
// other's exact count assertions, depending purely on which one the scheduler
// ran first on that worker. That is not a hypothetical: 970010 was shared by
// comment-author-avatar.spec.mjs and a navigate.spec.mjs test, and 970011 by
// comment-author-avatar.spec.mjs and comment-last-reply.spec.mjs. The
// convention "give a seeding spec its own number" was already written down and
// still got broken twice, because nothing enforced it — hence an allocator
// instead of a rule. tests/seeded-pr-literals.spec.mjs keeps new literals out.
//
// The RETRY is part of the key for the same reason: a retry reuses the same
// worker DB, so reusing the number would leave the second attempt looking at
// the first attempt's leftovers and failing every exact count.
//
// `slot` is for a single test that genuinely needs two isolated PRs at once
// (e.g. an anchored and a PR-wide comment side by side); leave it at 0 for the
// ordinary one-PR case.
export function seededPr(testInfo, slot = 0) {
  const key = `${testInfo.testId}:${testInfo.retry}:${slot}`
  if (!seededPrs.has(key)) seededPrs.set(key, SEEDED_PR_BASE + seededPrs.size)
  return seededPrs.get(key)
}

// appReady replaces `await page.waitForLoadState('networkidle')`, which ~109
// spec sites used as "let the app finish loading before I touch it".
//
// NEVER USE `networkidle` IN THIS APP. It waits for 500ms with zero in-flight
// requests, and this app never offers that:
//   • /pr/<id> holds `GET /api/events` (the multiplexed SSE stream, see
//     .claude/docs/server-events.md) open for the whole life of the page — an
//     in-flight request that by design never finishes. Measured: networkidle
//     times out 3/3 there, even on an otherwise idle box. Whether a spec
//     survived was pure luck: the stream opens on the first detail-column
//     render, so an idle window that happened to be sampled BEFORE that render
//     passed and everything after it hung for the full timeout. That is the
//     "flaky, worse under load" signature.
//   • /pr-overview has no stream but polls continuously (800ms
//     ingest stage, 1500ms repoll, 2500ms workflows, 5000ms comments, 15s
//     snapshot, 60s heartbeats), so under 4 parallel workers the quiet gap
//     between two polls shrinks below 500ms and idle is missed there too.
// Migrating a poller onto the SSE channel (the stated plan in
// server-events.md) makes this strictly worse, so the criterion had to go.
//
// What replaces it is deterministic and traffic-independent: the document's
// own `load` event, then the app's first render (#app has children — all three
// shells mount into it) plus, on /pr/<id>, the sidebar's search box, which is
// the same anchor leaveSearchBox already relies on to prove BlockList mounted.
// Two rAFs at the end settle the first paint (same idiom as leaveSearchBox).
//
// This is deliberately NOT "the data has loaded": every assertion in the suite
// polls (15s expect timeout) and every locator auto-waits, so callers never
// needed that — they needed "the app is mounted" before mounting a second
// component into the live page or sending keys at it.
export async function appReady(page) {
  await page.waitForLoadState('load')
  await page.waitForFunction(() => {
    const app = document.getElementById('app')
    return !!app && app.children.length > 0
  })
  if (/\/pr\/\d+/.test(page.url())) {
    // `.first()`/attached, deliberately NOT toHaveCount(1): a ~14-spec family
    // mounts a SECOND BlockList into this same live page, and evaluateSettled
    // calls appReady from its retry path — i.e. possibly with a half-finished
    // extra mount standing. Requiring exactly one would turn the recovery path
    // into a failure of its own.
    await expect(page.locator('#block-search').first()).toBeAttached()
  }
  // Then let the app's own one-shot loads land: no fetch in flight for 300ms
  // straight (the page-side counter installed by the `page` fixture, which
  // never sees the SSE stream). This is what `networkidle` was really buying
  // the ~14 specs that mount a second component into the live page: home.mjs
  // keeps pushing into shared module state as /api/callresolve, /api/testcovers
  // and /api/comments arrive — RelatedPanel's setRelated is a module-level
  // singleton — so injecting fixture data before those land gets it overwritten
  // a second later (approval.spec.mjs's per-child badges appeared and then
  // vanished, at ~50% under load).
  //
  // Bounded and non-fatal on purpose: the app polls forever (2500ms workflows,
  // 5000ms comments, …), so a busy box can genuinely never show a 300ms gap.
  // Missing the window then costs nothing — every caller's real assertions poll
  // for 15s anyway — whereas making it an assertion would reintroduce exactly
  // the hang this helper replaced.
  await page
    .waitForFunction(
      () => {
        if (window.__pendingFetches === undefined) return true // no counter (raw context)
        if (window.__pendingFetches > 0) {
          window.__quietSince = 0
          return false
        }
        if (!window.__quietSince) {
          window.__quietSince = performance.now()
          return false
        }
        return performance.now() - window.__quietSince > 300
      },
      null,
      { timeout: 5000 },
    )
    .catch(() => {})
  // Finally settle the first paint. The load-time history.replaceState burst
  // (see evaluateSettled below) can tear down the execution context
  // mid-evaluate; this settle is a nicety, not a guarantee, so a lost context
  // here is simply retried once and then let go.
  for (let i = 0; i < 2; i++) {
    try {
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      )
      return
    } catch (err) {
      if (i === 1) return
    }
  }
}

// leaveSearchBox replaces the `await page.keyboard.press('Escape') // leave the
// auto-focused starting-points search box` idiom that ~70 spec sites open with.
// That bare press is a race: home.mjs focuses the search box from a
// `requestAnimationFrame(focusSearchBox)` on load (a list-mode convenience, so
// the reviewer can type a filter straight away), and a press sent before that
// frame runs is handled while nothing is focused — then the rAF lands and the
// box takes focus anyway. Every later key is swallowed by onKeydown's
// searchActive branch, which does something entirely different from the
// key-with-nothing-focused path: ArrowRight becomes "step into the diff"
// instead of the navigation the spec was driving. That flaked
// comment-index-items.spec.mjs (`→` never entered the comment thread, so the
// thread's focus ring never appeared).
//
// So: let that rAF actually run first (two frames, so we are past it whether it
// was already queued or not), then press Escape and assert the box does not
// hold focus — that last assertion, not the press, is the real guarantee.
//
// Deliberately NOT `await expect(box).toBeFocused()` up front: plenty of call
// sites click a sidebar row before this (which moves focus off the box), and
// some load a page in diff mode, where home.mjs' load-time focus is guarded off
// entirely. Requiring the focus would fail there for no reason — the postcondition
// ("the box is not holding the keyboard") is what every caller actually needs.
// enableFailedTasksPopup lifts the suite-wide pre-snooze the `page` fixture
// installs (see its comment), so the global failed-tasks dialog really opens.
// Call it BEFORE page.goto — it works by clearing the localStorage key on
// every fresh document.
export async function enableFailedTasksPopup(page) {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('failedTasksSnoozeUntil')
    } catch (err) {
      // storage blocked — the dialog shows anyway
    }
  })
}

export async function leaveSearchBox(page) {
  const box = page.locator('#block-search')
  await expect(box).toHaveCount(1)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await page.keyboard.press('Escape')
  await expect(box).not.toBeFocused()
}

// evaluateSettled runs an in-page evaluate() that is resilient to the
// documented cold-start mount race (see "Playwright test infra" in
// .claude/rules/conventions.md). A fair number of specs mount a component by
// dynamically importing a module *inside* page.evaluate() against the live app
// page — they need index.html's Tailwind/Prism CSS for their computed-style and
// geometry assertions, so a bare fixture page won't do. Meanwhile home.mjs's
// bindUrlState watches fire a burst of history.replaceState during load, and
// that burst can tear down the very execution context the evaluate() is running
// in ("Execution context was destroyed"); under 4 parallel workers the dynamic
// import itself can also simply lose its race with a briefly saturated server
// ("Failed to fetch dynamically imported module"). No wait criterion
// guarantees the burst is over (`networkidle` least of all — it never fires on
// /pr/<id> at all, see appReady), so on exactly those two errors we re-settle
// via appReady and retry the whole evaluate.
//
// This started life as a local helper in approval.spec.mjs; it lives here now
// because every mounting spec needs it — relying on the config's `retries: 1`
// instead means a genuine, unrelated failure in the same spec file also gets a
// free retry, and it hides how often this race actually fires.
//
// A retry MUST NOT leave the previous attempt's mount standing. The tear-down
// can land anywhere in the body, including after `Block(b, …)(host)` has already
// appended and mounted a host — the second attempt then appends a second host
// with the same id, and `#some-host code.language-php` resolves to two elements
// instead of one. That is not hypothetical: it flaked diffview.spec.mjs's
// one-sided-removed-block test with "Expected 1, Received 2" and two identical
// <article>s in the failure snapshot. So before every retry we remove whatever
// the failed attempt appended to <body>.
//
// Identifying that without knowing each spec's host id: mark the pre-existing
// body children with a data attribute (DOM state, so it survives an execution
// context being recreated for the same document — a `window.__x` Set would not),
// then treat every unmarked body child as the failed attempt's. Guarded on at
// least one mark still being present, so a real navigation (fresh document, no
// marks) skips the cleanup instead of deleting the app's entire UI. It cannot
// delete app chrome either: every caller awaits `appReady` before mounting,
// by which time the app's own body-level mounts (MenuHost, the call-arrows svg)
// are long done — anything appearing after our mark is the test's own host.
//
// Covered by tests/evaluate-settled.spec.mjs, which drives that retry path
// deterministically (mount, then throw the race's own error once).
const MOUNT_RACE = /context was destroyed|Failed to fetch dynamically imported module/i
const PRE_MARK = 'data-eval-settled-pre'

export async function evaluateSettled(page, fn, arg, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    // (Re)mark before each attempt: whatever exists right now is not ours.
    await page
      .evaluate((attr) => {
        for (const el of Array.from(document.body.children)) el.setAttribute(attr, '1')
      }, PRE_MARK)
      .catch(() => {})
    try {
      return await page.evaluate(fn, arg)
    } catch (err) {
      if (!MOUNT_RACE.test(err.message) || i === attempts - 1) throw err
      lastErr = err
      // Clean up the failed attempt FIRST, then re-settle — in that order,
      // because the leftovers are what make the page ambiguous (a half-mounted
      // second BlockList carries its own #block-search, which appReady looks
      // at). Re-settling is never `networkidle`, see appReady above: on
      // /pr/<id> that would burn the whole test timeout on the open SSE
      // stream, on the very path that exists to RECOVER from a race.
      await page
        .evaluate((attr) => {
          const kids = Array.from(document.body.children)
          if (!kids.some((el) => el.hasAttribute(attr))) return // fresh document — not ours to clean
          for (const el of kids) if (!el.hasAttribute(attr)) el.remove()
        }, PRE_MARK)
        .catch(() => {})
      await appReady(page)
    }
  }
  throw lastErr
}

// openNewComment opens the new-comment composer via the command palette's
// "Comment op deze regel" item (startComment, RelatedPanel.mjs) — the only
// way left to open it. The always-present "+ Nieuwe comment" trigger row
// (`data-testid=new-comment`) that many specs used to `.click()` directly
// has been removed entirely (see "Inline comment blocks" in
// .claude/docs/detail-layout.md) — a comment is now started exclusively
// through Enter → the palette (or, for an AI finding,
// convertWarningToComment's own menu item). Assumes the diff already has the
// keyboard (i.e. Enter opens the block-scoped palette, not some other menu).
export async function openNewComment(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
}

// widthPx(page, chars) — the pixel width Block.mjs's contentWidthCls builds
// for a given chars-count, and widthClsRe(px) the matching class-name
// pattern. A diff card's width class used to spell out its chars-count
// (`w-[calc(80ch_+_2rem)]`), so a spec could assert on it directly; it is now
// a plain pixel value, because `ch` resolved against the card's own
// PROPORTIONAL font instead of the code panes' monospace one and made every
// card ~34% too wide (see CODE_CHAR_PX in Block.mjs). Both helpers ask
// Block.mjs itself, so a spec keeps expressing its expectation in
// CHARACTERS and no pixel number gets hardcoded into a spec.
export async function widthPx(page, chars) {
  return page.evaluate(async (c) => (await import('/src/Block.mjs')).contentWidthPx(c), chars)
}

export function widthClsRe(px) {
  return new RegExp('w-\\[' + px + 'px\\]')
}

// widthCharsOf(page, clsString) — the reverse: the chars-count behind a card's
// own width class, or null when that class isn't a content-driven one.
export async function widthCharsOf(page, clsString) {
  const m = /w-\[(\d+)px\]/.exec(clsString || '')
  if (!m) return null
  return page.evaluate(async (px) => (await import('/src/Block.mjs')).contentWidthChars(px), Number(m[1]))
}
