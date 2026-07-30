import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for a reported layout bug: the "zoeken…" pill
// (data-testid=related-searching, RelatedPanel.mjs) is position:absolute
// (right-2 top-2 z-10) on the Onderliggende-code <section>, so it takes no
// flow space of its own. Without reserved room, it sat directly on top of
// the FIRST child card's own right-aligned header badges
// (related-diffstat/related-approval) — reported as "+22 −0"/"19/21" reading
// through the semi-transparent pill.
//
// Reuses PR 100's existing call-arrow fixture (tests/fixtures/arrow-blocks.json
// + arrow-callresolve.json, materializeArrowWorktrees in tests/_setup.mjs).
// The top-level ArrowCallerAction::execute's own Onderliggende-code panel
// isn't a good repro on its own: its top card (ArrowHelperService::arrowHelper)
// itself has a changed grandchild (ArrowNestedService::arrowNested), so it
// grows a drill-hint chip column of its own that narrows the card and moves
// its header badges away from the section's right edge. Drilling one level
// deeper — into arrowHelper itself — shows arrowNested as the (chip-less,
// full-width) top card instead, whose diffstat/approval badges land exactly
// under the pill's top-right corner: the reproducing case.
//
// The extra "searching" callresolve row uses a block-level callKey prefix
// (see isBlockLevelCallKey in home.mjs) so it stays in scope regardless of
// the drilled column's own diff cursor, without depending on a real LLM
// search ever running.
test('the "zoeken…" indicator does not overlap the top card\'s header badges', async ({ page }) => {
  await page.route('**/api/callresolve?pr=100', async (route) => {
    const response = await route.fetch()
    const rows = await response.json()
    rows.push({
      pr: 100,
      callerId: '100:app/Services/ArrowHelperService.php:ArrowHelperService::arrowHelper',
      callKey: 'resource:arrowStillSearching',
      status: 'searching',
      childFile: '',
      childClass: '',
      childMethod: '',
      childLine: 0,
      childCode: '',
    })
    await route.fulfill({ response, json: rows })
  })

  await page.goto('/pr/100')
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // step into the diff

  const helperChild = page.getByTestId('related-item').first()
  await expect(helperChild).toContainText('arrowHelper')
  await helperChild.click() // drill into arrowHelper

  const item = page.getByTestId('related-item').first()
  await expect(item).toContainText('arrowNested')
  const diffstat = item.getByTestId('related-diffstat')
  const approval = item.getByTestId('related-approval')
  await expect(diffstat).toBeVisible()
  await expect(approval).toBeVisible()

  const pill = page.getByTestId('related-searching')
  await expect(pill).toBeVisible()

  const pillBox = await pill.boundingBox()
  const diffstatBox = await diffstat.boundingBox()
  const approvalBox = await approval.boundingBox()

  const overlaps = (a, b) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

  expect(overlaps(pillBox, diffstatBox)).toBe(false)
  expect(overlaps(pillBox, approvalBox)).toBe(false)
})
