import { test, expect, appReady } from './_fixtures.mjs'

// Analog clock left of the bell in the /pr/<id> corner: colour by local time.
for (const [iso, state] of [
  ['2026-09-30T14:29:00', 'normal'],
  ['2026-09-30T14:31:00', 'warn'],
  ['2026-09-30T15:01:00', 'late'],
  ['2026-09-30T17:00:00', 'normal'],
  // Wednesday keeps the default rule.
  ['2026-09-30T16:46:00', 'late'],
  // Tuesday / Thursday: orange from 16:45, red from 17:00 until midnight.
  ['2026-09-29T14:31:00', 'normal'],
  ['2026-09-29T16:44:00', 'normal'],
  ['2026-09-29T16:45:00', 'warn'],
  ['2026-09-29T17:01:00', 'late'],
  ['2026-10-01T16:45:00', 'warn'],
  ['2026-10-01T23:59:00', 'late'],
]) {
  test(`tree clock is ${state} at ${iso}`, async ({ page }) => {
    await page.clock.install({ time: new Date(iso) })
    await page.goto('/pr/12903')
    await appReady(page)
    await expect(page.getByTestId('tree-clock')).toHaveAttribute('data-state', state)
  })
}
