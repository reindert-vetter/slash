import { test, expect, appReady } from './_fixtures.mjs'

// If arrow.js loses the selected block card's DOM (LOCAL PATCH 7/9 chunk cycle
// abort), ensureDetailCard (home.mjs) re-creates it instead of leaving the
// column empty until a refresh.
test('a missing detail card is re-created', async ({ page }) => {
  await page.goto('/pr/12903')
  await appReady(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  const card = page.locator('main [data-testid="detail-card"]')
  await expect(card.first()).toBeVisible()
  await page.evaluate(() => {
    document.querySelectorAll('main [data-testid="detail-card"]').forEach((e) => e.remove())
    window.dispatchEvent(new Event('arrow-chunk-abort'))
  })
  await expect(card.first()).toBeVisible({ timeout: 5000 })
})
