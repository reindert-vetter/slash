import { test, expect } from '@playwright/test'

// Change navigation: from the sidebar (list mode) → steps into the selected
// block's diff and selects the first changed line; ↑/↓ then walk the change
// groups; ← steps back out. Consecutive changed lines collapse into one group,
// but a run longer than 5 rows is split into successive groups. See home.mjs +
// Block.mjs (changeGroups / paneHTML active highlight).
test.describe('PR Review Tree — change navigation', () => {
  test('changeGroups collapses runs and splits every 5 rows', async ({ page }) => {
    await page.goto('/')
    // Let the app's initial module load + lazy fetches settle; otherwise an
    // in-page evaluate() can race the load and hit "context destroyed".
    await page.waitForLoadState('networkidle')
    const groups = await page.evaluate(async () => {
      const { changeGroups } = await import('/src/Block.mjs')
      const mk = (n, changed) =>
        Array.from({ length: n }, () =>
          changed ? { leftMark: 'del', rightMark: 'ins' } : { leftMark: null, rightMark: null },
        )
      // 8 changed rows, an unchanged gap, then 2 more changed rows.
      const rows = [...mk(8, true), ...mk(1, false), ...mk(2, true)]
      return changeGroups(rows)
    })
    // 8 changed → [0..4] + [5..7]; gap at 8 resets; 2 changed → [9..10].
    expect(groups).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 7 },
      { start: 9, end: 10 },
    ])
  })

  test('an active group is highlighted with an anchor on both panes', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::bar',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        approved: false,
        code: {
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: {
            start: 26,
            end: 29,
            text: "public function bar(): ?int {\n    $x = 'hi';\n    return $x;\n}",
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'nav-host'
      document.body.appendChild(host)
      // Highlight the first change group (the paired signature/return lines).
      Block(b, { activeGroup: () => ({ start: 0, end: 2 }) })(host)
    })

    const host = page.locator('#nav-host')
    // One anchor per pane (first row of the group), so two in total.
    await expect(host.locator('[data-change-active]')).toHaveCount(2)
    // Brighter tints replace the base rose-100/emerald-100 for active rows.
    await expect(host.locator('.bg-rose-200')).toHaveCount(2)
    await expect(host.locator('.bg-emerald-200')).toHaveCount(3)
  })

  test('→ steps into the diff and highlights the first change, ← steps back out', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    // Wait for the selected block's diff to load.
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()

    // No highlight while browsing the list.
    await expect(page.locator('[data-change-active]')).toHaveCount(0)

    // → steps in: the first change of block 0 gets highlighted.
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // ← steps back out: highlight clears.
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('[data-change-active]')).toHaveCount(0)
  })
})
