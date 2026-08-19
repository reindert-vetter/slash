import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request: "als ik in een tree ben en ik ga naar blokken index, en
// ik heb dan niks geselecteerd omdat er iets weg is (omdat ik aan het kijken
// was dieper in de code, maar comment is goedgekeurd ofzo), dan wil ik niet
// niks selecteren in de blokken index, selecteer dan de eerste in de blokken
// index".
//
// recomputeLeftList (home.mjs) preserves the current selection by stable ID
// across a reindex (see "snapshot a selection by stable ID" in
// .claude/rules/conventions.md) — but when that id is genuinely GONE (here: a
// resolved block-anchored comment drops out of indexComments entirely, see
// its own doc comment in RelatedPanel.mjs) it used to fall back to
// `Math.min(state.selected, blocks.length - 1)` — the stale RAW INDEX clamped
// into the new, shorter list. That lands on whatever now happens to sit at
// that position: an arbitrary leftover, not a real selection, and often
// scrolled out of view — which is exactly what read as "nothing selected".
// Fixed to reset to the first row instead, mirroring setSearch's own
// `state.selected = 0` after a filter change.
function mockAnchoredComment(page) {
  const now = new Date().toISOString()
  const state = {
    comments: [
      {
        id: 'anchor-1',
        runId: 'run-anchor-1',
        pr: 12903,
        file: 'app/Actions/CreatePaymentAction.php',
        label: 'CreatePaymentAction::execute',
        line: 30,
        author: 'reviewer',
        body: 'please rename this variable',
        createdAt: now,
        reactionCount: 0,
        status: 'open',
        source: 'ui',
        kind: '',
        reactions: [],
        rowStart: -1,
        rowEnd: -1,
      },
    ],
  }
  const ready = page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.comments) }),
  )
  return Object.assign(ready, { serve: (next) => (state.comments = next) })
}

test('a resolved comment that was deep-drilled-into falls back to the first row, not an arbitrary one', async ({
  page,
}) => {
  const mock = mockAnchoredComment(page)
  await mock
  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  // Select the comment (auto-drills its own anchor open) and step deep into
  // it: first ArrowRight reveals the diff, second hands the keyboard into the
  // related panel — "aan het kijken dieper in de code".
  const row = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
  await row.click()
  await expect(page.getByTestId('drill-column')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)

  // "comment is goedgekeurd ofzo" — resolved elsewhere (e.g. someone else on
  // GitHub) while the reviewer is deep in the drilled column; the comment
  // poll (every 5s, RelatedPanel.mjs) picks it up on its own, no reload.
  mock.serve([])
  await page.waitForTimeout(5500)

  // The comment's own drilled column auto-closes (it's no longer anchored to
  // anything) and the reviewer lands back on the blocks index — WITH a real
  // selection, not nothing.
  await expect(page.getByTestId('pr-index')).toBeVisible()
  await expect(page).not.toHaveURL(/mode=diff/)
  const selectedRow = page.locator('[data-idx].bg-indigo-50')
  await expect(selectedRow).toHaveCount(1)
  await expect(selectedRow).toHaveAttribute('data-idx', '0')
})
