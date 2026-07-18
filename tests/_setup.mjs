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
}
