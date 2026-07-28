import { test, expect } from './_fixtures.mjs'

// Block-scoped comments (task_code_comment workflow) render as their own
// inline blocks, directly above the Onderliggende-code card — not a browsable,
// unscoped index. They are scoped to the selected block (and, in the diff, to
// the unit under the selection: call ⊂ line ⊂ group ⊂ block — see
// RelatedPanel's visibleComments/commentUnder/commentRowSet + the
// state→cs.scope watch in home.mjs). A diff row that carries a comment shows
// a 💬 marker (Block.mjs's paneHTML). Per conversation, exactly one card:
// several threads on the same unit each get their own, compact card, and only
// the one currently focused/selected expands to its full thread. See
// detail-layout.md ("Inline comment blocks").
test.describe('PR Review Tree — inline comment blocks', () => {
  async function ready(page) {
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  }
  // selectedCard is the selected block's card (the first card in the column).
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
  // waitBlock waits until the selected card is the block `label` (used after a
  // deep link restores ?sel=, which may select a non-first row).
  async function waitBlock(page, label) {
    await expect(selectedCard(page).locator('h2').first()).toHaveText(label)
  }

  test('a comment shows only as an inline block on its own block, with a 💬 on its row', async ({ page }) => {
    // Discover a block other than the first (so this spec never pollutes the first
    // block other 12903 specs select by default) and remember its file:line ref
    // (?sel= carries the block's `file:line`, not its index — see CLAUDE.md).
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)
    for (let i = 0; i < 12; i++) {
      if ((await ident(page)).label !== first.label) break
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(120)
    }
    const mine = await ident(page)
    expect(mine.label).not.toBe(first.label)

    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: mine.file,
        line: 1,
        author: 'reviewer',
        body: 'commentaar op mijn blok',
        label: mine.label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(res.ok()).toBeTruthy()

    const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: 'commentaar op mijn blok' })

    // Deep-link to the default (first) block — the comment is on another
    // block, so it never shows as an inline block there.
    await page.goto('/pr/12903')
    await waitBlock(page, first.label)
    await expect(item).toHaveCount(0)

    // Deep-link with its own block selected — the comment shows as an inline
    // card, and its diff row carries a 💬 marker.
    await page.goto('/pr/12903?sel=' + encodeURIComponent(mine.fileLine))
    await waitBlock(page, mine.label)
    await expect(item).toHaveCount(1)
    await expect(page.getByTestId('block-column').locator('[data-comment]').first()).toBeVisible()
  })

  test('resolving a comment removes its 💬 marker', async ({ page }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    const created = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: first.file,
        line: 1,
        author: 'reviewer',
        body: 'resolve me',
        label: first.label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(created.ok()).toBeTruthy()
    const { runId } = await created.json()
    expect(runId).toBeTruthy()

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    const marker = page.getByTestId('block-column').locator('[data-comment]').first()
    await expect(marker).toBeVisible()

    const resolved = await page.request.post(`/api/workflows/${runId}/signals/reply`, {
      data: { author: 'reviewer', body: 'klaar', done: true },
    })
    expect(resolved.ok()).toBeTruthy()

    // syncComments polls cs.list; the marker disappears reactively once it refetches.
    await expect(marker).toBeHidden({ timeout: 15000 })
  })

  test('multiple conversations on the same unit each get their own card; only the focused one expands', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    // Two separate conversations, same block, same (whole-block) anchor.
    const bodies = ['eerste conversatie', 'tweede conversatie']
    for (const body of bodies) {
      const res = await page.request.post('/api/workflows/task_code_comment', {
        data: { pr: 12903, file: first.file, line: 1, author: 'reviewer', body, label: first.label, rowStart: -1, rowEnd: -1 },
      })
      expect(res.ok()).toBeTruthy()
    }

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    const items = page.getByTestId('inline-comments').getByTestId('comment-item')
    await expect(items).toHaveCount(2)
    // Neither is focused yet — both render compact.
    await expect(items.nth(0)).toHaveAttribute('data-expanded', 'false')
    await expect(items.nth(1)).toHaveAttribute('data-expanded', 'false')

    // Clicking the second expands only that one; the first stays compact.
    await items.nth(1).click()
    await expect(items.nth(0)).toHaveAttribute('data-expanded', 'false')
    await expect(items.nth(1)).toHaveAttribute('data-expanded', 'true')
    await expect(items.nth(1).getByTestId('comment-thread')).toContainText('tweede conversatie')

    // Clicking the first expands it instead and collapses the second again.
    await items.nth(0).click()
    await expect(items.nth(0)).toHaveAttribute('data-expanded', 'true')
    await expect(items.nth(1)).toHaveAttribute('data-expanded', 'false')
    await expect(items.nth(0).getByTestId('comment-thread')).toContainText('eerste conversatie')
  })

  test('the expanded thread has no internal height cap — a long conversation is never clipped', async ({ page }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    const created = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file: first.file, line: 1, author: 'reviewer', body: 'lange conversatie', label: first.label, rowStart: -1, rowEnd: -1 },
    })
    expect(created.ok()).toBeTruthy()
    const { runId } = await created.json()
    expect(runId).toBeTruthy()

    // Enough replies to make the thread taller than the old max-h-64 (16rem/256px) cap.
    for (let i = 0; i < 15; i++) {
      const res = await page.request.post(`/api/workflows/${runId}/signals/reply`, {
        data: { author: 'bogsat', body: 'reactie nummer ' + i, done: false },
      })
      expect(res.ok()).toBeTruthy()
    }

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: 'lange conversatie' })
    await item.click()
    await expect(item).toHaveAttribute('data-expanded', 'true')

    const thread = item.getByTestId('comment-thread')
    const lastBubble = thread.getByTestId('reaction-bubble').last()
    await expect(lastBubble).toContainText('reactie nummer 14')

    // No internal clipping: the thread's content height fits its own box (no
    // overflow beyond it — height simply grows with the conversation).
    const overflow = await thread.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(overflow).toBe(0)

    // The last message is fully visible without any scroll action.
    await expect(lastBubble).toBeInViewport()
  })
})
