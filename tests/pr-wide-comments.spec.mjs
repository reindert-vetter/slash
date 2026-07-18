import { test, expect } from './_fixtures.mjs'

// C2: the PR-wide comment block under the PR-description column (stop 1 of
// the nav chain) shows GitHub-imported issue/review comments (c.kind !== '')
// — comments with no file:line anchor, which the block-scoped comments index
// (RelatedPanel's cs.view) deliberately excludes. See detail-layout.md /
// keyboard-navigation.md.

const PR_WIDE_BODY = 'Overall this looks great, one nit below'
const ANCHORED_BODY = 'please rename this variable'

function mockComments(page) {
  const now = new Date().toISOString()
  const comments = [
    {
      id: 'pw-1',
      runId: 'run-pw-1',
      pr: 12903,
      file: '',
      line: 0,
      author: 'octocat',
      body: PR_WIDE_BODY,
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'github',
      kind: 'issue',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
    {
      id: 'anchored-1',
      runId: 'run-anchored-1',
      pr: 12903,
      file: 'app/Http/Controllers/Api/ContractController.php',
      label: 'ContractController::index',
      line: 1,
      author: 'reviewer',
      body: ANCHORED_BODY,
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'ui',
      kind: '',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
  ]
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )
}

test.describe('PR-wide comment block (C2)', () => {
  test('shows a PR-wide comment, hides the anchored one, and shows the github badge', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    // Open stop 1 (the description column) — the PR-wide block lives under it.
    await page.keyboard.press('ArrowLeft')
    const wide = page.getByTestId('pr-wide-comments')
    await expect(wide).toBeVisible()

    const items = wide.getByTestId('pr-wide-item')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText(PR_WIDE_BODY)
    await expect(items.first()).not.toContainText(ANCHORED_BODY)
    await expect(wide.getByTestId('comment-source')).toHaveText(/bron: github/)

    // The anchored (block-scoped) comment shows in the block-scoped sidebar
    // instead — never here.
    await page.keyboard.press('ArrowRight') // close the description
    await page.keyboard.press('g') // open the comments/taken sidebar
    const sidebar = page.getByTestId('comments-sidebar')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByTestId('comment-item')).toHaveCount(1)
    await expect(sidebar.getByTestId('comment-item').first()).toContainText(ANCHORED_BODY)
    await expect(sidebar).not.toContainText(PR_WIDE_BODY)
  })

  test('keyboard: ↓ enters the block, Enter opens the thread, a reply sends the reply signal', async ({ page }) => {
    await mockComments(page)
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      const data = route.request().postDataJSON()
      replyBody = data
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1: the description
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    // ↓ hands the keyboard to the PR-wide block, landing on its first entry.
    await page.keyboard.press('ArrowDown')
    const item = page.getByTestId('pr-wide-item').first()
    await expect(item).toHaveAttribute('data-active', 'true')

    // Enter opens its thread + focuses the reply composer.
    await page.keyboard.press('Enter')
    const compose = page.getByTestId('pr-wide-compose')
    await expect(compose).toBeFocused()

    await compose.fill('thanks, fixed')
    await page.keyboard.press('Enter')

    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.body).toBe('thanks, fixed')
    expect(replyBody.done).toBe(false)
  })

  test('resolve sends the reply signal with done:true', async ({ page }) => {
    await mockComments(page)
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      const data = route.request().postDataJSON()
      replyBody = data
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await page.getByTestId('pr-wide-resolve').click()

    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.done).toBe(true)
  })

  test('the description/comment-block height ratio flips with focus (2/3 vs 3/4)', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1: the description owns the keyboard
    const card = page.getByTestId('pr-info-card')
    const wide = page.getByTestId('pr-wide-comments')
    await expect(wide).toBeVisible()

    // Description selected: prInfoCard flex-[2] vs pr-wide-comments flex-1.
    // The real ratio lands a bit above the "pure" 2:1 (prInfoCard's p-5 border
    // adds a small fixed floor to its share, see the flex-grow note in
    // detail-layout.md) — assert generously below that (1.9) so this stays
    // robust to sub-pixel/font-metric variance across machines.
    let cardH, wideH
    await expect
      .poll(async () => {
        cardH = (await card.boundingBox()).height
        wideH = (await wide.boundingBox()).height
        return cardH / wideH
      })
      .toBeGreaterThan(1.9)
    const [cardH1, wideH1] = [cardH, wideH]

    // ↓ hands the keyboard to the PR-wide block: flex-[3] vs flex-1 -> the
    // ratio flips, and pr-wide-comments now clearly dominates.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('pr-wide-item').first()).toHaveAttribute('data-active', 'true')

    await expect
      .poll(async () => {
        cardH = (await card.boundingBox()).height
        wideH = (await wide.boundingBox()).height
        return wideH / cardH
      })
      .toBeGreaterThan(2.0)

    // The description's share shrank substantially (~2/3 -> ~1/4 of the
    // column) and the comment block's share grew substantially (~1/3 -> ~3/4)
    // — the two states are clearly distinct, not just noise.
    expect(cardH).toBeLessThan(cardH1 * 0.6)
    expect(wideH).toBeGreaterThan(wideH1 * 1.8)
  })

  test('← from within the block returns to the description without leaving the PR', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('pr-wide-item').first()).toHaveAttribute('data-active', 'true')

    await page.keyboard.press('ArrowLeft')
    // Still on the PR, still showing the description column.
    await expect(page).toHaveURL(/\/pr\/12903/)
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    // A further ← now leaves the whole nav chain (nothing left owns the
    // keyboard inside the PR-wide block anymore).
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(/\/pr-overview/)
  })
})
