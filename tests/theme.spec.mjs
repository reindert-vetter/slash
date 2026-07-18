import { test, expect } from './_fixtures.mjs'

// Both pages default to following the OS-level prefers-color-scheme setting
// (theme pref "system"), but a manual toggle (src/theme.mjs, systeem/licht/
// donker) can override it — Tailwind runs darkMode:'selector', so a `.dark`
// class on <html> (not the media query directly) is what flips every dark:
// utility; src/theme.mjs sets that class (plus data-theme, for the two plain-
// CSS blocks in index.html) reactively. See .claude/rules/conventions.md,
// "Thema: systeem/licht/donker". This first describe block pins down the
// default "system" behaviour (no localStorage entry yet): page.emulateMedia
// lets us assert the two colour schemes actually render differently, and that
// each mode is applied consistently (no leftover forced-dark / forced-light
// artifact). The second describe block below covers the manual toggle itself.

test.describe('theme — prefers-color-scheme (default "system" pref)', () => {
  test('PR page (index.html) switches background/text colour with the OS scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const lightText = await page.evaluate(() => getComputedStyle(document.body).color)

    await page.emulateMedia({ colorScheme: 'dark' })
    // No reload needed — src/theme.mjs's matchMedia 'change' listener re-applies
    // the .dark class while pref stays "system" — but that listener callback
    // runs on the next microtask/event-loop turn, not synchronously with
    // emulateMedia, so poll instead of reading immediately.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe('rgb(9, 9, 11)') // dark:bg-zinc-950
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
    // See the "no reload needed" note in the PR-page test above — the
    // matchMedia 'change' listener applies async, so poll rather than read
    // immediately.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe('rgb(9, 9, 11)') // dark:bg-zinc-950
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

test.describe('theme — manual toggle (systeem/licht/donker)', () => {
  test('clicking cycles system -> light -> dark -> system, updates <html>, and persists across reload', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()

    // The toggle lives in a slim row in prInfoCard, just above the PR summary
    // (data-testid=pr-info-summary) — see the "Thema" section in
    // conventions.md. That card only mounts while the PR-description column is
    // open (state.showDescription, stop 1 of the nav chain), so it is not
    // visible by default; open it with the same ← that reaches stop 1 (see
    // keyboard-navigation.md). The footer itself stays hidden throughout this
    // test (no diff is open), which is fine — the toggle no longer depends on
    // it.
    await expect(page.getByTestId('footer')).toBeHidden()
    await expect(page.getByTestId('theme-toggle')).toHaveCount(0)
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toBeVisible()

    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    const dataTheme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    const stored = () => page.evaluate(() => localStorage.getItem('theme'))

    // Fresh context: no stored preference yet, default "system" resolves to
    // the emulated light OS scheme.
    expect(await stored()).toBeNull()
    expect(await isDark()).toBe(false)
    expect(await dataTheme()).toBe('light')

    // system -> light (explicit, still light — no visible flip, but persisted)
    await toggle.click()
    await expect.poll(stored).toBe('light')
    expect(await isDark()).toBe(false)
    expect(await dataTheme()).toBe('light')

    // light -> dark
    await toggle.click()
    await expect.poll(stored).toBe('dark')
    await expect.poll(isDark).toBe(true)
    expect(await dataTheme()).toBe('dark')

    // The choice survives a reload (localStorage, not the URL).
    await page.reload()
    await expect(page.getByTestId('pr-index')).toBeVisible()
    expect(await stored()).toBe('dark')
    expect(await isDark()).toBe(true)
    expect(await dataTheme()).toBe('dark')

    // state.showDescription is ephemeral (not in the URL) — a reload closes
    // stop 1 again, so the toggle is gone until it's reopened.
    await expect(page.getByTestId('theme-toggle')).toHaveCount(0)
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    // dark -> system (OS is still emulated light, so this flips back to light)
    await page.getByTestId('theme-toggle').click()
    await expect.poll(stored).toBe('system')
    await expect.poll(isDark).toBe(false)
    expect(await dataTheme()).toBe('light')
  })

  test('overview page (/pr-overview) exposes the same toggle', async ({ page }) => {
    await page.goto('/pr-overview')
    await expect(page.getByTestId('inbox')).toBeVisible()
    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toBeVisible()

    await toggle.click()
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('theme')))
      .toBe('light')
  })
})
