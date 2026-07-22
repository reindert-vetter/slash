import { test, expect } from './_fixtures.mjs'

// A file the PR moved (a git-detected rename) is scanned as ONE logical file:
// its methods pair up on class::method across the old and new path, so each
// shows as a single `modified` block (not the removed@old + added@new pair the
// reviewer saw before). Every block of that file carries oldFile (the
// pre-rename path) so the card shows the OLD path stacked ABOVE the new path.
// Seeded via tests/fixtures/rename-blocks.json (PR 104, no worktrees needed —
// the path badge reads b.oldFile/b.file directly).
test.describe('PR Review Tree — renamed-file path display', () => {
  test('block card shows the old path above the new path', async ({ page }) => {
    await page.goto('/pr/104')
    await page.waitForLoadState('networkidle')

    // Block 0 (file/line order) is InvoiceService::total — the moved file.
    const oldPath = page.locator('[data-testid="block-old-path"]').first()
    await expect(oldPath).toHaveText('app/Services/Legacy/InvoiceService.php')
    // Struck-through, rendered as its own line (muted) above the new path.
    await expect(oldPath).toHaveClass(/line-through/)

    // The new path + line sits directly below, in the same stacked container.
    const container = oldPath.locator('..')
    await expect(container).toContainText('app/Services/New/InvoiceService.php:12')

    // Old path is visually above the new path.
    const oldBox = await oldPath.boundingBox()
    const newLine = container.locator('span', {
      hasText: 'app/Services/New/InvoiceService.php:12',
    })
    const newBox = await newLine.boundingBox()
    expect(oldBox.y).toBeLessThan(newBox.y)
  })

  test('a non-renamed block shows no old-path line', async ({ page }) => {
    // PR 12903 (the default blocks.json fixture) has no renamed files.
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid="block-old-path"]')).toHaveCount(0)
  })
})
