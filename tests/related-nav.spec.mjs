import { test, expect } from './_fixtures.mjs'

// Keyboard navigation into the inline Onderliggende-code card and the fixed
// comments/taken sidebar. From the diff, → selects the related-code block
// (stop 5 of the left→right nav chain, unaffected by the sidebar). The
// comments/taken sidebar is a separate, `g`-toggled overlay (see
// detail-layout.md): `g` opens it on the composer; ↓/↑ cross between the
// comments list and the taken list (stacked vertically); → on a comment opens
// its thread with the reply field focused; ↑ walks up through the old
// messages; ← from *anywhere* in the sidebar exits straight back to the diff
// in one step, and the sidebar stays open. See home.mjs (onKeydown →
// relatedActive/enterRelated/handleRelatedKey/toggleSidebar) and
// RelatedPanel.mjs (the cs.focus/threadPos/sidebarOpen state machine).
test.describe('PR Review Tree — related-panel navigation', () => {
  // stepIntoRelated: from a fresh load (list mode), → steps into the diff, →
  // again hands the keyboard to the inline Onderliggende-code card.
  async function stepIntoRelated(page) {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related-code
  }

  test('g opens the comments sidebar on the composer; ← exits straight back to the diff, sidebar stays open; g toggles it shut', async ({
    page,
  }) => {
    await stepIntoRelated(page)

    // `g` opens the comments/taken sidebar and lands on the "+ Comment op deze
    // regel" button (an empty composer, focused so the reviewer can type
    // straight away) — a deterministic anchor, regardless of where the
    // keyboard was (the diff, or this related-code card).
    await page.keyboard.press('g')
    const sidebar = page.getByTestId('comments-sidebar')
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('new-comment')).toHaveClass(/ring-indigo-300/)
    await expect(page.getByTestId('comment-compose')).toBeFocused()

    // ← exits straight back to the diff in one step — the sidebar stays open.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('new-comment')).not.toHaveClass(/ring-indigo-300/)
    await expect(sidebar).toBeVisible()

    // `g` again — the sidebar is open but the keyboard sits elsewhere (the
    // diff) — re-focuses the composer instead of closing it.
    await page.keyboard.press('g')
    await expect(page.getByTestId('comment-compose')).toBeFocused()

    // `g` once more would type a literal "g" into the now-focused composer
    // (same isEditableFocused guard as `a`, see keyboard-navigation.md) — blur
    // it first (as a click elsewhere/tabbing away would) to exercise the
    // close-from-inside-the-sidebar path without typing into the field.
    await page.evaluate(() => document.activeElement && document.activeElement.blur())
    await page.keyboard.press('g')
    await expect(sidebar).toHaveCount(0)
    await expect(page.getByTestId('sidebar-collapsed')).toBeVisible()
  })

  test('↓ into the comment index, → opens the thread (reply focused), ↑ selects an old message, ← exits to the diff', async ({
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

    // g opens the sidebar on the composer; ↓ steps down into the comment index
    // (the seeded comment). Landing on the comment shows its history and
    // focuses the reply field, so the reviewer can type a reply straight away.
    await page.keyboard.press('g')
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

    // ← from inside the thread exits straight back to the diff in one step —
    // not just one level back to the comment index — and the sidebar stays
    // open (see toggleSidebar/handleRelatedKey).
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await expect(page.getByTestId('comment-item').first()).not.toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('reaction-compose')).not.toBeFocused()
  })
})
