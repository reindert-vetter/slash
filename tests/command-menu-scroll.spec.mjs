import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// The command-list box is a fixed max-h-72 with its scrollbar hidden
// (no-scrollbar, CommandMenu.mjs) — arrowing down into a long enough list
// used to leave the highlighted row genuinely below the fold, with nothing
// scrolling it into view. See "The highlighted row scrolls itself into view
// on ↑/↓" in .claude/docs/command-palette.md.
//
// A PR-wide, local, AI-authored finding's own action menu is long enough to
// overflow on its own (Sluit menu, Beantwoorden, Resolve comment, Verwijder
// comment, Comment hiervan maken, Chat met Claude, Zet op GitHub, Ignore =
// 8 rows) — the exact shape tests/convert-warning-to-comment.spec.mjs also
// seeds.
test('arrowing down through a long prComment menu keeps the highlighted row inside the visible list', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'app/Http/Controllers/Api/ContractController.php',
      line: 1,
      author: 'AI check',
      body: 'Dit endpoint valideert de invoer niet.',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('comment-detail-card')).toBeVisible()

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  const rows = menu.getByTestId('command-row')
  await expect(rows).toHaveCount(8)

  const list = page.getByTestId('command-list')
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('ArrowDown')
  }
  // The last row (index 7, "Ignore") is now selected and must be fully
  // within the scrollable list's own bounding box — not clipped below it.
  const lastRow = rows.nth(7)
  await expect(lastRow).toContainText('Ignore')
  await expect(lastRow).toHaveClass(/bg-indigo-50/)
  const listBox = await list.boundingBox()
  const rowBox = await lastRow.boundingBox()
  expect(rowBox.y).toBeGreaterThanOrEqual(listBox.y - 1)
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
})
