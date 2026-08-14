import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Mouse-only approve (Block.mjs's rowApproveMarkerHTML/segHoverRingMarkers ->
// onBlockMouseDown -> home.mjs's approveClickAt/mouseApprove): a per-unit
// clickable affordance next to the existing keyboard-only Space/palette
// approve — see ".claude/docs/approval.md"'s "Approving from the mouse"
// section. Every action here reuses toggleApprove/toggleCallApprove exactly
// like Space does; this only adds a mouse entry point.
//
// Reuses PR 102 (RangeSelectAction::execute, four changed lines ($a/$b/$c/$d)
// in two groups — see diff-row-mouse-select.spec.mjs) for line/group, and PR
// 12903 (CreatePaymentAction::execute, a real multi-segment call chain) for
// the call-segment hover ring.
test.describe('PR Review Tree — mouse approve (gutter toggles)', () => {
  test('an empty line toggle only shows on hover, and a click approves + retracts (toggle)', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // gran 'line'

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    const toggle = rowA.locator('[data-approve-toggle="line"]')
    await expect(toggle).toHaveAttribute('title', 'Keur deze regel goed')
    // Hover-only reveal (CLAUDE.md's colourblind rule: shape/position, never
    // colour alone — the empty circle stays invisible until hovered).
    await expect(toggle).toHaveCSS('opacity', '0')
    await rowA.hover()
    await expect(toggle).toHaveCSS('opacity', '1')

    await toggle.click({ force: true })
    // The just-approved row keeps its own ✓, regardless of where the cursor
    // auto-advanced to next (mouseApprove's "approve + continue", mirroring
    // Space).
    await expect(rowA.locator('[data-approve-toggle="line"]')).toHaveAttribute('title', 'Trek goedkeuring in')

    // Clicking the now-solid ✓ retracts it — no auto-advance on a retract.
    await rowA.locator('[data-approve-toggle="line"]').click({ force: true })
    await expect(rowA.locator('[data-approve-toggle="line"]')).toHaveAttribute('title', 'Keur deze regel goed')
  })

  test('the group toggle sits on the LAST row and approves every row of that group', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // gran 'group', default

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    const rowB = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$b' }) // last row of the $a/$b group
    // The first row of the group never gets a group toggle — only its last
    // row does (groupApproveInfo keys on g.end).
    await expect(rowA.locator('[data-approve-toggle="group"]')).toHaveCount(0)
    const groupToggle = rowB.locator('[data-approve-toggle="group"]')
    await expect(groupToggle).toHaveAttribute('title', 'Keur deze hele groep goed')

    await groupToggle.click({ force: true })

    await expect(rowA.locator('[data-approve-toggle="line"]')).toHaveAttribute('title', 'Trek goedkeuring in')
    await expect(rowB.locator('[data-approve-toggle="line"]')).toHaveAttribute('title', 'Trek goedkeuring in')
    // The now-fully-approved group's own toggle switched shape/state too
    // (▣, retract) — never a second, colour-only signal.
    await expect(rowB.locator('[data-approve-toggle="group"]')).toHaveAttribute(
      'title',
      'Trek goedkeuring van deze groep in',
    )
  })

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
    // so the row keeps its partial-approval dot strip — no plain ✓ on this
    // row's line toggle.
    await expect(row.locator('[data-approve-toggle="line"]')).toHaveAttribute('title', 'Keur deze regel goed')
    await expect(row.locator('[data-seg-dot]').first()).toBeVisible()
  })
})
