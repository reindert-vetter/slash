import { test, expect, appReady } from './_fixtures.mjs'

// The block card's description strip (Block.mjs's `block-description`) is
// capped at 2 visual lines and is its own keyboard stop inside stop 3: it is
// NOT focused when you step into a block, ↑ from the block's first change lands
// on it as one extra step, Enter there opens it to its full text, and ↓ goes
// back down into the diff. Reviewer request: "omschrijving boven blok moet
// maximaal uit 2 regels zijn (ook na wrapped). het moet niet gelijk
// geselecteerd zijn als ik een blok open, maar ik moet naar boven kunnen en dat
// moet dan een extra stap zijn ... dan wil ik het kunnen uitklappen, dan wil ik
// ook weer naar beneden kunnen".
//
// PR 117 is the fixture (tests/fixtures/description-blocks.json) — the one
// block with a real, multi-paragraph description.
test('the block description is capped at 2 lines and is an extra ↑ stop that Enter expands', async ({
  page,
}) => {
  await page.goto('/pr/117')
  await appReady(page)

  const strip = page.getByTestId('block-description-strip')
  await expect(strip).toBeVisible()

  // Capped by default, and NOT focused just because the block is open.
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'true')
  await expect(strip).toHaveAttribute('data-desc-focused', 'false')
  await expect(page.getByTestId('block-description')).toHaveClass(/line-clamp-2/)
  // "Meer …" plus a round badge holding the total number of lines in the
  // raw description (3: two sentences separated by a blank line) — see
  // descriptionLineCount in Block.mjs.
  await expect(page.getByTestId('block-description-toggle')).toHaveText('Meer … 3')

  // "Maximaal 2 regels" is a real height, not just a class: two lines of this
  // 14px/leading-relaxed text measure ~45.5px, so anything under 50 is two
  // lines or fewer — and the full text is genuinely taller than that (asserted
  // after Enter below).
  const cappedHeight = (await page.getByTestId('block-description').boundingBox()).height
  expect(cappedHeight).toBeLessThan(50)

  // Stepping into the diff still doesn't select it.
  await page.keyboard.press('ArrowRight')
  await expect(strip).toHaveAttribute('data-desc-focused', 'false')

  // ↑ off the block's first change is the extra step onto the strip.
  await page.keyboard.press('ArrowUp')
  await expect(strip).toHaveAttribute('data-desc-focused', 'true')
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'true')

  // Enter opens it to its full text instead of opening the block palette.
  await page.keyboard.press('Enter')
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'false')
  await expect(page.getByTestId('block-description')).not.toHaveClass(/line-clamp-2/)
  await expect(page.getByTestId('block-description-toggle')).toHaveText('Inklappen')
  const fullHeight = (await page.getByTestId('block-description').boundingBox()).height
  expect(fullHeight).toBeGreaterThan(cappedHeight)
  await expect(page.getByTestId('command-menu')).toHaveCount(0)

  // ↓ goes back down into the diff; the strip stays expanded.
  await page.keyboard.press('ArrowDown')
  await expect(strip).toHaveAttribute('data-desc-focused', 'false')
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'false')

  // A click on the strip is the mouse twin of that Enter: it focuses AND
  // toggles (here: back to the 2-line cap).
  await strip.click()
  await expect(strip).toHaveAttribute('data-desc-focused', 'true')
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'true')
})
