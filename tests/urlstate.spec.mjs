import { test, expect } from '@playwright/test'

// URL-state persistence: the navigation position (selected block, mode, change)
// is mirrored into the query string via history.replaceState, so a refresh
// reopens the exact same spot. See src/urlState.mjs + home.mjs (bindUrlState).
test.describe('PR Review Tree — URL state persistence', () => {
  test('navigation writes the query string and survives a reload', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    // The PR lives in the path (/pr/12903), not the query. Step down once in the list.
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('1')

    // enterDiff needs the block's code loaded to know its change groups; wait for
    // the lazy fetch to settle before stepping in.
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('diff')

    // Walk to the next change group → chg is recorded (if the block has >1 group).
    await page.keyboard.press('ArrowDown')
    const before = new URL(page.url()).search

    // Reload from the exact URL — state must come back.
    await page.reload()
    await page.waitForLoadState('networkidle')
    expect(new URL(page.url()).search).toBe(before)

    // Diff mode restored → the detail panel is in its full-width (left-6) layout.
    const panel = page.locator('[data-testid="detail-panel"]')
    await expect(panel).toHaveClass(/left-6/)
    expect(new URL(page.url()).searchParams.get('sel')).toBe('1')
    expect(new URL(page.url()).searchParams.get('mode')).toBe('diff')
  })

  test('stepping back to defaults clears the params again', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.keyboard.press('ArrowDown')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('1')
    await page.keyboard.press('ArrowUp') // back to sel=0, the default

    // Default values are dropped, keeping the URL canonical/short.
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBeNull()
  })
})
