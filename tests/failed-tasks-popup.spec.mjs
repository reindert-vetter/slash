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

  test('retries one failure via its own row button, not the whole window', async ({ page }) => {
    await enableFailedTasksPopup(page)
    await stubProblems(page)
    const posted = []
    await page.route('**/api/workflows/retry', (route) => {
      posted.push(JSON.parse(route.request().postData() || '{}'))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: 'run-boom-0' }) })
    })
    await page.goto('/pr-overview')
    await appReady(page)

    const dialog = page.getByTestId('failed-tasks-dialog')
    await dialog.getByTestId('problem-retry').first().click()
    await expect(page.getByTestId('failed-tasks-note')).toHaveText('Opnieuw gestart.')
    expect(posted).toEqual([{ runId: 'run-boom-0' }])
  })

  // A comment/reply whose post to GitHub failed for good is no failed RUN (the
  // thread keeps running), so it arrives as GET /api/problems' failedPosts.
  // It can NOT be ignored — only retried, through the thread's own Signal.
  test('lists failed GitHub posts without an ignore option, and retries them via a Signal', async ({ page }) => {
    await enableFailedTasksPopup(page)
    const now = new Date().toISOString()
    await stubProblems(page, {
      ok: true,
      failedRuns: [],
      logErrors: [],
      failedPosts: [
        { commentId: 'run-c1', runId: 'run-c1', pr: 12903, file: 'app/Order.php', line: 10, body: 'why?', error: 'gh: Validation Failed (HTTP 422)', createdAt: now },
        { commentId: 'run-c2', runId: 'run-c2', pr: 12903, file: 'app/Order.php', line: 20, reactionId: 'ui-r1', body: 'ping', error: 'gh: Not Found (HTTP 404)', createdAt: now },
      ],
      prTitles: {},
    })
    const signals = []
    await page.route('**/api/workflows/*/signals/reply', (route) => {
      signals.push({ url: new URL(route.request().url()).pathname, body: JSON.parse(route.request().postData() || '{}') })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'signalled' }) })
    })
    await page.goto('/pr-overview')
    await appReady(page)

    const dialog = page.getByTestId('failed-tasks-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('failed-tasks-title')).toHaveText('Mislukte taken van de laatste 4 dagen · 2')
    const posts = dialog.getByTestId('problem-post')
    await expect(posts).toHaveCount(2)
    await expect(posts.nth(0)).toContainText('Comment niet op GitHub geplaatst')
    await expect(posts.nth(1)).toContainText('Reactie niet op GitHub geplaatst')
    await expect(dialog.getByTestId('problem-ignore')).toHaveCount(0)
    await expect(page.getByTestId('failed-tasks-ignore-all')).toBeDisabled()

    await posts.nth(0).getByTestId('problem-retry').click()
    await expect(page.getByTestId('failed-tasks-note')).toHaveText('Opnieuw gestart.')
    await posts.nth(1).getByTestId('problem-retry').click()
    await expect.poll(() => signals.length).toBe(2)
    expect(signals).toEqual([
      { url: '/api/workflows/run-c1/signals/reply', body: { action: 'publish' } },
      { url: '/api/workflows/run-c2/signals/reply', body: { action: 'repost', targetId: 'ui-r1' } },
    ])
  })

  test('is mounted on the QA and plan pages too', async ({ page }) => {
    await enableFailedTasksPopup(page)
    await stubProblems(page)
    await page.goto('/qa/12903')
    await expect(page.getByTestId('failed-tasks-dialog')).toBeVisible()
    await page.goto('/plan/TEST-901')
    await expect(page.getByTestId('failed-tasks-dialog')).toBeVisible()
  })

  // A PR review GitHub refuses: the dialog opens at once — even through a
  // running snooze (the harness pre-snoozes it, and this test deliberately
  // does NOT call enableFailedTasksPopup) — and the tab stays on the PR
  // instead of following "en ga naar overzicht".
  test('a failed PR review opens the dialog at once and does not navigate away', async ({ page }) => {
    let failed = false
    await page.route('**/api/problems', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          logErrors: [],
          failedPosts: [],
          prTitles: {},
          failedRuns: failed
            ? [{ runId: 'run-review', workflow: 'submit_review', pr: 12903, updatedAt: new Date().toISOString(), error: 'submit review: gh: Can not approve your own pull request (HTTP 422)', retryable: true }]
            : [],
        }),
      }),
    )
    await page.route('**/api/workflows/submit_review', (route) => {
      failed = true
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'submit review failed (run run-review)' }) })
    })
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    const rows = page.getByTestId('command-row')
    await rows.filter({ hasText: 'GitHub' }).click()
    await rows.filter({ hasText: 'PR keuren' }).click()
    await rows.filter({ hasText: 'Keur de HELE PR goed' }).click()
    await rows.filter({ hasText: 'Goedkeuren en ga naar overzicht' }).click()

    const dialog = page.getByTestId('failed-tasks-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('problem-run')).toContainText('Can not approve your own pull request')
    expect(new URL(page.url()).pathname).toBe('/pr/12903')
  })

  test('a review refused before any run started shows the server reason as its own row', async ({ page }) => {
    await page.route('**/api/problems', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, failedRuns: [], logErrors: [], failedPosts: [], prTitles: {} }) }),
    )
    await page.route('**/api/workflows/submit_review', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'you cannot review your own PR' }) }),
    )
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('/')
    const rows = page.getByTestId('command-row')
    await rows.filter({ hasText: 'GitHub' }).click()
    await rows.filter({ hasText: 'PR keuren' }).click()
    await rows.filter({ hasText: 'Keur de HELE PR goed' }).click()
    await rows.filter({ hasText: 'Goedkeuren en sluiten' }).click()

    const row = page.getByTestId('failed-tasks-dialog').getByTestId('problem-client')
    await expect(row).toContainText('Review insturen is niet gelukt')
    await expect(row).toContainText('you cannot review your own PR')
  })
})
