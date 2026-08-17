import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression for a reported bug: the pr-index (<aside>, BlockList.mjs) used to
// be its own independent `position:fixed` panel that only avoided overlapping
// <main> because <main> separately, manually computed a `left-[Nrem]` offset
// that happened to match the index's own width — hiding the index relied on a
// translate-x/opacity trick that never actually gave its layout space back.
// Any state where those two hand-synced numbers drifted (or a transient
// mid-animation frame) let a diff/comment column render PARTLY BEHIND the
// index instead of beside it. AppColumns (home.mjs) now mounts PrInfoPanel/
// <aside>/<main> as real flex siblings in one row, so this can no longer
// happen by construction — see "Columns instead of independently fixed
// panels" in detail-layout.md.
function mockComments(page) {
  const now = new Date().toISOString()
  const comments = [
    {
      id: 'anchored-1',
      runId: 'run-anchored-1',
      pr: 12903,
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      line: 1,
      author: 'reviewer',
      body: 'Overall this looks great, one nit below. Zorg ervoor dat we de twee charset-regels ook meenemen, anders CREATE TABLE gaat mis.',
      createdAt: now,
      reactionCount: 0,
      status: 'resolved',
      source: 'ui',
      kind: '',
      reactions: [
        { id: 'r1', author: 'octocat', body: 'akkoord, aangepast', createdAt: now, avatarUrl: '' },
      ],
      rowStart: -1,
      rowEnd: -1,
    },
  ]
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )
}

test('the pr-index never sits under (or over) the block/comment/Claude columns next to it', async ({ page }) => {
  await mockComments(page)
  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  // Select the ordinary block the comment is anchored to (not the synthetic
  // comment-index item) so its own diff-preview card + comment-claude-row
  // render next to the still-open pr-index, list mode, exactly the reported
  // screenshot's layout.
  const row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).first()
  await expect(row).toBeVisible()
  await row.click()

  const aside = page.getByTestId('pr-index')
  const main = page.getByTestId('detail-panel')
  await expect(aside).toBeVisible()
  await expect(main).toBeVisible()
  const commentRow = page.getByTestId('comment-claude-row')
  await expect(commentRow).toBeVisible()

  await expect
    .poll(async () => {
      const asideBox = await aside.boundingBox()
      const mainBox = await main.boundingBox()
      if (!asideBox || !mainBox) return null
      return mainBox.x - (asideBox.x + asideBox.width)
    })
    .toBeGreaterThanOrEqual(0)

  const asideBox = await aside.boundingBox()
  const commentRowBox = await commentRow.boundingBox()
  // The comment/Claude card sits inside <main>, well clear of the index too —
  // this is the exact card that fell partly behind the sidebar in the report.
  expect(commentRowBox.x).toBeGreaterThanOrEqual(asideBox.x + asideBox.width)

  await page.screenshot({ path: 'tests/.tmp/main-columns-no-overlap.png' })
})

test('opening the PR-description column pushes the pr-index and <main> right without overlap', async ({ page }) => {
  await mockComments(page)
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowLeft')

  const info = page.getByTestId('pr-info-column')
  const aside = page.getByTestId('pr-index')
  const main = page.getByTestId('detail-panel')
  await expect(info).toBeVisible()

  await expect
    .poll(async () => {
      const infoBox = await info.boundingBox()
      const asideBox = await aside.boundingBox()
      const mainBox = await main.boundingBox()
      if (!infoBox || !asideBox || !mainBox) return null
      return asideBox.x - (infoBox.x + infoBox.width) >= 0 && mainBox.x - (asideBox.x + asideBox.width) >= 0
    })
    .toBe(true)
})
