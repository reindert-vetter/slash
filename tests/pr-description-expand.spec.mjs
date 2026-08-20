import { test, expect } from './_fixtures.mjs'

// C1: the PR description (Omschrijving) in the PR-info column is truncated by
// default once it's long, and expands via both the in-card "meer…" affordance
// and the `/` PR-menu item — one ephemeral state.descriptionExpanded flag.

const LONG_BODY =
  'This PR reworks the checkout flow end to end. ' +
  'It touches the cart action, the shipping address builder, the order model, ' +
  'and the invoice resource. '.repeat(6) +
  'See the linked ticket for the full rationale and the migration plan.'

// Mock GET /api/pr so the description column has a long body offline (the fake
// pr_status tracker returns empty meta). The statuses fields end the poll loop.
async function mockLongBody(page) {
  await page.route('**/api/pr?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pr: 12903,
        title: 'Rework checkout flow',
        url: 'https://github.com/x/y/pull/12903',
        body: LONG_BODY,
        reviewDecision: 'APPROVED',
        reviewers: [],
        checksTotal: 1,
        checksPassed: 1,
      }),
    }),
  )
}

test.describe('PR description truncate/expand (C1)', () => {
  test('long body is clipped, "meer…" expands it, and toggles back', async ({ page }) => {
    await mockLongBody(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    // Open the description column (stop 1).
    await page.keyboard.press('ArrowLeft')
    const body = page.getByTestId('pr-info-body')
    await expect(body).toBeVisible()

    const wrap = page.getByTestId('pr-info-body-wrap')
    const clip = wrap.locator('.markdown-body')
    const toggle = page.getByTestId('pr-info-body-toggle')

    // Collapsed: clipped (fills the available column height via flex/h-full,
    // not a fixed pixel cap — see the "Description truncation" section in
    // detail-layout.md) and the affordance reads "meer…".
    await expect(clip).toHaveClass(/overflow-hidden/)
    await expect(toggle).toHaveText(/meer/)
    // Regression guard for the actual bug this fixes: the collapsed wrap must
    // fill (most of) the column's available height instead of the old fixed
    // 160px (max-h-40) that left a large unused gap above the status pills.
    // The floor is comfortably above that 160 but not tight against the actual
    // value: the block itself gained `p-2.5` when it became a focusable stop
    // (its focus ring is ring-inset), which legitimately costs 20px here.
    const wrapBox = await wrap.boundingBox()
    expect(wrapBox.height).toBeGreaterThan(200)

    // Click expands: no longer clipped, affordance flips to "Inklappen".
    await toggle.click()
    await expect(clip).not.toHaveClass(/overflow-hidden/)
    await expect(toggle).toHaveText(/Inklappen/)

    // Click collapses again.
    await toggle.click()
    await expect(clip).toHaveClass(/overflow-hidden/)
    await expect(toggle).toHaveText(/meer/)
  })

  // The whole point of making it a stop-1 cursor stop: with the since-review
  // blocks above it the description sat below the scrolling card's bottom edge
  // ("ik kan niet naar omschrijving"), so ↓ must reach it and Enter must read
  // it in full instead of opening a menu.
  test('the arrow keys reach the description block and Enter expands it', async ({ page }) => {
    await page.route('**/api/pr?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pr: 12903,
          title: 'Rework checkout flow',
          url: 'https://github.com/x/y/pull/12903',
          body: LONG_BODY,
          reviewDecision: 'APPROVED',
          reviewers: [],
          checksTotal: 1,
          checksPassed: 1,
          // Two since-review blocks sit above the description, exactly the
          // situation that pushed it out of reach.
          ghUpdatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
          newSinceKind: 'review',
          sinceSummary: 'De laatste wijziging raakt de afronding.',
          sinceFacts: '**1 nieuwe commit** sinds jouw laatste review:\n\n- Fix rounding (alice)\n',
        }),
      }),
    )
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await page.keyboard.press('ArrowLeft')

    const body = page.getByTestId('pr-info-body')
    const clip = page.getByTestId('pr-info-body-wrap').locator('.markdown-body')
    await expect(body).toHaveAttribute('data-desc-focused', 'false')

    // ↓ walks the two since blocks first, then lands on the description.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(body).toHaveAttribute('data-desc-focused', 'false')
    await page.keyboard.press('ArrowDown')
    await expect(body).toHaveAttribute('data-desc-focused', 'true')
    await expect(page.getByTestId('pr-info-since-review')).toHaveAttribute('data-since-focused', 'false')

    // Enter reads it in full — and does NOT open the PR-wide menu.
    await page.keyboard.press('Enter')
    await expect(clip).not.toHaveClass(/overflow-hidden/)
    await expect(page.getByTestId('command-menu')).toHaveCount(0)

    // Enter again collapses it, ↑ walks back out to the since blocks.
    await page.keyboard.press('Enter')
    await expect(clip).toHaveClass(/overflow-hidden/)
    await page.keyboard.press('ArrowUp')
    await expect(body).toHaveAttribute('data-desc-focused', 'false')
    await expect(page.getByTestId('pr-info-since-block')).toHaveAttribute('data-since-focused', 'true')
  })

  test('the `/` PR menu item expands the description', async ({ page }) => {
    await mockLongBody(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const clip = page.getByTestId('pr-info-body-wrap').locator('.markdown-body')

    // Open the description column first so the wrap exists to assert against.
    await page.keyboard.press('ArrowLeft')
    await expect(clip).toHaveClass(/overflow-hidden/)

    // Open the PR-wide menu and run the expand item.
    await page.keyboard.press('/')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-input').fill('volledige')
    await page.keyboard.press('Enter')

    await expect(clip).not.toHaveClass(/overflow-hidden/)
  })
})
