import { test, expect, appReady } from './_fixtures.mjs'

// The general chat about a ticket ("/" on /plan/<KEY>) — reviewer request:
// "ik wil de algemene chat openen door / te drukken. precies zoals in de
// tree. die mag je hergebruiken". The UI (ClaudeChat.mjs's claudeChatColumn)
// is the exact review-tree component; the backend behind it is this page's
// own (plan_answer Signal, Kind "chat"), keyed on the Jira key rather than a
// GitHub PR number — there is no PR yet at planning time. See
// .claude/docs/plan-page.md.
//
// planChatReply calls m.claude.RunChat now (not the non-conversational Run),
// so it shares the SAME Fake chat script every other embedded-Claude-chat
// spec on this worker uses (SLASH_CLAUDE_CHAT_TURNS, see _fixtures.mjs) —
// but since it never sets a SessionID, every call starts a brand-new fake
// session, which always begins that script at its OWN first line
// (claude.Fake.RunChat: an unseen session id has no chatPos yet). The
// deterministic reply is therefore always the script's first line.
test.describe('Plan page — the general chat (/)', () => {
  test('/ opens the chat, a sent message round-trips through the Signal, Escape closes it', async ({ page }) => {
    await page.goto('/plan/TEST-901')
    await appReady(page)

    await expect(page.getByTestId('plan-chat-overlay')).toBeHidden()
    await page.keyboard.press('/')
    const overlay = page.getByTestId('plan-chat-overlay')
    await expect(overlay).toBeVisible()

    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    await composer.fill('Waarom kiezen we hier voor een facade?')
    await composer.press('Enter')

    // The reviewer's own message shows up immediately (the optimistic echo),
    // and the assistant's reply follows once the Signal round trip (one
    // blocking Claude call server-side) lands.
    await expect(page.getByTestId('claude-chat-thread')).toContainText('Waarom kiezen we hier voor een facade?')
    await expect(page.getByTestId('claude-chat-thread')).toContainText('Ik heb naar de code gekeken', { timeout: 15000 })

    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
  })

  // Reviewer report: "ik typ hier iets, maar de chat is opeens weg"
  // (data/review-shots/task7-ticket-chat-gone.png) — the 3s poll
  // (setInterval(loadPlan, POLL_MS), src/plan.mjs) used to overwrite the
  // optimistically-echoed message with the server's still-stale doc while the
  // BLOCKING Signal POST (handlePlanChat runs the whole Claude reply inline)
  // was still in flight. Reproduced here without touching the Go side at all:
  // delay the signals response past one poll tick so the race window is
  // deterministic, then assert the reviewer's own message survives it.
  test("the reviewer's own message survives a poll tick while the reply is still in flight", async ({ page }) => {
    await page.route('**/api/workflows/*/signals/*', async (route) => {
      await new Promise((r) => setTimeout(r, 3500))
      await route.continue()
    })

    await page.goto('/plan/TEST-904')
    await appReady(page)
    await page.keyboard.press('/')
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    await composer.fill('Blijft dit bericht staan?')
    await composer.press('Enter')

    const thread = page.getByTestId('claude-chat-thread')
    await expect(thread).toContainText('Blijft dit bericht staan?')
    // A poll tick (POLL_MS = 3000ms) fires well before the delayed Signal
    // response (3500ms) — without the fix this is exactly the moment the
    // message used to disappear.
    await page.waitForTimeout(3200)
    await expect(thread).toContainText('Blijft dit bericht staan?')

    await expect(thread).toContainText('Ik heb naar de code gekeken', { timeout: 15000 })
  })

  test('the mouse entry point (plan-chat-button) opens the same overlay', async ({ page }) => {
    await page.goto('/plan/TEST-902')
    await appReady(page)
    await page.getByTestId('plan-chat-button').click()
    await expect(page.getByTestId('plan-chat-overlay')).toBeVisible()
  })

  test('a click on the backdrop closes the overlay', async ({ page }) => {
    await page.goto('/plan/TEST-903')
    await appReady(page)
    await page.keyboard.press('/')
    const overlay = page.getByTestId('plan-chat-overlay')
    await expect(overlay).toBeVisible()
    // Click the backdrop itself, not the card inside it.
    await overlay.click({ position: { x: 5, y: 5 } })
    await expect(overlay).toBeHidden()
  })
})
