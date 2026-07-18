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
  // with no if-statement: neither the inline one-line diff (footerUnit, the
  // group spans 2 rows) nor the AI description (footerExplain, no "if" in the
  // text) has anything to show — state.footerVisible stays false. The footer
  // bar must disappear entirely (not just its content), and the panels that
  // reserve space for it (<main>, the comments/taken sidebar rail) must fall
  // back to their no-reservation bottom-6, not the old always-90px floor.
  test('a multi-row group with no if hides the footer bar AND its reserved space', async ({ page }) => {
    await page.goto('/pr/97')
    const row = page.getByTestId('block-row').filter({ hasText: 'ExplainNoIfAction::execute' })
    await expect(row).toBeVisible()
    await page.keyboard.press('Escape')
    await row.click()

    const footer = page.getByTestId('footer')
    await expect(footer).toBeHidden() // list mode: footer never shows anyway

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // The only change group is the 2-line reassignment, with no if — the
    // footer bar (and its description/inline-diff content) stays hidden even
    // though a diff is open, unlike the old state.mode==='diff'-only rule.
    await expect(footer).toBeHidden()
    await expect(footer.getByTestId('footer-description')).toBeHidden()

    // No reserved bottom strip: <main> (detail-panel) falls back to bottom-6
    // instead of the old always-at-least-90px floor.
    await expect(page.getByTestId('detail-panel')).toHaveClass(/bottom-6\b/)
    await expect(page.getByTestId('detail-panel')).not.toHaveClass(/bottom-\[90px\]/)
    await expect(page.getByTestId('detail-panel')).not.toHaveClass(/bottom-\[140px\]/)

    // The comments/taken sidebar's collapsed hint-rail mirrors the same rule.
    await expect(page.getByTestId('sidebar-collapsed')).toHaveClass(/bottom-6\b/)
  })
})
