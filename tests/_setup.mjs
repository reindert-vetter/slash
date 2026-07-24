// globalSetup: build the Go binary ONCE for the whole run. Each worker then
// seeds its own DB and starts its own server against this binary (see
// _fixtures.mjs) — so we never rebuild per test and workers don't share write
// state. The per-worker DBs/servers live under tests/.tmp/w<n>/.
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

export default function globalSetup() {
  rmSync('tests/.tmp', { recursive: true, force: true })
  mkdirSync('tests/.tmp', { recursive: true })
  execSync('go build -o tests/.tmp/slash .', { stdio: 'inherit' })
  materializeTreeWorktrees()
  materializeExplainWorktrees()
  materializeTestsGroupWorktrees()
  materializeArrowWorktrees()
  materializeRangeSelectWorktrees()
  materializePreviewWidthWorktrees()
  materializeDrillLineSkipWorktrees()
  materializeTranslationWorktrees()
}

// materializeTranslationWorktrees writes the synthetic PR 107 fixture worktrees
// for translation.spec.mjs (same rationale as materializeTreeWorktrees above): a
// changed Laravel lang file `resources/lang/nl/checkout.php` (a TRANSLATION
// block → the changes-only key overview), its unchanged `en` sibling (for the
// read-only companion card + GET /api/langsiblings), and a caller
// CheckoutRequest::messages that references two keys via trans()/__() (the
// resolved translation children come from tests/fixtures/translation-callresolve.json).
function materializeTranslationWorktrees() {
  const nlBase = `<?php

return [
    'foo' => 'oud',
    'bar' => 'zelfde',
    'weg' => 'verwijderd',
    'only_nl' => 'alleen nl',
];
`
  const nlHead = `<?php

return [
    'foo' => 'nieuw',
    'bar' => 'zelfde',
    'extra' => 'toegevoegd',
    'only_nl' => 'alleen nl',
];
`
  const en = `<?php

return [
    'foo' => 'new-en',
    'bar' => 'same',
    'extra' => 'added-en',
];
`
  const caller = (body) => `<?php

namespace App\\Http\\Requests;

class CheckoutRequest
{
    public function messages()
    {
        return [${body}];
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-107-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  write('base', 'resources/lang/nl/checkout.php', nlBase)
  write('head', 'resources/lang/nl/checkout.php', nlHead)
  write('base', 'resources/lang/en/checkout.php', en)
  write('head', 'resources/lang/en/checkout.php', en)
  write('base', 'app/Http/Requests/CheckoutRequest.php', caller(''))
  write(
    'head',
    'app/Http/Requests/CheckoutRequest.php',
    caller("\n            'x' => trans('checkout.foo'),\n            'y' => __('checkout.only_nl'),\n        "),
  )
}

// materializeTreeWorktrees writes the (gitignored, normally real-git-derived)
// base/head worktree files for the synthetic PR 95 fixture used by
// postapprove-tree.spec.mjs — two tiny, hand-written PHP files with one real
// changed line each (parent + child, linked via tests/fixtures/tree-relations.json),
// so GET /api/code (and /api/blockstats) has an actual on-disk diff to read.
// Every other seeded fixture PR (90/91/92/93/94) deliberately has NO worktree
// on disk — their tests only exercise child-listing/drill mechanics, never
// real diff/approval content (see relations.spec.mjs) — but a tree-descent
// approve test needs something real to approve, and data/worktrees/ is
// shared + read-only across workers (see _fixtures.mjs) rather than
// per-worker, so this writes it once here, like the binary build above,
// instead of relying on a real `gh`/`git` ingest that CI/a fresh checkout
// can't reproduce.
function materializeTreeWorktrees() {
  const file = (name, method, value) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-95-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  write('base', 'app/Actions/TreeParentAction.php', file('TreeParentAction', 'execute', 1))
  write('head', 'app/Actions/TreeParentAction.php', file('TreeParentAction', 'execute', 2))
  write('base', 'app/Actions/TreeChildAction.php', file('TreeChildAction', 'run', 1))
  write('head', 'app/Actions/TreeChildAction.php', file('TreeChildAction', 'run', 2))
}

// materializeExplainWorktrees writes the synthetic PR 97 fixture worktrees for
// footer-explanation.spec.mjs (same rationale as materializeTreeWorktrees
// above): a parent function whose change introduces an if-statement, plus an
// event_listener child (tests/fixtures/explain-relations.json) with its own
// if-introducing change — so the footer's AI-description flow has a real,
// deterministic diff whose aligned rows — and thus the seeded unit keys
// group-2-4/line-2, see tests/fixtures/explanations.json — are fully fixed by
// these file contents, for both the top-level block and a drilled column.
// materializeTestsGroupWorktrees writes the synthetic PR 99 fixture worktrees
// for related-tests-group.spec.mjs (same rationale as materializeTreeWorktrees
// above): one production method plus two test methods, each with one real
// changed line, so keyboard navigation can genuinely enter the production
// block's diff (→) and step into its Onderliggende-code panel — where the two
// covering tests (tests/fixtures/testsgroup-testcovers.json) group into the
// horizontal tests bar next to a seeded resolved call
// (tests/fixtures/testsgroup-callresolve.json, the "other" non-test child).
function materializeTestsGroupWorktrees() {
  const file = (ns, name, method, value) => `<?php

namespace ${ns};

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-99-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  write('base', 'app/Models/TgOrder.php', file('App\\Models', 'TgOrder', 'billingAddress', 1))
  write('head', 'app/Models/TgOrder.php', file('App\\Models', 'TgOrder', 'billingAddress', 2))
  write('base', 'tests/Feature/TgOrderBillingTest.php', file('Tests\\Feature', 'TgOrderBillingTest', 'testBilling', 1))
  write('head', 'tests/Feature/TgOrderBillingTest.php', file('Tests\\Feature', 'TgOrderBillingTest', 'testBilling', 2))
  write('base', 'tests/Feature/TgOrderShippingTest.php', file('Tests\\Feature', 'TgOrderShippingTest', 'testShipping', 1))
  write('head', 'tests/Feature/TgOrderShippingTest.php', file('Tests\\Feature', 'TgOrderShippingTest', 'testShipping', 2))
}

// materializeArrowWorktrees writes the synthetic PR 100 fixture worktrees for
// call-arrows.spec.mjs (same rationale as materializeTreeWorktrees above): a
// caller with TWO separate changed groups — an unrelated group first (a
// changed $flag/$note pair, no call site at all — this is the reported-bug
// group: it's the DEFAULT active unit on entering the diff, and doesn't cover
// either call site) and, after a blank/unchanged line, a second group with
// the two adjacent call lines — `arrowHelper` resolves to
// ArrowHelperService::arrowHelper, itself a changed PR 100 block (so the
// call-arrow overlay draws an arrow to its child card), while `arrowPlain`
// resolves to a file the PR doesn't touch (an "Ongewijzigd" child — no arrow).
// A THIRD layer proves the overlay follows a drilled column, not just the
// top-level cursor: ArrowHelperService::arrowHelper itself calls
// ArrowNestedService::arrowNested on a changed line, so drilling into
// arrowHelper from the caller's Onderliggende-code panel (see
// call-arrows.spec.mjs) must show an arrow anchored inside THAT drilled
// column's own diff, scoped to its own drillCursor — not the top-level one.
// Seeded via tests/fixtures/arrow-blocks.json + arrow-callresolve.json.
function materializeArrowWorktrees() {
  const caller = (flag, note, h, p) => `<?php

namespace App\\Actions;

class ArrowCallerAction
{
    public function execute()
    {
        $flag = ${flag};
        $note = '${note}';

        $value = $this->calc->arrowHelper(${h});
        $other = $this->calc->arrowPlain(${p});
        return $value + $other;
    }
}
`
  const helper = (value, n) => `<?php

namespace App\\Services;

class ArrowHelperService
{
    public function arrowHelper()
    {
        $value = ${value};
        $nested = $this->service->arrowNested(${n});
        return $value + $nested;
    }
}
`
  const nested = (mult) => `<?php

namespace App\\Services;

class ArrowNestedService
{
    public function arrowNested($x)
    {
        return $x * ${mult};
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-100-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  write('base', 'app/Actions/ArrowCallerAction.php', caller('false', 'old', 1, 1))
  write('head', 'app/Actions/ArrowCallerAction.php', caller('true', 'context', 2, 3))
  write('base', 'app/Services/ArrowHelperService.php', helper(1, 1))
  write('head', 'app/Services/ArrowHelperService.php', helper(2, 2))
  write('base', 'app/Services/ArrowNestedService.php', nested(2))
  write('head', 'app/Services/ArrowNestedService.php', nested(3))
}

function materializeExplainWorktrees() {
  const file = (name, method, varName, body) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
${body}
        return $${varName};
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-97-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  write('base', 'app/Actions/ExplainAction.php', file('ExplainAction', 'execute', 'value', '        $value = 1;'))
  write(
    'head',
    'app/Actions/ExplainAction.php',
    file('ExplainAction', 'execute', 'value', '        if ($value > 0) {\n            $value = 2;\n        }'),
  )
  write('base', 'app/Actions/ExplainChildAction.php', file('ExplainChildAction', 'handle', 'amount', '        $amount = 5;'))
  write(
    'head',
    'app/Actions/ExplainChildAction.php',
    file('ExplainChildAction', 'handle', 'amount', '        if ($amount > 10) {\n            $amount = 20;\n        }'),
  )
  // ExplainNoIfAction — a third block whose change is a plain, MULTI-LINE
  // reassignment with no if-statement at all: its one change group spans 2
  // rows (a paired "$value = 1;" → "$value = 2;" modification, plus a lone
  // "$extra = 3;" insert row) — footerExplain has nothing to show (no
  // "if"/"elseif" in the text), but footerUnit now DOES (the per-line inline
  // diff of the whole group). Used by the "footer shows a per-line diff for
  // a multi-row group" test in footer-explanation.spec.mjs — distinct from
  // ExplainAction/ExplainChildAction above, which both deliberately DO
  // introduce an if.
  write('base', 'app/Actions/ExplainNoIfAction.php', file('ExplainNoIfAction', 'execute', 'value', '        $value = 1;'))
  write(
    'head',
    'app/Actions/ExplainNoIfAction.php',
    file('ExplainNoIfAction', 'execute', 'value', '        $value = 2;\n        $extra = 3;'),
  )
}

// materializeRangeSelectWorktrees writes the synthetic PR 102 fixture worktree
// for range-select.spec.mjs (same rationale as materializeTreeWorktrees
// above): ONE file with two methods, so they're linked as same-file
// neighbours (the dashed connector) — needed to prove a Shift+ArrowDown range
// selection clamps at the block boundary instead of flowing into the next
// block like a plain ArrowDown does. `execute` changes FOUR lines in TWO
// separate runs of two ($a/$b, then $c/$d), split by one unchanged `$mid`
// line in between — so at gran==='line' there are still four contiguous
// gran==='line' units in a row (unaffected by the grouping, none split by
// MAX_GROUP since each run is well under 5), while at gran==='group' there
// are now two distinct group units to Shift-select across (the whole point
// of the group-level range-select test). `other` changes just one line,
// only used to prove the flow boundary.
function materializeRangeSelectWorktrees() {
  const contents = (a, b, c, d, x) => `<?php

namespace App\\Actions;

class RangeSelectAction
{
    public function execute()
    {
        $a = ${a};
        $b = ${b};
        $mid = 5;
        $c = ${c};
        $d = ${d};
        return $a + $b + $c + $d;
    }

    public function other()
    {
        $x = ${x};
        return $x;
    }
}
`
  const write = (side, contents_) => {
    const full = `data/worktrees/pr-102-${side}/app/Actions/RangeSelectAction.php`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents_)
  }
  write('base', contents(0, 0, 0, 0, 8))
  write('head', contents(1, 2, 3, 4, 9))
}

// materializePreviewWidthWorktrees writes the synthetic PR 107 fixture
// worktrees for preview-matches-active-width.spec.mjs (Task 29, same
// rationale as materializeTreeWorktrees above): a one-sided `added` block
// (selected — a whole new file, only written to the head worktree, never the
// base one) followed in the blocks list by a two-sided `modified` block (the
// look-ahead preview) — so the preview's own diff is genuinely two-sided
// (has real old+new text) and the test can prove home.mjs's
// activeSingleSided override actually collapses it to narrow + new-only
// instead of showing its natural, wider, both-panes diff.
function materializePreviewWidthWorktrees() {
  const file = (name, method, value) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-107-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  // Added block: head-only, no base file at all (fileAdded-equivalent).
  write('head', 'app/Actions/PreviewWidthAddedAction.php', file('PreviewWidthAddedAction', 'execute', 1))
  // Modified block: real old+new text, so its diff is genuinely two-sided.
  write('base', 'app/Actions/PreviewWidthModAction.php', file('PreviewWidthModAction', 'execute', 1))
  write('head', 'app/Actions/PreviewWidthModAction.php', file('PreviewWidthModAction', 'execute', 2))
}

// materializeDrillLineSkipWorktrees writes the synthetic PR 106 fixture
// worktrees for drill-approve-line-skip.spec.mjs (same rationale as
// materializeTreeWorktrees above): a parent block (one changed line, mold of
// the PR-95 tree fixture) whose event_listener child (TreeChildAction2::run)
// has TWO adjacent changed lines instead of one — contiguous, so they still
// form a single 'group' unit, but f (zoom in) splits them into two separate
// 'line' units. That shape is exactly what's needed to prove the "next unit
// stays in the same block" exception in afterApproveAction (home.mjs) also
// fires while a drilled Onderliggende-code column owns the keyboard, not only
// at the top level.
function materializeDrillLineSkipWorktrees() {
  const parent = (value) => `<?php

namespace App\\Actions;

class TreeParentAction2
{
    public function execute()
    {
        $value = ${value};
        return $value;
    }
}
`
  const child = (a, b) => `<?php

namespace App\\Actions;

class TreeChildAction2
{
    public function run()
    {
        $a = ${a};
        $b = ${b};
        return $a + $b;
    }
}
`
  const write = (side, relPath, contents) => {
    const full = `data/worktrees/pr-106-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
  write('base', 'app/Actions/TreeParentAction2.php', parent(1))
  write('head', 'app/Actions/TreeParentAction2.php', parent(2))
  write('base', 'app/Actions/TreeChildAction2.php', child(1, 2))
  write('head', 'app/Actions/TreeChildAction2.php', child(10, 20))
}
