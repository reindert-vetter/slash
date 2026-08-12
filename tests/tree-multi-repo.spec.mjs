import { test, expect, appReady, evaluateSettled } from './_fixtures.mjs'

// The review tree of a SECOND repository. Its URL carries the repo name —
// /pr/plug-and-pay-ops/12 — while the primary repo keeps the historical
// /pr/<n> (Reindert's choice: a URL is read by humans, the short internal key is
// not). Everything below that follows from it: every per-PR request carries
// `repo=`, and the server scopes its rows by (repo, number) — see repos.go.
//
// The fixture is plug-and-pay-ops#12 (tests/fixtures/ops-blocks.json + the
// ops-pr-12-base/head worktrees from _setup.mjs). Its PR NUMBER, 12, deliberately
// does not exist in the primary repo's seeded data: if the repo scoping were
// dropped, this page would simply come up empty instead of quietly showing the
// wrong PR.
test.describe('PR Review Tree — a second repository', () => {
  test('opens at /pr/<repo-name>/<n> and renders that repo\'s blocks', async ({ page }) => {
    await page.goto('/pr/plug-and-pay-ops/12')
    await appReady(page)

    // Not bounced to the overview (which is what an unparsable path does).
    await expect(page).toHaveURL(/\/pr\/plug-and-pay-ops\/12/)

    const rows = page.locator('[data-testid="block-row"]')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('import')
  })

  // The block id carries the repo's key, so it can never collide with the primary
  // repo's PR 12 — the whole reason the prefix exists (see Block.ID in model.go).
  test('its blocks are keyed by repo+PR', async ({ page }) => {
    await page.goto('/pr/plug-and-pay-ops/12')
    await appReady(page)

    const ids = await evaluateSettled(page, async () => {
      const res = await fetch('/api/blocks?pr=12&repo=plug-and-pay-ops')
      const list = await res.json()
      return list.map((b) => b.id)
    })
    expect(ids).toEqual(['ops#12:app/Services/MollieCapitalImporter.php:MollieCapitalImporter::import'])

    // And the primary repo's PR 12 has nothing at all — proving the scoping is
    // real and not just a cosmetic prefix.
    const primary = await evaluateSettled(page, async () => {
      const res = await fetch('/api/blocks?pr=12')
      return (await res.json()).length
    })
    expect(primary).toBe(0)
  })

  // The diff comes from that repo's OWN worktrees ("ops-pr-12-base|head"), which
  // is the layout the server derives from the repo key.
  test('its code diff is read from the second repo\'s worktrees', async ({ page }) => {
    await page.goto('/pr/plug-and-pay-ops/12')
    await appReady(page)

    const code = await evaluateSettled(page, async () => {
      const res = await fetch(
        '/api/code?pr=12&repo=plug-and-pay-ops&file=' +
          encodeURIComponent('app/Services/MollieCapitalImporter.php') +
          '&class=MollieCapitalImporter&name=import',
      )
      return await res.json()
    })
    expect(String(code.old.text || code.old)).toContain('$rows = 1')
    expect(String(code.new.text || code.new)).toContain('$rows = 2')
  })
})
