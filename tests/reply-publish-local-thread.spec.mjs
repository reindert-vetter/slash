import { test, expect } from './_fixtures.mjs'

// Replying to a thread that has never touched GitHub (an AI finding, or a
// private note seeded directly via the API) first asks what may become
// public — see needsPublishChoice/openPublishMenu + sendPendingReply
// (RelatedPanel.mjs), the 'replyPublish' menu (home.mjs's
// replyPublishCommandsFor) and ReactionSignal.Publish (workflows.go). There
// used to be a third, DEFAULT "Alleen voor mijzelf (blijft lokaal)" item that
// kept the reply local; it was removed on request (same kind of removal as
// the compose menu's own local item — see replyPublishCommandsFor's doc
// comment), so the menu now only ever offers a GitHub destination, and
// "Alleen mijn antwoord op GitHub" is the new default. Once the thread HAS a
// GitHub root the question disappears for good: every following reply
// mirrors on its own.
//
// Each test only waits for `block-column` to render before seeding, rather
// than asserting the sidebar's first `block-row` is the selected one — that
// assumption broke separately (across ~20 unrelated specs, not just this
// file) once applyDefaultUnapprovedSelection started tie-breaking by
// (file, line) instead of array order (see the "Land a fresh PR open on…"
// commit), which is outside the scope of this change.
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
    const runId = (await res.json()).runId
    await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
    await expect(selectedCard(page).locator('h2').first()).toHaveText(label)
    return { label, fileLine, runId }
  }

  // Adds an earlier local reply directly via the reply Signal, bypassing the
  // (now GitHub-only) publish menu — the only way left to build up an earlier
  // local message on a still-local thread, needed to reach the with/without-
  // history submenu below.
  async function seedLocalReply(page, runId, body) {
    const res = await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'reviewer', body, done: false },
    })
    expect(res.ok()).toBeTruthy()
  }

  async function openThread(page, body) {
    // The thread no longer collapses after a reply (see typeReply's own doc
    // comment), so once its reply field is already on screen there is
    // nothing left to reopen — just re-focus the field directly.
    const compose = page.getByTestId('reaction-compose')
    if (await compose.count()) {
      await compose.click()
      await expect(compose).toBeFocused()
      return
    }
    const row = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
  }

  // Types a reply and submits it from the field itself. A reply that
  // actually sends (not just opens the publish menu — see
  // needsPublishChoice) no longer opens any action menu (see "A reply no
  // longer auto-opens the comment's own menu" in comments-panel.md) — the
  // thread just stays expanded underneath. `body` re-opens the thread first
  // if it isn't already open.
  async function typeReply(page, body, text) {
    if (!(await page.getByTestId('reaction-compose').count())) await openThread(page, body)
    const field = page.getByTestId('reaction-compose')
    await field.fill(text)
    await field.press('Enter')
  }

  test('the send asks first (GitHub-only), and stops asking once the thread is on GitHub', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    const aiBody = 'deze aanroep valideert de invoer niet meer'
    await seedWarning(page, aiBody)
    await openThread(page, aiBody)

    // A first reply, while nothing else was ever written: no history choice
    // yet, and no local item any more — just the two GitHub destinations.
    await typeReply(page, aiBody, 'eerste reactie')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = menu.getByTestId('command-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).toContainText('Alleen mijn antwoord op GitHub')
    await expect(rows.nth(2)).toContainText('Ook de AI-melding op GitHub')
    // The default (2nd item) publishes just the typed reply as the thread's
    // new GitHub root — sending it opens no action menu anymore, and the
    // thread stays expanded so the reply is visible right away.
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('comment-thread')).toContainText('eerste reactie')

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

    // So the next reply goes straight out — no PUBLISH-choice menu at all,
    // and still no action menu afterward.
    await typeReply(page, aiBody, 'tweede reactie')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(page.getByTestId('comment-thread')).toContainText('tweede reactie')
  })

  test('an earlier local reply offers a with/without-history choice when publishing', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    const aiBody = 'deze query is niet geindexeerd'
    const { runId } = await seedWarning(page, aiBody)
    await seedLocalReply(page, runId, 'eerste lokale reactie')

    await openThread(page, aiBody)
    await expect(page.getByTestId('reaction-bubble')).toHaveCount(2)

    // A second reply now has an earlier local message to decide about, so the
    // two GitHub items grow a with/without-history submenu.
    await typeReply(page, aiBody, 'tweede reactie, nu publiek')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    let rows = menu.getByTestId('command-row')
    await expect(rows).toHaveCount(3)
    await rows.nth(2).click()
    await expect(menu.getByTestId('command-row').nth(1)).toContainText('Zonder de eerdere 1 bericht')
    await expect(menu.getByTestId('command-row').nth(2)).toContainText('Met de eerdere 1 bericht')
    await menu.getByTestId('command-row').nth(2).click()
    // The submenu's own selection sends — no action menu opens afterward,
    // the thread just stays expanded.
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('comment-thread')).toContainText('eerste lokale reactie')
    await expect(page.getByTestId('comment-thread')).toContainText('tweede reactie, nu publiek')

    await expect
      .poll(async () => {
        const res = await page.request.get('/api/comments?pr=12903')
        const list = await res.json()
        const c = list.find((x) => x.body === aiBody)
        return (c && c.githubId) || 0
      })
      .toBeGreaterThan(0)
  })

  // Regression: the 'replyPublish' mode had no menuAnchor/menuRegion branch of
  // its own and fell through to the generic diff-row default, which floated
  // this menu over the code being reviewed instead of the comment column it
  // belongs to (see the 'replyPublish' branches in home.mjs and
  // .claude/docs/command-palette.md).
  test('the publish menu is positioned over the comment column, not the diff', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
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

    await page.keyboard.press('Enter') // publish just the reply, the default
    // The send completes and opens no action menu anymore — this test only
    // cares about the PUBLISH-choice menu's own position, asserted above.
    await expect(menu).toHaveCount(0)
  })

  test('Enter on an empty reply field offers to move the existing conversation over, then returns to the diff', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    const aiBody = 'de nieuwe tak wordt nooit bereikt'
    const { runId } = await seedWarning(page, aiBody)

    // An earlier local reply, seeded directly (the publish menu no longer
    // has a "stay local" item), so the with/without-history choice applies.
    await seedLocalReply(page, runId, 'lokale aantekening')
    await openThread(page, aiBody)
    await expect(page.getByTestId('comment-thread')).toContainText('lokale aantekening')

    // Enter on the empty reply field opens the comment menu, which offers
    // the publish item. On an AI finding the default item is "Verwijder
    // comment" (there is no resolve slot, see isAiComment in home.mjs), so
    // this keypress only opens the menu — it never runs anything.
    const menu = page.getByTestId('command-menu')
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
    // Nothing was added to the thread — publishing is not a message. But
    // unlike the earlier "publishThreadOnly never closes the thread"
    // decision this test used to cover, it now DOES hand the keyboard back
    // to the diff row the thread was anchored to (publishThreadAndSelectRow,
    // home.mjs) — reviewer request: "na ai warning, zet op github, laat mij
    // verder navigeren door code" — the same landing deleteCommentAndSelectRow
    // already does for a delete.
    await expect(page.getByTestId('comment-thread')).toHaveCount(0)
    await expect(page.getByTestId('reaction-compose')).toHaveCount(0)
    // The thread itself still exists (it was published, not deleted) — its
    // compact row is still listed among the block's inline comments.
    await expect(
      page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: aiBody }),
    ).toBeVisible()
  })
})
