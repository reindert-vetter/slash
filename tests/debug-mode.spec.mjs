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
