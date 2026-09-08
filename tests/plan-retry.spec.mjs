import { test, expect, appReady } from './_fixtures.mjs'

// "Er moet een retry knop komen om opnieuw te plannen" — a failed `plan`
// tracker run (the questions/tasks generation itself) gets a retry action in
// two places: the run row in the "Taken" list, and the ticket column's own
// Enter-menu (see .claude/docs/plan-page.md). A GENUINELY failed run (this
// file's first describe block) resumes via the generic, sanctioned
// POST /api/workflows/retry endpoint; a SWALLOWED generation error — the run
// itself still `waiting`, see the second describe block below — resumes via
// the plan_answer Signal's "retry" Kind instead, because the generic endpoint
// requires a genuinely `failed` run and refuses this case outright.
//
// The "Taken" block is now the literal TasksPanel the PR review tree uses
// (see "The Taken block is the literal TasksPanel" in
// .claude/docs/plan-page.md), so there is no dedicated "plan-retry" button
// any more — a click on the row itself (data-testid=workflow-row) retries,
// mirroring "every row is clickable" there.
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

  test('clicking the failed run row resumes the run', async ({ page }) => {
    let retried = null
    await page.route('**/api/workflows/retry', (route) => {
      retried = route.request().postDataJSON()
      route.fulfill({ json: { ok: true, runId: 'run-plan-1' } })
    })

    await page.goto('/plan/RETRY-1')
    await appReady(page)

    const row = page.getByTestId('workflow-row').filter({ hasText: 'Plan' })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('workflow-status')).toContainText('mislukt')

    await row.click()
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

// Reported bug: a parse/timeout error on planGenerate is swallowed onto
// doc.error instead of failing the Execution (see plan_workflow.go), so the
// `plan` tracker's own run status stays `waiting`, never `failed` — the
// generic POST /api/workflows/retry (TaskManager.RetryRun) then refuses it
// with "run is waiting, not failed" and the reviewer's "Opnieuw plannen"
// click silently did nothing, leaving a plan permanently stuck. Both retry
// entry points must recognise this "synthetic" failed row (state.doc.error
// set, the run itself still waiting) and resume via the plan_answer Signal's
// "retry" Kind instead of the generic endpoint.
test.describe('Plan page — retry a swallowed generation error (run still waiting)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'RETRY-2',
          doc: {
            key: 'RETRY-2',
            title: 'Retry a swallowed error',
            description: 'desc',
            url: '',
            questions: [],
            tasks: [],
            answers: [],
            error: 'plan: parse answer: unexpected end of JSON input',
            chat: [],
          },
          runs: [{ runId: 'run-plan-2', workflow: 'plan', status: 'waiting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          generating: false,
        },
      }),
    )
  })

  test('clicking the row sends a plan_answer retry Signal, not the generic resume endpoint', async ({ page }) => {
    let genericRetryCalled = false
    let signalled = null
    await page.route('**/api/workflows/retry', (route) => {
      genericRetryCalled = true
      route.fulfill({ json: { error: 'retry: run "run-plan-2" is waiting, not failed' }, status: 400 })
    })
    await page.route('**/api/workflows/run-plan-2/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { status: 'answered' } })
    })

    await page.goto('/plan/RETRY-2')
    await appReady(page)

    const row = page.getByTestId('workflow-row').filter({ hasText: 'Plan' })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('workflow-status')).toContainText('mislukt')

    await row.click()
    await expect.poll(() => signalled).toEqual({ questionId: '', optionId: '', text: '', kind: 'retry' })
    expect(genericRetryCalled).toBe(false)
  })

  test('the ticket column\'s Enter-menu also offers "Opnieuw plannen" for a swallowed error', async ({ page }) => {
    let signalled = null
    await page.route('**/api/workflows/run-plan-2/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { status: 'answered' } })
    })

    await page.goto('/plan/RETRY-2')
    await appReady(page)

    await page.getByTestId('plan-ticket-card').click()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page.getByTestId('command-row')).toContainText(['Sluit menu', 'Open in Jira', 'Terug naar overzicht', 'Opnieuw plannen'])

    await page.getByTestId('command-row').filter({ hasText: 'Opnieuw plannen' }).click()
    await expect.poll(() => signalled).toEqual({ questionId: '', optionId: '', text: '', kind: 'retry' })
  })
})
