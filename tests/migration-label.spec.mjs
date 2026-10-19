import { test, expect } from './_fixtures.mjs'

// A Laravel migration's up()/down() is an anonymous-class method, so its own
// label is just "up"/"down" — a PR touching a dozen migrations used to show a
// dozen indistinguishable rows. migrationLabel (Block.mjs) shows a ▲/▼ glyph
// (direction in title/aria-label, never colour alone), the migration's name
// and its date, in the index row AND the card title. b.label itself stays
// "up": comments anchor on it. Fixture: PR 12903
// (database/migrations/2026_07_06_120000_add_type_to_addresses_table.php).
test('a migration up() row and card show glyph, migration name and date', async ({ page }) => {
  await page.goto('/pr/12903')
  const row = page.getByTestId('block-row').nth(0)
  await expect(row.getByTestId('category-pill')).toHaveText('MIGRATION')
  const label = row.getByTestId('migration-label')
  await expect(label.getByTestId('migration-dir')).toHaveText('▲')
  await expect(label.getByTestId('migration-dir')).toHaveAttribute('aria-label', /up/)
  await expect(label.getByTestId('migration-name')).toHaveText('add_type_to_addresses_table')
  await expect(label.getByTestId('migration-date')).toHaveText('2026-07-06')

  await row.click()
  const card = page.getByTestId('detail-panel').locator('article').first()
  await expect(card.getByTestId('migration-name')).toHaveText('add_type_to_addresses_table')
})
