import { test, expect } from './_fixtures.mjs'

// Both pages follow the OS-level prefers-color-scheme setting (Tailwind
// darkMode:'media', no JS toggle — see .claude/rules/conventions.md, "Thema:
// dark/light volgt de systeeminstelling"). page.emulateMedia lets us assert
// the two colour schemes actually render differently, and that each mode is
// applied consistently (no leftover forced-dark / forced-light artifact).

test.describe('theme — prefers-color-scheme', () => {
  test('PR page (index.html) switches background/text colour with the OS scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const lightText = await page.evaluate(() => getComputedStyle(document.body).color)

    await page.emulateMedia({ colorScheme: 'dark' })
    // No reload needed — prefers-color-scheme is a live media query, Tailwind's
    // CDN JIT re-evaluates dark: classes immediately.
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const darkText = await page.evaluate(() => getComputedStyle(document.body).color)

    expect(darkBg).not.toBe(lightBg)
    expect(darkText).not.toBe(lightText)
    // Sanity: light body is the slate-50 tint (near white), dark body is zinc-950 (near black).
    expect(lightBg).toBe('rgb(248, 250, 252)')
    expect(darkBg).toBe('rgb(9, 9, 11)')
  })

  test('PR page block card follows the scheme too (not just the body)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/pr/12903')
    const card = page.locator('article').first()
    await expect(card).toBeVisible()
    const lightCardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(lightCardBg).toBe('rgb(255, 255, 255)') // bg-white

    await page.emulateMedia({ colorScheme: 'dark' })
    // The card has a `transition` class; the media-query re-evaluation and the
    // resulting repaint aren't always reflected in the very next evaluate() call,
    // so poll briefly instead of asserting immediately.
    await expect
      .poll(() => card.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(24, 24, 27)') // dark:bg-zinc-900
  })

  test('PR overview page (/pr-overview) switches background/text colour with the OS scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/pr-overview')
    await expect(page.getByTestId('inbox')).toBeVisible()
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const lightText = await page.evaluate(() => getComputedStyle(document.body).color)

    await page.emulateMedia({ colorScheme: 'dark' })
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const darkText = await page.evaluate(() => getComputedStyle(document.body).color)

    expect(darkBg).not.toBe(lightBg)
    expect(darkText).not.toBe(lightText)
    // Overview used to force dark mode unconditionally (<html class="dark">) —
    // this pins down that light mode now really is white/near-black text, not
    // the old forced zinc-950 shell.
    expect(lightBg).toBe('rgb(255, 255, 255)')
    expect(darkBg).toBe('rgb(9, 9, 11)')
  })
})
