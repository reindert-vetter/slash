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

    const clip = page.getByTestId('pr-info-body-wrap').locator('.markdown-body')
    const toggle = page.getByTestId('pr-info-body-toggle')

    // Collapsed: clipped (max-h-40) and the affordance reads "meer…".
    await expect(clip).toHaveClass(/max-h-40/)
    await expect(toggle).toHaveText(/meer/)

    // Click expands: no longer clipped, affordance flips to "Inklappen".
    await toggle.click()
    await expect(clip).not.toHaveClass(/max-h-40/)
    await expect(toggle).toHaveText(/Inklappen/)

    // Click collapses again.
    await toggle.click()
    await expect(clip).toHaveClass(/max-h-40/)
    await expect(toggle).toHaveText(/meer/)
  })

  test('the `/` PR menu item expands the description', async ({ page }) => {
    await mockLongBody(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const clip = page.getByTestId('pr-info-body-wrap').locator('.markdown-body')

    // Open the description column first so the wrap exists to assert against.
    await page.keyboard.press('ArrowLeft')
    await expect(clip).toHaveClass(/max-h-40/)

    // Open the PR-wide menu and run the expand item.
    await page.keyboard.press('/')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-input').fill('volledige')
    await page.keyboard.press('Enter')

    await expect(clip).not.toHaveClass(/max-h-40/)
  })
})
