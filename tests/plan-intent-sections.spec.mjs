import { test, expect, appReady } from './_fixtures.mjs'

// Two related reviewer requests, both in the "Intentie" area of column 0
// (.claude/docs/plan-page.md, "The 'Intentie' field: shown, and editable"):
//
//   1. "misschien dat de markdown titels niet aangepast kan worden, alleen de
//      description daaronder, meer github markdown editor ofzo" — intent.md's
//      own markdown headings (parseIntentSections in src/plan.mjs) become
//      fixed, non-editable labels; only the text below each heading is its
//      own editable field, and an edit anywhere reconstructs and saves the
//      WHOLE intent.md text.
//   2. "als je dat selecteerd, alleen dan opmerkingen rechts daarvan zien
//      (ook als je pr description selecteerd hebt)" — a dedicated column
//      showing only the Jira-opmerkingen appears once the reviewer clicks
//      into either the ticket description or the intent field, and
//      disappears again once the keyboard moves elsewhere.
test.describe('Plan page — the sectioned Intentie editor and its comments column', () => {
  // A task (or question) on the document is what pushes planPhaseNow() past
  // 'intent' into 'specs' — only then does the field actually sit in the
  // TICKET placement (intentInQuestionsColumn() false), the one with the
  // collapse/lock behavior and the new dedicated comments column this test
  // is about. Without one, this ticket (no artifacts reported either) would
  // stay in the 'questions'-column placement instead, same as
  // plan-intent-phase.spec.mjs's own "stage specs" test.
  const planJson = () => ({
    ok: true,
    key: 'SECT-1',
    doc: {
      key: 'SECT-1',
      title: 'Sectioned intent test',
      description: 'De omschrijving van het ticket.',
      url: '',
      questions: [],
      tasks: [{ id: 't1', title: 'Iets doen', detail: '', blocks: [] }],
      answers: [],
      error: '',
      chat: [],
    },
    runs: [],
    generating: false,
    intent: '# Intent — SECT-1 Some feature\n\n## Problem\n\nDe oorzaak.\n\n## Proposed outcome\n\nHet resultaat.',
  })

  test('a heading is a fixed label, only the text below it is editable, and an edit saves the whole document', async ({ page }) => {
    let signalled = null
    await page.route('**/api/plan?*', (route) => route.fulfill({ json: planJson() }))
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-sect-1' } }))
    await page.route('**/api/workflows/run-sect-1/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/SECT-1')
    await appReady(page)

    // The field collapses while column 1 (the default) has the keyboard —
    // same pre-existing rule as the single-textarea version.
    await page.getByTestId('plan-ticket-card').click()

    const headings = page.getByTestId('plan-intent-heading')
    await expect(headings).toHaveCount(3)
    await expect(headings.nth(0)).toContainText('# Intent — SECT-1 Some feature')
    await expect(headings.nth(1)).toContainText('## Problem')
    await expect(headings.nth(2)).toContainText('## Proposed outcome')

    const bodies = page.getByTestId('plan-intent-section-body')
    await expect(bodies).toHaveCount(3)
    await expect(bodies.nth(1)).toHaveValue('De oorzaak.')
    await expect(bodies.nth(2)).toHaveValue('Het resultaat.')

    // Unlock (Enter), edit only the middle section, blur it — the heading
    // lines themselves were never touched (there is no field to type them
    // into), yet the saved Signal carries the full document, headings
    // included, with only that one section's body changed.
    await bodies.nth(1).focus()
    await bodies.nth(1).press('Enter')
    await bodies.nth(1).fill('De echte oorzaak.')
    await bodies.nth(1).blur()

    await expect.poll(() => signalled).toEqual({
      kind: 'intent',
      text: '# Intent — SECT-1 Some feature\n\n## Problem\n\nDe echte oorzaak.\n\n## Proposed outcome\n\nHet resultaat.',
    })
  })

  test('selecting the ticket description or the intent field shows a dedicated Jira-opmerkingen column, hidden otherwise', async ({
    page,
  }) => {
    await page.route('**/api/plan?*', (route) => route.fulfill({ json: planJson() }))
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [{ key: 'SECT-1', title: 'Sectioned intent test', relation: 'self', comments: [{ id: 'c1', author: 'Alice', created: '2026-01-01T10:00:00Z', body: 'Een opmerking' }] }],
        },
      }),
    )

    await page.goto('/plan/SECT-1')
    await appReady(page)

    // Nothing selected in column 0 yet (default cursor sits in column 1) —
    // no dedicated column.
    await expect(page.getByTestId('plan-intent-comments-column')).toHaveCount(0)

    // Selecting the ticket description shows it.
    await page.getByTestId('plan-description').click()
    const col = page.getByTestId('plan-intent-comments-column')
    await expect(col).toBeVisible()
    await expect(col).toContainText('Een opmerking')

    // Moving the keyboard to the questions column hides it again — and
    // collapses the intent field itself, since it lives under the ticket
    // description while column 1 has the keyboard.
    await page.getByTestId('plan-questions-column').click()
    await expect(page.getByTestId('plan-intent-comments-column')).toHaveCount(0)
    await expect(page.getByTestId('plan-intent-section-body')).toHaveCount(0)

    // Re-expand it (column 0 back in focus), then select the intent field
    // itself — that also shows the dedicated column.
    await page.getByTestId('plan-ticket-card').click()
    const firstBody = page.getByTestId('plan-intent-section-body').first()
    await firstBody.click()
    await expect(page.getByTestId('plan-intent-comments-column')).toBeVisible()
  })
})
