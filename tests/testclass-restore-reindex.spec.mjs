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
// test insert a comment AFTER the initial restore has already selected and
// rendered the test method's diff. It must be one that still ranks ahead of
// every real block so its arrival reindexes the still-selected class row by
// exactly one — the same "index shifts while staying selected" mechanics
// recomputeLeftList produced in production once
// loadRelations/loadCallResolve/loadTestCovers landed. An ORDINARY PR-wide
// comment no longer does that (it now ranks 2.4, right above "Comments op
// regels", under every real category — reviewer request: "gooi algemene pr
// comments net boven Comments op regels"); only a comment that `@`-mentions
// the local reviewer still ranks -2, above everything, so this test mocks
// `/api/settings` and mentions that login (mirrors mention-highlight.spec.mjs).
const PR = 110
const ME = 'reindert-vetter'

function mockSettings(page) {
  return page.route('**/api/settings', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, me: { login: ME, aliases: [] } }),
    }),
  )
}

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
  await mockSettings(page)
  const comments = mockComments(page)

  const sel = encodeURIComponent('testclass:tests/Feature/TriggersIndexTest.php::TriggersIndexTest')
  const tmethod = encodeURIComponent('tests/Feature/TriggersIndexTest.php:12')
  await page.goto(`/pr/${PR}?sel=${sel}&tmethod=${tmethod}&mode=diff&chg=0`)

  const activeRow = page.locator('[data-change-active]')
  await expect(activeRow.first()).toBeVisible()
  const initialCount = await activeRow.count()
  expect(initialCount).toBeGreaterThan(0)

  // Insert a comment that `@`-mentions the local reviewer — the next 5s
  // comment poll picks it up and reindexes every existing row (including the
  // still-selected class row) by one, exactly like
  // loadRelations/loadCallResolve/loadTestCovers landing shortly after the
  // restore did in production.
  comments.serve([
    {
      id: 'reindex-1',
      runId: 'run-reindex-1',
      pr: PR,
      file: '',
      line: 0,
      author: 'octocat',
      body: `@${ME} a note that ranks ahead of every block`,
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
  await expect(page.getByTestId('block-row').first()).toContainText('a note that ranks ahead of every block', {
    timeout: 8000,
  })
  // ... and the active-row cursor on the still-selected test method's diff
  // must still be there — the bug made it vanish permanently right around
  // this point.
  await expect(activeRow.first()).toBeVisible()
  expect(await activeRow.count()).toBe(initialCount)
  await expect(page).toHaveURL(/mode=diff/)
})
