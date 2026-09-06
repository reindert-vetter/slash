import { test, expect, appReady } from './_fixtures.mjs'

// The general chat about a ticket ("/" on /plan/<KEY>) — reviewer request:
// "ik wil de algemene chat openen door / te drukken. precies zoals in de
// tree. die mag je hergebruiken". The UI (ClaudeChat.mjs's claudeChatColumn)
// is the exact review-tree component; the backend behind it is this page's
// own (plan_answer Signal, Kind "chat"), keyed on the Jira key rather than a
// GitHub PR number — there is no PR yet at planning time. See
// .claude/docs/plan-page.md. The harness runs with SLASH_CLAUDE=off, so the
// Fake answers every Sonnet call with an empty string — planChatReply then
// falls back to its own fixed "kon geen antwoord genereren" line, which is
// exactly what makes the round trip deterministic here.
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
    await expect(page.getByTestId('claude-chat-thread')).toContainText('Kon geen antwoord genereren', { timeout: 15000 })

    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
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
