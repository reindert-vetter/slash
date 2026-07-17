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
