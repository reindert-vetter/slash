import { test, expect } from './_fixtures.mjs'

// "Checks gefaald" on /pr-overview opens /pr/<id>?chat=checks, which starts a
// NEW, separate Claude chat (never the one general chat) whose first turn asks
// Claude to investigate the failing CI checks. The param is one-shot: it is
// stripped right away so a refresh never starts a second chat. See
// maybeStartChecksChat (home.mjs) / startPrChecksChat (RelatedPanel.mjs).
const ANCHOR_BODY = 'Gefaalde CI-checks onderzoeken'

test('?chat=checks starts a new checks chat, sends the prompt, and is one-shot', async ({ page }) => {
  const posts = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/workflows/task_code_comment')) posts.push(r.postDataJSON())
  })

  // A `sel` keeps the harness's own fresh-open Escape/→ (see _fixtures.mjs)
  // out of the way: that Escape would close the overlay under test.
  await page.goto('/pr/12903?sel=' + encodeURIComponent('app/Actions/CreatePaymentAction.php:26') + '&chat=checks')

  const overlay = page.getByTestId('general-chat-overlay')
  await expect(overlay).toBeVisible()
  await expect(page.getByTestId('claude-message').filter({ hasText: 'De CI-checks van deze PR zijn gefaald' }).first()).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBeNull()

  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ kind: 'issue', file: '', local: true, body: ANCHOR_BODY })

  // Not the general chat: no "Algemene chat" row appears for it.
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
  await expect(page.getByTestId('block-row').filter({ hasText: 'Algemene chat' })).toHaveCount(0)

  // A refresh does not start another one.
  await page.reload()
  await expect(page.getByTestId('block-column')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(overlay).toBeHidden()
  expect(posts).toHaveLength(1)
})
