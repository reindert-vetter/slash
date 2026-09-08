import { test, expect, appReady } from './_fixtures.mjs'

// "Referenced tickets" (a Jira link or a bare key mention outside this
// ticket's own family, each with its own best-effort branch) and the
// editable "Intentie" field in column 0 — see .claude/docs/plan-page.md,
// "Referenced tickets outside this one's own family" / "Intent field".
test.describe('Plan page — referenced tickets and the editable Intentie field', () => {
  test('lists a referenced ticket with an authoritative PR branch and one with a guessed branch', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'PROD-254',
          doc: {
            key: 'PROD-254',
            title: 'Statistieken in clickhouse',
            description: 'desc',
            url: '',
            questions: [],
            tasks: [],
            answers: [],
            error: '',
            chat: [],
            referenced: [
              { key: 'PROD-216', title: 'Productgroepen', reason: 'relates to', branch: 'feature/PROD-216-groepen', branchSource: 'pr:#4211' },
              { key: 'PROD-300', title: 'Migratie', reason: 'vermeld in tekst', branch: 'prod-300-migratie', branchSource: 'jira-tekst' },
            ],
          },
          runs: [],
          generating: false,
          intent: '# Intent — PROD-254 Statistieken in clickhouse\n\nAuto-generated body.',
        },
      }),
    )

    await page.goto('/plan/PROD-254')
    await appReady(page)

    const rows = page.getByTestId('plan-referenced-issue')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('PROD-216')
    await expect(rows.nth(0)).toContainText('relates to')
    await expect(rows.nth(0)).toContainText('feature/PROD-216-groepen')
    await expect(rows.nth(0)).toContainText('pr:#4211')
    await expect(rows.nth(1)).toContainText('PROD-300')
    await expect(rows.nth(1)).toContainText('vermoedelijk')
    await expect(rows.nth(1)).toContainText('prod-300-migratie')
    await expect(rows.nth(0)).toHaveAttribute('href', '/plan/PROD-216')
  })

  test('the Intentie field seeds itself with the generated text and saves an edit on blur', async ({ page }) => {
    let signalled = null
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'PROD-254',
          doc: {
            key: 'PROD-254',
            title: 'Statistieken',
            description: 'desc',
            url: '',
            questions: [],
            tasks: [],
            answers: [],
            error: '',
            chat: [],
          },
          runs: [],
          generating: false,
          intent: 'Auto-generated intent text.',
        },
      }),
    )
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-intent-1' } }))
    await page.route('**/api/workflows/run-intent-1/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/PROD-254')
    await appReady(page)

    const field = page.getByTestId('plan-intent-field')
    await expect(field).toHaveValue('Auto-generated intent text.')

    await field.fill('Mijn eigen intentie: bouwt voort op PROD-216.')
    await field.blur()
    await expect.poll(() => signalled).toEqual({ kind: 'intent', text: 'Mijn eigen intentie: bouwt voort op PROD-216.' })
  })

  test('an active override shows a reset button that clears it', async ({ page }) => {
    let signalled = null
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'PROD-254',
          doc: {
            key: 'PROD-254',
            title: 'Statistieken',
            description: 'desc',
            url: '',
            questions: [],
            tasks: [],
            answers: [],
            error: '',
            chat: [],
            intentOverride: 'Mijn eigen intentie.',
          },
          runs: [],
          generating: false,
          intent: 'Mijn eigen intentie.',
        },
      }),
    )
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-intent-2' } }))
    await page.route('**/api/workflows/run-intent-2/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/PROD-254')
    await appReady(page)

    await expect(page.getByTestId('plan-intent-field')).toHaveValue('Mijn eigen intentie.')
    await page.getByTestId('plan-intent-reset').click()
    await expect.poll(() => signalled).toEqual({ kind: 'intent', text: '' })
  })
})
