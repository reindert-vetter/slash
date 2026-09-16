import { test, expect, appReady, seededPr } from './_fixtures.mjs'

// F5 toggle dictation (src/dictation.mjs): press F5 to start recording, press
// it again to stop and transcribe — the transcript lands in the Claude
// composer for the reviewer to send themselves. See .claude/docs/dictation.md.
//
// Two things are faked here and nothing else:
//
//   - navigator.mediaDevices.getUserMedia, replaced by a real MediaStream fed
//     by an oscillator. That is deliberately a REAL stream rather than a stub
//     object: the module runs it through an AudioContext and an AudioWorklet,
//     and a plain fake would skip exactly the part most likely to break. It
//     also counts its own calls, which is how the auto-repeat guard is tested.
//   - POST /api/transcribe, so no whisper.cpp binary or 1.6 GB model is needed
//     on the machine running the suite.
//
// Everything in between — the key handling, the ways a recording ends, the
// minimum duration, the insertion into the composer — is the real code.

const FAKE_MEDIA = `
  window.__gumCalls = 0
  navigator.mediaDevices.getUserMedia = async () => {
    window.__gumCalls++
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const dest = ctx.createMediaStreamDestination()
    osc.connect(dest)
    osc.start()
    return dest.stream
  }
`

async function stubDictation(page, { text = 'dit is ingesproken tekst', status = 200, body = null } = {}) {
  await page.addInitScript(FAKE_MEDIA)
  await page.route('**/api/transcribe', (route) =>
    route.fulfill({ status, json: body || { ok: true, text } }),
  )
}

// pressF5 dispatches a single, real keydown+keyup pair for F5, back to back —
// exactly what BetterTouchTool forwards from a physical mic button (it cannot
// "hold" a key), and the reason the gesture is a toggle rather than
// push-to-talk in the first place.
async function pressF5(page) {
  await page.keyboard.down('F5')
  await page.keyboard.up('F5')
}

// toggleF5For starts a recording, waits ms, then presses F5 a second time to
// stop and transcribe it — the ordinary two-press toggle gesture.
async function toggleF5For(page, ms) {
  await pressF5(page)
  await page.waitForTimeout(ms)
  await pressF5(page)
}

test.describe('F5 dictation — review tree (/pr/<id>)', () => {
  test('one press opens the chat and starts recording, a second press stops and transcribes', async ({
    page,
  }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await pressF5(page)
    // The chat opens on the very first press, so the reviewer can see where
    // their words are going while they are still talking.
    await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
    const status = page.getByTestId('dictation-status')
    await expect(status).toBeVisible()
    await expect(status).toContainText('Opnemen')
    // The word carries the state, never colour alone — and the stop
    // instruction is spelled out rather than implied.
    await expect(status).toContainText('druk nogmaals op F5 om te stoppen')

    await page.waitForTimeout(500)
    // Releasing the key does nothing — only a second, separate press stops it.
    await pressF5(page)

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('dit is ingesproken tekst')
    // Nothing is ever sent on the reviewer's behalf: the text sits in the
    // composer waiting for their own Enter.
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  })

  test('with a group/line/call selected that already has a Claude conversation, F5 opens THAT scoped chat, not the general one', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
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
    await stubDictation(page)

    await page.goto('/pr/' + pr)
    await appReady(page)
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await item.click() // cs.focus = 'comment' — the unit this comment is on is now selected
    const claudeCard = page.getByTestId('claude-chat-card')
    await expect(claudeCard).toBeVisible()
    // Back to the diff (cs.focus = null): a group/line/call is selected, the
    // keyboard is not inside the comment/Claude column itself — exactly the
    // reviewer's "ik heb groep, line of call geselecteerd" state. The card
    // itself stays visible (claudeColumnVisible() only depends on the
    // selected unit having a conversation, not on where the keyboard is).
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('claude-chat-compose')).not.toBeFocused()

    await pressF5(page)

    // The scoped chat for this exact unit reopened — never the PR-wide one.
    await expect(page.getByTestId('general-chat-overlay')).toBeHidden()
    await expect(claudeCard).toBeVisible()
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

    await page.waitForTimeout(500)
    await pressF5(page)
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('dit is ingesproken tekst')
  })

  test('with nothing selected that has a conversation, F5 falls back to the general chat', async ({ page }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await pressF5(page)

    await expect(page.getByTestId('general-chat-overlay')).toBeVisible()
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

    await page.waitForTimeout(500)
    await pressF5(page)
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('dit is ingesproken tekst')
  })

  test('auto-repeat while the key is held does not toggle back and forth', async ({ page }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await page.keyboard.down('F5')
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')
    // macOS (and a held BTT trigger) fires keydown over and over while the key
    // is considered held. Playwright's own keyboard.down sends exactly one, so
    // the repeats are dispatched directly — repeat:true is the only thing
    // that distinguishes them.
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', repeat: true, bubbles: true }))
      }
    })
    await page.keyboard.up('F5')
    // Still recording: none of the 20 repeats toggled it off.
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')

    await page.waitForTimeout(400)
    await pressF5(page)

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('dit is ingesproken tekst')
    // One microphone session for one recording — 21 would mean every repeat
    // restarted it and threw the earlier audio away.
    expect(await page.evaluate(() => window.__gumCalls)).toBe(1)
  })

  test('Escape aborts a running recording without transcribing it', async ({ page }) => {
    let transcribeCalls = 0
    await page.addInitScript(FAKE_MEDIA)
    await page.route('**/api/transcribe', (route) => {
      transcribeCalls++
      return route.fulfill({ json: { ok: true, text: 'moet nooit verschijnen' } })
    })
    await page.goto('/pr/12903')
    await appReady(page)

    await pressF5(page)
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')
    await page.waitForTimeout(400)
    // F5 fell back to the general chat here (nothing scoped was selected), so
    // Escape also closes that overlay — its own capture-phase handler runs
    // first and stops the event, but it still aborts the recording behind it
    // (see abortDictationIfRecording in generalChatOverlay.mjs) rather than
    // silently leaving the microphone on.
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('general-chat-overlay')).toBeHidden()
    expect(transcribeCalls).toBe(0)
  })

  test('Escape aborts a recording started on a scoped chat, without closing it', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
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

    let transcribeCalls = 0
    await page.addInitScript(FAKE_MEDIA)
    await page.route('**/api/transcribe', (route) => {
      transcribeCalls++
      return route.fulfill({ json: { ok: true, text: 'moet nooit verschijnen' } })
    })
    await page.goto('/pr/' + pr)
    await appReady(page)
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await item.click()
    await page.keyboard.press('ArrowLeft') // back to the diff, unit stays selected

    await pressF5(page)
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')

    // The scoped chat card itself is untouched by Escape — only the
    // recording is cancelled.
    await expect(page.getByTestId('claude-chat-card')).toBeVisible()
    expect(transcribeCalls).toBe(0)
  })

  test('losing window focus while recording still finishes and transcribes it', async ({ page }) => {
    await stubDictation(page, { text: 'afgebroken door focusverlies' })
    await page.goto('/pr/12903')
    await appReady(page)

    await pressF5(page)
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')
    await page.waitForTimeout(400)
    // Alt-Tab away while recording: with a toggle there is no keyup at all to
    // rely on, so the blur safety net is the only thing that ends this
    // recording (short of the reviewer coming back to press F5 again).
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('afgebroken door focusverlies')
  })

  test('two presses in quick succession are discarded instead of transcribed', async ({ page }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await toggleF5For(page, 40)

    await expect(page.getByTestId('dictation-note')).toContainText('Te kort')
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('')
  })

  test('without whisper installed it says so and points at the settings page', async ({ page }) => {
    await stubDictation(page, { status: 503, body: { ok: false, setup: true, error: 'not set up' } })
    await page.goto('/pr/12903')
    await appReady(page)

    await toggleF5For(page, 500)

    await expect(page.getByTestId('dictation-note')).toContainText('Instellingen')
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('')
  })
})

test.describe('F5 dictation — plan page (/plan/<KEY>)', () => {
  test('the same gesture works on the ticket chat', async ({ page }) => {
    await stubDictation(page, { text: 'ingesproken op de planpagina' })
    await page.goto('/plan/TEST-901')
    await appReady(page)

    await expect(page.getByTestId('plan-chat-overlay')).toBeHidden()
    await pressF5(page)
    await expect(page.getByTestId('plan-chat-overlay')).toBeVisible()
    await page.waitForTimeout(500)
    await pressF5(page)

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('ingesproken op de planpagina')
  })

  test('F5 still works once the chat is already open', async ({ page }) => {
    await stubDictation(page, { text: 'tweede alinea' })
    await page.goto('/plan/TEST-901')
    await appReady(page)

    await page.keyboard.press('/')
    await expect(page.getByTestId('plan-chat-overlay')).toBeVisible()
    const composer = page.getByTestId('claude-chat-compose')
    await composer.fill('eerste alinea')

    await toggleF5For(page, 500)

    // Appended at the caret with a separating space, not replacing what was
    // already typed. This is the case that forced the keydown branch to sit
    // ABOVE the chat-overlay guard in both pages' onKeydown: those guards
    // return early, so a branch further down would never have run here.
    await expect(composer).toHaveValue('eerste alinea tweede alinea')
  })
})

test.describe('Settings — the speech model download', () => {
  test('offers a download button when whisper-cli is there but the model is not', async ({ page }) => {
    let started = 0
    await page.route('**/api/auth/status*', (route) =>
      route.fulfill({
        json: {
          checkedAt: new Date().toISOString(),
          ok: false,
          checks: [
            {
              id: 'whisper',
              label: 'Spraak naar tekst (whisper.cpp)',
              state: 'missing',
              detail: 'whisper-cli is er, maar het taalmodel ontbreekt nog',
              action: 'whisperModel',
            },
          ],
          jira: { email: '', site: '', tokenSet: false },
        },
      }),
    )
    await page.route('**/api/workflows/whisper_model', (route) => {
      started++
      return route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/whisper/progress', (route) =>
      route.fulfill({ json: { active: false, done: 0, total: 0 } }),
    )

    await page.goto('/settings')
    await page.getByTestId('settings-tab-account').click()
    const button = page.getByTestId('settings-whisper-download')
    await expect(button).toBeVisible()
    await button.click()
    await expect.poll(() => started).toBe(1)
  })

  test('shows no download button when the binary itself is missing — that fix is a terminal command', async ({
    page,
  }) => {
    await page.route('**/api/auth/status*', (route) =>
      route.fulfill({
        json: {
          checkedAt: new Date().toISOString(),
          ok: false,
          checks: [
            {
              id: 'whisper',
              label: 'Spraak naar tekst (whisper.cpp)',
              state: 'missing',
              detail: 'whisper-cli is niet gevonden',
              fixCommand: 'brew install whisper.cpp',
            },
          ],
          jira: { email: '', site: '', tokenSet: false },
        },
      }),
    )
    await page.goto('/settings')
    await page.getByTestId('settings-tab-account').click()
    await expect(page.getByTestId('settings-whisper-download')).toHaveCount(0)
    await expect(page.getByTestId('settings-auth-checks')).toContainText('brew install whisper.cpp')
  })

  // Regression for the "Niet ingesteld" badge stuck next to a "Klaar voor
  // gebruik" detail line: authCheckRow's row is keyed by check id
  // ('authrow:whisper'), so "Opnieuw controleren" reuses the same DOM chunk
  // instead of remounting it. authStateBadge(check) used to be interpolated
  // as a bare, non-`() =>` nested template — a static slot that only ever
  // gets baked in at first mount and is never re-diffed on a reused keyed
  // node (see "A keyed node is reused without re-running its bindings" in
  // .claude/rules/arrowjs-pitfalls.md). The detail line right below it is a
  // genuine `${() => check.detail || ''}` reactive slot and always updated
  // correctly, which is what made the mismatch so easy to miss.
  test('re-checking updates the state badge, not just the detail line', async ({ page }) => {
    let state = 'missing'
    await page.route('**/api/auth/status*', (route) =>
      route.fulfill({
        json: {
          checkedAt: new Date().toISOString(),
          ok: state === 'ok',
          checks: [
            {
              id: 'whisper',
              label: 'Spraak naar tekst (whisper.cpp)',
              state,
              detail:
                state === 'ok'
                  ? 'Klaar voor gebruik — druk op F5 om in te spreken, nogmaals om te stoppen'
                  : 'whisper-cli is niet gevonden',
              fixCommand: state === 'ok' ? undefined : 'brew install whisper.cpp',
            },
          ],
          jira: { email: '', site: '', tokenSet: false },
        },
      }),
    )

    await page.goto('/settings')
    await page.getByTestId('settings-tab-account').click()
    const row = page.locator('[data-testid="auth-check-row"][data-check="whisper"]')
    await expect(row.getByTestId('auth-state')).toContainText('Niet ingesteld')

    state = 'ok'
    await page.getByTestId('settings-auth-recheck').click()

    await expect(row.getByTestId('auth-state')).toContainText('Werkt')
    await expect(row).toContainText('Klaar voor gebruik — druk op F5 om in te spreken, nogmaals om te stoppen')
  })
})
