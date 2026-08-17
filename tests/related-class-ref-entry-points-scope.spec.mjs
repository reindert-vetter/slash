import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A class_ctor/class_method entry-point card (rule 6c-bis, "the entry points
// of a referenced class" in .claude/docs/underlying-code.md) used to be
// block-level: it stayed visible regardless of which call/line the reviewer
// had selected in the block, so an unrelated call elsewhere in the same block
// still showed it, reading as "this call resolves to that method" with no
// actual relation between the two (reported bug: selecting
// `$request->isPartner()` still showed `CommissionRepository::getAsPartner`
// as "eerste methode"). Reversed on explicit request: both cards now scope to
// the group/line that actually carries the `Foo::class` reference, exactly
// like an ordinary call. PR 121 (materializeScopeClassRefWorktrees,
// tests/_setup.mjs, seeded via scopeclassref-blocks.json/
// scopeclassref-callresolve.json) seeds ScopeClassRefAction::run with two
// separate changed groups: group 0 (`$unrelated = …`) never mentions the
// class, group 1 (`$repo = app(SomeRepo::class)`) does.
const BLOCK = 'ScopeClassRefAction::run'

test.describe('class_ctor/class_method entry-point cards are scoped like an ordinary call', () => {
  test('hidden on the unrelated group, shown on the group with the Foo::class reference', async ({ page }) => {
    await page.goto('/pr/121')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into the diff, group 0: the unrelated line
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    await page.keyboard.press('ArrowDown') // group 1: the SomeRepo::class line
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(2)
    await expect(items.filter({ hasText: '__construct' })).toContainText('constructor')
    await expect(items.filter({ hasText: 'find' })).toContainText('eerste method')
  })

  test('list mode stays unscoped — both cards always show, regardless of any group/line', async ({ page }) => {
    await page.goto('/pr/121')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(2)
  })
})
