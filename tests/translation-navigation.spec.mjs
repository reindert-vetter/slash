import { test, expect } from './_fixtures.mjs'

// Per-key navigation/approve/comment for a TRANSLATION block (PR 107, see
// translation.spec.mjs for the render-only coverage of the same fixture).
// resources/lang/nl/checkout.php changes exactly 3 keys — 'foo' (changed,
// oud -> nieuw), 'extra' (added) and 'weg' (removed) — in that order
// (translationChangeUnits: changed, then added, then removed — see
// translationDiff.mjs). Note: 'extra'/'weg' sit on ADJACENT lines in both
// file versions (materializeTranslationWorktrees, tests/_setup.mjs), so the
// generic line-aligner (alignRows) pairs the removed 'weg' line and the
// added 'extra' line into ONE row — the SAME "adjacent add+remove merges
// into one row" behaviour any ordinary code block already has. Per decision
// 4 (blocks-and-ingest.md), per-key approve deliberately rides on that
// EXISTING row-based counter as-is (no parallel/Go-side count), so the
// approve total here is 2, not 3 — this test picks 'foo' (its own,
// unshared row) to demonstrate a clean single-key approve.
// enterDiffAndSettle presses Escape (leave the auto-focused search box) then
// ArrowRight (list -> diff) and waits for the DIFF-MODE-SPECIFIC "diffActive"
// card border (border-indigo-300, see Block.mjs/diffActive) to actually
// appear before returning. The ?sel= URL restore (applyBlockRefRestore) and
// enterDiff() itself are async/microtask-deferred, so firing a SECOND key
// right after ArrowRight without settling on this can race: the translation
// row's own highlight is a weaker signal here, since it *also* shows the
// first unit as "active" in list-mode preview (groupsFor's fallback) — this
// border only ever appears once state.mode is really 'diff'.
async function enterDiffAndSettle(page) {
  // Wait for the block's own key overview to be on screen first: enterDiff()
  // reads the SELECTED block (curBlock()) and silently no-ops while
  // state.blocks is still empty, so pressing ArrowRight straight after the
  // goto() can land before loadBlocks/applyBlockRefRestore have run — the
  // keypress is then simply swallowed and mode never becomes 'diff' (the
  // border below then never appears, whatever we wait for afterwards).
  await expect(page.getByTestId('translation-row').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-testid="detail-card"] article').first()).toHaveClass(/border-indigo-300/)
}

test.describe('TRANSLATION block — per-key navigation/approve/comment', () => {
  test('↑/↓ moves the highlight per key', async ({ page }) => {
    await page.goto('/pr/107?sel=' + encodeURIComponent('resources/lang/nl/checkout.php:1'))
    await enterDiffAndSettle(page)

    const rows = page.getByTestId('translation-row')
    await expect(rows).toHaveCount(3)

    // Lands on the first unit: the changed key 'foo'.
    await expect(rows.nth(0)).toHaveAttribute('data-active', '1')
    await expect(rows.nth(0)).toContainText('foo')

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(0)).toHaveAttribute('data-active', '0')
    await expect(rows.nth(1)).toHaveAttribute('data-active', '1')
    await expect(rows.nth(1)).toContainText('extra')

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(2)).toHaveAttribute('data-active', '1')
    await expect(rows.nth(2)).toContainText('weg')

    // f/d/s are a deliberate no-op for a TRANSLATION block (no group/line/
    // call zoom, see setGran's TRANSLATION guard in home.mjs) — same 3 keys,
    // same active row, unchanged.
    await page.keyboard.press('f')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(2)).toHaveAttribute('data-active', '1')

    // ArrowDown clamps at the last key (no same-file neighbour block here).
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(2)).toHaveAttribute('data-active', '1')

    await page.keyboard.press('ArrowUp')
    await expect(rows.nth(1)).toHaveAttribute('data-active', '1')
  })

  // The companion card's own fetch (GET /api/langsiblings) + re-render has a
  // separate, pre-existing timing gap (ensureLangSiblings/companionCard, see
  // blocks-and-ingest.md) — occasionally slower to reflect than the rest of
  // this feature, unrelated to per-key navigation itself (which the test
  // above already covers on its own). Kept as its own test so that gap can
  // never flake the core per-key nav/approve/comment coverage.
  test('the en companion card mirrors the same per-key highlight', async ({ page }) => {
    await page.goto('/pr/107?sel=' + encodeURIComponent('resources/lang/nl/checkout.php:1'))
    await enterDiffAndSettle(page)

    const rows = page.getByTestId('translation-row')
    const companionRows = page.getByTestId('translation-sibling-row')
    await expect(companionRows).toHaveCount(3)
    const companionRow = (key) => companionRows.filter({ hasText: key })
    await expect(companionRow('foo')).toHaveAttribute('data-active', '1')
    await expect(companionRow('extra')).toHaveAttribute('data-active', '0')

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('data-active', '1')
    await expect(companionRow('foo')).toHaveAttribute('data-active', '0')
    await expect(companionRow('extra')).toHaveAttribute('data-active', '1')

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(2)).toHaveAttribute('data-active', '1')
    await expect(companionRow('weg')).toHaveAttribute('data-active', '1')
    // 'weg' doesn't exist in en (it's an nl-only removal) — the companion
    // still shows the row, with the "missing" marker instead of a value.
    await expect(companionRow('weg')).toContainText('ontbreekt in en')
  })

  test('approving the focused key closes exactly one unit of the existing approve counter', async ({ page }) => {
    await page.goto('/pr/107?sel=' + encodeURIComponent('resources/lang/nl/checkout.php:1'))
    await enterDiffAndSettle(page)

    // 'weg'/'extra' share one aligned row (see the test-file header comment
    // above), so the block's total is 2, not 3 — 'foo' (index 0, focused by
    // default) has its own row, so approving it in isolation demonstrates a
    // clean single-key approve against that existing counter.
    await expect(page.getByText('approve 0/2')).toBeVisible()
    await expect(page.getByTestId('translation-row').nth(0)).toContainText('foo')

    // Enter opens the block command palette; "Keur ... goed" is the default
    // (2nd) item (see COMMANDS/withClose in home.mjs) — a plain Enter,Enter
    // approves the currently focused unit ('foo').
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page.getByTestId('command-row').nth(1)).toHaveText(/Keur/)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    await expect(page.getByText('approve 1/2')).toBeVisible()
    await expect(page.getByTestId('translation-row').nth(0)).toContainText('✓')

    // The next (not yet approved) key still shows no checkmark.
    await expect(page.getByTestId('translation-row').nth(1)).not.toContainText('✓')
  })

  test("placing a comment on the focused key anchors on that key's own line/side", async ({ page }) => {
    await page.goto('/pr/107?sel=' + encodeURIComponent('resources/lang/nl/checkout.php:1'))
    await enterDiffAndSettle(page)
    await page.keyboard.press('ArrowDown') // move onto the added key 'extra'
    await expect(page.getByTestId('translation-row').nth(1)).toHaveAttribute('data-active', '1')

    await page.keyboard.press('Meta+ArrowRight') // open the comments sidebar
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await page.keyboard.press('Enter') // focus the composer
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()
    await composer.fill('deze vertaling klopt niet')

    const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
    await page.keyboard.press('Enter') // opens the compose-kind menu
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('Enter') // default: "Plaats comment"

    const posted = (await postPromise).postDataJSON()
    expect(posted.body).toBe('deze vertaling klopt niet')
    expect(posted.file).toBe('resources/lang/nl/checkout.php')
    // 'extra' only exists in the HEAD file (an added key), so it anchors on
    // the NEW side — startLine/endLine both point at its own (single)
    // source line, never the block's generic start line (7 — see
    // translation-blocks.json).
    expect(posted.side).toBe('RIGHT')
    expect(posted.startLine).toBeGreaterThan(0)
    expect(posted.startLine).toBe(posted.endLine)
    expect(posted.code).toContain('extra')
  })
})
