import { test, expect, appReady, seededPr } from './_fixtures.mjs'

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
// focused search box, see appReady/leaveSearchBox in _fixtures.mjs), which
// this overlay would swallow. The value itself is deliberately not a real
// block reference: an
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
    // Both options, the always-present "Opnieuw proberen" row, plus the two
    // always-available escapes, plus the always-present "Chat pauzeren" row
    // (disabled here, no turn is running).
    await expect(page.getByTestId('workdir-overlay-option')).toHaveCount(6)
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

  // Reviewer report: he answered the dirty-tree choice ("Meenemen in de
  // commit") without ever being told WHICH already-changed files that covered,
  // and only found out afterwards. The choice now names them —
  // chatCheckoutDecision.Paths, chat_checkout.go.
  test('a dirty-tree choice lists the files it is about', async ({ page }) => {
    const paths = Array.from({ length: 14 }, (_, i) => `src/File${i + 1}.php`)
    await mockCheckout(page, {
      pr: 12903,
      runId: 'chatmerge-12903',
      dir: '/home/reindert/dev/pnp',
      dirName: 'pnp',
      branch: 'feature/x',
      decision: {
        stage: 'dirtyTree',
        dir: '/home/reindert/dev/pnp',
        body: '`/home/reindert/dev/pnp` heeft nog niet-gerelateerde, niet-gecommitte wijzigingen.',
        options: ['Verwijderen', 'Meenemen in de commit'],
        paths,
      },
    })
    await page.goto('/pr/12903' + SEL)
    await appReady(page)

    await expect(page.getByTestId('workdir-overlay')).toBeVisible()
    // The count and the file names carry the meaning — no colour involved.
    await expect(page.getByTestId('workdir-overlay-paths-title')).toContainText('14 bestanden')
    await expect(page.getByTestId('workdir-overlay-path')).toHaveCount(12)
    await expect(page.getByTestId('workdir-overlay-path').first()).toHaveText('src/File1.php')
    await expect(page.getByTestId('workdir-overlay-paths-more')).toContainText('2')

  })

  test('a choice without files shows no file list at all', async ({ page }) => {
    await mockCheckout(page, DECISION)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()
    await expect(page.getByTestId('workdir-overlay-paths')).toHaveCount(0)
  })

  // Reviewer report: the werkmap question disappeared while it was still
  // open server-side (an accidental Escape / click beside the panel), after
  // which every write turn kept dead-ending on "er staat nog een keuze open
  // over de werkmap van deze PR" with nothing on screen asking anything. The
  // overlay is now genuinely blocking: only a real answer closes it.
  test('Escape and a click beside the panel do NOT close it — only a real choice does', async ({ page }) => {
    await mockCheckout(page, DECISION)
    const signals = mockSignals(page)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    const overlay = page.getByTestId('workdir-overlay')
    await expect(overlay).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(overlay).toBeVisible()
    // A click on the backdrop itself (the top-left corner is never the panel).
    await overlay.click({ position: { x: 4, y: 4 } })
    await expect(overlay).toBeVisible()
    // Every other key stays swallowed too: ← does not reach the review tree.
    await page.keyboard.press('ArrowLeft')
    await expect(overlay).toBeVisible()
    expect(signals.length).toBe(0)

    // A click on an option row is an answer, and answers really are sent.
    await page.getByTestId('workdir-overlay-option').nth(0).click()
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toMatchObject({ action: 'checkoutAnswer', reply: '/home/reindert/dev/a' })
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

  // Reviewer request: an option to pause the currently running Claude turn
  // right from this overlay, without first having to close it and step into
  // the Claude column's own "Stop" control. Reuses cancelClaudeTurn()
  // (RelatedPanel.mjs) — the exact same POST /api/chat/cancel the "Stop"
  // button and "Stop deze Claude-beurt" palette item already call — so it is
  // NOT one of act()'s checkout Actions: it never locks the rest of the list
  // and never dismisses the overlay, since it does not answer the werkmap
  // question at all.
  test('the "Chat pauzeren" row is disabled and says so when nothing is running', async ({ page }) => {
    await mockCheckout(page, DECISION)
    const cancelRequests = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/chat/cancel')) cancelRequests.push(r)
    })
    await page.goto('/pr/12903' + SEL)
    await appReady(page)

    const pauseRow = page.getByTestId('workdir-overlay-option').filter({ hasText: 'Chat pauzeren' })
    await expect(pauseRow).toHaveCount(1)
    // The "nothing to stop" state is carried by the WORDING, not only by the
    // dimmed style — colourblind rule.
    await expect(pauseRow).toContainText('er loopt nu niets')
    await expect(pauseRow).toBeDisabled()
    expect(cancelRequests).toHaveLength(0)
  })

  // The enabled counterpart: a real turn running on the conversation
  // currently shown in the tree, with the werkmap overlay opening on top of
  // it (an unrelated write attempt elsewhere in the PR can raise the same
  // PR-wide choice at any time, exactly like the "steals focus" test above).
  test('the "Chat pauzeren" row stops the currently open conversation\'s running turn', async ({ page }, testInfo) => {
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

    let releaseEvents
    const eventsReleased = new Promise((r) => (releaseEvents = r))
    let delivered = false
    await page.route('**/api/events*', async (route) => {
      await eventsReleased
      if (delivered) return // never resolves — no further reconnect
      delivered = true
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'checkout.changed', pr, seq: 1 })}\n\n`,
      })
    })

    // Hold the reviewer's own message Signal open so the conversation stays
    // genuinely "busy" for as long as this test needs it to.
    let releaseMessage
    const messageReleased = new Promise((r) => (releaseMessage = r))
    await page.route('**/signals/message', async (route) => {
      await messageReleased
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    const cancelRequests = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/chat/cancel')) cancelRequests.push(r.postDataJSON())
    })

    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr,
        file: 'test.php',
        line: 1,
        author: 'reviewer',
        body: 'pas dit aan',
        code: '$order->total();',
        gran: 'call',
        label: 'Order::total',
      },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.goto('/pr/' + pr)
    await page.getByTestId('comment-item').first().click()
    await page.keyboard.press('ArrowRight') // comment -> claude
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    await composer.fill('doe iets')
    await page.getByTestId('claude-chat-send').click()

    // The werkmap choice arrives while THIS conversation's own turn is
    // genuinely in flight.
    open = true
    releaseEvents()
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()

    const pauseRow = page.getByTestId('workdir-overlay-option').filter({ hasText: 'Chat pauzeren' })
    await expect(pauseRow).toContainText('stopt de lopende beurt')
    await expect(pauseRow).toBeEnabled()

    await pauseRow.click()
    await expect.poll(() => cancelRequests.length).toBe(1)
    // Answering-the-question rows are untouched: this option never sent a
    // checkoutAnswer/checkoutRelist/checkoutOff Signal, only the cancel.
    await expect(page.getByTestId('workdir-overlay')).toBeVisible()

    releaseMessage()
  })

  // Reviewer follow-up request: "retry in élke werkmap-melding", not only
  // checkoutStageLandingFailed — each stage's "Opnieuw proberen" row re-runs
  // whichever ladder check raised THAT decision (see retryRowFor's own doc
  // comment, workDirOverlay.mjs).
  test('every stage offers "Opnieuw proberen", each re-running its own ladder check', async ({ page }) => {
    // dirtyTree: re-running the check is an EMPTY-reply checkoutAnswer (the
    // exact request prepareChatShellWorkDirAt's own reviewerReply === ""
    // branch expects) — no `reply` field at all, unlike a real answer.
    await mockCheckout(page, {
      pr: 12903,
      runId: 'chatmerge-12903',
      dir: '/home/reindert/dev/pnp',
      dirName: 'pnp',
      branch: 'feature/x',
      decision: {
        stage: 'dirtyTree',
        dir: '/home/reindert/dev/pnp',
        body: '`/home/reindert/dev/pnp` heeft nog niet-gerelateerde, niet-gecommitte wijzigingen.',
        options: ['Verwijderen', 'Meenemen in de commit'],
      },
    })
    let signals = mockSignals(page)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    let retryRow = page.getByTestId('workdir-overlay-option').filter({ hasText: 'Opnieuw proberen' })
    await expect(retryRow).toBeVisible()
    await retryRow.click()
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toEqual({ action: 'checkoutAnswer' })
  })

  test('reuseMerged: "Opnieuw proberen" is also an empty-reply checkoutAnswer', async ({ page }) => {
    await mockCheckout(page, {
      pr: 12903,
      runId: 'chatmerge-12903',
      dir: '/home/reindert/dev/pnp',
      dirName: 'pnp',
      decision: {
        stage: 'reuseMerged',
        dir: '/home/reindert/dev/pnp',
        body: '`/home/reindert/dev/pnp` staat nu op `oude-feature`, dat al is gemerged.',
        options: ['Ja, gebruik deze directory voor deze PR', 'Nee, zoek een andere directory'],
      },
    })
    const signals = mockSignals(page)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    const retryRow = page.getByTestId('workdir-overlay-option').filter({ hasText: 'Opnieuw proberen' })
    await expect(retryRow).toBeVisible()
    await retryRow.click()
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toEqual({ action: 'checkoutAnswer' })
  })

  test('chooseDirectory: "Opnieuw proberen" re-runs discovery, same as "Andere werkmap kiezen"', async ({ page }) => {
    await mockCheckout(page, DECISION)
    const signals = mockSignals(page)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    const retryRow = page.getByTestId('workdir-overlay-option').filter({ hasText: 'Opnieuw proberen' })
    await expect(retryRow).toBeVisible()
    await retryRow.click()
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toEqual({ action: 'checkoutRelist' })
  })

  // landingFailed: the one stage with no Options at all — "Opnieuw proberen"
  // resends the exact land request that failed (empty action, the SAME
  // conversationId/turnId chatCheckoutDecision carried), never
  // checkoutAnswer/checkoutRelist.
  test('landingFailed: "Opnieuw proberen" resends the exact land request that failed', async ({ page }) => {
    await mockCheckout(page, {
      pr: 12903,
      runId: 'chatmerge-12903',
      dir: '/home/reindert/dev/pnp',
      dirName: 'pnp',
      branch: 'feature/x',
      decision: {
        stage: 'landingFailed',
        dir: '/home/reindert/dev/pnp',
        body: 'De wijziging kon niet op de PR-branch worden gezet (reden: fetch checkout commit into shared clone: ...).',
        conversationId: 'conv-abc',
        turnId: 'turn-def',
      },
    })
    const signals = mockSignals(page)
    await page.goto('/pr/12903' + SEL)
    await appReady(page)
    // No Options at all, so this is JUST the retry row plus the three
    // always-available escapes.
    await expect(page.getByTestId('workdir-overlay-option')).toHaveCount(4)
    const retryRow = page.getByTestId('workdir-overlay-option').first()
    await expect(retryRow).toContainText('Opnieuw proberen')
    await retryRow.click()
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toEqual({ conversationId: 'conv-abc', turnId: 'turn-def' })
  })
})

// Reviewer-reported bug: making the werkmap choice resolved the PR-wide
// decision, but the Claude chat column that was stuck on the "keuze open
// over de werkmap" dead-end (chat_workflow.go's own static reply once
// prepareChatShellWorkDir sees checkoutChoiceOpen) showed nothing new and
// never continued — the reviewer had to notice this and retype the original
// request by hand. Answering the option now also resumes that SAME
// conversation: a synthetic "Werkmap gekozen: …" turn (RelatedPanel.mjs's
// resumeStuckClaudeAfterCheckout, wired from home.mjs's sendCheckoutAction).
// The decision only becomes open AFTER the chat column is already showing the
// dead-end (same "checkout.changed over SSE" gating as the "steals focus"
// test above) so the overlay's own full-screen backdrop never blocks the
// earlier click/ArrowRight into that column.
test('answering the choice also resumes a chat column stuck on the "keuze open" dead-end', async ({ page }, testInfo) => {
  // `messages` (the conversation transcript GET /api/chat serves) is declared
  // up front, mutable: once the resend's own message Signal lands, it is
  // pushed on so the NEXT GET /api/chat re-fetch (loadChatMessages, called
  // from sendClaudeMessage's own belt-and-braces refetch) already reflects it
  // — mirrors what a real backend does (chat_workflow.go's saveChatMessage
  // persists the reviewer's turn before Claude is even asked anything) — or
  // the optimistic pending bubble it briefly showed gets wiped by the stale
  // mocked list underneath it.
  const messages = []
  // Captured from the start (not via page.waitForRequest AFTER the answer),
  // because the resend fires synchronously off the SAME merge-signal round
  // trip the test already waits on below — by the time that wait resolves the
  // message Signal has usually already completed too, which a waitForRequest
  // registered afterwards would miss entirely.
  const messageReqs = []
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/signals/message')) return
    const data = r.postDataJSON()
    messageReqs.push(data)
    messages.push({ id: 'resend-' + messageReqs.length, role: 'user', kind: '', body: data.body })
  })
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

  // Fulfilled exactly once, on the FIRST connection after `release()` — every
  // reconnect afterwards just hangs. Without this, the mocked stream (which
  // always immediately has an already-resolved `released` promise once
  // release() has run) sends the same event, gets torn down, and reconnects
  // in a tight loop for the rest of the test — real, unnecessary CPU/network
  // churn alongside the real backend round trips (task_code_comment,
  // ensureChatConversation, the chat_merge queue) this test already makes.
  let release
  const released = new Promise((r) => (release = r))
  let delivered = false
  await page.route('**/api/events*', async (route) => {
    await released
    if (delivered) return // never resolves — no further reconnect
    delivered = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'checkout.changed', pr, seq: 1 })}\n\n`,
    })
  })

  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'pas dit aan',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const deadEndBody =
    'Ik kan nu geen code aanpassen: er staat nog een keuze open over de werkmap van deze PR. Maak die keuze en vraag het daarna opnieuw.'
  messages.push(
    { id: 'user-1', role: 'user', kind: '', body: 'pas dit aan' },
    { id: 'assistant-1', role: 'assistant', kind: '', body: deadEndBody, noShell: true },
  )
  await page.route('**/api/chat?commentId=' + conversationId, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages }) }),
  )

  await page.goto('/pr/' + pr)
  await expect(page.getByTestId('workdir-overlay')).toHaveCount(0)
  await page.getByTestId('comment-item').first().click()
  await page.keyboard.press('ArrowRight') // comment -> claude
  await expect(page.getByTestId('claude-message-body').last()).toContainText('er staat nog een keuze open')

  // The choice arrives while the reviewer is looking straight at the stuck
  // conversation.
  open = true
  release()
  await expect(page.getByTestId('workdir-overlay')).toBeVisible()

  // A mouse click on the option row itself, not ArrowDown+Enter: which
  // element owns real DOM focus at this exact moment is a separate concern
  // (the composer-vs-overlay focus race the "steals focus" test above
  // covers), orthogonal to what THIS test is about — resuming the stuck
  // chat once the choice is answered.
  await page.getByTestId('workdir-overlay-option').filter({ hasText: '/home/reindert/dev/b' }).click()
  await expect.poll(() => signals.length).toBe(1)
  expect(signals[0]).toMatchObject({ action: 'checkoutAnswer', reply: '/home/reindert/dev/b' })
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Werkmap gekozen: /home/reindert/dev/b')
  await expect.poll(() => messageReqs.length).toBe(1)
  expect(messageReqs[0].body).toContain('Werkmap gekozen: /home/reindert/dev/b')
})

// Reviewer-reported follow-up on the very same bug, PR 13535: the resume above
// only ever reached the conversation that happened to be ON SCREEN. The
// decision is PR-wide (one work directory per PR), so one open choice dead-ends
// every write turn of that PR — with several comment chats running at once,
// three of them had answered "doe maar"/"retry" into a dead-end that never came
// back, while the one displayed at answer time carried on fine. Answering now
// resumes every conversation of the PR whose LAST message is a checkout dead
// end (isCheckoutDeadEnd, RelatedPanel.mjs), the displayed one included.
test('answering the choice also resumes the OTHER stuck chats of the same PR', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const runId = 'chatmerge-' + pr
  const OTHER_ID = 'gh-other-stuck'
  const OTHER_RUN = 'claudechat-other-stuck'
  const deadEndBody =
    'Ik kan nu geen code aanpassen: er staat nog een keuze open over de werkmap van deze PR. Maak die keuze en vraag het daarna opnieuw.'

  // Every message Signal, WITH its target run id — that is the whole point
  // here: one has to land on the conversation nothing is displaying.
  const messageReqs = []
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/signals/message')) return
    messageReqs.push({ url: r.url(), body: r.postDataJSON() })
  })

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

  // Same one-shot checkout.changed delivery as the test above: the choice must
  // only open AFTER the displayed column already shows its dead-end.
  let release
  const released = new Promise((r) => (release = r))
  let delivered = false
  await page.route('**/api/events*', async (route) => {
    await released
    if (delivered) return
    delivered = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'checkout.changed', pr, seq: 1 })}\n\n`,
    })
  })

  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'pas dit aan',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  // The PR has TWO conversations, and only one of them is ever displayed.
  await page.route('**/api/chat?pr=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, conversations: [conversationId, OTHER_ID], seenAt: {} }),
    }),
  )
  await page.route('**/api/chat?commentId=' + conversationId + '*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          { id: 'user-1', role: 'user', kind: '', body: 'pas dit aan' },
          { id: 'assistant-1', role: 'assistant', kind: '', body: deadEndBody, noShell: true },
        ],
      }),
    }),
  )
  await page.route('**/api/chat?commentId=' + OTHER_ID + '*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          { id: 'other-user-1', role: 'user', kind: '', body: 'doe maar' },
          { id: 'other-assistant-1', role: 'assistant', kind: '', body: deadEndBody, noShell: true },
        ],
      }),
    }),
  )
  // The foreign conversation's claude_chat Execution is ensured purely to
  // learn its runId; only THAT id is mocked, the displayed conversation's own
  // ensure still goes to the real backend.
  await page.route('**/api/workflows/claude_chat', async (route) => {
    const data = route.request().postDataJSON()
    if (data && String(data.commentId) === OTHER_ID) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: OTHER_RUN }) })
      return
    }
    await route.continue()
  })
  await page.route(`**/api/workflows/${OTHER_RUN}/signals/message`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' }),
  )

  await page.goto('/pr/' + pr)
  await page.getByTestId('comment-item').first().click()
  await page.keyboard.press('ArrowRight') // comment -> claude
  await expect(page.getByTestId('claude-message-body').last()).toContainText('er staat nog een keuze open')

  open = true
  release()
  await expect(page.getByTestId('workdir-overlay')).toBeVisible()
  await page.getByTestId('workdir-overlay-option').filter({ hasText: '/home/reindert/dev/b' }).click()
  await expect.poll(() => signals.length).toBe(1)

  // Both conversations were resumed: the displayed one, and the one that only
  // exists in the PR's conversation list.
  await expect.poll(() => messageReqs.length).toBe(2)
  const other = messageReqs.find((m) => m.url.includes(OTHER_RUN))
  expect(other).toBeTruthy()
  expect(other.body.body).toContain('Werkmap gekozen: /home/reindert/dev/b')
  expect(messageReqs.some((m) => !m.url.includes(OTHER_RUN))).toBe(true)
})

// Reviewer-reported bug: pressing Enter on a keyboard-highlighted inline
// question option (here a chat.KindCleanupChoice bubble, "opruimen na
// afbreken" — see claudeQuestionOptions/PENDING_CLAUDE_QUESTION_KINDS in
// ClaudeChat.mjs/RelatedPanel.mjs) opened the werkmap overlay instead of
// sending the highlighted option. isWorkDirOverlayOpen() is a PR-WIDE read
// model (chat_checkout.go's Pending decision, keyed on the PR, not on any one
// conversation) and home.mjs's onKeydown checked it UNCONDITIONALLY before
// ever reaching relatedActive()'s own Enter handling — so the moment an
// UNRELATED write attempt elsewhere in the PR also raised the same "werkmap
// dirty" question at the overlay level, every Enter in the whole app
// (including one already aimed, via ↑, at an inline option in a completely
// different, currently open conversation) got swallowed by the overlay
// instead. Fixed by hasHighlightedClaudeOption() in RelatedPanel.mjs: Enter
// on a highlighted inline option now wins over the overlay; the overlay still
// owns every other key (↑/↓/Escape, or an Enter with nothing inline
// highlighted — see the tests above).
test('Enter on a keyboard-highlighted inline cleanup_choice option is not swallowed by an unrelated, PR-wide werkmap overlay', async ({
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
  const overlaySignals = mockSignals(page, runId)

  let release
  const released = new Promise((r) => (release = r))
  let delivered = false
  await page.route('**/api/events*', async (route) => {
    await released
    if (delivered) return
    delivered = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'checkout.changed', pr, seq: 1 })}\n\n`,
    })
  })

  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'pas dit aan',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const cleanupOptions = [
    'Verwijderen',
    'Stash (ik zet het later zelf terug)',
    'Stash (automatisch terugzetten zodra dit gesprek de directory weer vrijgeeft)',
    "Los laten (buiten Claude's commit houden)",
    'Meenemen in de commit',
  ]
  await page.route('**/api/chat?commentId=' + conversationId, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [
          {
            id: 'cleanup-1',
            role: 'assistant',
            kind: 'cleanup_choice',
            body: 'De afgebroken beurt liet niet-gecommitte wijzigingen achter. Wat wil je daarmee doen?',
            options: cleanupOptions,
          },
        ],
      }),
    }),
  )

  // cc.runId (the id the "message" Signal is actually POSTed to) is minted
  // by ensureAndLoadChat's own POST /api/workflows/claude_chat call once the
  // reviewer enters the column — NOT the same id task_code_comment returned
  // above (that only identifies commentId) — so this listens for the
  // request rather than routing it by a guessed id, mirroring the "resumes
  // stuck chat" test above; left unmocked (real backend), same as that test.
  const messageSignals = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/signals/message')) messageSignals.push(r.postDataJSON())
  })

  await page.goto('/pr/' + pr)
  await expect(page.getByTestId('workdir-overlay')).toHaveCount(0)
  await page.getByTestId('comment-item').first().click()
  await page.keyboard.press('ArrowRight') // comment -> claude
  const options = page.getByTestId('claude-question-option')
  await expect(options).toHaveCount(5)

  // Walk all the way to the topmost option ("Verwijderen"), exactly like the
  // reviewer-reported repro.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
  await expect(options.nth(0)).toHaveAttribute('data-active', 'true')

  // An UNRELATED write attempt elsewhere in the PR raises the same "werkmap
  // dirty" question at the PR-wide overlay level, while the reviewer is still
  // looking at their own already-highlighted inline option.
  open = true
  release()
  await expect(page.getByTestId('workdir-overlay')).toBeVisible()
  // The inline highlight is untouched by the overlay's own arrival.
  await expect(options.nth(0)).toHaveAttribute('data-active', 'true')

  await page.keyboard.press('Enter')

  // The reviewer's highlighted inline option won: the cleanup Signal fired
  // with the chosen option, not the overlay's own default row.
  await expect.poll(() => messageSignals.length).toBe(1)
  expect(messageSignals[0]).toMatchObject({ body: 'Verwijderen', action: 'cleanup' })
  expect(overlaySignals).toHaveLength(0)
})
