import { test, expect, appReady, leaveSearchBox, seededPr } from './_fixtures.mjs'

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

  // Reviewer request: "meer feedback geven en laten zien wat het echt doet
  // voor commando's" — a bare "Bezig…" in the corner named neither which
  // option was running nor what it was actually doing. The busy row now
  // names itself, every other row locks, and a live panel
  // (GET /api/chat/checkout/progress, checkout_progress.go) shows the real
  // git commands the in-flight Activity is running.
  test('answering shows which option is busy, locks the rest, and streams the real git commands it runs', async ({ page }) => {
    await mockCheckout(page, DECISION)

    let release
    const released = new Promise((r) => (release = r))
    const signals = []
    await page.route(`**/api/workflows/chatmerge-12903/signals/merge`, async (route) => {
      signals.push(route.request().postDataJSON())
      await released
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    await page.route('**/api/chat/checkout/progress?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pr: 12903,
          steps: [
            { cmd: 'git stash push -u -m slash-chat-20260901-120000', ok: true, output: '', at: 1 },
            { cmd: 'git status --porcelain', ok: true, output: '', at: 2 },
          ],
        }),
      }),
    )

    await page.goto('/pr/12903' + SEL)
    await appReady(page)

    const rows = page.getByTestId('workdir-overlay-option')
    await page.keyboard.press('ArrowDown') // select the second option ("…/b")
    await page.keyboard.press('Enter')

    // The chosen row names itself — not a bare repeat of "Bezig…" — and every
    // other row locks (both visually and for real: `disabled`).
    await expect(rows.nth(1)).toHaveAttribute('data-busy', 'true')
    await expect(rows.nth(1)).toContainText('/home/reindert/dev/b…')
    await expect(rows.nth(0)).toBeDisabled()
    await expect(rows.nth(1)).toBeDisabled()
    await expect(rows.nth(2)).toBeDisabled()
    await expect(page.getByTestId('workdir-overlay-status')).toContainText('Bezig: /home/reindert/dev/b…')

    // The live panel shows the REAL git commands the Activity is running —
    // not just the chosen option's own label repeated.
    const steps = page.getByTestId('workdir-overlay-progress-step')
    await expect(steps).toHaveCount(2)
    await expect(steps.nth(0)).toContainText('git stash push -u -m slash-chat-20260901-120000')
    await expect(steps.nth(1)).toContainText('git status --porcelain')

    // ↑/↓/Enter are swallowed while an answer is in flight — a stray keypress
    // must not queue up a second action against a locked menu.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect.poll(() => signals.length).toBe(1)

    // Releasing the answer clears the busy/progress state again.
    release()
    await expect.poll(() => signals.length).toBe(1)
    await expect(rows.nth(0)).toBeEnabled()
    await expect(page.getByTestId('workdir-overlay-status')).toHaveText('')
    await expect(page.getByTestId('workdir-overlay-progress')).toHaveCount(0)
  })

  // Reviewer-reported bug: a choice arriving while the empty Claude-chat
  // composer already holds real DOM focus (e.g. having just stepped into an
  // embedded conversation) let that composer's own `@keydown` intercept Enter
  // first — it stopPropagation()s and opens the Claude command menu instead —
  // so the overlay's own highlighted row silently never got confirmed and the
  // Claude menu popped up BEHIND the still-open overlay. See "It steals DOM
  // focus back the moment a choice opens" in .claude/docs/command-palette.md.
  test('a choice opening while the empty Claude composer holds focus steals it back — Enter still confirms the overlay, not the Claude menu behind it', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const runId = 'chatmerge-' + pr
    let open = false
    await page.route(`**/api/chat/checkout?prs=${pr}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          checkout: open
            ? {
                [pr]: {
                  pr,
                  runId,
                  decision: {
                    stage: 'chooseDirectory',
                    body: 'Kies welke lokale werkmap Claude voor deze PR gebruikt.',
                    options: ['/home/reindert/dev/a', '/home/reindert/dev/b'],
                  },
                },
              }
            : {},
        }),
      }),
    )
    const signals = mockSignals(page, runId)

    let release
    const released = new Promise((r) => (release = r))
    await page.route('**/api/events*', async (route) => {
      await released
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'checkout.changed', pr, seq: 1 })}\n\n`,
      })
    })

    // A real code comment carries its own embedded Claude conversation — no
    // fake claude turn needed, this test never sends a message.
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr,
        file: 'test.php',
        line: 1,
        author: 'reviewer',
        body: 'kan dit sneller?',
        code: '$order->total();',
        gran: 'call',
        label: 'Order::total',
      },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.goto('/pr/' + pr)
    await expect(page.getByTestId('workdir-overlay')).toHaveCount(0)
    await page.getByTestId('comment-item').first().click()
    await page.keyboard.press('ArrowRight') // comment -> claude
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('')

    // The choice arrives (via the real checkout.changed event) while the
    // still-empty composer holds focus.
    open = true
    release()
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()
    await expect(composer).not.toBeFocused()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toMatchObject({ action: 'checkoutAnswer', reply: '/home/reindert/dev/b' })
    // The Claude command menu never opened behind the overlay.
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
  })
})
