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
    // (group-2-4, the three inserted if-lines) — a multi-row unit, so the
    // footer's inline diff now covers all three rows, and the group also
    // contains an if: the footer shows the seeded group description too.
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
    // The parent + ExplainNoIfAction (unrelated, see the test below) are in
    // the left list; the child is pulled into "Onderliggende code" via the
    // event_listener relation.
    await expect(page.getByTestId('block-row')).toHaveCount(2)
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

  // ExplainNoIfAction's one change group is a plain, multi-line reassignment
  // with no if-statement: the AI description (footerExplain, no "if" in the
  // text) has nothing to show, but the inline diff (footerUnit) now covers
  // the WHOLE group — one row per changed line, not just a single-liner — so
  // the footer bar shows and reserves its 90px strip even without a
  // description.
  test('selecting a multi-row group shows a per-line inline diff in the footer', async ({ page }) => {
    await page.goto('/pr/97')
    const row = page.getByTestId('block-row').filter({ hasText: 'ExplainNoIfAction::execute' })
    await expect(row).toBeVisible()
    await page.keyboard.press('Escape')
    await row.click()

    const footer = page.getByTestId('footer')
    await expect(footer).toBeHidden() // list mode: footer never shows anyway

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // The only change group is the 2-row reassignment ("$value = 1;" → "$value
    // = 2;" paired on row 1, "$extra = 3;" a lone insert on row 2) — no
    // if-statement, so no description, but the footer now shows regardless,
    // with one line pair per row: 2 del/ins divs for the paired row, plus 1
    // ins-only div for the added row = 3 diff lines total.
    await expect(footer).toBeVisible()
    await expect(footer.getByTestId('footer-description')).toBeHidden()
    const footerDiff = footer.getByTestId('code-diff')
    await expect(footerDiff.locator('div.block')).toHaveCount(3)
    await expect(footerDiff).toContainText('$value = 1;')
    await expect(footerDiff).toContainText('$value = 2;')
    await expect(footerDiff).toContainText('$extra = 3;')

    // Reserved bottom strip: just the 90px inline-diff floor, no description
    // so no 140px.
    await expect(page.getByTestId('detail-panel')).toHaveClass(/bottom-\[90px\]/)
    await expect(page.getByTestId('detail-panel')).not.toHaveClass(/bottom-\[140px\]/)
    await expect(page.getByTestId('detail-panel')).not.toHaveClass(/bottom-6\b/)
  })
})
