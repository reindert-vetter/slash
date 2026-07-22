import { test, expect } from './_fixtures.mjs'

// A drilled Onderliggende-code column (state.drill/drillCursor) mirrors into
// `?drill=`/`?dgran=`/`?dchg=` (home.mjs, alongside `sel`/`mode`/`chg`/`gran`)
// so a refresh — or a round trip through /pr-overview — restores the same
// drilled column, at the same f/d/s granularity and change index, not just the
// top-level block. See "Drillen" in .claude/rules/detail-layout.md.
//
// Uses PR 12903 with a synthetic relation (mocked /api/relations, no seed
// change needed) nesting Order::address as a child of
// CreatePaymentAction::execute — same fixture setup as drill-focus.spec.mjs's
// own f/d/s test, including the same /api/blocks status patch: Order::address
// is fixture-`removed` (a single-line change, single-side pane), which this
// test needs 'modified' for so both panes render and the row-count technique
// below (group vs. call) stays meaningful.
async function mockChild(page) {
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
}

// normalizeQuery sorts a query string's params so two URLs carrying the same
// state compare equal regardless of param insertion order — the various
// mirror watches (blockRef/drillRef/mode/...) can flush in a different
// relative order depending on timing (see the same helper in urlstate.spec.mjs).
function normalizeQuery(search) {
  return [...new URLSearchParams(search)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')
}

async function drillIntoChild(page) {
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
  return drillColumn
}

test.describe('PR Review Tree — drilled column URL state', () => {
  test('drilling writes drill=/dgran=/dchg= and a reload restores the same column + cursor', async ({ page }) => {
    await mockChild(page)
    const drillColumn = await drillIntoChild(page)
    const drillArticle = drillColumn.locator('article').first()

    await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toContain('Order.php')
    // Default cursor on a fresh drill: group granularity, change 0 — both are
    // bindUrlState defaults, so they're dropped from the URL (short/canonical).
    expect(new URL(page.url()).searchParams.get('dgran')).toBeNull()
    expect(new URL(page.url()).searchParams.get('dchg')).toBeNull()

    // Zoom the drilled column's OWN cursor to 'call' (a single-row group, so f
    // skips 'line' and jumps straight to 'call' — same as drill-focus.spec.mjs's
    // own f/d/s test) — a non-default value, so it must appear in the URL
    // (mirrors state.gran/state.change's own dgran/dchg mirror). The indigo
    // call-segment underline is a structural, content-independent way to
    // observe the zoom actually landed on 'call'.
    const underline = drillColumn.locator('span[class*="decoration-[#6366f1]"]')
    await expect(underline).toHaveCount(0)
    await page.keyboard.press('f')
    await page.waitForTimeout(150)
    await expect.poll(() => new URL(page.url()).searchParams.get('dgran')).toBe('call')
    await expect(underline.first()).toBeVisible()

    const before = new URL(page.url()).search

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)

    // The drilled column reopened, owns the keyboard again, and the URL is
    // exactly what it was before the reload.
    await expect(drillColumn).toHaveCount(1)
    await expect(drillArticle).toHaveClass(/border-indigo-300/)
    expect(normalizeQuery(new URL(page.url()).search)).toBe(normalizeQuery(before))
    expect(new URL(page.url()).searchParams.get('dgran')).toBe('call')

    // The restored granularity is really 'call' (not just the URL param) — the
    // indigo call-segment underline is visible again inside the drilled column.
    await expect(underline.first()).toBeVisible()

    // ← still closes the restored column normally, proving the restore left a
    // fully-functional drill/drillCursor/focusLevel behind, not a visual-only
    // stand-in — and the URL drops back to canonical (no drill/dgran param).
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(200)
    await expect(drillColumn).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toBeNull()
    expect(new URL(page.url()).searchParams.get('dgran')).toBeNull()
  })

  test('leaving to /pr-overview and reopening via "Open review-boom" restores the drilled column', async ({ page }) => {
    await mockChild(page)
    const drillColumn = await drillIntoChild(page)
    const drillArticle = drillColumn.locator('article').first()

    await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toContain('Order.php')

    // "Naar PR-overzicht" (the `/` PR-wide menu) reads overviewExitUrl() at the
    // moment it runs — unlike repeated ←, it doesn't require first popping the
    // drilled column back out, so it's the only reachable way to leave while
    // still drilled (see the round-trip note in pages-and-routing.md).
    await page.keyboard.press('/')
    await page.getByTestId('command-row').first().click()
    await expect(page).toHaveURL(/\/pr-overview/)
    expect(page.url()).toContain('drill=')
    expect(page.url()).toContain('Order.php')

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await row.click()
    await page.getByTestId('open-tree').click()

    await expect(page).toHaveURL(/\/pr\/12903/)
    await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toContain('Order.php')
    await page.waitForTimeout(300)

    await expect(drillColumn).toHaveCount(1)
    await expect(drillArticle).toHaveClass(/border-indigo-300/)
  })
})
