import { test, expect, appReady } from './_fixtures.mjs'

// A method the PR RENAMED or MOVED is one block, not a loose "Verwijderd" +
// "added" pair: blockmove.go pairs the two bodies PR-wide and stamps the
// pre-move identity on the surviving (new) block. The UI then shows that
// identity stacked as `- oud` above `+ nieuw`, for the symbol AND the path, and
// says which of the two happened in a word ("Hernoemd"/"Verplaatst" — never
// colour alone). Seeded via tests/fixtures/blockmove-blocks.json (PR 122),
// worktrees via materializeBlockMoveWorktrees in _setup.mjs.
test.describe('PR Review Tree — renamed/moved blocks', () => {
  test('sidebar rows say Hernoemd and Verplaatst', async ({ page }) => {
    await page.goto('/pr/122')
    await appReady(page)

    const pills = page.locator('[data-testid="block-row-moved"]')
    await expect(pills).toHaveCount(2)
    await expect(pills.filter({ hasText: 'Hernoemd' })).toHaveCount(1)
    await expect(pills.filter({ hasText: 'Verplaatst' })).toHaveCount(1)
    // Neither is a removed block any more — the pair collapsed into one.
    await expect(page.locator('[data-testid="block-row-removed"]')).toHaveCount(0)
  })

  test('the card stacks the old symbol and path above the new ones', async ({ page }) => {
    await page.goto('/pr/122')
    await appReady(page)

    // Both cards are mounted (the selected block plus its look-ahead preview),
    // so assert the whole set in file order rather than one card's `.first()`.
    // Block 0 is the cross-file move (app/Queries/…), block 1 the same-file
    // rename. The moved one keeps its NAME but changes CLASS, which is exactly
    // why its old symbol is worth stacking too.
    await expect(page.locator('[data-testid="block-old-label"]')).toHaveText([
      '- CommissionRepository::movedAway',
      '- CommissionRepository::getIndexCommissionsForPartner',
    ])
    await expect(page.locator('[data-testid="block-old-path"]')).toHaveText([
      '- app/Repositories/CommissionRepository.php:18',
      '- app/Repositories/CommissionRepository.php:7',
    ])
    await expect(page.locator('[data-testid="block-status-badge"]')).toHaveText([
      'Verplaatst',
      'Hernoemd',
    ])
  })

  test('the diff reads the old side from the pre-move file and symbol', async ({ page }) => {
    // Without the oldFile/oldName round trip through /api/code the old side
    // comes back empty and the whole body renders as one big addition.
    const res = await page.request.get(
      '/api/code?pr=122&file=app%2FQueries%2FCommissionQuery.php&class=CommissionQuery&name=movedAway' +
        '&oldFile=app%2FRepositories%2FCommissionRepository.php&oldClass=CommissionRepository&oldName=movedAway',
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.old.text).toContain('public function movedAway')
    expect(body.new.text).toContain('public function movedAway')
    // The body itself is untouched by the move, so the two sides match apart
    // from their indentation-identical declaration.
    expect(body.old.text).toContain("->whereNotNull('paid_at')")
    expect(body.new.text).toContain("->whereNotNull('paid_at')")
  })
})
