import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for LOCAL PATCH 4 in src/vendor/arrow.js (Gt/emit).
//
// Reported symptom: "als ik diep zit, dan is de tree traag als ik een regel
// goedkeur" — repeatedly pressing Space deep inside a drilled Onderliggende-
// code column silently did nothing. Root cause was NOT drill depth and NOT a
// CPU-bound longtask (a CDP Profiler capture around the crashing Space press
// showed under 2ms of actual self-time) — it was a crash:
// `TypeError: f[d] is not a function` thrown from arrow.js's `Gt` (upstream
// `emit`), which dispatches every listener subscribed to a reactive property
// by looping over its listener ARRAY in place. `state.drill`/
// `state.drillCursor` normally has 2+ subscribers at once (the columns-render
// effect plus the `?drill=`/`?dcur=` URL-mirroring watch, see
// urlState.mjs/home.mjs's bindUrlState call) — a listener's own execution can
// synchronously dispose a nested reconciler subtree (LOCAL PATCH 2's
// cascading disposal, e.g. a drilled column's card being torn down), which
// unsubscribes from that SAME array via `Yt` while `Gt` is still mid-loop
// over it, corrupting the iteration.
//
// Isolated (see .claude/docs/frontend-memory.md, "The Gt dispatch-array
// crash") to have NOTHING to do with drill depth specifically: plain `↓`
// (ArrowDown, changing a drilled column's own change-group cursor) repeated
// ~10-40 times inside ANY drilled column reproduces it, with zero
// Onderliggende-code-panel interaction — the same repetition count at drill
// depth 0 (no drilled column at all) never reproduces it. This spec is
// therefore the cheap version: drill ONE level deep and hammer ArrowDown,
// rather than reconstructing a 6-level-deep session.
//
// PR 126 fixture (materializeDrillChurnWorktrees, tests/_setup.mjs):
// DrillChurnParent::execute (top-level, one changed line) →
// DrillChurnChild::run (its event_listener child, tests/fixtures/
// drillchurn-relations.json) with FIVE separate, isolated changed lines — so
// drilling into it gives a column with five real 'group' units to step
// through (plus repeated clamping at the last one, which still reassigns the
// same cursor value and so still re-dispatches Gt every press — see "watch
// fires even when the write reassigns the SAME value" in
// .claude/rules/arrowjs-pitfalls.md).
//
// Honesty note (see frontend-memory.md for the full record): this exact
// minimal fixture did NOT reliably reproduce the crash pre-patch, even at
// 150+ presses, with a mocked comment-poll churning in parallel, and even on
// the richer PR 100/12903 fixtures — only the real ~300-block PR 13451
// dataset did, reliably, within 10-40 presses. Whatever makes the second,
// disposal-triggering subscriber collide with Gt's own dispatch loop needs
// a reactive graph this dense; a handful of synthetic blocks isn't enough to
// force it. This spec therefore is NOT proof the bug reproduces here — it's
// a cheap smoke/guard test exercising the exact interaction (drill one level,
// hammer ↓) so a FUTURE regression of this class has a fast, deterministic
// place to fail once it's dense enough to trigger, and so the drilled column
// itself never silently breaks under rapid navigation. The real before/after
// evidence for LOCAL PATCH 4 is the isolated-PR-13451-harness measurement
// recorded in frontend-memory.md, not this spec.
test.describe('PR Review Tree — hammering ArrowDown inside a drilled column must never throw', () => {
  test('20-40 ArrowDown presses inside a drilled column produce zero page errors', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    await page.goto('/pr/126')
    await page.locator('[data-idx="0"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the parent's diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // → into the Onderliggende-code panel

    const child = page.getByTestId('related-item').first()
    await expect(child).toContainText('DrillChurnChild::run')
    await child.click() // drill in — focus lands on the drilled column's diff

    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('DrillChurnChild::run')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Hammer the drilled column's own change-group cursor — this is the
    // exact write (`state.drillCursor[i].change`) whose fan-out ends up
    // reassigning `state.drill`/`state.drillCursor` with 2+ subscribers.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowDown')
    }

    // The column must still be there, still focused, still responsive —
    // not merely "no exception": a genuinely wedged reconciler (the
    // pre-LOCAL-PATCH-2b failure mode) would also leave the DOM stuck.
    await expect(drill).toHaveCount(1)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    expect(pageErrors).toEqual([])
  })
})
