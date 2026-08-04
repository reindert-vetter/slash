import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// An @mention of the local reviewer (who that is: <dataDir>/settings.json →
// GET /api/settings, else the /api/me login — see settings.go/src/mentions.mjs)
// does two things: it highlights inside the comment body, and it lifts the
// comment to the very top of the block index under its own "Mentioned" heading
// (BlockList.mjs's mentionHeading, rank -2 in recomputeLeftList). That INCLUDES
// a block-anchored (kind === '') comment, which has no index row otherwise —
// deliberately, so a mention can't hide in a thread on a block you haven't
// opened yet.
//
// Both /api/settings and /api/comments are mocked: the harness runs with
// SLASH_GITHUB=off, so /api/me answers {ok:false} and settings.json is the only
// source of "who am I" here — which is exactly the override path being tested.

const ME = 'reindert-vetter'

function mockSettings(page, aliases = ['reindert']) {
  return page.route('**/api/settings', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, me: { login: ME, aliases } }),
    }),
  )
}

function comment(over) {
  return {
    id: 'x',
    runId: 'run-x',
    pr: 12903,
    file: '',
    line: 0,
    author: 'dennissloove',
    body: '',
    createdAt: new Date().toISOString(),
    reactionCount: 0,
    status: 'open',
    source: 'github',
    kind: 'issue',
    reactions: [],
    rowStart: -1,
    rowEnd: -1,
    ...over,
  }
}

// The block-anchored comment uses the anchor fixture's own file/label (PR
// 12903, see materializeMainWorktrees in tests/_setup.mjs) so it really belongs
// to a block in the index — the row it gets under "Mentioned" is then an
// addition to its inline thread, not a replacement.
const ANCHOR_FILE = 'app/Http/Controllers/Api/ContractController.php'
const ANCHOR_LABEL = 'ContractController::index'

// mockComments installs the route ONCE and serves whatever it was given —
// never page.unroute()+route() again, see comment-index-items.spec.mjs for why
// (the app polls /api/comments and a poll landing in the gap reaches the real,
// empty endpoint).
function mockComments(page, comments) {
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )
}

test.describe('@mention of the local reviewer', () => {
  test('highlights in the body and lands under the "Mentioned" heading, above "PR-comments"', async ({ page }) => {
    await mockSettings(page)
    await mockComments(page, [
      comment({ id: 'plain-1', runId: 'run-plain-1', body: 'Overall this looks great, one nit below' }),
      comment({ id: 'mention-1', runId: 'run-mention-1', body: `Ik laat het staan zodat ik dit met @${ME} kan doornemen` }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.getByTestId('mention-heading')).toBeVisible()
    await expect(page.getByTestId('comment-heading')).toBeVisible()
    // The mentioned comment sorts first (rank -2), so it owns row 0 and its
    // heading sits above the "PR-comments" one.
    const first = page.locator('[data-idx="0"]')
    // The row label is a 60-char snippet of the body (commentBlockItem), so
    // assert on its start rather than the tail.
    await expect(first).toContainText('Ik laat het staan zodat ik dit met')
    const headings = page.locator('[data-testid=mention-heading], [data-testid=comment-heading]')
    await expect(headings).toHaveCount(2)
    await expect(headings.first()).toHaveAttribute('data-testid', 'mention-heading')

    // The body highlight: a <mark> around the mention only, in the detail card
    // that opens on the selected (mentioned) comment.
    // Two cards are on screen (the selected one plus the look-ahead preview of
    // the next comment item), so scope to the first — the selected one.
    const card = page.getByTestId('comment-detail-card').first()
    await expect(card).toBeVisible()
    const mark = card.getByTestId('mention').first()
    await expect(mark).toHaveText(`@${ME}`)
    // Not colour alone (the reviewer is colorblind): bold + a ring on top of
    // the tint.
    await expect(mark).toHaveClass(/font-bold/)
    await expect(mark).toHaveClass(/ring-1/)
  })

  test('a mention in a REPLY counts, and an unrelated comment gets no highlight', async ({ page }) => {
    await mockSettings(page)
    await mockComments(page, [
      comment({
        id: 'reply-1',
        runId: 'run-reply-1',
        body: 'Even een aanvulling op @Levivb',
        reactions: [{ id: 'r-1', author: 'dennissloove', source: 'github', body: `ping @reindert hier ook` }],
      }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    // The root body mentions someone ELSE — that must not highlight, but the
    // reply's mention still lifts the comment into "Mentioned".
    await expect(page.getByTestId('mention-heading')).toBeVisible()
    const card = page.getByTestId('comment-detail-card')
    await expect(card).toBeVisible()
    await expect(card.getByText('@Levivb').getByTestId('mention')).toHaveCount(0)
    // The alias form (@reindert, from settings.json) highlights in the reply.
    await expect(card.getByTestId('mention').first()).toHaveText('@reindert')
  })

  test('a block-anchored comment mentioning me gets exactly ONE index row, and keeps its inline thread', async ({
    page,
  }) => {
    await mockSettings(page)
    await mockComments(page, [
      comment({
        id: 'anchored-mention',
        runId: 'run-anchored-mention',
        file: ANCHOR_FILE,
        label: ANCHOR_LABEL,
        line: 1,
        kind: '',
        source: 'ui',
        author: 'reviewer',
        body: `graag @${ME} hiernaar laten kijken`,
      }),
      // A block-anchored comment WITHOUT a mention stays out of the index
      // entirely (unchanged behaviour).
      comment({
        id: 'anchored-plain',
        runId: 'run-anchored-plain',
        file: ANCHOR_FILE,
        label: ANCHOR_LABEL,
        line: 1,
        kind: '',
        source: 'ui',
        author: 'reviewer',
        body: 'please rename this variable',
      }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.getByTestId('mention-heading')).toBeVisible()
    // Exactly one row for it — the dedup in indexComments plus the fact that a
    // block-anchored comment has no second source of index items. Two rows
    // would share the same state.blocks id ('comment:' + c.id), which is what
    // selection preservation and ?sel=comment:<id> resolve through.
    await expect(page.locator('[data-idx]').filter({ hasText: 'hiernaar laten kijken' })).toHaveCount(1)
    await expect(page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })).toHaveCount(0)
    // No "PR-comments" section at all here: the only index comment is a
    // mentioned one.
    await expect(page.getByTestId('comment-heading')).toHaveCount(0)

    // Its own block still shows both comments in the inline index — the index
    // row is an addition, not a move.
    await page.keyboard.press('ArrowDown')
    const inline = page.getByTestId('inline-comments')
    await expect(inline.getByText('please rename this variable')).toBeVisible()
    await expect(inline.getByText('hiernaar laten kijken')).toBeVisible()
  })

  test('?sel=comment:<id> restores a mentioned block-anchored row after a reload', async ({ page }) => {
    await mockSettings(page)
    await mockComments(page, [
      comment({
        id: 'anchored-mention',
        runId: 'run-anchored-mention',
        file: ANCHOR_FILE,
        label: ANCHOR_LABEL,
        line: 1,
        kind: '',
        source: 'ui',
        author: 'reviewer',
        body: `graag @${ME} hiernaar laten kijken`,
      }),
    ])
    await page.goto('/pr/12903?sel=comment:anchored-mention')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const card = page.getByTestId('comment-detail-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('hiernaar laten kijken')
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)
  })

  test('without settings.json (and no GitHub user) nothing is mentioned', async ({ page }) => {
    // /api/settings answers with an empty me-block, exactly like a machine with
    // no settings.json, and the harness's SLASH_GITHUB=off leaves /api/me empty
    // too — so no alias is known and the feature is a no-op.
    await page.route('**/api/settings', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, me: { login: '', aliases: [] } }),
      }),
    )
    await mockComments(page, [comment({ id: 'plain-2', runId: 'run-plain-2', body: `hoi @${ME}, kijk hier eens naar` })])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.getByTestId('comment-heading')).toBeVisible()
    await expect(page.getByTestId('mention-heading')).toHaveCount(0)
    await expect(page.getByTestId('mention')).toHaveCount(0)
  })
})
