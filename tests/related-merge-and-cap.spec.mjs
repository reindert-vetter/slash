import { test, expect } from './_fixtures.mjs'

// PR 14092 froze the tab: config/country_states.php referenced 1126 enum cases,
// each resolving to the SAME large enum, so the Onderliggende-code panel rendered
// 1126 cards x ~1100 highlighted lines (~10M DOM nodes). Identical read-only
// children now merge into one card, a card shows at most 100 lines until the
// cursor is on it, and the list is capped at 50 cards with a "+N meer" line.
// Driven through a mocked /api/callresolve on PR 91's AlphaAction::run.
const ENUM = Array.from({ length: 400 }, (_, i) => `    case C${i} = 'c${i}';`).join('\n')

function rows() {
  const out = []
  for (let i = 0; i < 300; i++)
    out.push({
      pr: 91,
      callerId: '91:app/Actions/AlphaAction.php:AlphaAction::run',
      callKey: 'C' + i,
      status: 'resolved',
      childFile: 'app/Enums/Big.php',
      childClass: 'Big',
      childMethod: 'C' + i,
      childLine: 3,
      childCode: ENUM,
    })
  for (let i = 0; i < 80; i++)
    out.push({
      pr: 91,
      callerId: '91:app/Actions/AlphaAction.php:AlphaAction::run',
      callKey: 'm' + i,
      status: 'resolved',
      childFile: `app/Services/S${i}.php`,
      childClass: 'S' + i,
      childMethod: 'm' + i,
      childLine: 5,
      childCode: `public function m${i}(): int\n{\n    return ${i};\n}`,
    })
  return out
}

test('identical children merge, long code is an excerpt until selected, the list is capped', async ({ page }) => {
  await page.route('**/api/callresolve?pr=91', (route) => route.fulfill({ json: rows() }))
  await page.goto('/pr/91')
  await page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' }).click()

  const items = page.getByTestId('related-item')
  // 1 merged enum card + 80 distinct = 81 -> capped at 50.
  await expect(items).toHaveCount(50)
  await expect(page.getByTestId('related-more')).toContainText('+31')
  const merged = items.filter({ hasText: '300 verwijzingen' })
  await expect(merged).toHaveCount(1)

  // Not selected: at most 100 lines plus the "+N regels" marker.
  await expect(merged).toContainText('+300 regels')
  await expect(merged).not.toContainText('C399')

  // Moving the cursor onto the card renders the whole code.
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('ArrowRight') // diff -> Onderliggende code
  await expect(merged).toHaveAttribute('data-active', 'true')
  await expect(merged).toContainText('C399')
})
