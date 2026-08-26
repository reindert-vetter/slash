import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A long comment gets a short generated heading (the comment_titles workflow,
// see comment_titles.go): the title renders above the body, the body itself is
// clamped back to 3 lines, and the comment's own index row shows that title
// instead of the first 60 characters of its text. A title that describes an
// OLDER version of the body (the reviewer edited the comment — titleBodyLen no
// longer matches) counts as no title at all. See comments-panel.md.

const LONG_BODY =
  'Naast API_TOKEN (moneybird apitoken, in werkelijkheid een vault kolom) komt nu TOKEN in dezelfde enum te staan. ' +
  'Dat maakt het makkelijk de verkeerde case te pakken, en deleteSettings() loopt over alle cases om settings rijen te ' +
  'verwijderen, waar de vault case niets te zoeken heeft.'

const STALE_BODY =
  'De migratie draait zonder transactie, dus als hij halverwege klapt blijft er een halve tabel achter waar niemand ' +
  'nog iets mee kan. Dat is precies het geval dat we vorige keer met de hand hebben moeten repareren.'

// Two PR-wide comments (kind 'issue' — no file:line anchor, so both land in
// the comment index as their own rows): one with a fresh title, one whose
// title was generated for a shorter body and must therefore be ignored.
function mockTitledComments(page) {
  const now = new Date().toISOString()
  const base = {
    pr: 12903,
    file: '',
    line: 0,
    author: 'reviewer',
    createdAt: now,
    reactionCount: 0,
    status: 'open',
    source: 'ui',
    kind: 'issue',
    reactions: [],
    rowStart: -1,
    rowEnd: -1,
  }
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          ...base,
          id: 'titled-1',
          runId: 'run-titled-1',
          body: LONG_BODY,
          title: 'Vault case wist echte settings rijen',
          titleStatus: 'done',
          titleBodyLen: [...LONG_BODY].length,
        },
        {
          ...base,
          id: 'stale-1',
          runId: 'run-stale-1',
          body: STALE_BODY,
          title: 'Titel van een oudere versie',
          titleStatus: 'done',
          titleBodyLen: 12,
        },
      ]),
    }),
  )
}

test.describe('a long comment shows a short generated title', () => {
  test('the index row is named after the title, and the detail card shows it above the body', async ({ page }) => {
    await mockTitledComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // The index row for the titled comment is named after its title — not
    // after the first 60 characters of the body (commentBlockItem, home.mjs).
    const row = page.locator('[data-idx]').filter({ hasText: 'Vault case wist echte settings rijen' })
    await expect(row).toHaveCount(1)
    await expect(row).not.toContainText('Naast API_TOKEN')
    await row.click()

    // Its own detail card carries the title as a heading, with the full body
    // still readable underneath (the detail card never clamps).
    // .first(): the second card is the look-ahead preview of the next index
    // item (see detail-layout.md).
    const card = page.getByTestId('comment-detail-card').first()
    await expect(card).toBeVisible()
    await expect(card.getByTestId('comment-title')).toHaveText('Vault case wist echte settings rijen')
    await expect(card).toContainText('deleteSettings()')
  })

  test('a title generated for an older body is ignored', async ({ page }) => {
    await mockTitledComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // The stale-titled comment falls back to the body snippet, and no title
    // heading is rendered for it at all.
    const row = page.locator('[data-idx]').filter({ hasText: 'De migratie draait zonder transactie' })
    await expect(row).toHaveCount(1)
    await expect(page.locator('[data-idx]').filter({ hasText: 'Titel van een oudere versie' })).toHaveCount(0)
    await row.click()

    const card = page.getByTestId('comment-detail-card').filter({ hasText: 'De migratie draait zonder transactie' })
    await expect(card).toBeVisible()
    await expect(card.getByTestId('comment-title')).toHaveCount(0)
  })

  // The compact card in the comments column (the one in the reviewer's own
  // screenshot: an AI-controle finding whose three sentences filled the whole
  // card). With a title the body goes back to 3 clamped lines even when the
  // "lone comment, no underlying code" rule would otherwise show it in full
  // (autoExpandLoneComment) — the title now does that job.
  //
  // Reached via the ORDINARY block row here, not the "Comments op regels"
  // index row — selecting THAT row now always forces the full expanded
  // thread (isAnchorOnlyComment, home.mjs's openCommentAnchorDrill/
  // cs.scope.onlyIds, see comments-panel.md), so it is not itself a compact
  // card any more. This test is about the compact-card+title rendering
  // itself, which still applies to an ordinary drilled-into block's own
  // inline comment.
  test('the compact card shows the title and clamps the body back to 3 lines', async ({ page }) => {
    const now = new Date().toISOString()
    const anchored = {
      id: 'anchor-titled',
      runId: 'run-anchor-titled',
      pr: 12903,
      file: 'app/Http/Controllers/Api/ContractController.php',
      label: 'ContractController::index',
      line: 30,
      author: 'reviewer',
      body: LONG_BODY,
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'ui',
      kind: '',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
      title: 'Vault case wist echte settings rijen',
      titleStatus: 'done',
      titleBodyLen: [...LONG_BODY].length,
    }
    await page.route('**/api/comments?*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([anchored]) }),
    )
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'ContractController::index' })
    await row.click()

    const item = page.getByTestId('comment-item').first()
    await expect(item.getByTestId('comment-title')).toHaveText('Vault case wist echte settings rijen')
    await expect(item.locator('.line-clamp-3')).toHaveCount(1)
  })

  // A title arrives LATER (the workflow takes a few seconds; the comment poll
  // brings it in on its next tick). arrow.js reuses a keyed node without
  // re-running its bindings, so the card's .key() has to encode the title —
  // without titleKeyOf (RelatedPanel.mjs) the heading would never appear until
  // a navigation happened to rebuild the card. See arrowjs-pitfalls.md.
  test('a title that only arrives on a later poll still shows up', async ({ page }) => {
    const now = new Date().toISOString()
    const base = {
      id: 'late-1',
      runId: 'run-late-1',
      pr: 12903,
      file: '',
      line: 0,
      author: 'reviewer',
      body: LONG_BODY,
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'ui',
      kind: 'issue',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    }
    let calls = 0
    await page.route('**/api/comments?*', (route) => {
      calls++
      const titled =
        calls <= 1
          ? base
          : { ...base, title: 'Vault case wist echte settings rijen', titleStatus: 'done', titleBodyLen: [...LONG_BODY].length }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([titled]) })
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'Naast API_TOKEN' })
    await row.click()
    const card = page.getByTestId('comment-detail-card').first()
    await expect(card).toBeVisible()
    // No title yet on the first load…
    await expect(card.getByTestId('comment-title')).toHaveCount(0)
    // …and it appears once the poll brings it in, without any navigation.
    await expect(page.getByTestId('comment-title')).toHaveText('Vault case wist echte settings rijen', { timeout: 15000 })
  })
})
