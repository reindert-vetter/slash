import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Enter on an EMPTY, focused Claude composer (the rest position) used to be a
// silent no-op — ClaudeChat.mjs's own @keydown only acts on non-blank text.
// Reviewer request: it should instead open the Claude-column menu, same as
// Enter while stepped up into the transcript, with an extra choice on a
// conversation whose backing comment never got the reviewer's own text (still
// CLAUDE_ANCHOR_PLACEHOLDER): "Comment hiervan maken" (prefills the origin
// bubble's edit field with a Claude-written summary) alongside "Wis
// Claude-gesprek" (which now also deletes that same still-empty comment). See
// "Comment hiervan maken' on an empty Claude input" in
// .claude/docs/claude-chat-panel.md. The worker's Fake Haiku client is
// programmed deterministically via SLASH_CLAUDE_CHAT_SUMMARY (_fixtures.mjs).
//
// Uses PR 12903 (real ingested blocks, its comments reset before every test —
// see _cleanApprovals in _fixtures.mjs) exactly like the "Chat over deze
// regel" setup in claude-chat-panel.spec.mjs.
const SEEDED_SUMMARY = 'Claude legt uit dat de `total()` aanroep het orderbedrag optelt, en dat er geen bijzonderheden zijn.'

async function seedPlaceholderChat(page) {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Chat over deze regel' }).click()

  const claudeComposer = page.getByTestId('claude-chat-compose')
  await expect(claudeComposer).toBeFocused()
  await claudeComposer.fill('Wat doet deze functie?')
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    claudeComposer.press('Enter'),
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()
  const item = page.getByTestId('comment-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('Nog geen eigen comment getypt')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  return { runId, claudeComposer }
}

test.describe('PR Review Tree — "Comment hiervan maken" on an empty Claude input', () => {
  test('Enter on the empty, focused composer opens the menu with "Wis Claude-gesprek" and "Comment hiervan maken"', async ({
    page,
  }) => {
    const { runId, claudeComposer } = await seedPlaceholderChat(page)
    try {
      // The composer clears itself synchronously on send and stays focused —
      // nothing moved the keyboard elsewhere.
      await expect(claudeComposer).toBeFocused()
      await expect(claudeComposer).toHaveValue('')

      await expect(page.getByTestId('command-menu')).not.toBeVisible()
      await page.keyboard.press('Enter')
      const menu = page.getByTestId('command-menu')
      await expect(menu).toBeVisible()
      await expect(menu).toContainText('Wis Claude-gesprek')
      await expect(menu).toContainText('Comment hiervan maken')
      await expect(menu).toContainText('Probeer de mislukte turn opnieuw')
    } finally {
      await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
    }
  })

  test('"Comment hiervan maken" prefills the origin bubble\'s edit field with a Claude-written summary', async ({
    page,
  }) => {
    const { runId } = await seedPlaceholderChat(page)
    try {
      await page.keyboard.press('Enter')
      const menu = page.getByTestId('command-menu')
      await expect(menu).toBeVisible()
      await menu.getByTestId('command-row').filter({ hasText: 'Comment hiervan maken' }).click()
      await expect(menu).not.toBeVisible()

      // Keyboard hands back to the comment card (toComment(false)) and opens
      // the ORIGIN bubble's own inline editor — the pre-existing "Bewerk
      // bericht" mechanism, not a second parallel one.
      const editor = page.getByTestId('message-edit-compose')
      await expect(editor).toBeVisible()
      await expect(editor).toHaveValue(SEEDED_SUMMARY, { timeout: 15000 })

      await page.getByTestId('message-edit-save').click()
      await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)
      // The rendered bubble runs the body through renderMarkdown (commentBody),
      // so the backtick-fenced `total()` becomes an inline <code> element —
      // check the surrounding plain text instead of the raw markdown source.
      await expect(page.getByTestId('reaction-bubble').first()).toContainText('Claude legt uit dat de')
      await expect(page.getByTestId('reaction-bubble').first().locator('code')).toHaveText('total()')
      await expect
        .poll(async () => {
          const list = await (await page.request.get('/api/comments?pr=12903')).json()
          const c = list.find((x) => x.runId === runId)
          return c && c.body
        })
        .toBe(SEEDED_SUMMARY)
    } finally {
      await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
    }
  })

  test('"Wis Claude-gesprek" also deletes the still-placeholder anchor comment', async ({ page }) => {
    const { runId } = await seedPlaceholderChat(page)
    try {
      await page.keyboard.press('Enter')
      const menu = page.getByTestId('command-menu')
      await expect(menu).toBeVisible()
      // "Wis Claude-gesprek" is the default selection and clears straight away
      // — no confirm step, this conversation has no pending shadow work (see
      // claudeChatCommandsFor).
      await page.keyboard.press('Enter')

      await expect(menu).not.toBeVisible()
      await expect(page.getByTestId('claude-message')).toHaveCount(0)
      // The placeholder comment is gone too — nothing left to focus, the
      // keyboard falls back to the diff.
      await expect(page.getByTestId('comment-item')).toHaveCount(0)
      await expect
        .poll(async () => {
          const list = await (await page.request.get('/api/comments?pr=12903')).json()
          return list.some((x) => x.runId === runId)
        })
        .toBe(false)
    } finally {
      // Best-effort: the comment is normally already gone by this point.
      await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
    }
  })
})
