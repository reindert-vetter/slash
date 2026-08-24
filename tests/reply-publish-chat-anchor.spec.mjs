import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reported bug 1: "ik heb niet al een comment, waarom die 2 opties hier?" — a
// reviewer who starts a Claude conversation (which lazily creates a LOCAL
// placeholder comment, see ensureClaudeAnchorForNew/CLAUDE_ANCHOR_PLACEHOLDER
// in RelatedPanel.mjs, since the backend requires an existing comment to
// anchor a chat on) and then sends their FIRST reply on that thread used to
// see the ordinary two-item publish menu, including "Ook mijn comment op
// GitHub" — which implies there is a reviewer-authored root comment to
// publish alongside the reply. There isn't one: the root is only the
// auto-generated placeholder sentence.
//
// Reported bug 2, same session, immediate follow-up once bug 1 was fixed:
// "als ik eigenlijk maar 1 optie heb (- sluiten) dan wil ik geen menu zien" —
// with the bogus item gone, the menu was left with exactly one real
// destination next to the pinned "Sluit menu", i.e. no actual choice to make
// at all. `sendReaction` (RelatedPanel.mjs) now skips the publish-choice menu
// entirely for a bare, still-untaken-over chat anchor and sends straight to
// GitHub as that one destination (`publish:'reply'`), exactly like the
// existing pure-Claude-draft shortcut just above it. See pendingPublishInfo's
// `chatAnchor` doc comment and "A bare, still-untaken-over Claude-chat anchor
// thread..." in .claude/docs/command-palette.md.
//
// Separately, ecf4979 ("Stop auto-opening the comment menu right after a
// reply is sent") removed the comment's OWN action menu that used to open
// right after any reply landed — deliberate, reviewer-reported reversal, not
// a regression. So this test no longer expects ANY menu after the reply: not
// the (already skipped) publish-choice menu, and not the comment's own
// action menu either. See "A reply no longer auto-opens the comment's own
// menu" in .claude/docs/comments-panel.md.
test.use({ viewport: { width: 2000, height: 1100 } })

test('a bare Claude-chat anchor thread\'s first reply posts straight to GitHub, no publish-choice menu', async ({
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
  // there is no publish-choice menu to click through: it goes straight out.
  await page.getByTestId('comment-item').click()
  const reply = page.getByTestId('reaction-compose')
  await reply.click()
  await expect(reply).toBeFocused()
  const [replyReq] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/signals/reply') && req.method() === 'POST'),
    reply.fill('asdf'),
    reply.press('Enter'),
  ])
  const payload = replyReq.postDataJSON()
  expect(payload.body).toBe('asdf')
  expect(payload.publish).toBe('reply')

  // No menu opens at all after this reply: not the (already skipped)
  // publish-choice menu, and — since ecf4979 — not the comment's own action
  // menu either (that auto-open was deliberately removed on a later
  // reviewer report). The reviewer can still open it themselves with Enter
  // on the now-empty reply field.
  const menu = page.getByTestId('command-menu')
  await expect(menu).not.toBeVisible()

  // The thread is now taken over and public.
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/comments?pr=12903')
      const list = await res.json()
      const c = list.find((x) => x.body === 'asdf' || (x.reactions || []).some((r) => r.body === 'asdf'))
      return (c && c.githubId) || 0
    })
    .toBeGreaterThan(0)
})
