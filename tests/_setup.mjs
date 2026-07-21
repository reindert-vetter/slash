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
  const helper = (value) => `<?php

namespace App\\Services;

class ArrowHelperService
{
    public function arrowHelper()
    {
        $value = ${value};
        return $value;
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
  write('base', 'app/Services/ArrowHelperService.php', helper(1))
  write('head', 'app/Services/ArrowHelperService.php', helper(2))
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
  // reassignment with no if-statement at all: neither footerUnit (the group
  // spans 2 rows, not 1) nor footerExplain (no "if"/"elseif" in the text) has
  // anything to show, so state.footerVisible stays false for its one change
  // group. Used by the "footer disappears entirely, no reserved space" test
  // in footer-explanation.spec.mjs — distinct from ExplainAction/
  // ExplainChildAction above, which both deliberately DO introduce an if.
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
// block like a plain ArrowDown does. `execute` changes FOUR contiguous lines
// (four separate gran==='line' units in a row, none split by MAX_GROUP since
// 4 <= 5) so a Shift+ArrowDown range can span more than one but fewer than
// all of them; `other` changes just one line, only used to prove the flow
// boundary.
function materializeRangeSelectWorktrees() {
  const contents = (a, b, c, d, x) => `<?php

namespace App\\Actions;

class RangeSelectAction
{
    public function execute()
    {
        $a = ${a};
        $b = ${b};
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
