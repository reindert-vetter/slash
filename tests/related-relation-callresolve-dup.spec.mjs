import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A block can reach the SAME changed target through two independent paths:
// a relation edge (childrenOf/relatedChildren, home.mjs) AND a resolved call
// (resolvedCallChildren) — preferredCallRows already collapses several
// callresolve rows pointing at one definition down to a single survivor, but
// that survivor still duplicated the relation card, because nothing compared
// the two lists against each other. Reported live: DiscountController::store
// showed DiscountResource::toArray TWICE under Onderliggende code — once via
// the `controller_resource` relation, once via callresolve (itself already
// the collapsed survivor of three callKeys: `toArray`,
// `class_method:DiscountResource`, `resource:DiscountResource`). See
// materializeRelationCallresolveDupWorktrees (tests/_setup.mjs) and
// .claude/docs/underlying-code.md.
const BLOCK = 'DiscountController::store'

test.describe('a relation and a resolved call to the same target collapse to one card', () => {
  test('DiscountResource::toArray shows only once under Onderliggende code', async ({ page }) => {
    await page.goto('/pr/131')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    const items = page.getByTestId('related-item')
    await expect(items.filter({ hasText: 'DiscountResource::toArray' })).toHaveCount(1)
  })
})
