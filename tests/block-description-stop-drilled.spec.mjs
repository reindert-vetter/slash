import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The block-description strip (see block-description-stop.spec.mjs for the
// top-level case) used to be scoped to the top level only (focusLevel === 0)
// — a deliberate limit that this test proves is now lifted for a drilled
// Onderliggende-code column too. Reviewer report, against a drilled child
// carrying a "meer… (Enter)" description strip: "als ik hier naar boven druk,
// moet meer... (Enter) geselecteerd worden, ik moet daar enter op kunnen
// drukken. als ik daarna nog een keer naar boven ga, moet het zoals normaal
// soms naar bovenstaande blok kunnen gaan".
//
// Same PR 95 tree fixture as drill-approve.spec.mjs (TreeParentAction::execute
// → its child TreeChildAction::run, shown in "Onderliggende code"); the child
// now carries a long-enough description to be collapsible.
test('↑ off a drilled column\'s first unit reaches its own description strip, Enter expands it, a second ↑ continues the sibling walk', async ({
  page,
}) => {
  await page.goto('/pr/95')
  await page.locator('[data-idx="0"]').click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // into the parent's diff
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await page.keyboard.press('ArrowRight') // into the Onderliggende-code panel

  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('TreeChildAction::run')
  await child.click() // drill in

  const drill = page.getByTestId('drill-column')
  await expect(drill).toHaveCount(1)
  const strip = drill.getByTestId('block-description-strip')
  await expect(strip).toBeVisible()
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'true')
  await expect(strip).toHaveAttribute('data-desc-focused', 'false')
  // The fixture description (tests/fixtures/tree-blocks.json) is one single
  // line, so the round badge next to "Meer …" reads 1.
  await expect(drill.getByTestId('block-description-toggle')).toHaveText('Meer … 1')

  // ↑ off the drilled column's first (only) change lands on its own strip.
  await page.keyboard.press('ArrowUp')
  await expect(strip).toHaveAttribute('data-desc-focused', 'true')

  // Enter expands it to the full text, same as the top-level stop.
  await page.keyboard.press('Enter')
  await expect(strip).toHaveAttribute('data-desc-collapsed', 'false')
  await expect(drill.getByTestId('block-description-toggle')).toHaveText('Inklappen')
  await expect(page.getByTestId('command-menu')).toHaveCount(0)

  // ↓ releases the strip back onto the drilled diff.
  await page.keyboard.press('ArrowDown')
  await expect(strip).toHaveAttribute('data-desc-focused', 'false')
  await expect(drill).toHaveCount(1)

  // ↑ again reaches the strip, and a SECOND ↑ continues past it: this child
  // has no previous sibling of its own, so it just clamps — the drilled
  // column stays open, exactly what drillPrevChange already does at an edge.
  await page.keyboard.press('ArrowUp')
  await expect(strip).toHaveAttribute('data-desc-focused', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(strip).toHaveAttribute('data-desc-focused', 'false')
  await expect(drill).toHaveCount(1)
  await expect(page.locator('[data-change-active]').first()).toBeVisible()

  // ← from the focused strip closes the drilled column back into its parent,
  // mirroring the ordinary (non-strip) ← handling.
  await page.keyboard.press('ArrowUp')
  await expect(strip).toHaveAttribute('data-desc-focused', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('drill-column')).toHaveCount(0)
})
