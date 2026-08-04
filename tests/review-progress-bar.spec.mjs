import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// ProgressBar.mjs — the thin, always-visible, PR-wide review progress strip
// at the true bottom of the screen. Reuses state.approvalTotal ({done,
// total}), the same figure BlockList.mjs's "X/Y approved" heading already
// shows (see approval.spec.mjs). Mounted directly with inline reactive state,
// like the other approval-indicator specs — no worktree/diff needed.
test.describe('PR Review Tree — review progress bar', () => {
  test('fill width tracks state.approvalTotal, reactively, no label', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)
    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const ProgressBar = (await import('/src/ProgressBar.mjs')).default
      const state = reactive({ approvalTotal: { done: 1, total: 4 } })
      const host = document.createElement('div')
      host.id = 'pb-host'
      document.body.appendChild(host)
      ProgressBar(state)(host)
      window.__pbState = state
    })

    const host = page.locator('#pb-host')
    const bar = host.getByTestId('review-progress-bar')
    const fill = host.getByTestId('review-progress-fill')
    await expect(bar).toBeVisible()
    // No text label anywhere in the bar — deliberately bar-only.
    await expect(bar).toHaveText('')
    await expect(fill).toHaveCSS('width', /.+/)
    const w1 = await fill.evaluate((el) => el.style.width || getComputedStyle(el).width)
    expect(w1).toBeTruthy()

    // Reactive: bumping done/total changes the fill width.
    await page.evaluate(() => {
      window.__pbState.approvalTotal = { done: 4, total: 4 }
    })
    await expect(fill).toHaveClass(/w-\[100\.00%\]/)

    // total === 0 (nothing to review yet) hides the bar entirely.
    await page.evaluate(() => {
      window.__pbState.approvalTotal = { done: 0, total: 0 }
    })
    await expect(bar).toBeHidden()
  })
})
