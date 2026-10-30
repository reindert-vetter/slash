import { test, expect, appReady } from './_fixtures.mjs'

// Regression for three reviewer reports on the questions column's keyboard/
// mouse navigation (.claude/docs/plan-page.md, "One `Enter` chooses AND
// advances…" and "`focusColumn1`…"):
//
// 1. "Eén enter = door" — Enter on an option row must choose it AND jump to
//    the next question in one press, not require a second Enter inside the
//    free-text field.
// 2. Arrowing (↑/↓) over an option auto-focuses its own free-text field so
//    the reviewer can start typing right away — but Enter itself must never
//    trigger that focus.
// 3. `focusColumn1` — clicking an option from a deeper (block-column) view
//    must re-anchor the horizontal scroll instead of leaving a stale
//    scrollLeft for the browser to silently clamp (which used to reveal
//    column 0 unexpectedly, "input 'Eigen antwoord' laat opeens ook eerste
//    kolom zien").
function fixtureDoc() {
  return {
    ok: true,
    key: 'NAV-1',
    doc: {
      key: 'NAV-1',
      title: 'Nav test',
      description: 'desc',
      url: '',
      questions: [
        {
          id: 'q1',
          question: 'Eerste vraag?',
          why: '',
          options: [
            {
              id: 'q1o1',
              label: 'Optie A',
              detail: 'omschrijving A',
              blocks: [{ file: 'a.php', label: 'fnA', lang: 'php', code: '<?php\necho 1;', note: 'n', children: [] }],
            },
            { id: 'q1o2', label: 'Optie B', detail: 'omschrijving B', blocks: [] },
          ],
        },
        {
          id: 'q2',
          question: 'Tweede vraag?',
          why: '',
          options: [{ id: 'q2o1', label: 'Optie C', detail: 'omschrijving C', blocks: [] }],
        },
      ],
      tasks: [],
      answers: [],
      error: '',
      chat: [],
    },
    runs: [],
    generating: false,
  }
}

test.describe('Plan page — ArrowRight slides the example-code column to the left edge', () => {
  test('the focused block column ends up at the left edge of the flow', async ({ page }) => {
    await page.route('**/api/plan?*', (route) => route.fulfill({ json: fixtureDoc() }))
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto('/plan/NAV-1')
    await appReady(page)
    await page.keyboard.press('ArrowRight') // ticket -> questions
    await page.keyboard.press('ArrowRight') // questions -> block column
    const col = page.getByTestId('plan-block-column')
    await expect(col).toHaveAttribute('data-column-focused', 'true')
    await expect
      .poll(async () => {
        const b = await col.boundingBox()
        return Math.round(b.x)
      }, { timeout: 5000 })
      .toBeLessThanOrEqual(30)
  })
})
