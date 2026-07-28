import { test, expect } from './_fixtures.mjs'

// PR-wide comments (issue/review/review_summary comments + code_warning's
// ai_warning findings — c.kind !== '') no longer live in their own card
// under the PR description. Instead home.mjs turns each one into a
// synthetic, navigable "Start" sidebar item (kind:'comment', see
// recomputeLeftList/commentBlockItem) — replaces the old PrWideComments card
// (see tests/pr-wide-comments.spec.mjs, removed) and its own pw cursor/
// handlePrWideKey. See detail-layout.md ("Comment-index items") and
// keyboard-navigation.md.

function mockComments(page, extra = []) {
  const now = new Date().toISOString()
  const comments = [
    {
      id: 'ci-1',
      runId: 'run-ci-1',
      pr: 12903,
      file: '',
      line: 0,
      author: 'octocat',
      body: 'Overall this looks great, one nit below',
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'github',
      kind: 'issue',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
    // A block-scoped comment (kind '') — must stay OUT of the "Start" index
    // and out of the toggle-approved rollup; it belongs to the block-scoped
    // sidebar instead (unchanged behaviour).
    {
      id: 'anchored-1',
      runId: 'run-anchored-1',
      pr: 12903,
      file: 'app/Http/Controllers/Api/ContractController.php',
      label: 'ContractController::index',
      line: 1,
      author: 'reviewer',
      body: 'please rename this variable',
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'ui',
      kind: '',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
    ...extra,
  ]
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )
}

test.describe('Comment-index items ("Start" sidebar)', () => {
  test('shows a PR-wide comment as a "0/1" Start row, never the anchored one', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.getByTestId('comment-heading')).toBeVisible()
    const row = page.locator('[data-idx="0"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Overall this looks great')
    await expect(row.getByTestId('block-approval')).toHaveText('0/1')
    // The block-scoped comment never becomes its own Start row — it's
    // anchored to block 0 (the currently selected block, whole-block scope),
    // so it does show up as an inline comment card there, just never in the
    // "Start" index (no [data-idx] row for it).
    await expect(page.locator('[data-idx]').getByText('please rename this variable')).toHaveCount(0)
    await expect(page.getByTestId('inline-comments').getByText('please rename this variable')).toBeVisible()
  })

  test('a fresh open lands on the unresolved comment item, with its thread shown to the right', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)

    const card = page.getByTestId('comment-detail-card')
    await expect(card).toBeVisible()
    // The body is shown once, as the first message of the thread (no separate
    // duplicated title above it — see commentDetailCard's own doc comment).
    await expect(card.getByTestId('reaction-bubble').first()).toContainText('Overall this looks great')
  })

  test('↑/↓ selects it like any other Start row', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Already on the comment item (index 0) — step down onto an ordinary
    // block, then back up onto the comment item again.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('comment-detail-card')).toHaveCount(0)
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()
  })

  test('Enter opens the action menu', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Beantwoorden')
    await expect(menu).toContainText('Resolve comment')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // → used to open the same action menu as Enter; changed on explicit request
  // so → mirrors an ordinary block (steps you INTO it) instead of opening a
  // menu — see enterPrCommentThread/isPrCommentThreadFocused/
  // handlePrCommentThreadKey (RelatedPanel.mjs) and detail-layout.md
  // ("Comment-index items").
  test('→ steps into the comment thread; ↑/↓ walk the messages, ← steps back to the index', async ({ page }) => {
    const now = new Date().toISOString()
    await page.route('**/api/comments?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ci-1',
            runId: 'run-ci-1',
            pr: 12903,
            file: '',
            line: 0,
            author: 'octocat',
            body: 'Overall this looks great, one nit below',
            createdAt: now,
            reactionCount: 1,
            status: 'open',
            source: 'github',
            kind: 'issue',
            reactions: [{ id: 'react-1', author: 'reviewer', body: 'thanks, will fix', source: 'ui', createdAt: now }],
            rowStart: -1,
            rowEnd: -1,
          },
        ]),
      }),
    )
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    const bubbles = page.getByTestId('reaction-bubble')
    await expect(bubbles).toHaveCount(2) // the comment's own opening body + the one reaction

    // → steps into the thread — no menu opens, nothing highlighted yet (rest position).
    // But the thread container itself DOES get a ring right away — without any
    // signal at all, → looked like it did nothing (see commentDetailCard).
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('command-menu')).toHaveCount(0)
    await expect(bubbles.nth(0)).not.toHaveClass(/ring-indigo-400/)
    await expect(bubbles.nth(1)).not.toHaveClass(/ring-indigo-400/)
    await expect(page.getByTestId('comment-detail-thread')).toHaveClass(/ring-indigo-200/)

    // ↑ walks up to the newest message first (the reaction, bottom of the thread).
    await page.keyboard.press('ArrowUp')
    await expect(bubbles.nth(1)).toHaveClass(/ring-indigo-400/)
    await expect(bubbles.nth(0)).not.toHaveClass(/ring-indigo-400/)

    // ↑ again walks further up, to the comment's own opening message.
    await page.keyboard.press('ArrowUp')
    await expect(bubbles.nth(0)).toHaveClass(/ring-indigo-400/)
    await expect(bubbles.nth(1)).not.toHaveClass(/ring-indigo-400/)

    // ↑ at the oldest message clamps — no further change.
    await page.keyboard.press('ArrowUp')
    await expect(bubbles.nth(0)).toHaveClass(/ring-indigo-400/)

    // ↓ walks back down towards the newest message.
    await page.keyboard.press('ArrowDown')
    await expect(bubbles.nth(1)).toHaveClass(/ring-indigo-400/)
    await expect(bubbles.nth(0)).not.toHaveClass(/ring-indigo-400/)

    // ← steps back out to the index — the highlight disappears, and Enter
    // still opens the action menu regardless of the thread ever having been
    // focused.
    await page.keyboard.press('ArrowLeft')
    await expect(bubbles.nth(1)).not.toHaveClass(/ring-indigo-400/)
    await expect(page.getByTestId('comment-detail-thread')).not.toHaveClass(/ring-indigo-200/)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
  })

  // ↓ used to clamp at the newest thread message, leaving no way to continue
  // reviewing without first pressing ← back to the index. It now falls
  // through — exactly like the block-scoped panel's own "↓ loopt door"
  // convention — and advances the sidebar cursor to the next comment/block,
  // see handlePrCommentThreadKey (RelatedPanel.mjs) and detail-layout.md
  // ("Comment-index items").
  test('↓ at the bottom of the comment thread falls through to the next block', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)

    // → steps into the thread — rest position, nothing highlighted yet, but
    // already at the "newest message" end (pos === 0).
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('comment-detail-thread')).toHaveClass(/ring-indigo-200/)

    // ↓ from here falls through immediately: the thread cursor releases and
    // the sidebar selection advances to the next row (the first real PR
    // block), instead of doing nothing.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('comment-detail-card')).toHaveCount(0)
    await expect(page.locator('[data-idx="0"]')).not.toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)
  })

  test('"Beantwoorden" reveals the reply field only after Enter, and sends via the reply Signal', async ({
    page,
  }) => {
    await mockComments(page)
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      replyBody = route.request().postDataJSON()
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // "Beantwoorden" is the first real item, default-selected (2nd item
    // overall, after the pinned "Sluit menu") — the reply field must not
    // exist yet.
    await expect(page.getByTestId('comment-detail-reply')).toHaveCount(0)

    await page.keyboard.press('Enter') // run "Beantwoorden"
    await expect(menu).toHaveCount(0)
    const reply = page.getByTestId('comment-detail-reply')
    await expect(reply).toBeFocused()

    await reply.fill('thanks, fixed')
    await page.keyboard.press('Enter')

    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.body).toBe('thanks, fixed')
    expect(replyBody.done).toBe(false)
  })

  test('resolving moves the item into "Toon N goedgekeurde blocks" (1/1)', async ({ page }) => {
    await mockComments(page)
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      replyBody = route.request().postDataJSON()
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown') // "Resolve comment"
    await page.keyboard.press('Enter')

    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.done).toBe(true)
    expect(replyBody.body).toBe('/resolve')

    // The mocked GET /api/comments never actually flips the row to
    // status:'resolved' server-side (it's a static route mock) — re-mock it
    // as resolved and reload, proving the item folds into the approved
    // section once its status is (same as any other fully-approved block).
    await page.unroute('**/api/comments?*')
    const now = new Date().toISOString()
    await page.route('**/api/comments?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ci-1',
            runId: 'run-ci-1',
            pr: 12903,
            file: '',
            line: 0,
            author: 'octocat',
            body: 'Overall this looks great, one nit below',
            createdAt: now,
            reactionCount: 0,
            status: 'resolved',
            source: 'github',
            kind: 'issue',
            reactions: [],
            rowStart: -1,
            rowEnd: -1,
          },
        ]),
      }),
    )
    // Force a fresh comments load (mirrors the poll cycle) via a resolve on a
    // no-op signal — simplest robust trigger here is just to wait for the
    // existing 5s poll, but that's slow; instead reload the page against the
    // now-resolved fixture, which re-runs recomputeLeftList from scratch.
    await page.reload()
    await expect(page.getByTestId('toggle-approved')).toBeVisible()
    await expect(page.getByTestId('toggle-approved')).toContainText('1')
    // The comment row itself is hidden by default (folded into that button),
    // like any other fully-approved block.
    await expect(page.getByTestId('comment-heading')).toHaveCount(0)
  })

  test('an ai_warning finding is also a navigable comment-index item', async ({ page }) => {
    const now = new Date().toISOString()
    await mockComments(page, [
      {
        id: 'ai-1',
        runId: 'run-ai-1',
        pr: 12903,
        file: '',
        line: 0,
        author: 'AI check',
        body: 'this call no longer matches the changed signature',
        createdAt: now,
        reactionCount: 0,
        status: 'open',
        source: 'ai',
        kind: 'ai_warning',
        reactions: [],
        rowStart: -1,
        rowEnd: -1,
      },
    ])
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await expect(page.getByTestId('comment-heading')).toBeVisible()
    // Two comment-index rows now: the plain issue comment (index 0, already
    // selected by default) and the ai_warning finding (index 1).
    await page.keyboard.press('ArrowDown')
    const card = page.getByTestId('comment-detail-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('comment-ai-warning')).toBeVisible()
    await expect(card).toContainText('this call no longer matches')
  })
})
