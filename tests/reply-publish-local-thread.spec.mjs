import { test, expect } from './_fixtures.mjs'

// Replying to a thread that has never touched GitHub (an AI finding, or a
// private "Alleen voor mijzelf" note) first asks what may become public — see
// needsPublishChoice/openPublishMenu + sendPendingReply (RelatedPanel.mjs), the
// 'replyPublish' menu (home.mjs's replyPublishCommandsFor) and
// ReactionSignal.Publish (workflows.go). Local stays the default action, and
// once the thread HAS a GitHub root the question disappears for good: every
// following reply mirrors on its own.
test.describe('Publish a local comment thread to GitHub', () => {
  function selectedCard(page) {
    return page.getByTestId('block-column').locator('article').first()
  }
  // Same seeding shape as convert-warning-to-comment.spec.mjs: an inline-visible
  // AI finding needs a real block of the seeded PR to anchor on.
  async function seedWarning(page, body) {
    const card = selectedCard(page)
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: fileLine.split(':')[0],
        line: 1,
        author: 'AI check',
        body,
        source: 'ai',
        local: true,
        label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(res.ok()).toBeTruthy()
    await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
    await expect(selectedCard(page).locator('h2').first()).toHaveText(label)
    return { label, fileLine }
  }

  async function openThread(page, body) {
    const row = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
  }

  // Types a reply and submits it from the field itself. A reply that actually
  // sends (not just opens the publish menu — see needsPublishChoice) closes
  // the thread back to the diff IMMEDIATELY (optimistic exit, see
  // postThreadReply in RelatedPanel.mjs) — a deliberate, later reversal of
  // "the thread stays open after a reply". `body` re-opens the thread first
  // if an earlier send already closed it.
  async function typeReply(page, body, text) {
    if (!(await page.getByTestId('reaction-compose').count())) await openThread(page, body)
    const field = page.getByTestId('reaction-compose')
    await field.fill(text)
    await field.press('Enter')
  }

  test('the send asks first, and stops asking once the thread is on GitHub', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    const aiBody = 'deze aanroep valideert de invoer niet meer'
    await seedWarning(page, aiBody)
    await openThread(page, aiBody)

    // A first reply, while nothing else was ever written: no history choice yet.
    await typeReply(page, aiBody, 'eerste lokale reactie')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    let rows = menu.getByTestId('command-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(1)).toContainText('Alleen voor mijzelf')
    await expect(rows.nth(2)).toContainText('Alleen mijn antwoord op GitHub')
    await expect(rows.nth(3)).toContainText('Ook de AI-melding op GitHub')
    // The default (2nd item) keeps it local — sending it closes the thread
    // immediately (optimistic exit), so reopen it to verify the reply landed.
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await openThread(page, aiBody)
    await expect(page.getByTestId('comment-thread')).toContainText('eerste lokale reactie')

    // A second reply now has an earlier local message to decide about, so the
    // two GitHub items become submenus.
    await typeReply(page, aiBody, 'tweede reactie, nu publiek')
    await expect(menu).toBeVisible()
    rows = menu.getByTestId('command-row')
    await rows.nth(3).click()
    await expect(menu.getByTestId('command-row').nth(1)).toContainText('Zonder de eerdere 1 bericht')
    await expect(menu.getByTestId('command-row').nth(2)).toContainText('Met de eerdere 1 bericht')
    await menu.getByTestId('command-row').nth(2).click()
    await expect(menu).toHaveCount(0)
    await openThread(page, aiBody)
    await expect(page.getByTestId('comment-thread')).toContainText('tweede reactie, nu publiek')

    // The thread now has a GitHub root (github.Fake answers offline). The
    // workflow records that id asynchronously, so wait for it: it is exactly
    // the "this is a GitHub chat now" marker the UI reads (githubId).
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/comments?pr=12903')
        const list = await res.json()
        const c = list.find((x) => x.body === aiBody)
        return (c && c.githubId) || 0
      })
      .toBeGreaterThan(0)

    // So the next reply goes straight out — no menu at all, and it too
    // closes the thread immediately.
    await typeReply(page, aiBody, 'derde reactie')
    await expect(menu).toHaveCount(0)
    await openThread(page, aiBody)
    await expect(page.getByTestId('comment-thread')).toContainText('derde reactie')
  })

  // Regression: the 'replyPublish' mode had no menuAnchor/menuRegion branch of
  // its own and fell through to the generic diff-row default, which floated
  // this menu over the code being reviewed instead of the comment column it
  // belongs to (see the 'replyPublish' branches in home.mjs and
  // .claude/docs/command-palette.md).
  test('the publish menu is positioned over the comment column, not the diff', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    const aiBody = 'deze functie mist een null-check'
    await seedWarning(page, aiBody)
    await openThread(page, aiBody)

    await typeReply(page, aiBody, 'positioneringstest')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()

    const anchor = page.getByTestId('command-anchor')
    const comments = page.getByTestId('inline-comments')
    const a = await anchor.boundingBox()
    const c = await comments.boundingBox()
    const pane = await page.locator('[data-pane="new"]').first().boundingBox()
    expect(a).toBeTruthy()
    expect(c).toBeTruthy()
    // The menu's left edge sits within the comment column's own width, well
    // clear of the diff's NEW pane to its left.
    expect(a.x).toBeGreaterThanOrEqual(c.x - 10)
    if (pane) expect(a.x).toBeGreaterThanOrEqual(pane.x + pane.width - 10)

    await page.keyboard.press('Enter') // keep it local, the default
    await expect(menu).toHaveCount(0)
  })

  test('Enter on an empty reply field offers to move the existing conversation over', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    const aiBody = 'de nieuwe tak wordt nooit bereikt'
    await seedWarning(page, aiBody)
    await openThread(page, aiBody)

    // One local reply first, so the with/without-history choice applies.
    await typeReply(page, aiBody, 'lokale aantekening')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Enter') // "Alleen voor mijzelf", the default
    await expect(menu).toHaveCount(0)
    // The reply closed the thread immediately (optimistic exit) — reopen it
    // to verify it actually landed, and to reach the empty reply field again.
    await openThread(page, aiBody)
    await expect(page.getByTestId('comment-thread')).toContainText('lokale aantekening')

    // Enter on the now-empty reply field opens the comment menu, which offers
    // the publish item. On an AI finding the default item is "Verwijder
    // comment" (there is no resolve slot, see isAiComment in home.mjs), so
    // this keypress only opens the menu — it never runs anything.
    await page.getByTestId('reaction-compose').press('Enter')
    await expect(menu).toBeVisible()
    const publish = menu.getByTestId('command-row').filter({ hasText: 'Zet op GitHub' })
    await expect(publish).toHaveCount(1)
    await expect(menu).not.toContainText('Resolve comment')
    await expect(menu.getByTestId('command-row').nth(1)).toContainText('Verwijder comment')
    await publish.click()
    await expect(menu.getByTestId('command-row').nth(1)).toContainText('Alleen de AI-melding')
    await menu.getByTestId('command-row').nth(2).click() // met de eerdere 1 bericht
    await expect(menu).toHaveCount(0)

    await expect
      .poll(async () => {
        const res = await page.request.get('/api/comments?pr=12903')
        const list = await res.json()
        const c = list.find((x) => x.body === aiBody)
        return (c && c.githubId) || 0
      })
      .toBeGreaterThan(0)
    // Nothing was added to the thread — publishing is not a message, and
    // publishThreadOnly (unlike postThreadReply) never closes the thread.
    await expect(page.getByTestId('comment-thread')).toContainText('lokale aantekening')
    await expect(page.getByTestId('reaction-compose')).toHaveValue('')
  })
})
