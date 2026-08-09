import { test, expect, appReady } from './_fixtures.mjs'

// The block card's description strip (Block.mjs) renders b.description as
// MARKDOWN, not as one plain-text run. Two things depend on that:
//
//  - phpDocDescription (phpscan.go) keeps the docblock's paragraph breaks as
//    "\n\n" — flattening them turned a well-structured docblock into an
//    unreadable wall of text, which is exactly what item 1 of this batch was
//    about (Reindert: "blok-description mooier");
//  - a PHPDoc's prose routinely backticks identifiers/command names, which
//    should read as inline code like every other body in this app.
//
// PR 117 is the fixture (tests/fixtures/description-blocks.json).
test('a block description renders as markdown paragraphs, not one plain-text run', async ({
  page,
}) => {
  await page.goto('/pr/117')
  await appReady(page)

  const desc = page.getByTestId('block-description')
  await expect(desc).toBeVisible()

  // Two real <p> elements — the "\n\n" survived all the way to the DOM.
  await expect(desc.locator('p')).toHaveCount(2)
  await expect(desc.locator('p').first()).toContainText('Imports the nightly statistics')
  await expect(desc.locator('p').nth(1)).toContainText('nightly window')

  // The backticked command name became inline code, not literal backticks.
  await expect(desc.locator('code')).toHaveText('pay:contracts-due')
  await expect(desc).not.toContainText('`pay:contracts-due`')
})
