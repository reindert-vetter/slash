import { test, expect, appReady } from './_fixtures.mjs'

// "hier moeten 2 knoppen komen: vervolgvragen genereren of plan opstellen"
// (reviewer request) — a second action row next to the existing "meer vragen
// genereren" card: discard the current plan (questions/tasks) entirely and
// ask Claude for a brand new one, via the plan_answer Signal's "regenerate"
// Kind (see planAnswerRegenerate in plan_workflow.go). Own row/id
// (REGENERATE_ROW_ID), own keyboard stop, same shape as followupCard — see
// .claude/docs/plan-page.md.
test.describe('Plan page — "plan opstellen" regenerates the whole plan', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'REGEN-1',
          doc: {
            key: 'REGEN-1',
            title: 'Regenerate test',
            description: 'desc',
            url: '',
            questions: [{ id: 'q1', question: 'Eerste vraag?', options: [{ id: 'q1o1', label: 'Optie A' }] }],
            tasks: [{ id: 't1', title: 'Taak 1', explanation: '' }],
            answers: [],
            error: '',
            chat: [],
          },
          runs: [],
          generating: false,
        },
      }),
    )
  })

  test('renders next to the follow-up row, and a click sends the regenerate Signal', async ({ page }) => {
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-regen-1' } }))
    let signalled = null
    await page.route('**/api/workflows/run-regen-1/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/REGEN-1')
    await appReady(page)

    const followup = page.getByTestId('plan-followup')
    const regenerate = page.getByTestId('plan-regenerate')
    await expect(followup).toBeVisible()
    await expect(regenerate).toBeVisible()
    await expect(regenerate).toContainText('Plan opnieuw opstellen')
    await expect(regenerate.getByTestId('plan-regenerate-state')).toHaveText('plan opstellen')

    await regenerate.click()
    await expect.poll(() => signalled).toEqual({ questionId: '', optionId: '', text: '', kind: 'regenerate' })
    await expect(regenerate.getByTestId('plan-regenerate-state')).toHaveText('nieuw plan wordt opgesteld…')
  })

  test('Enter on the row, reached with ↓ from the default cursor, sends the same Signal', async ({ page }) => {
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-regen-2' } }))
    let signalled = null
    await page.route('**/api/workflows/run-regen-2/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/REGEN-1')
    await appReady(page)

    // Walk ↓ from wherever the default cursor lands until the regenerate row
    // has it — the exact number of rows before it (comments/options/own
    // answer) isn't this test's concern.
    const regenerate = page.getByTestId('plan-regenerate')
    for (let i = 0; i < 10 && (await regenerate.getAttribute('data-cursor')) !== 'true'; i++) {
      await page.keyboard.press('ArrowDown')
    }
    await expect(regenerate).toHaveAttribute('data-cursor', 'true')
    await page.keyboard.press('Enter')
    await expect.poll(() => signalled).toEqual({ questionId: '', optionId: '', text: '', kind: 'regenerate' })
  })
})
