import { test, expect } from './_fixtures.mjs'

// <main> (DetailPanel, home.mjs) reserves a right-hand margin so its columns
// — clipped by its own overflow-x-auto, so whatever scrolls into view can
// never poke out past <main>'s own right edge — never end up rendering
// behind the comments/taken sidebar, a separate, higher-z-index fixed
// overlay (RelatedPanel.mjs) that is either a narrow collapsed hint rail or
// the full open sidebar. Asserting on <main>'s own box (rather than the
// related-code card's unclipped getBoundingClientRect, which can report a
// right edge past what's actually visible) is what directly proves the
// margin is wide enough. See detail-layout.md.
test.describe('PR Review Tree — <main> clears the sidebar/rail on the right', () => {
  async function stepIntoRelated(page) {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related-code
    await expect(page.getByTestId('related-code')).toBeVisible()
  }

  test('<main> sits left of the collapsed hint rail', async ({ page }) => {
    await stepIntoRelated(page)
    await expect(page.getByTestId('sidebar-collapsed')).toBeVisible()

    const mainBox = await page.getByTestId('detail-panel').boundingBox()
    const railBox = await page.getByTestId('sidebar-collapsed').boundingBox()
    expect(mainBox).not.toBeNull()
    expect(railBox).not.toBeNull()
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(railBox.x)
  })

  test('<main> sits left of the open sidebar', async ({ page }) => {
    await stepIntoRelated(page)
    await page.keyboard.press('Meta+ArrowRight')
    const sidebar = page.getByTestId('comments-sidebar')
    await expect(sidebar).toBeVisible()

    // <main>'s right margin is a `transition-all duration-200` CSS property,
    // not an instant layout change — poll until the 200ms slide settles
    // instead of racing the animation.
    await expect
      .poll(async () => {
        const mainBox = await page.getByTestId('detail-panel').boundingBox()
        const sidebarBox = await sidebar.boundingBox()
        return mainBox && sidebarBox ? mainBox.x + mainBox.width : null
      })
      .toBeLessThanOrEqual((await sidebar.boundingBox()).x)
  })
})
