import { test, expect } from './_fixtures.mjs'

// Mouse-only approve for a call segment (Block.mjs's segHoverRingMarkers ->
// onBlockMouseDown -> home.mjs's approveClickAt/mouseApprove): a clickable
// hover-only ring on each call-chain segment's dot marker, next to the
// existing keyboard-only Space/palette approve — see ".claude/docs/
// approval.md"'s "Approving from the mouse" section. Reuses
// toggleApprove/toggleCallApprove exactly like Space does; this only adds a
// mouse entry point.
//
// The per-row/group gutter toggles (✓/○ line, ▣/▢ group) this file used to
// also cover were removed on request. A mouse selection (or an approve click)
// shows no menu at all any more either — only a right-click does, see "The
// right-click context menu" in .claude/docs/command-palette.md and
// tests/selection-menu.spec.mjs. Reuses PR 12903 (CreatePaymentAction::execute,
// a real multi-segment call chain).
test.describe('PR Review Tree — mouse approve (call-segment hover ring)', () => {
  test('a call segment’s hover ring approves exactly that one segment', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click() // CreatePaymentAction::execute
    await page.keyboard.press('ArrowRight')
    // Block 1's own single (one-row) change group auto-jumps the initial
    // stand to 'unified' once its code arrives (home.mjs's
    // allChangesAreSingleLine watch) — the hover-ring approve affordance
    // this test exercises only exists in 'split'/'fit' (see
    // rowApproveEnabled in Block.mjs). Wait for the code to actually render
    // (so that auto-jump has already fired) before forcing 'split' back, or
    // the click races the async code fetch and gets silently overridden.
    await expect(page.getByTestId('code-diff').first().locator('code.language-php').first()).toBeVisible()
    await page.getByTestId('diffview-split').click()
    // This group spans exactly one line, so a single 'f' already jumps
    // straight from 'group' to 'call' (see keyboard-navigation.md's "Refining
    // a group that spans exactly one line…") — a second 'f' would step to the
    // NEXT call instead of staying on this row.
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)

    const card = page.getByTestId('detail-card').first()
    const row = card.locator('[data-pane="new"] [data-row]').filter({ hasText: 'billingAddress' })
    // The hover-only ring is a ::after pseudo-element (same mechanism as the
    // real DONE/TODO dots, see segDotMarkers/SEG_DOT_HOVER_CLS) — its own
    // opacity isn't queryable via toHaveCSS the way a plain element's is, so
    // this only exercises the click itself, same as
    // diff-row-mouse-select.spec.mjs's own call-segment test.
    const dot = row.locator('[data-seg-dot]').first()
    await row.hover()
    await dot.click({ force: true })
    // One segment of the row is now approved (not the whole row/line yet),
    // so the row keeps its partial-approval dot strip.
    await expect(row.locator('[data-seg-dot]').first()).toBeVisible()
  })

  // mouseApprove() reuses Space's own approve-and-continue chain, which always
  // auto-continues the cursor (see afterApproveAction's `auto` parameter), and
  // shows no menu at all either way — exactly like Space itself. See
  // ".claude/docs/approval.md"'s "mouseApprove() is the mouse counterpart of
  // Space" section.
  test('a call-segment click auto-continues the cursor but shows no menu', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click() // CreatePaymentAction::execute
    await page.keyboard.press('ArrowRight')
    // See the previous test: wait for code, then force 'split' back — the
    // hover-ring approve affordance doesn't exist in the auto-jumped
    // 'unified' stand, and clicking too early races the async code fetch.
    await expect(page.getByTestId('code-diff').first().locator('code.language-php').first()).toBeVisible()
    await page.getByTestId('diffview-split').click()
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)

    const card = page.getByTestId('detail-card').first()
    const row = card.locator('[data-pane="new"] [data-row]').filter({ hasText: 'billingAddress' })
    const dot = row.locator('[data-seg-dot]').first()
    await row.hover()
    await dot.click({ force: true })

    // Approving auto-continued the cursor to the next unapproved unit — no
    // menu shows at the new landing spot, exactly like Space.
    await expect(page.getByTestId('command-overlay')).toHaveCount(0)
    await expect(page.locator('[data-testid="command-anchor"]')).toHaveCount(0)
  })
})
