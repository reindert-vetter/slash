import { test, expect } from './_fixtures.mjs'

// Sharpening on top of 3228444: a class-member card (resolveClassMembers,
// rule 9) attached to a SIBLING method must only show next to the
// group/line that actually USES the member — not next to every changed
// group of that sibling, which is what it did right after 3228444 (the
// callKey was unconditionally treated as block-level, see
// isBlockLevelCallKey/callScopeMethods in home.mjs). PR 115
// (materializeClassMemberScopeWorktrees, tests/_setup.mjs) seeds
// ScopeMemberAction::run with two separate changed groups: group 0
// (`$unrelated = …`) never mentions the constant, group 1 (`$tries =
// self::MAX_TRIES`) does.
const SEL = 'app%2FActions%2FScopeMemberAction.php%3A9'
const BASE = `/pr/115?mode=diff&sel=${SEL}`

test.describe('a class-member card attached to a sibling is scoped to the group/line that uses it', () => {
  test('group granularity: hidden on the unrelated group, shown on the group that uses the constant', async ({
    page,
  }) => {
    await page.goto(BASE) // default gran 'group', chg 0 — the unrelated group
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    await page.goto(BASE + '&chg=1') // the group using self::MAX_TRIES
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('MAX_TRIES')
  })

  test('line granularity: same hide/show split, one line at a time', async ({ page }) => {
    await page.goto(BASE + '&gran=line') // chg 0 → the first changed row ($unrelated)
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    await page.goto(BASE + '&gran=line&chg=1') // the second changed row ($tries = self::MAX_TRIES)
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('MAX_TRIES')
  })

  test('list mode stays unscoped — the member always shows, regardless of any group/line', async ({
    page,
  }) => {
    await page.goto('/pr/115')
    await page.getByTestId('block-row').filter({ hasText: 'ScopeMemberAction::run' }).click()
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('MAX_TRIES')
  })
})
