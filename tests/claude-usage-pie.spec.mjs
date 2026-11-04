import { test, expect, appReady } from './_fixtures.mjs'

// 5h Claude session pie left of the clock (src/UsagePie.mjs), fed by a mocked
// GET /api/claude/usage. Text carries the meaning; data-state the colour band.
const now = () => Math.floor(Date.now() / 1000)

// Wednesday 2026-11-04 15:00 Amsterdam (working hours 08:30–15:30). The window
// runs 13:40–18:40, so 80 of its 110 working minutes have passed: pace =
// used × 110/80 (same formula as ~/.claude/statusline.py).
const at = (iso) => Math.floor(Date.parse(iso) / 1000)
const NOW = '2026-11-04T14:00:00Z'

for (const [utilization, state, used, pace] of [
  [0.6, 'normal', '60%', '83%'],
  [0.7, 'warn', '70%', '96%'],
  [0.8, 'late', '80%', '110%!'],
]) {
  test(`usage pie shows ${used} used, pace ${pace} as ${state}`, async ({ page }) => {
    await page.clock.install({ time: new Date(NOW) })
    await page.route('**/api/claude/usage', (r) =>
      r.fulfill({ json: { ok: true, utilization, resetsAt: at('2026-11-04T17:40:00Z'), seenAt: at(NOW) } }),
    )
    await page.goto('/pr/12903')
    await appReady(page)
    const pie = page.getByTestId('claude-usage')
    await expect(pie).toHaveAttribute('data-state', state)
    await expect(page.getByTestId('claude-usage-text')).toHaveText(used)
    await expect(page.getByTestId('claude-usage-pace-text')).toHaveText(pace)
    await expect(pie).toHaveAttribute('title', new RegExp(`^${used} van je .* tempo ${pace} bij reset`))
    await expect(page.getByTestId('claude-usage-slice')).toHaveAttribute('d', /^M12/)
    await expect(page.getByTestId('claude-usage-pace-slice')).toHaveAttribute('d', /^M12/)
  })
}

test('usage pace falls back to wall clock, marked ~, outside working hours', async ({ page }) => {
  // Sunday: no working hours at all → pct × 5h / elapsed wall clock = 50 × 5/2.5.
  await page.clock.install({ time: new Date('2026-11-08T14:30:00Z') })
  await page.route('**/api/claude/usage', (r) =>
    r.fulfill({
      json: { ok: true, utilization: 0.5, resetsAt: at('2026-11-08T17:00:00Z'), seenAt: at('2026-11-08T14:30:00Z') },
    }),
  )
  await page.goto('/pr/12903')
  await appReady(page)
  await expect(page.getByTestId('claude-usage-pace-text')).toHaveText('~100%')
  await expect(page.getByTestId('claude-usage')).toHaveAttribute('data-state', 'warn')
})

test('usage pie is dimmed with "?" once the window has reset', async ({ page }) => {
  await page.route('**/api/claude/usage', (r) =>
    r.fulfill({ json: { ok: true, utilization: 0.9, resetsAt: now() - 60, seenAt: now() - 7200 } }),
  )
  await page.goto('/pr/12903')
  await appReady(page)
  await expect(page.getByTestId('claude-usage')).toHaveAttribute('data-state', 'stale')
  await expect(page.getByTestId('claude-usage-text')).toHaveText('?')
  await expect(page.getByTestId('claude-usage')).toHaveClass(/opacity-50/)
  await expect(page.getByTestId('claude-usage-pace')).toHaveCount(0)
})

test('usage pie is absent without a reading', async ({ page }) => {
  await page.route('**/api/claude/usage', (r) => r.fulfill({ json: { ok: false } }))
  await page.goto('/pr/12903')
  await appReady(page)
  await expect(page.getByTestId('tree-clock')).toBeVisible()
  await expect(page.getByTestId('claude-usage')).toHaveCount(0)
})
