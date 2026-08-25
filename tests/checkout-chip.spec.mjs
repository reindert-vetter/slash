import { test, expect, appReady, leaveSearchBox } from './_fixtures.mjs'

// The checkout chip in prInfoCard's pr-info-theme-row (which local checkout,
// if any, a claude_chat write turn edits directly for this PR —
// chat_checkout.go), and its PR-overview counterpart badge. See
// checkoutChip/checkoutChipCommandsFor (home.mjs), checkoutPill (overview.mjs)
// and todo/todo-local-checkout-chat-edits.md's UI chapter.
//
// Both GET /api/chat/checkout and the chat_merge queue's "merge" Signal are
// mocked throughout: the real read/write path needs an actual local git
// checkout on disk, which this offline harness has none of — the git-plumbing
// side (candidate matching/selection, the four checkout Actions) is covered
// by chat_checkout_test.go/chat_merge_test.go instead. This file is only
// about the FRONTEND rendering/interaction contract.

function mockCheckout(page, view) {
  return page.route('**/api/chat/checkout?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, checkout: view ? { '12903': view } : {} }),
    }),
  )
}

function mockSignals(page, runId = 'chatmerge-12903') {
  const signals = []
  const route = page.route(`**/api/workflows/${runId}/signals/merge`, async (r) => {
    signals.push(r.request().postDataJSON())
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
  })
  return { route, signals }
}

test.describe('Checkout chip in prInfoCard', () => {
  test('shows "Geen werkmap" with nothing assigned, and offers "Andere werkmap kiezen"', async ({ page }) => {
    await mockCheckout(page, { pr: 12903, runId: 'chatmerge-12903' })
    await page.goto('/pr/12903')
    await appReady(page)
    await page.keyboard.press('ArrowLeft')

    const chip = page.getByTestId('checkout-chip')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('Geen werkmap')

    await chip.click()
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page.getByTestId('command-row').filter({ hasText: 'Andere werkmap kiezen' })).toHaveCount(1)
    await expect(page.getByTestId('command-row').filter({ hasText: 'Nu terugzetten' })).toHaveCount(0)
    await expect(page.getByTestId('command-row').filter({ hasText: 'Uit (geen werkmap koppelen)' })).toHaveCount(1)
  })

  test('shows the assigned directory name and branch, and "uit" round-trips through the queue Signal', async ({
    page,
  }) => {
    await mockCheckout(page, {
      pr: 12903,
      runId: 'chatmerge-12903',
      dir: '/home/reindert/dev/plug-and-pay-2',
      dirName: 'plug-and-pay-2',
      branch: 'feature/x',
    })
    const { signals } = mockSignals(page)
    await page.goto('/pr/12903')
    await appReady(page)
    await page.keyboard.press('ArrowLeft')

    const chip = page.getByTestId('checkout-chip')
    await expect(chip).toContainText('plug-and-pay-2')
    await expect(chip).toHaveAttribute('title', /feature\/x/)

    await chip.click()
    await page.getByTestId('command-row').filter({ hasText: 'Uit (geen werkmap koppelen)' }).click()

    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toMatchObject({ action: 'checkoutOff' })
  })

  test('a pending decision offers its own options directly (checkoutAnswer), plus "nu terugzetten" while a stash is pending', async ({
    page,
  }) => {
    await mockCheckout(page, {
      pr: 12903,
      runId: 'chatmerge-12903',
      decision: {
        stage: 'chooseDirectory',
        body: 'Kies welke lokale directory Claude voor deze PR gebruikt.',
        options: ['/home/reindert/dev/a', '/home/reindert/dev/b'],
      },
      stashPending: true,
    })
    const { signals } = mockSignals(page)
    // `?sel=` so the harness's own goto wrapper does not press Escape (which
    // the werkmap overlay would eat) — see checkout-overlay.spec.mjs's SEL.
    await page.goto('/pr/12903?sel=' + encodeURIComponent('nothing.php:1'))
    await appReady(page)
    // An open choice opens the werkmap overlay by itself and it owns the
    // keyboard (see checkout-overlay.spec.mjs) — dismiss it first to reach the
    // chip, which is the second entry point to the very same choice.
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()
    await page.keyboard.press('Escape')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowLeft')

    const chip = page.getByTestId('checkout-chip')
    await expect(chip).toContainText('Keuze nodig')

    await chip.click()
    await expect(page.getByTestId('command-row').filter({ hasText: '/home/reindert/dev/a' })).toHaveCount(1)
    await expect(page.getByTestId('command-row').filter({ hasText: '/home/reindert/dev/b' })).toHaveCount(1)
    await expect(page.getByTestId('command-row').filter({ hasText: 'Nu terugzetten' })).toHaveCount(1)
    // A pending decision replaces the ordinary "Andere werkmap kiezen" row.
    await expect(page.getByTestId('command-row').filter({ hasText: 'Andere werkmap kiezen' })).toHaveCount(0)

    await page.getByTestId('command-row').filter({ hasText: '/home/reindert/dev/b' }).click()
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toMatchObject({ action: 'checkoutAnswer', reply: '/home/reindert/dev/b' })
  })
})

test.describe('Checkout badge on the PR overview', () => {
  test('shows the assigned directory on an ingested row', async ({ page }) => {
    await page.route('**/api/chat/checkout?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          checkout: { '12903': { pr: 12903, dir: '/x/plug-and-pay-2', dirName: 'plug-and-pay-2' } },
        }),
      }),
    )
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.getByTestId('checkout-badge')
    await expect(badge).toHaveCount(1)
    await expect(badge).toContainText('plug-and-pay-2')
  })

  test('no badge when nothing is assigned', async ({ page }) => {
    await page.route('**/api/chat/checkout?*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checkout: {} }) }),
    )
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.getByTestId('pr-row').first()).toBeVisible()
    await expect(page.getByTestId('checkout-badge')).toHaveCount(0)
  })
})
