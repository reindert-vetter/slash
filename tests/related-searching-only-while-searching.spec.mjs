import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The "zoeken…" pill (data-testid=related-searching, RelatedPanel.mjs) may only
// show for a callresolve/testcovers row that is really `searching`. A row that
// is merely `unresolved` means "the Go resolver could not pin this call" — not
// "a search is running right now".
//
// Reported against a real PR (13431): an answered `notfound` row was dropped
// back to `unresolved` by every rebuild (callresolve.UpsertGo, since narrowed),
// while both search triggers correctly refused to re-ask it — the deterministic
// resolve_call Run ID is idempotent and resolveCallAttempts remembers the
// attempt in the durable workflow history. So the row sat at `unresolved`
// forever, the pill claimed a search was running, and nothing appeared under
// "Taken". A real search still surfaces: the markCallsSearching Activity marks
// its rows `searching` before the LLM call.
//
// Fixture: PR 100's existing call-arrow blocks (tests/fixtures/arrow-blocks.json
// + arrow-callresolve.json, materializeArrowWorktrees in tests/_setup.mjs) with
// one extra injected row, exactly like related-searching-overlap.spec.mjs does.
// The block-level callKey prefix (see isBlockLevelCallKey in home.mjs) keeps the
// row in scope regardless of the diff cursor, without needing a real LLM search.
const CALLER = '100:app/Actions/ArrowCallerAction.php:ArrowCallerAction::execute'

const injectRow = (page, status) =>
  page.route('**/api/callresolve?pr=100', async (route) => {
    const response = await route.fetch()
    const rows = await response.json()
    rows.push({
      pr: 100,
      callerId: CALLER,
      callKey: 'resource:arrowPillProbe',
      status,
      childFile: '',
      childClass: '',
      childMethod: '',
      childLine: 0,
      childCode: '',
    })
    await route.fulfill({ response, json: rows })
  })

// Both cases walk to the same place: the top-level caller's own
// Onderliggende-code panel, where the injected row is in scope.
async function openPanel(page) {
  await page.goto('/pr/100')
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // step into the diff
  await expect(page.getByTestId('related-code')).toBeVisible()
}

test('an unresolved call shows no "zoeken…" pill', async ({ page }) => {
  await injectRow(page, 'unresolved')
  await openPanel(page)

  await expect(page.getByTestId('related-searching')).toHaveCount(0)
  // …and the pill's reserved top strip is gone with it, so the list doesn't
  // keep a dead 36px gap for a pill that never shows.
  const scroller = page.locator('[data-testid=related-code] .overflow-auto').first()
  await expect(scroller).not.toHaveClass(/pt-9/)
})

test('a searching call still shows the "zoeken…" pill', async ({ page }) => {
  await injectRow(page, 'searching')
  await openPanel(page)

  await expect(page.getByTestId('related-searching')).toBeVisible()
  const scroller = page.locator('[data-testid=related-code] .overflow-auto').first()
  await expect(scroller).toHaveClass(/pt-9/)
})
