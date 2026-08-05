import { test, expect, seededPr } from './_fixtures.mjs'

// Regression: a REJECTED message Signal must not be silent.
//
// sendClaudeMessage (RelatedPanel.mjs) used to fire the POST and never look at
// the response, so a 400/409/500 produced literally nothing in the UI: no
// bubble, no status line, no disabled state — the reviewer pressed "Stuur" (or
// "Opnieuw proberen") and the column just sat there. That is exactly how a
// server running an older binary than the page it serves (`src/` is read off
// disk on every reload, the Go process is not) makes the whole Claude column
// look healthy while rejecting every action it does not know yet with
// "invalid action". Reported as "ik kan niet reageren op claude".
//
// Asserted here against a mocked 400 — the real one came from a pre-`retry`
// server meeting a page that already had the button. See "A rejected Signal
// must not be silent" in .claude/docs/claude-chat-panel.md.
test('embedded Claude chat: a rejected message Signal is reported, and clears on the next accepted send', async ({
  page,
}, testInfo) => {
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

  // Reject the first send exactly like the real server does for an action it
  // does not know; let every later one through.
  let seen = 0
  await page.route('**/signals/message', async (route) => {
    seen++
    if (seen === 1) {
      await route.fulfill({ status: 400, contentType: 'text/plain', body: 'invalid action' })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'signalled' }),
    })
  })

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')

  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // Nothing wrong yet, so no line at all.
  await expect(page.getByTestId('claude-send-error')).toHaveCount(0)

  await composer.fill('eerste vraag')
  await composer.press('Enter')

  // The rejection is named in WORDS (never a bare colour), and says what to do
  // about it — the reviewer must be able to tell "not sent" from "sent, Claude
  // is thinking".
  const line = page.getByTestId('claude-send-error')
  await expect(line).toBeVisible()
  await expect(line).toContainText('Niet verstuurd')
  await expect(line).toContainText('Herstart slash')

  // The composer stays usable, and a send that IS accepted clears the line
  // again — it reports the LAST send, not a sticky failure state.
  await expect(composer).toBeEnabled()
  await composer.fill('tweede vraag')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-send-error')).toHaveCount(0)
})
