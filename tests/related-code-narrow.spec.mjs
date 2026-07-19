import { test, expect } from './_fixtures.mjs'

// The Onderliggende-code card auto-collapses to a narrow rail once the
// comments/taken sidebar is open on a laptop-width viewport (< Tailwind's
// 2xl breakpoint, 1536px) — the two compete for horizontal room. It stays
// the full card whenever it currently owns the keyboard (cs.focus === 'code')
// or the viewport is 2xl+ or the sidebar is closed. See RelatedPanel.mjs
// (relatedRailActive/relatedRail) and detail-layout.md.
test.describe('PR Review Tree — Onderliggende code collapses on a laptop viewport', () => {
  async function stepIntoRelated(page) {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related-code
    await expect(page.getByTestId('related-code')).toBeVisible()
  }

  test('opening the sidebar on a laptop-width viewport collapses the card; a click on the rail re-expands and re-focuses it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 }) // laptop-width, < 2xl (1536)
    await stepIntoRelated(page)

    // Sidebar closed: the full card stays, regardless of viewport width.
    await expect(page.getByTestId('related-code')).toBeVisible()
    await expect(page.getByTestId('related-collapsed')).toHaveCount(0)

    // Cmd+ArrowRight opens the sidebar and moves the keyboard off the related-code card
    // (onto the sidebar's "+ Comment op deze regel" row) — cs.focus is no
    // longer 'code', so on this narrow viewport the card now collapses.
    await page.keyboard.press('Meta+ArrowRight')
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await expect(page.getByTestId('related-collapsed')).toBeVisible()
    await expect(page.getByTestId('related-code')).toHaveCount(0)

    // A click on the rail re-expands the card (enterRelated: cs.focus='code')
    // — and leaves the sidebar open, since collapsing/expanding this card is
    // independent of the sidebar's own open/closed state.
    await page.getByTestId('related-collapsed').click()
    await expect(page.getByTestId('related-code')).toBeVisible()
    await expect(page.getByTestId('related-collapsed')).toHaveCount(0)
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()

    // Keyboard navigation stays workable straight after the click: the
    // keyboard genuinely landed on the card (cs.focus === 'code', not stuck
    // in some dead/hidden state) — ← exits it straight back to the diff, the
    // same as after a fresh → from the diff.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('related-collapsed')).toBeVisible()
  })

  test('→ from the diff always lands on the fully expanded card, even with the sidebar already open on a laptop viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await stepIntoRelated(page)

    // Sidebar closed so far — open it (moves the keyboard onto the sidebar,
    // collapsing the card, per test 1 above).
    await page.keyboard.press('Meta+ArrowRight')
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await expect(page.getByTestId('related-collapsed')).toBeVisible()

    // ← exits the sidebar straight back to the diff (sidebar stays open, per
    // toggleSidebar/handleRelatedKey — see keyboard-navigation.md); the diff
    // now owns the keyboard, with the sidebar still open on this laptop
    // viewport.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()

    // → from the diff enters related-code (enterRelated: cs.focus='code') and
    // must land on the fully expanded, navigable card — not stuck collapsed.
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('related-code')).toBeVisible()
    await expect(page.getByTestId('related-collapsed')).toHaveCount(0)

    // ← back out to the diff hands the keyboard away from the card again —
    // it collapses back to the rail since the sidebar is still open.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('related-collapsed')).toBeVisible()
    await expect(page.getByTestId('related-code')).toHaveCount(0)
  })

  test('a wide (2xl+) viewport never collapses the card, even with the sidebar open', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 }) // ≥ 1536 (2xl)
    await stepIntoRelated(page)

    await page.keyboard.press('Meta+ArrowRight')
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await expect(page.getByTestId('related-code')).toBeVisible()
    await expect(page.getByTestId('related-collapsed')).toHaveCount(0)
  })
})
