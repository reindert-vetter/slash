import { test, expect, appReady, enableFailedTasksPopup } from './_fixtures.mjs'

// The global failed-tasks dialog (src/failedTasks.mjs): shown over whatever
// page the reviewer is on as soon as GET /api/problems reports a failure in
// the last four days, capped at three rows with a "toon meer" button, and
// dismissable for five minutes.
//
// Driven through page.route like the other problems specs (see
// overview-problems.spec.mjs for why: a real failure is not deterministic in
// a worker). The backend half — the four-day window and the resume-based
// retry — is covered by run_errors_test.go and tembed/engine_test.go.
function rows(n) {
  return Array.from({ length: n }, (_, i) => ({
    runId: 'run-boom-' + i,
    workflow: 'task_code_comment',
    pr: 12903,
    updatedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    error: 'tembed: workflow failed: save reaction: database is locked (5)',
    retryable: true,
  }))
}

// The logErrors half is deliberately NOT in the dialog (see failedTasks.mjs's
// own header): a mirrored log line is "overgeslagen", not "mislukt", and
// nothing can resume it. One is included here to prove it is ignored.
const PROBLEMS = {
  ok: true,
  failedRuns: rows(5),
  logErrors: [{ at: new Date().toISOString(), scope: 'import comments', pr: 970099, message: 'import comments: skipped' }],
  prTitles: {},
}

function stubProblems(page, body = PROBLEMS) {
  return page.route('**/api/problems', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  )
}

test.describe('global failed-tasks dialog', () => {
  test('shows three rows with a "toon meer" button, and snoozes away', async ({ page }) => {
    await enableFailedTasksPopup(page)
    await stubProblems(page)
    await page.goto('/pr-overview')
    await appReady(page)

    const dialog = page.getByTestId('failed-tasks-dialog')
    await expect(dialog).toBeVisible()
    // The count in the title is the FULL list; only three rows are shown.
    await expect(page.getByTestId('failed-tasks-title')).toHaveText('Mislukte taken van de laatste 4 dagen · 5')
    await expect(dialog.getByTestId('problem-run')).toHaveCount(3)
    await expect(dialog.getByTestId('problem-log')).toHaveCount(0)

    const more = page.getByTestId('failed-tasks-more')
    await expect(more).toHaveText('Toon meer (2)')
    await more.click()
    await expect(dialog.getByTestId('problem-run')).toHaveCount(5)
    await expect(more).toHaveCount(0)

    await page.getByTestId('failed-tasks-snooze').click()
    await expect(dialog).toHaveCount(0)
  })

  test('appears on the review tree too, owns the keyboard, and Escape dismisses', async ({ page }) => {
    await enableFailedTasksPopup(page)
    await stubProblems(page)
    // keepDescription: the harness' own goto wrapper presses Escape on a
    // /pr/<id> open to leave the search box — which this dialog legitimately
    // reads as "negeer 5 minuten", so it must not run here.
    await page.goto('/pr/12903', { keepDescription: true })
    await appReady(page)

    await expect(page.getByTestId('failed-tasks-dialog')).toBeVisible()
    // While the dialog is up the tree must not navigate behind the backdrop.
    const before = page.url()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    expect(page.url()).toBe(before)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('failed-tasks-dialog')).toHaveCount(0)
  })

  test('ignores one failure, and the whole list after a confirm press', async ({ page }) => {
    await enableFailedTasksPopup(page)
    // The stub is mutable: an ignored run really disappears from the next
    // GET /api/problems, exactly as the deleted run would server-side.
    let remaining = rows(5)
    await page.route('**/api/problems', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...PROBLEMS, failedRuns: remaining }),
      }),
    )
    const ignored = []
    await page.route('**/api/workflows/ignore-runs', (route) => {
      const ids = JSON.parse(route.request().postData() || '{}').runIds || []
      ignored.push(...ids)
      remaining = remaining.filter((r) => !ids.includes(r.runId))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, ignored: ids.length, skipped: 0 }),
      })
    })
    await page.goto('/pr-overview')
    await appReady(page)

    const dialog = page.getByTestId('failed-tasks-dialog')
    await dialog.getByTestId('problem-ignore').first().click()
    await expect(page.getByTestId('failed-tasks-note')).toHaveText('1 genegeerd, 0 overgeslagen.')
    expect(ignored).toEqual(['run-boom-0'])
    await expect(page.getByTestId('failed-tasks-title')).toHaveText('Mislukte taken van de laatste 4 dagen · 4')

    // "Alles negeren" needs a second press: the label itself says so, never a
    // colour alone.
    const all = page.getByTestId('failed-tasks-ignore-all')
    await expect(all).toHaveText('Alles negeren')
    await all.click()
    await expect(all).toHaveText('Zeker? Alles negeren')
    expect(ignored).toEqual(['run-boom-0'])
    await all.click()
    expect(ignored).toEqual(['run-boom-0', 'run-boom-1', 'run-boom-2', 'run-boom-3', 'run-boom-4'])
    // Nothing left to fail, so the dialog closes itself.
    await expect(dialog).toHaveCount(0)
  })

  test('retries every failure of the window in one press', async ({ page }) => {
    await enableFailedTasksPopup(page)
    await stubProblems(page)
    let posted = 0
    await page.route('**/api/workflows/retry-all', (route) => {
      posted++
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, retried: 5, skipped: 0 }),
      })
    })
    await page.goto('/pr-overview')
    await appReady(page)

    await page.getByTestId('failed-tasks-retry-all').click()
    await expect(page.getByTestId('failed-tasks-note')).toHaveText('5 hervat, 0 overgeslagen.')
    expect(posted).toBe(1)
  })
})
