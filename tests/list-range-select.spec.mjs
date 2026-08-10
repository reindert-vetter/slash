import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Shift+ArrowDown/ArrowUp in the block index (and in the methodes-kolom)
// selects several rows at once — state.listAnchor/methodAnchor, the sidebar
// twin of the diff's own Shift+arrow line range (see extendListRange/
// extendMethodRange in home.mjs). Enter then opens a palette scoped to the
// whole selection, and Space approves it in one press.
//
// The tint marks the whole selection while the `›` marker stays on the cursor
// row alone, so shape — not a second colour — says where the arrows move from.
test.describe('PR Review Tree — Shift+arrow multi-row selection in the index', () => {
  test('Shift+↓ selects a range, the palette approves it in one action, and a plain arrow collapses it', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const rows = page.getByTestId('block-row')
    const selected = page.locator('[data-testid=block-row].bg-indigo-50')
    await expect(rows.first()).toHaveClass(/bg-indigo-50/)
    await expect(selected).toHaveCount(1)

    // Two Shift+↓ steps: three rows selected, cursor on the third.
    await page.keyboard.press('Shift+ArrowDown')
    await expect(selected).toHaveCount(2)
    await page.keyboard.press('Shift+ArrowDown')
    await expect(selected).toHaveCount(3)

    // Exactly one row carries the `›` cursor marker — the third.
    const markers = page.locator('[data-testid=block-row] span.text-indigo-500')
    await expect(markers).toHaveCount(1)

    // The palette is scoped to the selection: approve/comment/chat, all
    // naming the count — "Ignore" is absent here since none of these three
    // rows is a PR-comment index item (see tests/list-range-actions.spec.mjs
    // for that case).
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const cmdRows = page.getByTestId('command-row')
    await expect(cmdRows).toHaveCount(4)
    await expect(cmdRows.nth(0)).toContainText('Sluit menu')
    await expect(cmdRows.nth(1)).toContainText('Keur deze 3 blokken goed')
    await expect(cmdRows.nth(2)).toContainText('Plaats comment over deze 3 blokken')
    await expect(cmdRows.nth(3)).toContainText('Chat met Claude over deze 3 blokken')
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // A plain (non-shift) arrow collapses the selection back to one row.
    await page.keyboard.press('ArrowDown')
    await expect(selected).toHaveCount(1)

    // Shift+↑ works the same way in the other direction.
    await page.keyboard.press('Shift+ArrowUp')
    await expect(selected).toHaveCount(2)
    // …and clicking a row is a plain single-row choice again.
    await rows.nth(0).dispatchEvent('click')
    await expect(selected).toHaveCount(1)
  })

  test('Space approves every block of the selection at once', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const blockId = (name) => `102:app/Actions/RangeSelectAction.php:RangeSelectAction::${name}`
    // Start from a known-empty approval state for both blocks.
    const start = await page.request.post('/api/workflows/approve', { data: { pr: 102 } })
    const { runId } = await start.json()
    for (const name of ['execute', 'other']) {
      await page.request.post(`/api/workflows/${runId}/signals/set`, {
        data: { blockId: blockId(name), rows: [], calls: [] },
      })
    }
    await page.reload()
    await leaveSearchBox(page)

    const selected = page.locator('[data-testid=block-row].bg-indigo-50')
    await expect(selected).toHaveCount(1)
    await page.keyboard.press('Shift+ArrowDown') // both blocks of this PR
    await expect(selected).toHaveCount(2)

    await page.keyboard.press('Space')

    // Both blocks end up fully approved — one approve Signal per block, the
    // ordinary single-block write path.
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/approvals?pr=102')).json()
        if (!Array.isArray(list)) return 0
        return ['execute', 'other'].filter((n) => {
          const row = list.find((r) => r.blockId === blockId(n))
          return row && Array.isArray(row.rows) && row.rows.length > 0
        }).length
      })
      .toBe(2)
  })

  test('Escape collapses the selection, and an action on it leaves it standing', async ({ page }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const selected = page.locator('[data-testid=block-row].bg-indigo-50')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(selected).toHaveCount(2)

    // Escape drops the selection straight away, with no menu/action involved.
    await page.keyboard.press('Escape')
    await expect(selected).toHaveCount(1)

    // Running an action on the selection (via the palette) does NOT clear it
    // by itself — the tint stays exactly as-is until the reviewer explicitly
    // moves on (a plain arrow, a click, Escape, …), even once the menu that
    // ran it has closed again. Uses "Plaats comment" rather than "Keur ...
    // goed" here — approving these two blocks would fully approve (and thus
    // hide, see "Hidden (approved) blocks" in keyboard-navigation.md) one of
    // them, which would drop the visible tint count as a side effect of the
    // approval itself, not of the selection being cleared.
    await page.keyboard.press('Shift+ArrowDown')
    await expect(selected).toHaveCount(2)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Plaats comment over deze 2 blokken' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(page.getByTestId('comment-compose')).toBeFocused()
    await expect(selected).toHaveCount(2)

    // Escape first backs out of the just-opened composer (relatedActive()'s
    // own Escape handling), THEN a second Escape clears the still-standing
    // selection.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(selected).toHaveCount(1)
  })

  test('the methodes-kolom takes the same gesture over its own methods', async ({ page }) => {
    await page.goto(`/pr/110`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
    await page.keyboard.press('ArrowRight') // focus the methodes-kolom

    const methodRows = page.getByTestId('test-method-row')
    const selectedMethods = page.locator('[data-testid=test-method-row].bg-indigo-50')
    await expect(methodRows.first()).toBeVisible()
    await expect(selectedMethods).toHaveCount(1)

    await page.keyboard.press('Shift+ArrowDown')
    await expect(selectedMethods).toHaveCount(2)
    // Again exactly one cursor marker.
    await expect(page.locator('[data-testid=test-method-row] span.text-indigo-500')).toHaveCount(1)

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur deze 2 methodes goed')
    await page.keyboard.press('Escape')

    // A plain arrow collapses it again.
    await page.keyboard.press('ArrowUp')
    await expect(selectedMethods).toHaveCount(1)
  })
})
