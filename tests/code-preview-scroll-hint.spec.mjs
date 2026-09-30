import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

test.use({ viewport: { width: 2000, height: 1100 } })

// The scroll hint of a code-preview pane is statically anchored to its own
// scroller (no measured inline top/bottom), so it can never drift into the
// code after a size change that fires no scroll event.
test('the down hint sits on the scroller bottom edge and stays there after a resize without scrolling', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const lines = Array.from({ length: 80 }, (_, i) => `$v${i} = ${i};`).join('\n')
  await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr, file: 'test.php', line: 1, author: 'reviewer',
      body: 'lang:\n```php\n' + lines + '\n```',
      code: '$order->total();', gran: 'call', label: 'Order::total',
    },
  })
  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await page.getByTestId('comment-item').first().click()
  const card = page.getByTestId('code-preview-card').first()
  await expect(card).toBeVisible()
  const pre = card.locator('pre[data-scroll-body]').first()
  const down = card.locator('[data-hint="down"]').first()
  await expect(down).toHaveCSS('opacity', '1')
  const gap = async () => {
    const p = await pre.boundingBox()
    const d = await down.boundingBox()
    return p.y + p.height - (d.y + d.height)
  }
  expect(Math.abs(await gap())).toBeLessThan(1.5)
  expect(await down.evaluate((el) => el.style.bottom)).toBe('')

  await page.setViewportSize({ width: 2000, height: 600 })
  await expect.poll(async () => Math.abs(await gap())).toBeLessThan(1.5)
  await expect(down).toHaveCSS('opacity', '1')
  await expect(card.locator('[data-hint="up"]').first()).toHaveCSS('opacity', '0')
})
