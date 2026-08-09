import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// MAX_EXPLAIN_LINES (home.mjs, footerUnitInfo) — Reindert's explicit answer to
// "how big may the automatically-sent AI-explanation context become for a
// Shift+arrow range": "Uitleg maximaal 10 regels". An ordinary 'group' unit is
// already capped at 5 rows (MAX_GROUP, changeGroups), but a Shift+arrow range
// (rangeUnit) has no such ceiling of its own — it can merge arbitrarily many
// groups. This is deliberately front-end only and does NOT apply to the
// Claude-chat context (claudeContextBlock, RelatedPanel.mjs): that only ever
// sends on an explicit reviewer send, unlike this debounced, keypress-free
// auto-trigger (explain_code).
//
// PR 116 (tests/fixtures/explainrange-blocks.json, worktree materialized in
// _setup.mjs's materializeExplainRangeWorktrees): ExplainRangeAction::execute
// has THREE separate 2-row change groups ($a/$b, $c/$d, $e/$f), each split
// from the next by a 3-row unchanged filler run — merging the first two
// groups spans 7 rows (≤10, pre-seeded in tests/fixtures/explanations.json
// under unitKey "group-2-8" so no LLM run is needed), merging all three spans
// 12 rows (>10).
test.describe('PR Review Tree — the automatic AI-explanation stays capped at 10 rows for a Shift+arrow range', () => {
  test('a merged 2-group range (7 rows) still gets the seeded description; adding the 3rd group (12 rows) hides it', async ({
    page,
  }) => {
    await page.goto('/pr/116')
    await expect(page.getByTestId('block-row').first()).toContainText('ExplainRangeAction::execute')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // execute's diff, gran 'group', default unit = the first group ($a/$b)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const footer = page.getByTestId('footer')
    const description = footer.getByTestId('footer-description')
    // The lone first group (2 rows) has no seeded row of its own — no
    // description yet (and, since it's under the cap, this would otherwise
    // auto-request one; SLASH_CLAUDE=off in the harness makes that a no-op
    // either way, this assertion is just the starting state).
    await expect(description).toBeHidden()

    // Merge in the second group: range now spans rows [2,8] (7 rows) — at/under
    // the cap, so the pre-seeded explanation for "group-2-8" shows.
    await page.keyboard.press('Shift+ArrowDown')
    await expect(description).toBeVisible()
    await expect(description).toContainText('Deze twee samengevoegde groepen wijzigen a, b, c en d.')

    // Merge in the third group too: range now spans rows [2,13] (12 rows) —
    // over the cap. The footer must show nothing at all here, not a
    // "genereren…" placeholder for a request that was never made.
    await page.keyboard.press('Shift+ArrowDown')
    await expect(description).toBeHidden()
    await expect(description).not.toContainText('genereren')

    // The diff preview itself (unrelated to the explain cap) still follows
    // the full 3-group range — the footer keeps showing a per-line diff
    // regardless of the AI-description cap.
    await expect(footer.getByTestId('footer-diff')).toBeVisible()

    // Collapsing back to a plain 2-group range (one ArrowUp un-does the last
    // Shift extension's cursor step) restores the seeded description —
    // proving the earlier hide really was the cap, not a one-shot failure.
    await page.keyboard.press('Shift+ArrowUp')
    await expect(description).toBeVisible()
  })
})
