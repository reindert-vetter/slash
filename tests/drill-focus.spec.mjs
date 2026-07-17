import { test, expect } from './_fixtures.mjs'

// Verifies the new right-to-left drill-column keyboard navigation: after
// drilling, the keyboard focus lands on the new column's own diff (not its
// Onderliggende-code panel); ← closes the focused drilled column and steps
// focus back onto the parent column's own diff; eventually ← returns to the
// original block's own diff, and one more ← exits to the list.
//
// Uses PR 12903 (the only fixture PR backed by a real worktree, so its blocks
// have real diffs) with a synthetic relation — injected by mocking
// /api/relations, no server-side seed change needed — nesting one of its
// existing blocks (findOrCreateCustomer) as a child of another
// (CreatePaymentAction::execute). Both are then real PR blocks with real
// change groups, so the drilled column is a genuine, navigable diff too.
test('drilled columns are navigable left/right with the keyboard', async ({ page }) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          kind: 'event_listener',
        },
      ],
    })
  })

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const blockArticle = page.locator('[data-testid="block-column"] article').first()
  const drillColumn = page.getByTestId('drill-column')
  const drillArticle = drillColumn.locator('article').first()

  // Wait for the parent's diff to load, then step into it.
  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  // Sanity: the top-level block's own diff owns the keyboard before drilling.
  await expect(blockArticle).toHaveClass(/border-indigo-300/)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()

  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)

  // 1. Focus lands on the NEW diff column, not its Onderliggende-code panel:
  // the drilled column's article carries the focused-diff border, and the
  // top-level block column collapsed to a rail (no article left in it — see
  // drill-collapse.spec.mjs for the rail itself) since it no longer owns the
  // keyboard. No related-item shows the "selected" ring (the panel isn't
  // focused).
  await expect(drillArticle).toHaveClass(/border-indigo-300/)
  await expect(page.locator('[data-testid="block-column"] article')).toHaveCount(0)
  await expect(page.getByTestId('block-collapsed')).toBeVisible()
  const activeItem = page.locator('[data-testid="related-item"][data-active="true"]')
  await expect(activeItem).toHaveCount(0)

  // ↓ walks the drilled column's own change groups (its own cursor, not the
  // parent's state.change) without leaving the column or touching the parent.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillArticle).toHaveClass(/border-indigo-300/)

  // 2. ← closes the drilled column and steps focus back onto the original
  // block's own diff.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  await expect(drillColumn).toHaveCount(0)
  await expect(blockArticle).toHaveClass(/border-indigo-300/)

  // 3. One more ← drops back to the list (mode change) — the existing
  // diff→list behaviour.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  await expect(drillColumn).toHaveCount(0)
  await expect(panel).toHaveClass(/left-\[29rem\]/)
})

// Verifies a drilled column zooms its OWN granularity with f/d/s (group → line
// → call), exactly like the top-level block's own diff — mirroring
// navigate.spec.mjs's "f on a single-line group jumps straight to call" test,
// scoped to the drilled column instead of the top-level card.
//
// Parent: CreatePaymentAction::execute (block 0 — reliably carries a real diff,
// see the "Data-kanttekening" note in conventions.md), needed so ArrowRight
// actually enters diff mode (entering the parent's own, real diff) before we
// drill — a block with no changes would leave state.mode stuck on 'list' and
// f/d/s would never reach the drilled column at all.
// Child: Order::address (also a real single-line change — `morphOne(...)` →
// `billingAddress()` — in the same worktree snapshot). Its fixture status is
// 'removed', which (correctly, on its own) renders only the old/left pane —
// but that hides the new/right side where changeCalls underlines a modified
// row, so this test patches its status to 'modified' via a /api/blocks
// route-fulfill so both panes render, exactly like any other modified block.
test('f/d/s zoom a drilled column\'s own granularity (group → line → call)', async ({ page }) => {
  await page.route('**/api/blocks?pr=12903', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    for (const b of json) {
      if (b.class === 'Order' && b.name === 'address') b.status = 'modified'
    }
    await route.fulfill({ response: res, json })
  })
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Models/Order.php:Order::address',
          kind: 'event_listener',
        },
      ],
    })
  })

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/) // confirms the parent's own diff was entered
  await page.waitForTimeout(200)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('address')
  await child.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)

  // Scope the highlight/underline locators to the drilled column only, so this
  // never accidentally matches the (dimmed) parent card sitting to its left.
  const activeRows = drillColumn.locator('div[class*="inset_3px_0_0"]')
  const underline = drillColumn.locator('span[class*="decoration-[#6366f1]"]')

  // Lands on the first (group-granularity) change on drilling in — a single row.
  await expect(activeRows.first()).toBeVisible()
  const groupCount = await activeRows.count()
  expect(groupCount).toBe(2) // one row × two panes

  // f → call directly (skipping line, single-row group): the call segment gets
  // the indigo underline, same row count as before.
  await page.keyboard.press('f')
  await page.waitForTimeout(150)
  await expect(activeRows).toHaveCount(groupCount)
  await expect(underline.first()).toBeVisible()

  // The drilled column zoomed, NOT the (dimmed) parent card next to it — the
  // parent never had call granularity active in the first place (focusLevel
  // was already on the drilled column, not the parent's own diff).
  await expect(drillColumn).toHaveCount(1)

  // d walks back down one level at a time: call → line (no underline).
  await page.keyboard.press('d')
  await page.waitForTimeout(150)
  await expect(underline).toHaveCount(0)

  // d → group: the row count is unchanged (still the same single row).
  await page.keyboard.press('d')
  await page.waitForTimeout(150)
  await expect(activeRows).toHaveCount(groupCount)

  // f again to reach 'call', then s zooms back out one level (call → line),
  // same as d here since there's no next/previous call to flow through (a
  // drilled column never flows into a same-file neighbour).
  await page.keyboard.press('f')
  await page.waitForTimeout(150)
  await expect(underline.first()).toBeVisible()
  await page.keyboard.press('s')
  await page.waitForTimeout(150)
  await expect(underline).toHaveCount(0)
})

// Verifies the ← drill-pop scroll-restore fix: closing a drilled column must
// re-centre the parent column's active change, not just leave it scrolled to
// the top. The parent card gets a fresh key on this foc/unfoc flip (see the
// block-card .key(...) rekey comment in home.mjs), so its [data-scrollsync]
// pane starts at scrollTop 0 on rebuild — without scrollChangeIntoView(false)
// after scrollFocusIntoView() in the ← handler, a parent block whose active
// change sits well below the top of its own diff (CreatePaymentAction::execute
// here — a real ~60-line function, changed line sits ~40 lines in, see
// "Data-kanttekening" in conventions.md for why we anchor on this block) would
// leave the reviewer stranded above the edit row.
test('closing a drilled column re-scrolls the parent to its active change (not the top)', async ({
  page,
}) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          kind: 'event_listener',
        },
      ],
    })
  })

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  const blockColumn = page.getByTestId('block-column')
  // scrollChangeIntoView already ran once on entering the diff (enterDiff);
  // capture that as the "correctly scrolled" baseline before drilling away.
  const scrollTopOf = async (scope) =>
    scope.evaluate((el) => {
      const anchor = el.querySelector('[data-change-active]')
      const container = anchor && anchor.closest('[data-scrollsync]')
      return container ? container.scrollTop : null
    })
  const baseline = await scrollTopOf(blockColumn)
  expect(baseline).not.toBeNull()
  expect(baseline).toBeGreaterThan(0)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)

  // Close the drilled column: focus steps back onto the parent's own diff.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(300)
  await expect(drillColumn).toHaveCount(0)
  const blockArticle = blockColumn.locator('article').first()
  await expect(blockArticle).toHaveClass(/border-indigo-300/)

  // The parent's card was rebuilt (fresh key) for this focus change, so a
  // stale scrollTop reading would be misleading — assert against the fresh
  // container instead of relying on `baseline`'s own scrollTop value staying
  // numerically identical (only that it's re-centred, not reset to 0).
  const restored = await scrollTopOf(blockColumn)
  expect(restored).not.toBeNull()
  expect(restored).toBeGreaterThan(0)

  // Stronger check: the active-change anchor itself must be within the
  // container's visible viewport, not scrolled out of view above it.
  const inView = await blockColumn.evaluate((el) => {
    const anchor = el.querySelector('[data-change-active]')
    const container = anchor && anchor.closest('[data-scrollsync]')
    if (!anchor || !container) return false
    const a = anchor.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    return a.top >= c.top && a.bottom <= c.bottom
  })
  expect(inView).toBe(true)
})
