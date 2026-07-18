import { test, expect } from './_fixtures.mjs'

// A genuinely deleted file (absent from the head worktree — git's
// `+++ /dev/null`) is persisted as a reliable per-block flag
// (blocks.file_deleted → `fileDeleted` in /api/blocks) and marked prominently
// in three places: the block-card header badge, the sidebar row pill, and a
// banner above the old-only diff pane. A loose removed method in a file that
// still exists gets the softer "Verwijderd" wording instead. Seeded via
// tests/fixtures/filedeleted-blocks.json (PR 98, no worktrees needed for the
// badge/pill; the banner is exercised with a direct Block() mount, same
// pattern as diffview.spec.mjs).
test.describe('PR Review Tree — deleted-file markers', () => {
  test('sidebar rows carry the rose removed pills', async ({ page }) => {
    await page.goto('/pr/98')
    await page.waitForLoadState('networkidle')

    const pills = page.locator('[data-testid="block-row-removed"]')
    await expect(pills).toHaveCount(2)
    await expect(pills.filter({ hasText: 'Verwijderd bestand' })).toHaveCount(1)
    // The loose removed method (file still exists) reads plain "Verwijderd".
    await expect(pills.filter({ hasText: /^Verwijderd$/ })).toHaveCount(1)
    // The modified block carries no pill (2 pills across 3 rows, checked above).
  })

  test('block-card header shows the "Verwijderd bestand" badge', async ({ page }) => {
    await page.goto('/pr/98')
    await page.waitForLoadState('networkidle')

    // Block 0 (file/line order) is LegacyExporter::export — the deleted file.
    const badge = page.locator('[data-testid="block-status-badge"]').first()
    await expect(badge).toHaveText('Verwijderd bestand')
    await expect(badge).toHaveClass(/bg-rose-100/)
    await expect(badge).toHaveClass(/font-bold/)
  })

  test('diff banner renders above the old-only pane', async ({ page }) => {
    await page.goto('/pr/98')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const mount = (id, extra) => {
        const b = reactive({
          category: 'SERVICE',
          label: 'LegacyExporter::export',
          status: 'removed',
          file: 'app/Services/LegacyExporter.php',
          line: 8,
          name: 'export',
          class: 'LegacyExporter',
          approved: false,
          code: {
            old: { start: 8, end: 10, text: 'public function export(): void {\n    echo "x";\n}' },
            new: null,
          },
          ...extra,
        })
        const host = document.createElement('div')
        host.id = id
        document.body.appendChild(host)
        Block(b)(host)
      }
      mount('filedeleted-host', { fileDeleted: true })
      mount('loose-removed-host', {})
    })

    // Deleted file: prominent banner + still exactly one code pane, inside the
    // same data-testid=code-diff wrapper (updateHints/syncScroll anchor).
    const fdDiff = page.locator('#filedeleted-host [data-testid="code-diff"]')
    await expect(fdDiff.locator('[data-testid="removed-banner"]')).toHaveText(
      'Verwijderd bestand — deze code bestaat niet meer',
    )
    await expect(fdDiff.locator('code.language-php')).toHaveCount(1)

    // Loose removed block: same banner slot, softer wording, same pane count.
    const looseDiff = page.locator('#loose-removed-host [data-testid="code-diff"]')
    await expect(looseDiff.locator('[data-testid="removed-banner"]')).toHaveText(
      'Verwijderd — deze code bestaat niet meer',
    )
    await expect(looseDiff.locator('code.language-php')).toHaveCount(1)
  })
})
