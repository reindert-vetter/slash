import { test, expect, appReady } from './_fixtures.mjs'

// F5 push-to-talk dictation (src/dictation.mjs): hold F5, speak, release, and
// the transcript lands in the Claude composer for the reviewer to send
// themselves. See .claude/docs/dictation.md.
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
// Everything in between — the key handling, the four ways a recording ends, the
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

// holdF5 presses and holds F5 for ms, then releases it — the actual gesture.
async function holdF5(page, ms) {
  await page.keyboard.down('F5')
  await page.waitForTimeout(ms)
  await page.keyboard.up('F5')
}

test.describe('F5 dictation — review tree (/pr/<id>)', () => {
  test('holding F5 opens the chat, records, and drops the transcript in the composer', async ({ page }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await page.keyboard.down('F5')
    // The chat opens on the very first keydown, so the reviewer can see where
    // their words are going while they are still talking.
    await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
    const status = page.getByTestId('dictation-status')
    await expect(status).toBeVisible()
    await expect(status).toContainText('Opnemen')
    // The word carries the state, never colour alone — and the release
    // instruction is spelled out rather than implied.
    await expect(status).toContainText('laat F5 los om te stoppen')

    await page.waitForTimeout(500)
    await page.keyboard.up('F5')

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('dit is ingesproken tekst')
    // Nothing is ever sent on the reviewer's behalf: the text sits in the
    // composer waiting for their own Enter.
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  })

  test('auto-repeat while the key is held does not restart the recording', async ({ page }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await page.keyboard.down('F5')
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')
    // macOS fires keydown over and over while the key is held. Playwright's
    // own keyboard.down sends exactly one, so the repeats are dispatched
    // directly — repeat:true is the only thing that distinguishes them.
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', repeat: true, bubbles: true }))
      }
    })
    await page.waitForTimeout(400)
    await page.keyboard.up('F5')

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('dit is ingesproken tekst')
    // One microphone session for one press — 21 would mean every repeat
    // restarted the recording and threw the earlier audio away.
    expect(await page.evaluate(() => window.__gumCalls)).toBe(1)
  })

  test('losing window focus while the key is held still finishes the recording', async ({ page }) => {
    await stubDictation(page, { text: 'afgebroken door focusverlies' })
    await page.goto('/pr/12903')
    await appReady(page)

    await page.keyboard.down('F5')
    await expect(page.getByTestId('dictation-status')).toContainText('Opnemen')
    await page.waitForTimeout(400)
    // Alt-Tab away while still holding the key: no keyup ever arrives, so
    // without the blur safety net the microphone would stay open forever.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))

    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('afgebroken door focusverlies')
    await page.keyboard.up('F5')
  })

  test('a key brushed by accident is discarded instead of transcribed', async ({ page }) => {
    await stubDictation(page)
    await page.goto('/pr/12903')
    await appReady(page)

    await holdF5(page, 40)

    await expect(page.getByTestId('dictation-note')).toContainText('Te kort')
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('')
  })

  test('without whisper installed it says so and points at the settings page', async ({ page }) => {
    await stubDictation(page, { status: 503, body: { ok: false, setup: true, error: 'not set up' } })
    await page.goto('/pr/12903')
    await appReady(page)

    await holdF5(page, 500)

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
    await page.keyboard.down('F5')
    await expect(page.getByTestId('plan-chat-overlay')).toBeVisible()
    await page.waitForTimeout(500)
    await page.keyboard.up('F5')

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

    await holdF5(page, 500)

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
                  ? 'Klaar voor gebruik — houd F5 ingedrukt om in te spreken'
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
    await expect(row).toContainText('Klaar voor gebruik — houd F5 ingedrukt om in te spreken')
  })
})
