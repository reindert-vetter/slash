import { test, expect, appReady } from './_fixtures.mjs'

// "Altijd een laatste optie met alleen input velden" (reviewer request) —
// every multiple-choice question on the plan page also gets one synthetic,
// generated-content-free last choice, so a reviewer whose real cause isn't
// among Claude's suggested options can type their own instead of being
// forced to pick one that doesn't fit. See `ownOptionRow`/`ownOptionId` in
// `src/plan.mjs`. This is regression-sensitive: it's a synthetic row keyed
// alongside real, server-generated option rows (arrow.js duplicate-`.key()`
// pitfall, see `.claude/rules/arrowjs-pitfalls.md`), so the test asserts both
// the row count and that choosing it actually persists.
test.describe('Plan page — the always-present own-answer option', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'OWNOPT-1',
          doc: {
            key: 'OWNOPT-1',
            title: 'Own option test',
            description: 'desc',
            url: '',
            questions: [
              {
                id: 'q1',
                question: 'Wat is de oorzaak?',
                why: '',
                options: [
                  { id: 'q1o1', label: 'Optie A', detail: 'omschrijving A', blocks: [] },
                  { id: 'q1o2', label: 'Optie B', detail: 'omschrijving B', blocks: [] },
                ],
              },
            ],
            tasks: [],
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

  test('a third, label-less row is always appended, and choosing it persists the typed answer', async ({ page }) => {
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-ownopt-1' } }))
    let signalled = null
    await page.route('**/api/workflows/run-ownopt-1/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/OWNOPT-1')
    await appReady(page)

    const options = page.getByTestId('plan-option')
    await expect(options).toHaveCount(3)

    const ownOption = page.locator('[data-testid="plan-option"][data-own-option="true"]')
    await expect(ownOption).toHaveCount(1)
    // No generated label/detail text on this row — only its input field.
    await expect(ownOption).not.toContainText('Optie A')
    await expect(ownOption).not.toContainText('Optie B')

    const ownInput = ownOption.getByTestId('plan-option-input')
    await expect(ownInput).toBeVisible()
    await ownInput.fill('een oorzaak die niet in de lijst staat')
    await ownInput.press('Enter')

    await expect.poll(() => signalled).toMatchObject({
      questionId: 'q1',
      text: 'een oorzaak die niet in de lijst staat',
    })
    await expect(signalled.optionId).toBe('q1:own')
    await expect(ownOption).toHaveAttribute('data-chosen', 'true')
    await expect(ownOption).toContainText('gekozen')
  })
})
