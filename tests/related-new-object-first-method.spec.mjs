import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A plain `new Foo(...)` construction with no explicit chained call also
// shows the class's first OTHER method next to its constructor (rule
// "2b-bis" in .claude/docs/workflows-analysis.md) — the reported case: a
// Laravel validation Rule object handed straight to a `rules()` array
// (`new MaxLengthWithoutHtml(3000)`), whose real method (`validate`) is only
// ever invoked by the framework through the `Rule` interface, so no call
// site for it exists anywhere for the reviewer to select. Both the
// resolution and the "no chained call" gate have their own Go unit tests
// (TestResolveCallsNewObjectFirstMethod/
// TestResolveCallsNewObjectChainedCallNoFirstMethod); what needs proving
// here is the FRONTEND scoping half: the `class_method:` card's callKey
// names the class, not a call to `validate`, so findCallSites must match the
// `MaxLengthWithoutHtml(` literal (the constructor call itself) — same shape
// as related-class-ref-entry-points-scope.spec.mjs's `Foo::class` case, one
// literal earlier in the chain. PR 128
// (materializeNewObjectFirstMethodWorktrees, tests/_setup.mjs, seeded via
// newobjfirstmethod-blocks.json/newobjfirstmethod-callresolve.json) seeds
// NewObjectFirstMethodAction::run with two separate changed groups: group 0
// (`$unrelated = …`) never mentions the class, group 1
// (`$rule = new MaxLengthWithoutHtml(3000)`) does.
const BLOCK = 'NewObjectFirstMethodAction::run'

test.describe('a new Foo(...) with no chained call shows its class first method, scoped like an ordinary call', () => {
  test('hidden on the unrelated group, shown on the group with the construction', async ({ page }) => {
    await page.goto('/pr/128')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into the diff, group 0: the unrelated line
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    await page.keyboard.press('ArrowDown') // group 1: the `new MaxLengthWithoutHtml(3000)` line
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(2)
    const ctor = items.filter({ hasText: '__construct' })
    await expect(ctor).toBeVisible()
    const first = items.filter({ hasText: 'validate' })
    await expect(first).toContainText('eerste method')
  })

  test('list mode stays unscoped — both cards always show, regardless of any group/line', async ({ page }) => {
    await page.goto('/pr/128')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(2)
  })
})
