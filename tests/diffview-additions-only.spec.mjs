import { test, expect, appReady } from './_fixtures.mjs'

// Reviewer report (2026-08-20, screenshot of a live PR's
// modules/Statistics/Config/config.php): "als er alleen dingen zijn
// toegevoegd... wil ik de unified diff zien" — a genuinely two-sided
// (`modified`) block whose diff has no removed/replaced line anywhere used
// to still open in the default 'split' stand, wasting its entire left/old
// pane (empty) while the right/new pane ran every added line off the edge
// of its half-width column. home.mjs's allChangesAreAdditionsOnly (next to
// the existing allChangesAreSingleLine) auto-jumps the INITIAL stand to
// 'unified' for such a block too — see "Landing on an all-single-line
// block..." in .claude/docs/diff-card.md for the full mechanism/trade-offs
// this reuses.
//
// Fixture: PR 123 (materializeAdditionsOnlyWorktrees, tests/_setup.mjs) — a
// single block whose one change GROUP spans 4 lines (two comment lines plus
// two assignments), deliberately NOT single-line, so this test can't pass by
// accident via the pre-existing allChangesAreSingleLine trigger — only the
// additions-only one can explain a pass here.
const PR = 123

test.describe('diff view — an additions-only modified block auto-jumps to unified', () => {
  test('opens in unified (not split), and the reviewer can still cycle away with `a`', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await appReady(page)
    await page.locator('[data-idx="0"]').click()
    await page.keyboard.press('ArrowRight') // step into the diff

    const diff = page.getByTestId('code-diff').first()
    await expect(diff).toBeVisible()
    // Wait for the code to actually render before reading the indicator —
    // the auto-jump only fires once the code has loaded (same known race
    // documented next to allChangesAreSingleLine).
    await expect(diff.locator('code.language-php').first()).toBeVisible()

    await expect(page.getByTestId('diffview-unified')).toHaveClass(/bg-indigo-100/)
    await expect(page.getByTestId('diffview-split')).not.toHaveClass(/bg-indigo-100/)
    // 'unified' always renders through its single data-pane="new" column —
    // there is no separate old pane to waste width on.
    await expect(diff.locator('[data-pane="old"]')).toHaveCount(0)
    await expect(diff.locator('code.language-php')).toHaveCount(1)

    // Not a permanent override: the reviewer can still cycle back to
    // 'split' with `a` (unified -> fit -> split), exactly like the
    // single-line trigger.
    await page.keyboard.press('a')
    await page.keyboard.press('a')
    await expect(page.getByTestId('diffview-split')).toHaveClass(/bg-indigo-100/)
    await expect(diff.locator('code.language-php')).toHaveCount(2)
  })
})
