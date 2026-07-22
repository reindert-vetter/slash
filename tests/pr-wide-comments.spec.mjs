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
    await page.keyboard.press('Meta+ArrowRight') // open the comments/taken sidebar
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

  test('the comment block dominates the description column, more so when focused (4/5 -> 5/6)', async ({
    page,
  }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1: the description owns the keyboard
    const card = page.getByTestId('pr-info-card')
    const wide = page.getByTestId('pr-wide-comments')
    await expect(wide).toBeVisible()

    // The pr-wide comments card was enlarged (e9ff66b): prInfoCard is now a flat
    // flex-1 (the small share) in BOTH states, while pr-wide-comments takes
    // flex-[4] while the description is selected and flex-[5] while it owns the
    // keyboard (see PrWideComments in RelatedPanel.mjs + prInfoCard in home.mjs).
    // So the comments dominate the column already when the description is
    // selected (~4/5 vs 1/5), and dominate even more strongly once focused
    // (~5/6 vs 1/6) — the ratio tilts further rather than flipping. Assert
    // generously below the "pure" numbers (prInfoCard's p-5 padding gives its
    // share a small fixed floor) so this stays robust to sub-pixel/font-metric
    // variance across machines.
    let cardH, wideH
    await expect
      .poll(async () => {
        cardH = (await card.boundingBox()).height
        wideH = (await wide.boundingBox()).height
        return wideH / cardH
      })
      .toBeGreaterThan(2.0)
    const [cardH1, wideH1, ratio1] = [cardH, wideH, wideH / cardH]

    // ↓ hands the keyboard to the PR-wide block: flex-[5] vs flex-1 -> the
    // comments dominate more strongly still.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('pr-wide-item').first()).toHaveAttribute('data-active', 'true')

    await expect
      .poll(async () => {
        cardH = (await card.boundingBox()).height
        wideH = (await wide.boundingBox()).height
        return wideH / cardH
      })
      .toBeGreaterThan(3.0)

    // Focusing tilts the column further toward the comments: the description's
    // share shrank (~1/5 -> ~1/6) and the comment block's grew (~4/5 -> ~5/6),
    // so the ratio strictly increased — the two states are distinct, not noise.
    expect(wideH / cardH).toBeGreaterThan(ratio1)
    expect(cardH).toBeLessThan(cardH1 * 0.98)
    expect(wideH).toBeGreaterThan(wideH1)
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
