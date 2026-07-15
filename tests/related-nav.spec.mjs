import { test, expect } from './_fixtures.mjs'

// Keyboard navigation into the right-hand Related panel. From the diff, → selects
// the related-code block; → again jumps to the "+ Comment op deze regel" button,
// then ↓ walks into the comment index; → on a comment opens its thread with the
// reply field focused; ↑ walks up through the old messages. ← / Esc step back out.
// See home.mjs (onKeydown → relatedActive/enterRelated/handleRelatedKey) and
// RelatedPanel.mjs (the cs.focus/threadPos state machine).
test.describe('PR Review Tree — related-panel navigation', () => {
  // stepIntoRelated: from a fresh load (list mode), → steps into the diff, → again
  // hands the keyboard to the panel on the related-code block.
  async function stepIntoRelated(page) {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related panel
  }

  test('→ selects the related block (light blue), → opens the new-comment composer, ← exits', async ({
    page,
  }) => {
    await stepIntoRelated(page)

    // The related-code card itself has no outer focus border (that container
    // border was removed so children read as loose blocks, see RelatedPanel.mjs);
    // focus moving through it is instead observed via the new-comment composer
    // it hands off to below.

    // → moves focus to the "+ Comment op deze regel" button (indigo focus ring).
    // Landing there opens an empty new-comment composer and focuses it, so the
    // reviewer can type straight away. (↓/↑ now walk the code list instead.)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('new-comment')).toHaveClass(/ring-indigo-300/)
    await expect(page.getByTestId('comment-compose')).toBeFocused()

    // ↑ walks back up to the related block, closing the composer again.
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('new-comment')).not.toHaveClass(/ring-indigo-300/)

    // ← releases the keyboard back to the diff.
    await page.keyboard.press('ArrowLeft')
  })

  test('↓ into the comment index, → opens the thread (reply focused), ↑ selects an old message', async ({
    page,
  }) => {
    // The comment index is scoped to the selected block, so seed the comment on
    // whatever block loads first — read its file/label from the card. An unknown
    // row anchor (rowStart -1) means "block-level", so it shows for that block
    // whatever unit is selected. Writes still go through the workflow endpoints
    // (start + reply signal), so the write-boundary holds.
    await page.goto('/pr/12903')
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'eerste comment', label, rowStart: -1, rowEnd: -1 },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    // Add an old message (reaction) to the thread.
    await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'claude', body: 'oud bericht', done: false },
    })
    // Wait until the read-model shows *this* comment (by runId — other specs seed
    // on 12903 in parallel, so it isn't necessarily list[0]) with its reaction.
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        const c = list.find((x) => x.runId === runId)
        return c ? (c.reactions || []).length : 0
      })
      .toBeGreaterThan(0)

    await stepIntoRelated(page)

    // → then ↓ : related block → new-comment button → the first comment in the
    // index. Landing on the comment shows its history and focuses the reply field,
    // so the reviewer can type a reply straight away.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('comment-item').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('reaction-compose')).toBeFocused()

    // → steps into the thread (so ↑ now walks the old messages); ↑ highlights the
    // newest message (the reaction, last bubble — the comment's own body is the
    // first bubble above it) and drops the reply-field focus.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('reaction-bubble').last()).toHaveClass(/ring-indigo-400/)
    await expect(page.getByTestId('reaction-compose')).not.toBeFocused()
    // ↑ again reaches the opening message (the comment body itself).
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('reaction-bubble').first()).toHaveClass(/ring-indigo-400/)
    await expect(page.getByTestId('reaction-bubble').first()).toContainText('eerste comment')

    // ← steps back out of the thread to the comment index — reply focused again.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('comment-item').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
  })
})
