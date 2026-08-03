import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// The button to the right of "Stuur" in an expanded comment thread
// (reaction-status) used to double as the resolve action (a plain click sent
// "/resolve" straight away). It's now a pure send-status indicator — draft
// (pencil) while idle, a spinner while a reply is in flight, a circle-check
// right after one completes — and resolving moved to the comment-scoped
// command menu ("Resolve comment", already reachable via Enter, see
// comment-delete.spec.mjs). This spec covers the two things that change:
// (1) resolve must still be reachable with the mouse alone (the reaction-status
// button now opens that same menu on click instead of resolving directly), and
// (2) the status icon actually reflects draft/sending/sent.
test.describe('reaction-status: send-status icon + mouse-only resolve', () => {
  // Own PR per test, from seededPr — mirrors comment-delete.spec.mjs's
  // isolation reasoning (comments read-model, no ingested blocks needed here).
  async function seedComment(page, pr, body) {
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    return runId
  }

  test('clicking the status button opens the resolve/delete menu — no keyboard needed', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'mouse-only-resolve ' + Math.random().toString(36).slice(2)
    const runId = await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    const statusButton = page.getByTestId('reaction-status')
    await expect(statusButton).toBeVisible()
    // Idle: draft icon, not the "Verzenden" spinner or the "sent" mark.
    await expect(statusButton.getByTestId('send-status-draft')).toBeVisible()

    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await statusButton.click()

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows.first()).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Resolve comment')
    await expect(rows.nth(2)).toContainText('Verwijder comment')

    // Resolve it with a mouse click on the row itself — never touching the
    // keyboard for the actual action.
    await rows.nth(1).click()
    await expect(menu).not.toBeVisible()

    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + pr)).json()
        const c = list.find((x) => x.id === runId)
        return c && c.status
      })
      .toBe('resolved')
  })

  test('the status icon shows a spinner while sending and disables both buttons', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'status-icon-spinner ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    // Delay the reply Signal so the "sending" state is observable instead of
    // resolving before Playwright can assert on it.
    let releaseReply
    const gate = new Promise((resolve) => (releaseReply = resolve))
    await page.route('**/api/workflows/*/signals/reply', async (route) => {
      await gate
      await route.continue()
    })

    await page.goto('/pr/' + pr)
    await page.keyboard.press('Escape')
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.fill('bedankt voor de review')

    const sendButton = page.getByTestId('reaction-send')
    const statusButton = page.getByTestId('reaction-status')
    await sendButton.click()

    // In flight: spinner on the status button, both buttons disabled (no
    // double-submit / no opening the menu mid-send).
    await expect(statusButton.getByTestId('send-status-sending')).toBeVisible()
    await expect(sendButton).toBeDisabled()
    await expect(statusButton).toBeDisabled()

    releaseReply()

    // Done: a brief "sent" confirmation, then back to draft once the field is
    // empty again (the field is cleared on success).
    await expect(statusButton.getByTestId('send-status-sent')).toBeVisible()
    await expect(statusButton.getByTestId('send-status-draft')).toBeVisible({ timeout: 3000 })
    await expect(reply).toHaveValue('')
  })

  // reaction-compose used to be a plain single-line <input> — no Shift+Enter,
  // no growing height. It's now a <textarea> with the same behaviour as the
  // other three composers (comment-compose, comment-detail-reply, the Claude
  // chat composer — see textareaAutoGrow.mjs and
  // .claude/docs/claude-chat-panel.md).
  test('reaction-compose is a textarea: Shift+Enter adds a newline, it grows with content, and resets on send', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'reaction-textarea ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    expect(await reply.evaluate((el) => el.tagName)).toBe('TEXTAREA')

    const startHeight = (await reply.boundingBox()).height
    await reply.type('regel een')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Shift')
    await reply.type('regel twee')
    await expect(reply).toHaveValue('regel een\nregel twee')

    await expect(async () => {
      const grownHeight = (await reply.boundingBox()).height
      expect(grownHeight).toBeGreaterThan(startHeight)
    }).toPass()

    // Plain Enter sends and clears the field — and the grown height resets
    // back down (the field stays mounted, unlike comment-compose).
    await page.keyboard.press('Enter')
    await expect(reply).toHaveValue('')
    await expect(async () => {
      const resetHeight = (await reply.boundingBox()).height
      expect(resetHeight).toBe(startHeight)
    }).toPass()
  })
})
