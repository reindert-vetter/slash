import { test, expect, appReady } from './_fixtures.mjs'

// 5h Claude session pie left of the clock (src/UsagePie.mjs), fed by a mocked
// GET /api/claude/usage. Text carries the meaning; data-state the colour band.
const now = () => Math.floor(Date.now() / 1000)

for (const [utilization, state, text] of [
  [0.71, 'normal', '29%'],
  [0.85, 'warn', '15%'],
  [0.97, 'late', '3%'],
]) {
  test(`usage pie shows ${text} left as ${state}`, async ({ page }) => {
    await page.route('**/api/claude/usage', (r) =>
      r.fulfill({ json: { ok: true, utilization, resetsAt: now() + 3600, seenAt: now() } }),
    )
    await page.goto('/pr/12903')
    await appReady(page)
    const pie = page.getByTestId('claude-usage')
    await expect(pie).toHaveAttribute('data-state', state)
    await expect(page.getByTestId('claude-usage-text')).toHaveText(text)
    await expect(pie).toHaveAttribute('title', new RegExp(`^${text} over`))
    await expect(page.getByTestId('claude-usage-slice')).toHaveAttribute('d', /^M12/)
  })
}

test('usage pie is dimmed with "?" once the window has reset', async ({ page }) => {
  await page.route('**/api/claude/usage', (r) =>
    r.fulfill({ json: { ok: true, utilization: 0.9, resetsAt: now() - 60, seenAt: now() - 7200 } }),
  )
  await page.goto('/pr/12903')
  await appReady(page)
  await expect(page.getByTestId('claude-usage')).toHaveAttribute('data-state', 'stale')
  await expect(page.getByTestId('claude-usage-text')).toHaveText('?')
  await expect(page.getByTestId('claude-usage')).toHaveClass(/opacity-50/)
})

test('usage pie is absent without a reading', async ({ page }) => {
  await page.route('**/api/claude/usage', (r) => r.fulfill({ json: { ok: false } }))
  await page.goto('/pr/12903')
  await appReady(page)
  await expect(page.getByTestId('tree-clock')).toBeVisible()
  await expect(page.getByTestId('claude-usage')).toHaveCount(0)
})
