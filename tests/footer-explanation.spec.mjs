import { test, expect } from './_fixtures.mjs'

// The footer shows a short Dutch AI description whenever the focused line or
// group unit contains an if-statement (the explain_code workflow +
// modules/explanations read-model — see the footer watch in home.mjs and
// Footer.mjs). PR 97 (tests/fixtures/explain-blocks.json, worktrees
// materialized by _setup.mjs) has one block whose change introduces an
// if-statement; tests/fixtures/explanations.json pre-seeds the explanations
// for its group (group-2-4) and its if-line (line-2) — a fixture row's empty
// codeHash matches any hash, so no LLM run is needed (the harness forces
// SLASH_CLAUDE=off anyway).
test.describe('PR Review Tree — footer AI description for if-units', () => {
  test('a line/group unit with an if shows the seeded description; one without hides it', async ({
    page,
  }) => {
    await page.goto('/pr/97')
    await expect(page.getByTestId('block-row').first()).toContainText('ExplainAction::execute')

    // Step into the diff: gran 'group', landing on the only change group
    // (group-2-4, the three inserted if-lines) — a multi-row unit, so there is
    // no inline one-line diff, but the group DOES contain an if: the footer
    // shows the seeded group description.
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const footer = page.getByTestId('footer')
    const description = footer.getByTestId('footer-description')
    await expect(description).toBeVisible()
    await expect(description).toContainText('Deze groep introduceert een if-statement')
    // The footer grows (90px → 140px) while the description shows.
    await expect(footer).toHaveClass(/h-\[140px\]/)

    // Refine to 'line': the first changed line is the if-line itself (line-2)
    // — the footer swaps to that unit's own description.
    await page.keyboard.press('f')
    await expect(description).toContainText('Deze conditie controleert of de waarde positief is')

    // The next changed line ($value = 2;) has no if — the description hides
    // and the footer shrinks back to its normal height.
    await page.keyboard.press('ArrowDown')
    await expect(description).toBeHidden()
    await expect(footer).toHaveClass(/h-\[90px\]/)

    // Back up onto the if-line: the description returns (cached read-model,
    // no re-request).
    await page.keyboard.press('ArrowUp')
    await expect(description).toContainText('Deze conditie controleert')
  })

  test('the footer follows a drilled column (its own cursor, not the top-level block)', async ({
    page,
  }) => {
    await page.goto('/pr/97')
    // Only the parent is in the left list; the child is pulled into
    // "Onderliggende code" via the event_listener relation.
    await expect(page.getByTestId('block-row')).toHaveCount(1)
    await expect(page.getByTestId('related-item').first()).toContainText('ExplainChildAction::handle')

    // Enter the parent's diff → the footer shows the parent's group description.
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')
    const description = page.getByTestId('footer').getByTestId('footer-description')
    await expect(description).toContainText('Deze groep introduceert een if-statement')

    // Drill into the child (→ into Onderliggende code, Enter on its first
    // child): the new column owns the keyboard on ITS first change group —
    // the footer swaps to the child's own seeded description.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('drill-column')).toHaveCount(1)
    await expect(description).toContainText('Het onderliggende blok krijgt een if')

    // ← closes the drilled column, focus returns to the parent's diff — and
    // the footer follows back.
    await page.keyboard.press('ArrowLeft')
    await expect(description).toContainText('Deze groep introduceert een if-statement')
  })
})
