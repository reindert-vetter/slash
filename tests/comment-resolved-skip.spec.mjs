import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// → from the diff normally lands on the FIRST comment conversation of the
// selected unit (enterCommentsHead, cs.sel = 0 — see related-nav.spec.mjs).
// enterCommentsOrRelated (RelatedPanel.mjs) refines that one step: when THAT
// default comment is already resolved, → skips it — to the next still-open
// comment on the same unit if one exists, else to Underlying code if this
// unit has any, else (nothing else to land on) the resolved comment anyway.
// See "→ skips an already-resolved default comment" in
// .claude/docs/comments-panel.md.
//
// Reuses the shared anchor PR 12903 (its comments are wiped before every
// test, see _cleanApprovals in _fixtures.mjs). Blocks are selected by label,
// not by raw index — see "Sort order of the left list" in
// blocks-and-ingest.md: CreatePaymentAction::execute carries the
// GroupScopeChildA/B relation children, ContractController::index carries
// none (see materializeMainWorktrees/relations.json in _setup.mjs).
test.describe('PR Review Tree — → skips an already-resolved default comment', () => {
  test('→ skips a resolved default comment straight to the next open one', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

    // Comment A, placed first (so it lands at index 0 — see loadComments'
    // ordering) and immediately resolved via the sanctioned "/resolve"
    // sentinel Signal.
    const startA = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'comment A (resolved)', label, rowStart: -1, rowEnd: -1 },
    })
    const runIdA = (await startA.json()).runId
    expect(runIdA).toBeTruthy()
    await page.request.post('/api/workflows/' + encodeURIComponent(runIdA) + '/signals/reply', {
      data: { author: 'reviewer', body: '/resolve', done: true },
    })

    // Comment B, placed after — still open.
    const startB = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'comment B (open)', label, rowStart: -1, rowEnd: -1 },
    })
    const runIdB = (await startB.json()).runId
    expect(runIdB).toBeTruthy()

    // Wait until the read model shows both, A resolved.
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        const a = list.find((x) => x.runId === runIdA)
        return a ? a.status : null
      })
      .toBe('resolved')

    await page.goto('/pr/12903')
    await page.locator('[data-idx]').filter({ hasText: label }).first().click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → the comment stop

    const inlineComments = page.getByTestId('inline-comments')
    // Only ONE card is rendered: the landing comment B, with the resolved
    // comment A above it hidden behind the "1 hierboven" hint (see "The
    // selected conversation hides the ones above it" in
    // .claude/docs/comments-panel.md).
    await expect(inlineComments.getByTestId('comment-item')).toHaveCount(1)
    await expect(page.getByTestId('comment-more-above')).toContainText('1 hierboven')
    // The expanded card is comment B's — comment A (resolved, index 0) was
    // skipped straight past.
    const expandedCard = inlineComments.locator('[data-testid="comment-item"][data-expanded="true"]')
    await expect(expandedCard).toHaveCount(1)
    await expect(expandedCard).toContainText('comment B (open)')
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
  })

  test('→ skips a lone resolved comment straight to Underlying code when the unit has related children', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'the only comment (resolved)', label, rowStart: -1, rowEnd: -1 },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'reviewer', body: '/resolve', done: true },
    })
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        const c = list.find((x) => x.runId === runId)
        return c ? c.status : null
      })
      .toBe('resolved')

    await page.goto('/pr/12903')
    await page.locator('[data-idx]').filter({ hasText: label }).first().click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → skips the resolved comment, lands on Underlying code

    const relFoc = () => new URL(page.url()).searchParams.get('rel.foc')
    await expect.poll(relFoc).toBe('code')
    await expect(page.getByTestId('related-code').getByTestId('related-item').first()).toHaveAttribute('data-active', 'true')
  })

  test('→ still lands on a lone resolved comment when there is nothing else to land on', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'ContractController::index' }).click()
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'the only comment (resolved)', label, rowStart: -1, rowEnd: -1 },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'reviewer', body: '/resolve', done: true },
    })
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        const c = list.find((x) => x.runId === runId)
        return c ? c.status : null
      })
      .toBe('resolved')

    await page.goto('/pr/12903')
    await page.locator('[data-idx]').filter({ hasText: label }).first().click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → the resolved comment (nothing else to land on)

    const inlineComments = page.getByTestId('inline-comments')
    const expandedCard = inlineComments.locator('[data-testid="comment-item"][data-expanded="true"]')
    await expect(expandedCard).toHaveCount(1)
    await expect(expandedCard).toContainText('the only comment (resolved)')
  })
})
