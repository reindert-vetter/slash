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

test.describe('Plan page — questions column keyboard/mouse navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/plan?*', (route) => route.fulfill({ json: fixtureDoc() }))
    await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { ok: true, runId: 'run-nav-1' } }))
  })

  test('one Enter on an option row chooses it and jumps straight to the next question', async ({ page }) => {
    let signalled = null
    await page.route('**/api/workflows/run-nav-1/signals/plan_answer', (route) => {
      signalled = route.request().postDataJSON()
      route.fulfill({ json: { ok: true } })
    })

    await page.goto('/plan/NAV-1')
    await appReady(page)

    // Default cursor lands on q1o1 (the first row); Enter directly on the
    // row (no arrow-navigation, no click) — no input focused yet.
    await page.keyboard.press('Enter')

    await expect.poll(() => signalled).toMatchObject({ questionId: 'q1', optionId: 'q1o1' })
    // "Door" — the cursor already moved on to the SECOND question, not stuck
    // on q1 waiting for a second Enter.
    await expect(page).toHaveURL(/cur=q2o1/)
  })

  test('arrowing over options focuses the free-text field; Enter itself never does', async ({ page }) => {
    await page.route('**/api/workflows/run-nav-1/signals/plan_answer', (route) => route.fulfill({ json: { ok: true } }))

    await page.goto('/plan/NAV-1')
    await appReady(page)

    await page.keyboard.press('ArrowDown') // q1o1 -> q1o2
    await expect(page).toHaveURL(/cur=q1o2/)
    // The focus itself is requestAnimationFrame-deferred (focusOptionInput),
    // so it can genuinely lag one frame behind the (synchronous) URL update —
    // poll rather than read document.activeElement once.
    await expect
      .poll(() => page.evaluate(() => document.activeElement.getAttribute('data-testid')))
      .toBe('plan-option-input')

    // Enter on q1o2 chooses + advances to q2 WITHOUT leaving the input
    // focused on the new row (no auto-focus as a side effect of Enter).
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/cur=q2o1/)
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).not.toBe('INPUT')
  })

  test('an empty free-text field still lets ArrowRight open the block column', async ({ page }) => {
    await page.route('**/api/workflows/run-nav-1/signals/plan_answer', (route) => route.fulfill({ json: { ok: true } }))

    await page.goto('/plan/NAV-1')
    await appReady(page)

    await page.keyboard.press('ArrowDown') // focuses q1o2's own field
    await expect(page).toHaveURL(/cur=q1o2/)
    await page.keyboard.press('ArrowUp') // back to q1o1 (has a block), field focused and empty
    await expect(page).toHaveURL(/cur=q1o1/)
    await expect
      .poll(() => page.evaluate(() => document.activeElement.getAttribute('data-testid')))
      .toBe('plan-option-input')

    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('plan-block-column')).toBeVisible()
  })

  test('clicking a different option after opening a block column does not leave a stale horizontal scroll', async ({ page }) => {
    await page.route('**/api/workflows/run-nav-1/signals/plan_answer', (route) => route.fulfill({ json: { ok: true } }))

    await page.goto('/plan/NAV-1')
    await appReady(page)

    await page.keyboard.press('ArrowRight') // column 0 -> 1
    await page.keyboard.press('ArrowRight') // column 1 -> 2 (opens q1o1's block column)
    await expect(page.getByTestId('plan-block-column')).toBeVisible()

    const scrollLeft = () => page.evaluate(() => document.querySelector('[data-testid="plan-columns"]').scrollLeft)
    const infoColBox = () => page.getByTestId('plan-info-column').boundingBox()

    const before = await scrollLeft()

    // A real mouse click (not Playwright's auto-scrolling .click()) on a
    // DIFFERENT option's own field, from this deeper column.
    const target = await page
      .locator('[data-testid="plan-option"][data-option-id="q1o2"] input[data-testid="plan-option-input"]')
      .boundingBox()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(150)

    const after = await scrollLeft()
    const box = await infoColBox()
    // The whole point of focusColumn1: the scroll re-anchors to column 1
    // (scrollFocusIntoView), so column 0 stays fully out of view — not
    // wherever the browser's own scrollLeft clamp happened to leave it.
    expect(box.x).toBeLessThan(0)
    expect(after).not.toBe(before)
  })

  test('a real column jump is written to the debug-mode recording', async ({ page }) => {
    // Reviewer request (task4, debug mode already on for them): "voeg debug
    // manier toe zodat je dit later kan terugvinden" — verify the wiring end
    // to end, through the REAL /api/workflows/debug_log endpoint (not
    // mocked), since debug mode was never even initialized on this page
    // before this change (see .claude/docs/plan-page.md).
    await page.goto('/settings')
    const toggle = page.getByTestId('debug-mode-toggle')
    if ((await toggle.textContent()).includes('aan')) await toggle.click()
    await toggle.click()
    await expect(toggle).toHaveText(/Debug mode aan/)
    await page.getByTestId('settings-debug-clear').click()

    await page.route('**/api/workflows/run-nav-1/signals/plan_answer', (route) => route.fulfill({ json: { ok: true } }))
    await page.goto('/plan/NAV-1')
    await appReady(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight') // opens q1o1's block column (state.col: 2)

    const target = await page
      .locator('[data-testid="plan-option"][data-option-id="q1o2"] input[data-testid="plan-option-input"]')
      .boundingBox()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2)
    await page.mouse.down()
    await page.mouse.up()

    const readLog = () =>
      page.evaluate(async () => {
        const res = await fetch('/api/debug/log?limit=500')
        const data = await res.json()
        return data.events || []
      })
    await expect
      .poll(async () => (await readLog()).some((e) => e.type === 'action' && e.key === 'plan-col-jump'))
      .toBe(true)
  })
})
