import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reported bug: "ik heb niet al een comment, waarom die 2 opties hier?" — a
// reviewer who starts a Claude conversation (which lazily creates a LOCAL
// placeholder comment, see ensureClaudeAnchorForNew/CLAUDE_ANCHOR_PLACEHOLDER
// in RelatedPanel.mjs, since the backend requires an existing comment to
// anchor a chat on) and then sends their FIRST reply on that thread used to
// see the ordinary two-item publish menu, including "Ook mijn comment op
// GitHub" — which implies there is a reviewer-authored root comment to
// publish alongside the reply. There isn't one: the root is only the
// auto-generated placeholder sentence. See pendingPublishInfo's `chatAnchor`
// flag and replyPublishCommandsFor (home.mjs), plus "A bare, still-untaken-
// over Claude-chat anchor thread..." in .claude/docs/command-palette.md.
test.use({ viewport: { width: 2000, height: 1100 } })

test('a bare Claude-chat anchor thread only offers "Alleen mijn antwoord op GitHub", not "Ook mijn comment"', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
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
  expect((await createRes.json()).runId).toBeTruthy()
  await expect(page.getByTestId('comment-item')).toHaveCount(1)
  await expect(page.getByTestId('comment-item')).toContainText('Claude gesprek')

  // Open the bare anchor's own thread and send the reviewer's first reply —
  // this is the exact moment the publish-choice menu opens.
  await page.getByTestId('comment-item').click()
  const reply = page.getByTestId('reaction-compose')
  await reply.click()
  await expect(reply).toBeFocused()
  await reply.fill('asdf')
  await reply.press('Enter')

  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  const rows = menu.getByTestId('command-row')
  // Only "Sluit menu" + "Alleen mijn antwoord op GitHub" — no second,
  // "Ook mijn comment op GitHub" item, since there is no reviewer-authored
  // root comment on this thread yet.
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText('Alleen mijn antwoord op GitHub')
  await expect(menu).not.toContainText('Ook mijn comment op GitHub')
})
