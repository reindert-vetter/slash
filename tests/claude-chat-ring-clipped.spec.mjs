import { test, expect, seededPr } from './_fixtures.mjs'

// Regression: the SELECTED chat bubble's highlight is a Tailwind `ring-2`
// (claudeBubble, ClaudeChat.mjs), and a ring paints OUTSIDE the border box —
// so the thread's own `overflow-y-auto` clipped it flush against the
// container edge. On the newest message that read as "I can't see the bottom
// border of the last message" (Reindert): scrolling to the bottom didn't help,
// because those 2px were never inside the scrollable area at all.
//
// The fix is the `p-0.5` on the scroll container. This spec asserts the
// geometry rather than the class, so it keeps failing if someone drops the
// padding again while the ring stays: the selected bubble's box PLUS its 2px
// ring has to fit inside the thread's visible client rect.
const RING = 2

test('the selected Claude bubble\'s ring is not clipped at the bottom of the thread', async ({
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

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  await page.keyboard.press('ArrowRight') // comment -> claude
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // Fill the thread well past its max-h-[38vh] cap, so it really scrolls and
  // the last bubble really sits against the bottom edge — the exact situation
  // the clipping showed up in.
  for (const msg of ['eerste vraag', 'tweede vraag', 'derde vraag', 'commit en merge in branch']) {
    await composer.fill(msg)
    await composer.press('Enter')
    await expect(page.getByTestId('claude-message-body').filter({ hasText: msg })).toBeVisible()
  }

  // ↑ selects the newest bubble (claudePos 1 -> the ring appears on it).
  await page.keyboard.press('ArrowUp')
  const selected = page.locator('[data-testid=claude-message-body].ring-2').last()
  await expect(selected).toBeVisible()

  const fits = await page.evaluate((ring) => {
    const thread = document.querySelector('[data-testid=claude-chat-thread]')
    const bubbles = [...thread.querySelectorAll('[data-testid=claude-message-body]')]
    const sel = bubbles.filter((b) => b.classList.contains('ring-2')).pop()
    const t = thread.getBoundingClientRect()
    const b = sel.getBoundingClientRect()
    return {
      bottomOverflow: b.bottom + ring - t.bottom,
      rightOverflow: b.right + ring - t.right,
    }
  }, RING)

  // <= 0 means the ring still has room inside the visible thread box.
  expect(fits.bottomOverflow).toBeLessThanOrEqual(0)
  expect(fits.rightOverflow).toBeLessThanOrEqual(0)
})
