import { test, expect, appReady } from './_fixtures.mjs'

// The "N actief" pill opens a popup listing the runs that are running right
// now (src/runningTasks.mjs): the Taken block's own rows, repo-wide, each with
// its PR. Chat turns are in the number but not the list.
const RUNS = [
  { runId: 'run-live-1', workflow: 'explain_code', status: 'running', pr: 12903, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { runId: 'run-live-2', workflow: 'build_relations', status: 'running', pr: 555, createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString() },
]

function stub(page) {
  return page.route('**/api/running-count', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: 3, byPr: {}, runs: RUNS }) }),
  )
}

async function checkPopup(page) {
  await page.locator('[data-testid="running-count"]').click()
  const dlg = page.locator('[data-testid="running-tasks-dialog"]')
  await expect(dlg).toBeVisible()
  await expect(dlg.locator('[data-testid="workflow-row"]')).toHaveCount(2)
  await expect(dlg.locator('[data-testid="workflow-label"]').first()).toContainText('PR #12903')
  await expect(dlg.locator('[data-testid="running-tasks-chat-note"]')).toBeVisible()
  await page.screenshot({ path: 'data/review-shots/running-tasks-popup.png' })
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
}

test.describe('running-tasks popup', () => {
  test('opens from the pill on /pr-overview and closes with Escape', async ({ page }) => {
    await stub(page)
    await page.goto('/pr-overview')
    await appReady(page)
    await checkPopup(page)
  })

  test('opens from the pill on /pr/<id>', async ({ page }) => {
    await stub(page)
    await page.goto('/pr/12903')
    await appReady(page)
    if (!(await page.locator('[data-testid="running-count"]').isVisible())) await page.keyboard.press('ArrowLeft')
    await checkPopup(page)
  })
})
