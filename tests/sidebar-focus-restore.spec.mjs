import { test, expect } from './_fixtures.mjs'

// Verifies: `g`-out (← leaving the comments/taken sidebar back to the diff)
// followed by `g`-back-in restores the last comment/thread spot instead of
// resetting to the composer row (row 0) — see restoreLastSidebarFocus /
// lastSidebarFocus in RelatedPanel.mjs and the "Comments/taken-sidebar"
// section in detail-layout.md. Within-session only, no URL/cookie involved.
test.describe('comments sidebar — g restores last focus within a session', () => {
  const pr = 970003

  async function placeComment(page, body) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body, code: '$x;', gran: 'call', label: 'X::y' },
    })
    expect(res.ok()).toBeTruthy()
  }

  test('g out then g back lands on the same comment row, not the composer', async ({ page }) => {
    await placeComment(page, 'eerste comment')
    await placeComment(page, 'tweede comment')

    await page.goto('/pr/' + pr)
    await page.keyboard.press('Escape') // leave the auto-focused search box

    // Open the sidebar and select the *second* comment row.
    await page.keyboard.press('g')
    const items = page.getByTestId('comment-item')
    await expect(items).toHaveCount(2)
    await items.nth(1).click()
    await expect(items.nth(1)).toHaveClass(/ring-indigo-200/)

    // Leave the sidebar back to the diff (← from any sidebar spot, sidebar
    // stays open) — a fresh `g` press would previously reset to row 0.
    await page.keyboard.press('ArrowLeft')

    await page.keyboard.press('g')
    await expect(items.nth(1)).toHaveClass(/ring-indigo-200/)
    // The composer row (index 0 in the flat row-walk) must NOT be the one
    // that's active — that would mean it fell back to the default landing.
    await expect(items.nth(0)).not.toHaveClass(/ring-indigo-200/)
  })

  test('a second g still closes the sidebar right away after a restore', async ({ page }) => {
    await placeComment(page, 'derde comment')
    await page.goto('/pr/' + pr)
    await page.keyboard.press('Escape')

    await page.keyboard.press('g')
    const item = page.getByTestId('comment-item').last()
    await item.click()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('g') // restores onto the comment row
    await page.keyboard.press('g') // must close, not type a literal "g"
    await expect(page.getByTestId('sidebar-collapsed')).toBeVisible()
  })
})
