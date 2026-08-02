import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// "Comment hiervan maken" turns an AI-authored finding (code_warning,
// source:'ai') into a real, reviewer-owned comment the reviewer can edit
// before it's placed — see convertWarningToComment/
// convertPrWideWarningToComment (RelatedPanel.mjs), the new
// commentCommandsFor/prCommentCommandsFor menu items (home.mjs), and
// detail-layout.md ("Inline comment blocks"/"Comment-index items"). The
// original finding is only deleted once the replacement is confirmed placed
// (via the existing delete Signal, never a direct write).
test.describe('Convert an AI-controle finding into a real comment', () => {
  // selectedCard/ident/waitBlock mirror inline-comments.spec.mjs — the
  // anchored flow needs a real PR block to seed a matching, inline-visible
  // AI comment on (an unseeded PR has none, so placeComment's own `!b` guard
  // would no-op the whole conversion).
  function selectedCard(page) {
    return page.getByTestId('block-column').locator('article').first()
  }
  async function ident(page) {
    const card = selectedCard(page)
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
    return { label, file: fileLine.split(':')[0], fileLine }
  }
  async function waitBlock(page, label) {
    await expect(selectedCard(page).locator('h2').first()).toHaveText(label)
  }

  test('an anchored finding: the composer opens prefilled, and placing it deletes the original', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    const mine = await ident(page)

    const aiBody = 'deze aanroep valideert de invoer niet meer sinds de wijziging'
    const seeded = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: mine.file,
        line: 1,
        author: 'AI check',
        body: aiBody,
        source: 'ai',
        local: true,
        label: mine.label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(seeded.ok()).toBeTruthy()
    const { runId } = await seeded.json()
    expect(runId).toBeTruthy()

    await page.goto('/pr/12903?sel=' + encodeURIComponent(mine.fileLine))
    await waitBlock(page, mine.label)

    const row = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: aiBody })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('comment-ai-warning')).toBeVisible()
    await row.click()
    await expect(page.getByTestId('reaction-compose')).toBeFocused()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = menu.getByTestId('command-row')
    // "Sluit menu", "Resolve comment" (default), "Verwijder comment", "Comment
    // hiervan maken" — no "Open op GitHub" (a Local:true finding never posts).
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(1)).toContainText('Resolve comment')
    await expect(rows.nth(3)).toContainText('Comment hiervan maken')
    await rows.nth(3).click()
    await expect(menu).toHaveCount(0)

    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeVisible()
    await expect(composer).toHaveValue(aiBody)
    await expect(page.getByTestId('comment-composer')).toContainText('Comment van AI-controle')

    const editedBody = 'graag hier alsnog invoervalidatie toevoegen, zie ook de teststub'
    await composer.fill(editedBody)
    await page.getByTestId('comment-send').click()
    const composeMenu = page.getByTestId('command-menu')
    await expect(composeMenu).toBeVisible()
    // "Plaats comment" is the default (2nd row, after "Sluit menu") — a
    // public, non-local comment, exactly what "als échte comment plaatst" asks.
    await expect(composeMenu.getByTestId('command-row').nth(1)).toContainText('Plaats comment')
    await page.keyboard.press('Enter')
    await expect(composeMenu).toHaveCount(0)

    // The edited text becomes a real comment...
    await expect(page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: editedBody })).toBeVisible()
    // ...and the original AI finding is gone, everywhere — not just from view.
    await expect(page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: aiBody })).toHaveCount(0)

    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    expect(list.some((c) => c.id === runId)).toBe(false)
    const created = list.find((c) => c.body === editedBody)
    expect(created).toBeTruthy()
    expect(created.source).not.toBe('ai')
    expect(created.local).toBeFalsy()
    // The replacement keeps the ORIGINAL finding's own anchor, not whatever
    // the cursor happened to sit on afterwards.
    expect(created.label).toBe(mine.label)
    expect(created.file).toBe(mine.file)
    expect(created.gran).toBe('group')
    expect(created.rowStart).toBe(0)
    expect(created.rowEnd).toBe(0)
  })

  // A PR-wide (unanchored, kind:'ai_warning') finding has no diff/block
  // context to reuse — it repurposes its own reply field (startPrCommentConvert)
  // instead of the block composer, and the replacement becomes a brand-new,
  // unanchored PR-wide comment (Kind "issue") rather than a reply on the old
  // thread. No real PR blocks are needed for this: PR-wide comment-index
  // items render independently of state.blocks (recomputeLeftList). Its own
  // allocated PR (seededPr) so the exact comment counts below can never see
  // another spec's — or an earlier retry's — leftovers.
  test('a PR-wide finding: converting posts a brand-new PR-wide comment and removes the finding', async ({
    page,
  }, testInfo) => {
    const PR_WIDE = seededPr(testInfo)
    const aiBody = 'deze workflow schrijft ongevalideerde input naar de omgevingsvariabelen'
    const seeded = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: PR_WIDE,
        file: '.github/workflows/release.yml',
        line: 42,
        author: 'AI check',
        body: aiBody,
        source: 'ai',
        local: true,
        kind: 'ai_warning',
      },
    })
    expect(seeded.ok()).toBeTruthy()
    const { runId } = await seeded.json()
    expect(runId).toBeTruthy()

    await page.goto('/pr/' + PR_WIDE)
    await leaveSearchBox(page)
    await expect(page.getByTestId('comment-detail-card')).toContainText(aiBody)
    await expect(page.getByTestId('comment-detail-card').getByTestId('comment-ai-warning')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = menu.getByTestId('command-row')
    // "Sluit menu", "Beantwoorden" (default), "Resolve comment", "Comment
    // hiervan maken", "Ignore".
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(1)).toContainText('Beantwoorden')
    await expect(rows.nth(3)).toContainText('Comment hiervan maken')
    await rows.nth(3).click()
    await expect(menu).toHaveCount(0)

    const reply = page.getByTestId('comment-detail-reply')
    await expect(reply).toBeFocused()
    await expect(reply).toHaveValue(aiBody)

    const editedBody = 'laten we hier een onvoorspelbare delimiter gebruiken in plaats van EOF'
    await reply.fill(editedBody)
    await page.getByTestId('comment-detail-send').click()

    // The edited text becomes its own, brand-new "Start" row...
    await expect(page.getByTestId('block-row').filter({ hasText: editedBody.slice(0, 30) })).toBeVisible()
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + PR_WIDE)).json()
        return list.find((c) => c.body === editedBody)
      })
      .toBeTruthy()
    const list = await (await page.request.get('/api/comments?pr=' + PR_WIDE)).json()
    const created = list.find((c) => c.body === editedBody)
    expect(created.kind).toBe('issue')
    expect(created.source).not.toBe('ai')
    expect(created.local).toBeFalsy()

    // ...and the original finding is gone. Deliberately its OWN poll rather
    // than a check against the snapshot above: placeComment only fires the
    // finding's delete Signal AFTER the replacement is confirmed placed (see
    // "Converting an AI-controle finding into a real comment" in
    // detail-layout.md), and that Signal then travels through the finding's own
    // task_code_comment Execution (status 'deleting' → read-model row removed).
    // So the removal always lands strictly later than the creation this test
    // just polled for — asserting both against one fetch was a race, and did
    // flake.
    await expect
      .poll(async () => {
        const rows = await (await page.request.get('/api/comments?pr=' + PR_WIDE)).json()
        return rows.some((c) => c.id === runId)
      })
      .toBe(false)
  })
})
