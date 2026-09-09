import { test, expect, appReady } from './_fixtures.mjs'

// Reviewer report (task 52, screenshot "dit ziet er niet uit als een knop... /
// ik zie het niet als een taak wat bezig is, linksonder in de taken blok"):
// pressing "meer vragen genereren"/"plan opstellen" gave no sense in the
// Taken block that anything had started. planWorkflowsForPanel (src/plan.mjs)
// already overrode the `plan` tracker run to `running` while busy, but two
// gaps made that read as "nothing happening": `updatedAt` stayed at the run's
// OLD timestamp (so the row said "bezig" next to an old "N uur geleden"), and
// there was nothing to override at all when no `plan` run had been polled
// back yet. This asserts both fixes: a fresh, action-specific running row
// appears in the Taken block immediately on click, synthesized from nothing
// if needed.
test.describe('Plan page — the Taken block shows a running row for followup/regenerate', () => {
  const baseDoc = {
    key: 'BUSY-1',
    title: 'Iets plannen',
    description: 'desc',
    url: '',
    questions: [{ id: 'q1', question: 'Eerste vraag?', options: [{ id: 'q1o1', label: 'Optie A' }] }],
    tasks: [{ id: 't1', title: 'Taak 1', explanation: '' }],
    answers: [],
    error: '',
    chat: [],
  }

  test('clicking "meer vragen genereren" shows a fresh running "Plan" row, even with no prior run', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({ json: { ok: true, key: 'BUSY-1', doc: baseDoc, runs: [], generating: false } }),
    )
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-followup-1' } }))
    let resolveSignal
    const signalled = new Promise((res) => {
      resolveSignal = res
    })
    await page.route('**/api/workflows/run-followup-1/signals/plan_answer', async (route) => {
      resolveSignal(route.request().postDataJSON())
      // Hold the response open so the pending state stays observable long
      // enough for the assertions below — a route that resolves instantly
      // races the assertion, see plan-regenerate.spec.mjs's own known flake.
      await new Promise((r) => setTimeout(r, 1500))
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/BUSY-1')
    await appReady(page)

    await page.getByTestId('plan-followup-state').click()
    await signalled

    const row = page.getByTestId('workflow-row').filter({ hasText: 'Plan' })
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'running')
    await expect(row.getByTestId('workflow-note')).toHaveText('vragen worden bedacht…')
    await expect(row.getByTestId('workflow-updated')).toHaveText('net nu')
  })

  test('clicking "plan opstellen" shows a fresh running "Plan" row with its own note', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'BUSY-2',
          doc: baseDoc,
          runs: [{ runId: 'run-plan-2', workflow: 'plan', status: 'waiting', createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }],
          generating: false,
        },
      }),
    )
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-plan-2' } }))
    let resolveSignal
    const signalled = new Promise((res) => {
      resolveSignal = res
    })
    await page.route('**/api/workflows/run-plan-2/signals/plan_answer', async (route) => {
      resolveSignal(route.request().postDataJSON())
      await new Promise((r) => setTimeout(r, 1500))
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/BUSY-2')
    await appReady(page)

    await page.getByTestId('plan-regenerate-state').click()
    await signalled

    const row = page.getByTestId('workflow-row').filter({ hasText: 'Plan' })
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'running')
    await expect(row.getByTestId('workflow-note')).toHaveText('nieuw plan wordt opgesteld…')
    await expect(row.getByTestId('workflow-updated')).toHaveText('net nu')
  })
})
