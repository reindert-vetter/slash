import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Ignore" on a PR-comment index item used to be a purely client-side flag
// (state.ignoredComments), so a refresh brought every ignored comment straight
// back. It is durable now: toggleIgnoreComment signals the per-PR
// ignore_comment tracker (POST /api/workflows/{runId}/signals/ignore — the
// sanctioned write path) and loadIgnoredComments restores the set from
// GET /api/commentignores?pr=N on load. See "Comment-index items" in
// .claude/rules/detail-layout.md and "Ignoring a comment" in
// .claude/rules/tembed-workflows.md.
//
// Own PR number in the 97xxxx fixture range and no seeded blocks at all: the
// only sidebar row this spec needs is the synthetic comment item itself
// (commentBlockItem), so nothing here can collide with another spec's exact
// row-count assertion (see the APPROVAL_RESET_PRS note in _fixtures.mjs).
// Nothing is mocked — the ignore genuinely round-trips through the workflow
// and its read-model, which is the whole point of the test.
//
// prFor gives every test AND every retry its own PR number, because both
// place a comment and neither can take it back: comments have no reset hook
// in _cleanApprovals (only 12903's are wiped), and a retry reuses the same
// worker DB, so a shared number would leave the second attempt looking at two
// comments and break every exact count below. The offsets stay inside this
// spec's own 9707xx slot, which no other fixture claims (970600 is
// comment-orphan-anchor.spec.mjs's).
function prFor(testInfo, slot) {
  return 970700 + slot * 10 + testInfo.retry
}

// placePRWideComment posts a real, unanchored PR-wide comment (kind 'issue',
// the same Kind an imported general PR comment gets) through the ordinary
// task_code_comment start endpoint, so it shows up as a navigable "Start" row.
async function placePRWideComment(page, pr, body) {
  const res = await page.request.post('/api/workflows/task_code_comment', {
    // The start endpoint requires a non-empty file, but Kind 'issue' is what
    // actually makes this a PR-wide comment (prWideComments filters on
    // kind !== '', never on the file), so the path is inert here.
    data: {
      pr, file: 'app/Http/Controllers/IgnoreFixtureController.php', line: 1,
      kind: 'issue', author: 'octocat', body, local: true,
    },
  })
  expect(res.ok()).toBeTruthy()
  const { runId } = await res.json()
  expect(runId).toBeTruthy()
  return runId
}

// expectIgnoredCount waits until the read-model actually holds n ignored
// comments for this PR. Load-bearing before every reload: toggleIgnoreComment
// reassigns its local map first and fires the Signal fire-and-forget (so the
// row disappears instantly), which means a reload issued right after the click
// can abort that request in flight — the assertion would then be measuring the
// test's own race, not persistence.
async function expectIgnoredCount(page, pr, n) {
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/commentignores?pr=${pr}`)
      if (!res.ok()) return -1
      return ((await res.json()).ignored || []).length
    })
    .toBe(n)
}

test('an ignored PR-comment stays hidden after a reload', async ({ page }, testInfo) => {
  const pr = prFor(testInfo, 0)
  await placePRWideComment(page, pr, 'this one can wait until later')

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)

  // The comment shows as an ordinary, selected "Start" row, and there is no
  // hidden-comments toggle yet.
  const rows = page.getByTestId('block-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('this one can wait until later')
  await expect(page.getByTestId('toggle-ignored')).toHaveCount(0)

  // Enter opens the comment-scoped action menu; choose "Ignore".
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('Ignore', { exact: true }).click()

  // It disappears from the index right away (the optimistic local toggle) and
  // its own reveal toggle appears instead.
  await expect(page.getByTestId('block-row')).toHaveCount(0)
  await expect(page.getByTestId('toggle-ignored')).toBeVisible()
  await expectIgnoredCount(page, pr, 1)

  // The durable part: after a reload it is STILL hidden, restored from the
  // read-model rather than starting fresh.
  await page.reload()
  await leaveSearchBox(page)
  await expect(page.getByTestId('toggle-ignored')).toBeVisible()
  await expect(page.getByTestId('block-row')).toHaveCount(0)

  // Revealing it shows it under its own "Verborgen comments" heading.
  await page.getByTestId('toggle-ignored').click()
  await expect(page.getByTestId('hidden-comment-heading')).toBeVisible()
  await expect(page.getByTestId('block-row')).toHaveCount(1)
})

test('un-ignoring a comment also survives a reload', async ({ page }, testInfo) => {
  const pr = prFor(testInfo, 1)
  await placePRWideComment(page, pr, 'second opinion needed here')

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const row = page.getByTestId('block-row').filter({ hasText: 'second opinion needed here' })
  await expect(row).toHaveCount(1)
  await row.click()

  // Ignore it…
  await page.keyboard.press('Enter')
  await page.getByTestId('command-menu').getByText('Ignore', { exact: true }).click()
  await expect(page.getByTestId('block-row').filter({ hasText: 'second opinion needed here' })).toHaveCount(0)
  await expectIgnoredCount(page, pr, 1)

  // …then reveal and un-ignore it again. The menu item's label flips, so the
  // undo path goes through the same Signal with ignored:false.
  await page.getByTestId('toggle-ignored').click()
  const revealed = page.getByTestId('block-row').filter({ hasText: 'second opinion needed here' })
  await expect(revealed).toHaveCount(1)
  await revealed.click()
  await page.keyboard.press('Enter')
  await page.getByTestId('command-menu').getByText('Ignore ongedaan maken').click()
  await expectIgnoredCount(page, pr, 0)

  // After a reload it is an ordinary, visible row again — no hidden section.
  await page.reload()
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row').filter({ hasText: 'second opinion needed here' })).toHaveCount(1)
  await expect(page.getByTestId('toggle-ignored')).toHaveCount(0)
})
