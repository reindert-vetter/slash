import { test, expect, seededPr } from './_fixtures.mjs'

// Cmd+C on a keyboard-selected Claude chat bubble (cs.claudePos >= 1, walked
// there with ↑) copies that turn's own raw text — see "Cmd+C on a selected
// bubble copies that turn's own text" in .claude/docs/claude-chat-panel.md.
// Same mockClipboard shape as tests/copy-line-menu.spec.mjs (the native
// right-click "Kopieer selectie"/"Kopieer deze regel" mechanism).
async function mockClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied = t
          return Promise.resolve()
        },
        readText: () => Promise.resolve(window.__copied),
      },
    })
  })
}

async function openClaudeChatWithOneMessage(page, testInfo) {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kan dit sneller?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude

  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()
  await composer.fill('wil je hier niet console.warning hebben?')
  await composer.press('Enter')

  const own = page.getByTestId('claude-message-body').filter({ hasText: 'console.warning' })
  await expect(own).toContainText('wil je hier niet console.warning hebben?')

  // The test double auto-replies (fixtures/claude-chat-turns.json), same as
  // every other Claude-chat spec — wait for that reply so the message count
  // is stable before walking the transcript with ↑, otherwise the reply can
  // land mid-navigation and shift which bubble ↑ lands on.
  await expect(page.getByTestId('claude-message-body').filter({ hasText: 'Ik heb naar de code gekeken' })).toBeVisible()
  await expect(page.getByTestId('claude-message')).toHaveCount(2)
  return own
}

test('Cmd+C on a selected Claude chat bubble copies its own text', async ({ page }, testInfo) => {
  await mockClipboard(page)
  const own = await openClaudeChatWithOneMessage(page, testInfo)

  // ↑ selects the newest bubble first (the AI reply, cs.claudePos 1), a
  // second ↑ steps onto the reviewer's own message right below it
  // (cs.claudePos 2) — the exact scenario in the reported screenshot.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(own).toHaveClass(/ring-2/)

  await page.keyboard.press('Meta+c')
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('wil je hier niet console.warning hebben?')
})

test('Cmd+C leaves a real text selection alone instead of copying the whole bubble', async ({
  page,
}, testInfo) => {
  await mockClipboard(page)
  const own = await openClaudeChatWithOneMessage(page, testInfo)

  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(own).toHaveClass(/ring-2/)

  // A genuine DOM text selection inside the bubble (e.g. the reviewer
  // dragged over part of the text) must win over the "copy the whole turn"
  // shortcut — window.getSelection().toString() is the carve-out the branch
  // checks for.
  await own.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })

  await page.keyboard.press('Meta+c')
  // The app's own clipboard override must not have fired — whether the
  // browser's native copy actually reaches the OS clipboard in this
  // headless context is not what's under test here.
  expect(await page.evaluate(() => window.__copied)).toBeNull()
})
