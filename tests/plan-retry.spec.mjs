import { test, expect, appReady } from './_fixtures.mjs'

// "Er moet een retry knop komen om opnieuw te plannen" — a failed `plan`
// tracker run (the questions/tasks generation itself) gets a retry action in
// two places: the run row in the "Taken" list, and the ticket column's own
// Enter-menu (see .claude/docs/plan-page.md). Both resume the SAME run via
// the generic, sanctioned /api/workflows/retry endpoint.
test.describe('Plan page — retry a failed plan run', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'RETRY-1',
          doc: { key: 'RETRY-1', title: 'Retry me', description: 'desc', url: '', questions: [], tasks: [], answers: [], error: '', chat: [] },
          runs: [{ runId: 'run-plan-1', workflow: 'plan', status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          generating: false,
        },
      }),
    )
  })

  test('the run row shows a retry button that resumes the run', async ({ page }) => {
    let retried = null
    await page.route('**/api/workflows/retry', (route) => {
      retried = route.request().postDataJSON()
      route.fulfill({ json: { ok: true, runId: 'run-plan-1' } })
    })

    await page.goto('/plan/RETRY-1')
    await appReady(page)

    const retryBtn = page.getByTestId('plan-retry')
    await expect(retryBtn).toBeVisible()
    await expect(retryBtn).toContainText('Opnieuw plannen')

    await retryBtn.click()
    await expect.poll(() => retried).toEqual({ runId: 'run-plan-1' })
  })

  test('the ticket column\'s Enter-menu also offers "Opnieuw plannen" for a failed run', async ({ page }) => {
    await page.route('**/api/workflows/retry', (route) => route.fulfill({ json: { ok: true, runId: 'run-plan-1' } }))

    await page.goto('/plan/RETRY-1')
    await appReady(page)

    await page.getByTestId('plan-ticket-card').click()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page.getByTestId('command-row')).toContainText(['Sluit menu', 'Open in Jira', 'Terug naar overzicht', 'Opnieuw plannen'])
  })
})
