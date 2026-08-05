import { test, expect, appReady } from './_fixtures.mjs'

// Regression test for: "ingest-btn" (the "Ingest #<pr>" button in the empty
// block list, BlockList.mjs's emptyState) used to only be dimmed with
// `?disabled=` while state.ingesting — an arrow.js binding that silently
// does nothing (it sets a literal attribute named "?disabled", never the
// real `disabled`). A stray extra click during ingest could thus fire a
// second POST /api/ingest for the same PR.
//
// PR 900001 is a number never seeded by any fixture/worktree (see
// tests/_setup.mjs) — the real, unmocked GET /api/blocks?pr=900001 simply
// comes back empty, which is exactly the "No blocks ingested yet." state
// this button exists for. No approval is ever written here, so this PR
// doesn't need to join tests/_fixtures.mjs's APPROVAL_RESET_PRS list.
test.describe('PR Review Tree — ingest button', () => {
  test('ingest-btn is really disabled while ingesting, not just dimmed', async ({ page }) => {
    let ingestCalls = 0
    let resolveIngest
    const ingestDone = new Promise((resolve) => {
      resolveIngest = resolve
    })
    await page.route('**/api/ingest', async (route) => {
      ingestCalls++
      await ingestDone
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    await page.goto('/pr/900001')
    await appReady(page)

    const ingestBtn = page.locator('[data-testid="ingest-btn"]')
    await expect(ingestBtn).toBeVisible()
    await expect(ingestBtn).toBeEnabled()

    await ingestBtn.click()

    await expect(ingestBtn).toHaveText(/Ingesting…/)
    // Really disabled (a native `disabled` attribute) — a stray extra click
    // can't start a second ingest of the same PR while one is already in
    // flight. See the ?disabled= vs disabled= note in
    // .claude/rules/conventions.md.
    await expect(ingestBtn).toBeDisabled()
    await expect(ingestBtn.click({ trial: true, timeout: 500 })).rejects.toThrow()

    resolveIngest()
    await expect.poll(() => ingestCalls).toBe(1)
  })

  // Regression for: onKeydown's `if (state.blocks.length === 0) return` guard
  // used to sit BEFORE the state.showDescription ArrowRight/ArrowLeft branch,
  // so a genuinely block-less PR (nothing ingested yet — state.blocks really
  // is empty here, unlike the "everything approved" case in
  // fresh-open-default-selection.spec.mjs, where state.blocks keeps every
  // block regardless of approval) could never close or exit stop 1: the empty
  // guard ate the key first. See .claude/docs/keyboard-navigation.md.
  test('stop 1 still closes/exits on a genuinely block-less PR (state.blocks.length === 0)', async ({
    page,
  }) => {
    // keepDescription: true — see the _fixtures.mjs goto() wrapper's own
    // comment: it otherwise auto-presses ArrowRight to skip stop 1, which
    // hit this very bug too (silently, via its own `.catch(() => {})`).
    await page.goto('/pr/900001', { keepDescription: true })
    await appReady(page)

    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    // Lands on the empty state (nothing ingested yet) — a sensible landing
    // spot: the ingest button is the one actionable thing there.
    await expect(page.getByTestId('pr-info-column')).toHaveCount(0)
    await expect(page.locator('[data-testid="ingest-btn"]')).toBeVisible()
  })

  // Mirror of the above for ←, checked separately (a fresh page instead of
  // continuing from the ArrowRight above) since the block-less index has no
  // block/search context to walk back out of first.
  test('← on stop 1 still exits to /pr-overview on a genuinely block-less PR', async ({ page }) => {
    await page.goto('/pr/900001', { keepDescription: true })
    await appReady(page)

    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(/\/pr-overview/)
  })
})
