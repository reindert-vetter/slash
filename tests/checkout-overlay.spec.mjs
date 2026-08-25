import { test, expect, appReady, leaveSearchBox } from './_fixtures.mjs'

// The werkmap overlay (src/workDirOverlay.mjs): the PR-wide "which local work
// directory may Claude edit" choice, which used to be asked as a chat bubble
// inside whichever conversation happened to trigger it — including, for an
// unrelated conversation, an unanswerable "een andere Claude-conversatie wacht
// nog op een keuze" pointing at a chat nothing in the UI can find. It is now
// a setting with its own keyboard-owning overlay (reviewer decision, see
// .claude/docs/command-palette.md).
//
// GET /api/chat/checkout and the chat_merge queue's "merge" Signal are mocked
// throughout, exactly like checkout-chip.spec.mjs: the real path needs an
// actual local git checkout on disk, which this offline harness has none of.
// The git plumbing is covered by chat_checkout_test.go; this file is only
// about the frontend contract.

const DECISION = {
  pr: 12903,
  runId: 'chatmerge-12903',
  decision: {
    stage: 'chooseDirectory',
    body: 'Kies welke lokale werkmap Claude voor deze PR gebruikt.',
    options: ['/home/reindert/dev/a', '/home/reindert/dev/b'],
  },
}

function mockCheckout(page, view) {
  return page.route('**/api/chat/checkout?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, checkout: view ? { '12903': view } : {} }),
    }),
  )
}

// Every goto carries a `?sel=` — the harness's own page.goto wrapper presses
// Escape + ArrowRight on a /pr/<id> URL WITHOUT one (to leave the ambiently
// focused search box, see appReady/leaveSearchBox in _fixtures.mjs), and that
// Escape would land on this overlay and dismiss it before the test even
// starts. The value itself is deliberately not a real block reference: an
// unresolvable `sel` falls back to the ordinary index clamp (see CLAUDE.md's
// URL-state section), and which block is selected is irrelevant here.
const SEL = '?sel=' + encodeURIComponent('nothing.php:1')

function mockSignals(page, runId = 'chatmerge-12903') {
  const signals = []
  page.route(`**/api/workflows/${runId}/signals/merge`, async (r) => {
    signals.push(r.request().postDataJSON())
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
  })
  return signals
}

test.describe('Werkmap overlay', () => {
  test('opens by itself on an open choice, and ↓ + Enter answers it', async ({ page }) => {
    await mockCheckout(page, DECISION)
    const signals = mockSignals(page)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)

    const overlay = page.getByTestId('workdir-overlay')
    await expect(overlay).toBeVisible()
    await expect(page.getByTestId('workdir-overlay-body')).toContainText('Kies welke lokale werkmap')
    // Both options, plus the two always-available escapes.
    await expect(page.getByTestId('workdir-overlay-option')).toHaveCount(4)
    // The first row is highlighted, and the highlight is a glyph, not only a
    // colour (colourblind rule).
    const rows = page.getByTestId('workdir-overlay-option')
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'true')
    await expect(rows.nth(0)).toContainText('›')

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'true')
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'false')

    await page.keyboard.press('Enter')
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toMatchObject({ action: 'checkoutAnswer', reply: '/home/reindert/dev/b' })
  })

  test('Escape dismisses it and hands the keyboard back to the review tree', async ({ page }) => {
    await mockCheckout(page, DECISION)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('workdir-overlay')).toHaveCount(0)

    // The review tree has the keyboard again — ← really navigates to stop 1,
    // which it could not do while the overlay was swallowing every key — and
    // the chip there is still an entry point to the very same choice, so the
    // dismissal never strands it.
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await expect(page.getByTestId('checkout-chip')).toContainText('Keuze nodig')
  })

  test('a dismissal is not persisted: after a reload the overlay is back', async ({ page }) => {
    await mockCheckout(page, DECISION)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('workdir-overlay')).toHaveCount(0)

    await page.reload()
    await appReady(page)
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()
  })

  test('no open choice, no overlay', async ({ page }) => {
    await mockCheckout(page, { pr: 12903, runId: 'chatmerge-12903', dir: '/x/pnp', dirName: 'pnp' })
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    await expect(page.locator('#block-search')).toHaveCount(1)
    await expect(page.getByTestId('workdir-overlay')).toHaveCount(0)
  })
})
