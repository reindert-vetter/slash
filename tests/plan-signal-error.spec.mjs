import { test, expect, appReady } from './_fixtures.mjs'

// Reviewer report (task 54): "Plan opstellen doet hier niets" — end-to-end
// driving of the real app found no reproducible backend failure (the click
// correctly fires both requests, the button and the Taken block both show
// the busy state immediately, and a full regenerate → answer every question
// → draft-PR run completed with zero errors). What DID turn up reading the
// code: sendFollowup/sendRegenerate swallowed a non-2xx response (or a
// thrown fetch) in an empty `catch`, with no trace anywhere — exactly the
// "the button does nothing" symptom, for whatever DOES eventually fail this
// way (a rejected Signal, a dropped connection on the long-running call).
// This asserts the fix: a failed signal now renders a visible `⚠ …` line
// under the card, distinct per action.
test.describe('Plan page — a failed followup/regenerate signal is now visible', () => {
  const baseDoc = {
    key: 'ERR-1',
    title: 'Iets plannen',
    description: 'desc',
    url: '',
    questions: [{ id: 'q1', question: 'Eerste vraag?', options: [{ id: 'q1o1', label: 'Optie A' }] }],
    tasks: [{ id: 't1', title: 'Taak 1', explanation: '' }],
    answers: [],
    error: '',
    chat: [],
  }

  test('a non-ok response on the followup signal shows an inline error, cleared on the next attempt', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({ json: { ok: true, key: 'ERR-1', doc: baseDoc, runs: [], generating: false } }),
    )
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-err-1' } }))
    let fail = true
    await page.route('**/api/workflows/run-err-1/signals/plan_answer', (route) => {
      if (fail) return route.fulfill({ status: 409, json: { error: 'run is busy' } })
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/ERR-1')
    await appReady(page)

    await page.getByTestId('plan-followup-state').click()
    await expect(page.getByTestId('plan-followup-error')).toBeVisible()
    await expect(page.getByTestId('plan-followup-error')).toContainText('mislukt')

    // A second, successful attempt clears the error again.
    fail = false
    await page.getByTestId('plan-followup-state').click()
    await expect(page.getByTestId('plan-followup-error')).toBeHidden()
  })

  test('a non-ok response on the regenerate signal shows its own inline error', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({ json: { ok: true, key: 'ERR-2', doc: baseDoc, runs: [], generating: false } }),
    )
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-err-2' } }))
    await page.route('**/api/workflows/run-err-2/signals/plan_answer', (route) =>
      route.fulfill({ status: 500, json: { error: 'boom' } }),
    )

    await page.goto('/plan/ERR-2')
    await appReady(page)

    await page.getByTestId('plan-regenerate-state').click()
    await expect(page.getByTestId('plan-regenerate-error')).toBeVisible()
    await expect(page.getByTestId('plan-regenerate-error')).toContainText('mislukt')
    // The sibling followup card's error stays untouched — each action owns
    // its own error, never a shared one.
    await expect(page.getByTestId('plan-followup-error')).toHaveCount(0)
  })
})
