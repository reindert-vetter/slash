import { test, expect, appReady } from './_fixtures.mjs'

// Where the "Intentie" field lives, and when it can be typed in — reviewer
// request: "laat mij intentie in 2e kolom zien als je nog in stap 1 zit, als
// je in stap 2 zit, dan mag het zoals nu, maar alleen editbaar als je enter
// erop drukt". Two placements of ONE component (see `intentField` /
// `intentInQuestionsColumn` in src/plan.mjs), plus a read-only lock that only
// Enter opens — regression-sensitive because the placement is derived from the
// planning phase and the lock is a reactive `readonly` attribute (the
// boolean-attribute pitfall in .claude/rules/arrowjs-pitfalls.md).
test.describe('Plan page — the Intentie field per planning phase', () => {
  const planJson = (extra) => ({
    ok: true,
    key: 'INTENT-1',
    doc: {
      key: 'INTENT-1',
      title: 'Intentie test',
      description: 'desc',
      url: '',
      questions: [],
      tasks: [],
      answers: [],
      error: '',
      chat: [],
      ...extra,
    },
    runs: [],
    generating: false,
    intent: 'Auto-generated intent text.',
  })

  test('stage intent shows it in the questions column, directly typable', async ({ page }) => {
    await page.route('**/api/plan?*', (route) => route.fulfill({ json: planJson({}) }))

    await page.goto('/plan/INTENT-1')
    await appReady(page)

    const field = page.getByTestId('plan-intent')
    await expect(field).toHaveAttribute('data-intent-place', 'questions')
    await expect(page.getByTestId('plan-questions-column').getByTestId('plan-intent')).toHaveCount(1)
    await expect(field).toHaveAttribute('data-locked', 'false')

    // No lock to open: typing lands straight in the textarea.
    const area = page.getByTestId('plan-intent-section-body')
    await expect(area).not.toHaveAttribute('readonly', /.*/)
    await area.fill('Mijn eigen intentie.')
    await expect(area).toHaveValue('Mijn eigen intentie.')
  })

  test('stage specs keeps it under the ticket, read-only until Enter unlocks it', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: planJson({
          questions: [
            { id: 'q1', question: 'Wat is de oorzaak?', why: '', options: [{ id: 'q1o1', label: 'Optie A', detail: '', blocks: [] }] },
          ],
          tasks: [{ id: 't1', title: 'Iets doen', detail: '', blocks: [] }],
        }),
      }),
    )

    await page.goto('/plan/INTENT-1')
    await appReady(page)

    // Column 0 has to have the keyboard for the field to be expanded at all —
    // the pre-existing collapse rule, unchanged by this feature.
    await page.getByTestId('plan-ticket-card').click()

    const field = page.getByTestId('plan-intent')
    await expect(field).toHaveAttribute('data-intent-place', 'ticket')
    await expect(field).toHaveAttribute('data-locked', 'true')

    const area = page.getByTestId('plan-intent-section-body')
    await expect(area).toHaveAttribute('readonly', 'true')
    await expect(page.getByTestId('plan-intent-lock-label')).toContainText('vergrendeld')

    // Enter on the focused field is what unlocks it — and never types a
    // newline of its own.
    await area.focus()
    await area.press('Enter')
    await expect(area).not.toHaveAttribute('readonly', /.*/)
    await expect(field).toHaveAttribute('data-locked', 'false')
    await expect(area).toHaveValue('Auto-generated intent text.')
    await expect(page.getByTestId('plan-intent-lock-label')).toContainText('bewerken')
  })
})
