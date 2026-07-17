import { test, expect } from './_fixtures.mjs'

// The comment index is scoped to the selected block (and, drilling into the diff,
// to the unit under the selection: call ⊂ line ⊂ group ⊂ block). A diff row that
// carries a comment shows a 💬 marker. See RelatedPanel (visibleComments /
// commentUnder / commentRowSet + the state→cs.scope watch in home.mjs) and
// Block.mjs (paneHTML marker). The selected block is restored from ?sel= on load
// (bindUrlState), so the scoping is exercised deterministically via a deep link.
test.describe('PR Review Tree — comment index scoping', () => {
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

  test('a comment shows only on its own block, with a 💬 on its row', async ({ page }) => {
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

    // The comment index lives in the fixed comments/taken sidebar, toggled with
    // `g` (see detail-layout.md) — it renders nothing (just the collapsed hint
    // rail) until opened.
    const item = page.getByTestId('comments-sidebar').getByTestId('comment-item').filter({ hasText: 'commentaar op mijn blok' })

    // Deep-link to the default (first) block — the comment is on another block, so
    // the block-scoped index does not show it.
    await page.goto('/pr/12903')
    await waitBlock(page, first.label)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('g')
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await expect(item).toHaveCount(0)

    // Deep-link with its block selected — the comment shows, and its diff row
    // carries a 💬 marker.
    await page.goto('/pr/12903?sel=' + encodeURIComponent(mine.fileLine))
    await waitBlock(page, mine.label)
    await page.keyboard.press('Escape')
    await page.keyboard.press('g')
    await expect(item).toHaveCount(1)
    await expect(page.getByTestId('block-column').locator('[data-comment]').first()).toBeVisible()
  })
})
