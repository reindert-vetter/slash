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
// also cover were removed on request — a mouse selection now shows the
// command palette itself instead (see "A mouse selection shows the palette
// passively" in .claude/docs/command-palette.md, tests/selection-menu.spec.mjs).
// Reuses PR 12903 (CreatePaymentAction::execute, a real multi-segment call
// chain).
test.describe('PR Review Tree — mouse approve (call-segment hover ring)', () => {
  test('a call segment’s hover ring approves exactly that one segment', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click() // CreatePaymentAction::execute
    await page.keyboard.press('ArrowRight')
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
})
