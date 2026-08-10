import { test, expect } from './_fixtures.mjs'

// Regression for a reported bug: opening a shared/refreshed URL that restores
// a test method's diff (`?sel=testclass:...&tmethod=...&mode=diff&chg=N`)
// showed the active-row cursor for a split second and then lost it
// permanently, with no console error. Root cause: the DetailPanel's per-card
// reactive opts (activeGroup/hintsEnabled/diffActive/viewMode, home.mjs)
// compared the render loop's own raw index (`i === state.selected`) instead
// of the block's stable identity — see conventions.md's "snapshot a
// selection by stable ID, never by raw array index" rule. The card's own
// `.key(...)` deliberately does NOT include `i` (a still-selected row must
// not be torn down and rebuilt just because recomputeLeftList() reindexed
// it), so arrow.js keeps the mounted node's ORIGINAL closure — with `i`
// frozen at whatever index it was first built at — alive and reactively
// firing forever. The very recomputeLeftList() calls that follow a
// `?sel=`/`?tmethod=` restore (loadRelations/loadCallResolve/loadTestCovers/
// the comment poll landing) can legitimately reindex the still-selected row,
// and once that happens the frozen `i` no longer matches a freshly-read
// state.selected — permanently, since nothing else ever re-triggers that
// binding. Fixed by comparing identity (`isActiveCard`/`b === curBlock()`)
// instead. See .claude/docs/test-class-grouping.md.
//
// Fixture: PR 110 (see test-class-grouping.spec.mjs) — TriggersIndexTest's
// two methods. mockComments (mirrors comment-index-items.spec.mjs) lets the
// test insert a PR-wide comment AFTER the initial restore has already
// selected and rendered the test method's diff: a comment item ranks ahead
// of every real block (recomputeLeftList's rank -1), so its arrival via the
// next comment poll reindexes the still-selected class row by exactly one —
// the same "index shifts while staying selected" mechanics recomputeLeftList
// produced in production once loadRelations/loadCallResolve/loadTestCovers
// landed.
const PR = 110

function mockComments(page) {
  const state = { comments: [] }
  const ready = page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.comments) }),
  )
  return Object.assign(ready, { serve: (next) => (state.comments = next) })
}

test('the active diff cursor survives a reindex of the still-selected row after a URL restore', async ({
  page,
}) => {
  const comments = mockComments(page)

  const sel = encodeURIComponent('testclass:tests/Feature/TriggersIndexTest.php::TriggersIndexTest')
  const tmethod = encodeURIComponent('tests/Feature/TriggersIndexTest.php:12')
  await page.goto(`/pr/${PR}?sel=${sel}&tmethod=${tmethod}&mode=diff&chg=0`)

  const activeRow = page.locator('[data-change-active]')
  await expect(activeRow.first()).toBeVisible()
  const initialCount = await activeRow.count()
  expect(initialCount).toBeGreaterThan(0)

  // Insert a PR-wide comment — the next 5s comment poll picks it up and
  // reindexes every existing row (including the still-selected class row) by
  // one, exactly like loadRelations/loadCallResolve/loadTestCovers landing
  // shortly after the restore did in production.
  comments.serve([
    {
      id: 'reindex-1',
      runId: 'run-reindex-1',
      pr: PR,
      file: '',
      line: 0,
      author: 'octocat',
      body: 'a PR-wide note that ranks ahead of every block',
      createdAt: new Date().toISOString(),
      reactionCount: 0,
      status: 'open',
      source: 'github',
      kind: 'issue',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
  ])

  // The comment item must actually have landed and reindexed the list (proof
  // the reindex really happened, not just a timing coincidence) ...
  await expect(page.getByTestId('block-row').first()).toContainText('a PR-wide note', { timeout: 8000 })
  // ... and the active-row cursor on the still-selected test method's diff
  // must still be there — the bug made it vanish permanently right around
  // this point.
  await expect(activeRow.first()).toBeVisible()
  expect(await activeRow.count()).toBe(initialCount)
  await expect(page).toHaveURL(/mode=diff/)
})
