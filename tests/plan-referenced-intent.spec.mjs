import { test, expect, appReady } from './_fixtures.mjs'

// "Referenced tickets" (a Jira link or a bare key mention outside this
// ticket's own family, each with its own best-effort branch) and the Jira
// topics above the planning chat (which replaced the old editable "Intentie"
// field) — see .claude/docs/plan-page.md, "Referenced tickets outside this
// one's own family" / "The Jira topics above the chat".
test.describe('Plan page — referenced tickets and the Jira topics', () => {
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

  // The topics above the chat: ticking one off and rewriting another must
  // reach the tracker, and a reload right after typing (no blur, an
  // immediate F5) must neither show the old text nor lose the new one —
  // the reported "als ik input aanpas, dan is dat niet aangepast (na een
  // refresh)" of the old intent field.
  test('a topic toggle and an edit are signalled, and an edit survives an immediate reload', async ({ page }) => {
    const signals = []
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
            topicsAt: '2026-10-19T10:00:00Z',
            topics: [
              { id: 'o1', title: 'Probleem', body: 'MRR wijkt af.' },
              { id: 'o2', title: 'Export', body: '| a | b |\n|---|---|\n| 1 | 2 |' },
            ],
          },
          runs: [],
          generating: false,
        },
      }),
    )
    await page.route('**/api/workflows/*/signals/*', (route) => {
      signals.push(JSON.parse(route.request().postData() || '{}'))
      return route.fulfill({ json: { status: 'answered' } })
    })

    await page.goto('/plan/PROD-254')
    await appReady(page)

    const o2 = page.locator('[data-testid=plan-topic][data-topic-id=o2]')
    // A table in a topic renders as a table, not as pipes.
    await expect(o2.locator('table')).toBeVisible()
    await expect(o2).toHaveAttribute('data-topic-state', 'on')
    await o2.getByTestId('plan-topic-toggle').click()
    await expect(o2).toHaveAttribute('data-topic-state', 'off')
    await expect(o2.getByTestId('plan-topic-toggle')).toContainText('buiten scope')
    await expect.poll(() => signals.find((b) => b.kind === 'topic' && b.topicId === 'o2')).toMatchObject({ topicOff: true })

    const o1 = page.locator('[data-testid=plan-topic][data-topic-id=o1]')
    await o1.getByTestId('plan-topic-edit').click()
    await o1.getByTestId('plan-topic-input').fill('Alleen de MRR-berekening.')
    await page.reload()
    await appReady(page)
    await expect(page.locator('[data-topic-id=o1] [data-testid=plan-topic-body]')).toHaveText('Alleen de MRR-berekening.')
    await expect(page.locator('[data-topic-id=o2]')).toHaveAttribute('data-topic-state', 'off')
    // Re-sent once the page is back (the mocked server never confirms it).
    await expect
      .poll(() => signals.find((b) => b.kind === 'topic' && b.topicId === 'o1' && b.text === 'Alleen de MRR-berekening.'))
      .toBeTruthy()
  })
})
