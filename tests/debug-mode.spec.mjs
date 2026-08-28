import { test, expect } from './_fixtures.mjs'

// Debug mode (src/debugLog.mjs + debug_log.go): the settings-page switch that
// records navigation and actions into <dataDir>/debug-log.jsonl so Claude can
// replay a reported bug. See .claude/docs/debug-mode.md.
//
// The log file lives in the SHARED test data dir (-data tests/.tmp/data, see
// .claude/docs/testing-playwright.md), so each test here clears it first and
// only asserts on lines it produced itself. No other spec ever switches debug
// mode on — it is off by default — so nothing else writes to it.

async function readLog(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/debug/log?limit=500')
    const data = await res.json()
    return data.events || []
  })
}

async function clearLog(page) {
  await page.getByTestId('settings-debug-clear').click()
  await expect.poll(() => readLog(page).then((e) => e.length)).toBe(0)
}

test.describe('debug mode', () => {
  test('records the page open plus the keys that follow, and stays silent when off', async ({ page }) => {
    await page.goto('/settings')
    const toggle = page.getByTestId('debug-mode-toggle')
    await expect(toggle).toHaveText(/Debug mode uit/)
    await clearLog(page)

    await toggle.click()
    await expect(toggle).toHaveText(/Debug mode aan/)
    expect(await page.evaluate(() => localStorage.getItem('debugMode'))).toBe('on')

    // Opening the review tree is the START of a reproduction: the first line of
    // that page's session carries its full URL.
    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')

    // The buffer is shipped on a short timer (and on pagehide), so wait for the
    // batch to land rather than for a navigation.
    await expect
      .poll(async () => (await readLog(page)).filter((e) => e.type === 'nav').length)
      .toBeGreaterThan(0)
    const events = await readLog(page)

    const session = events.find((e) => e.type === 'session' && (e.url || '').includes('/pr/12903'))
    expect(session, 'a session event with the opened tree URL').toBeTruthy()
    expect(session.page).toBe('/pr/12903')
    expect(session.at).toBeTruthy()

    const keys = events.filter((e) => e.type === 'key' && e.key === 'ArrowDown')
    expect(keys.length).toBeGreaterThanOrEqual(2)

    // The navigation position lives in the query string, so a nav line is a
    // directly reusable reproduction point.
    const nav = events.find((e) => e.type === 'nav' && (e.url || '').includes('sel='))
    expect(nav, 'a nav event carrying the resulting ?sel=').toBeTruthy()

    // Switched off again: nothing new is recorded. Clearing comes AFTER the
    // switch, since the click that turns it off still happens while it is on —
    // and is correctly recorded.
    await page.goto('/settings')
    await expect(page.getByTestId('settings-rows')).toBeVisible()
    await page.getByTestId('debug-mode-toggle').click()
    await expect(page.getByTestId('debug-mode-toggle')).toHaveText(/Debug mode uit/)
    await clearLog(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(2500) // longer than the flush timer
    await page.goto('/settings')
    await expect(page.getByTestId('settings-rows')).toBeVisible()
    expect(await readLog(page)).toEqual([])
  })

  test('an uncaught error while recording lands as an error line with a stack, flushed immediately', async ({
    page,
  }) => {
    await page.goto('/settings')
    const toggle = page.getByTestId('debug-mode-toggle')
    await clearLog(page)
    await toggle.click()
    await expect(toggle).toHaveText(/Debug mode aan/)

    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()

    // Simulate the "one uncaught throw" shape documented in
    // .claude/docs/frontend-memory.md (Vt flush-abort / Gt dispatch crash):
    // debugLog.mjs's own `window.addEventListener('error', ...)` must catch
    // this regardless of where it originates.
    page.evaluate(() => {
      setTimeout(() => {
        throw new Error('synthetic-debug-log-test-error')
      }, 0)
    })

    // Deliberately NOT waitForTimeout-ing on the flush cadence: onError calls
    // flush() right away, so this should land fast — proving the "never sits
    // in a buffer" claim, not just that it eventually arrives.
    await expect
      .poll(async () => (await readLog(page)).some((e) => e.type === 'error' && e.message.includes('synthetic-debug-log-test-error')))
      .toBe(true)

    const events = await readLog(page)
    const err = events.find((e) => e.type === 'error' && e.message.includes('synthetic-debug-log-test-error'))
    expect(err.stack, 'a stack trace was captured').toBeTruthy()
    expect(err.page).toBe('/pr/12903')

    await page.goto('/settings')
    await expect(page.getByTestId('settings-rows')).toBeVisible()
    await page.getByTestId('debug-mode-toggle').click()
  })

  test('a caught arrow.js reactive throw (console.error, not an uncaught exception) still lands as an error line', async ({
    page,
  }) => {
    // LOCAL PATCH 4/5 in src/vendor/arrow.js catch every reactive
    // effect/listener throw and only console.error it — never rethrow — so
    // this is a DIFFERENT path than the uncaught-throw test above
    // (installConsoleErrorHook, not window.onerror). See "arrow.js's own
    // CAUGHT throws" in .claude/docs/debug-mode.md.
    await page.goto('/settings')
    const toggle = page.getByTestId('debug-mode-toggle')
    await clearLog(page)
    await toggle.click()
    await expect(toggle).toHaveText(/Debug mode aan/)

    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()

    page.evaluate(() => {
      console.error('arrow: reactive effect threw', new Error('synthetic-arrow-caught-throw'))
      // An unrelated console.error must NOT be recorded — only arrow's own
      // prefixed messages are.
      console.error('some unrelated app warning, not from arrow.js')
    })

    await expect
      .poll(async () => (await readLog(page)).some((e) => e.type === 'error' && e.message.startsWith('arrow: reactive effect threw')))
      .toBe(true)

    const events = await readLog(page)
    const err = events.find((e) => e.type === 'error' && e.message.startsWith('arrow: reactive effect threw'))
    expect(err.stack, 'the Error object passed to console.error was captured as a stack').toContain('synthetic-arrow-caught-throw')
    expect(events.some((e) => e.type === 'error' && e.message.includes('unrelated app warning')), 'a non-arrow console.error is not recorded').toBe(
      false,
    )

    await page.goto('/settings')
    await expect(page.getByTestId('settings-rows')).toBeVisible()
    await page.getByTestId('debug-mode-toggle').click()
  })

  test('Enter on the debug row toggles it, same as clicking the switch', async ({ page }) => {
    await page.goto('/settings')
    // ROWS order: theme, langui, langexplain, langreply, langcommit, autowarn,
    // autoingestpref, debug — seven ↓ from the top (see settings-page.md).
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('debug-mode-toggle')).toHaveText(/Debug mode aan/)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('debug-mode-toggle')).toHaveText(/Debug mode uit/)
  })
})
