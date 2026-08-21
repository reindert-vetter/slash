import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// PR-wide comments (issue/review/review_summary comments + code_warning's
// ai_warning findings — c.kind !== '') no longer live in their own card
// under the PR description. Instead home.mjs turns each one into a
// synthetic, navigable "Start" sidebar item (kind:'comment', see
// recomputeLeftList/commentBlockItem) — replaces the old PrWideComments card
// (see tests/pr-wide-comments.spec.mjs, removed) and its own pw cursor/
// handlePrWideKey. See detail-layout.md ("Comment-index items") and
// keyboard-navigation.md.

// mockComments installs the comments route ONCE and serves whatever
// `state.comments` holds at request time. The mutable-state shape matters: a
// test that needs a different payload later must never `page.unroute()` and
// re-`route()` to get it. Those two calls are not atomic, and the app polls
// /api/comments every few seconds, so a poll landing in the gap reaches the
// REAL endpoint — which returns [] for this PR (the _cleanApprovals fixture
// wipes 12903's comments before every test). The mocked comment then vanishes
// from state.blocks, the selection falls onto an ordinary block, and the
// ?sel=comment:<id> the mirror watch had written is replaced by that block's
// own ref — so the subsequent reload restores the wrong row and the assertion
// on the "PR-comments" heading fails. That flaked the resolve test below
// (~2 in 12 runs at 4 workers) and had nothing to do with the behaviour under
// test. Swap the payload via the returned handle instead.
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
    // A block-scoped comment (kind ''). It gets its OWN index row too as long
    // as it is unresolved (see indexComments in RelatedPanel.mjs — reviewer
    // request: every open comment sits in the blokken-index), on top of still
    // living in its block's own inline thread.
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
  const state = { comments }
  const ready = page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.comments),
    }),
  )
  return Object.assign(ready, { serve: (next) => (state.comments = next) })
}

test.describe('Comment-index items ("Start" sidebar)', () => {
  test('shows a PR-wide comment as a "0/1" Start row, never the anchored one', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.getByTestId('comment-heading')).toBeVisible()
    // The PR-wide comment section now sorts right above "Comments op regels"
    // (recomputeLeftList's rank 2.4, under every real category — reviewer
    // request: "gooi algemene pr comments net boven Comments op regels"), no
    // longer at data-idx="0", so locate the row by its own content.
    const row = page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('block-approval')).toHaveText('0/1')
    // The block-scoped comment ALSO gets its own index row, but under
    // "Comments op regels" (b.lineAnchored, home.mjs) — sorted UNDER the
    // changed-files categories, not right after the PR-wide row (only a
    // no-regel comment item sorts ahead of every real block).
    await expect(page.getByTestId('line-comment-heading')).toBeVisible()
    const anchoredRow = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
    await expect(anchoredRow).toBeVisible()
    // The "Start" item itself has no code anchor, so the block-scoped index
    // right next to it must show NOTHING while it's selected — not "no
    // filter" (see commentScope's sentinel scope, comments-panel.md). Only
    // once you select the block the comment is actually anchored to does it
    // reappear there.
    await expect(page.getByTestId('inline-comments').getByTestId('comment-item')).toHaveCount(0)
    // Selecting the comment's own block (ContractController::index, the
    // fixture's anchor) directly — its inline thread shows the comment.
    await page.locator('[data-idx]').filter({ hasText: 'ContractController::index' }).first().click()
    await expect(page.getByTestId('inline-comments').getByText('please rename this variable')).toBeVisible()
  })

  test('a fresh open lands on the first unapproved ordinary block, not the comment item (reversed 2026-08-20)', async ({
    page,
  }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // The PR-wide comment section sorts right above "Comments op regels"
    // (rank 2.4, DISPLAY position only — recomputeLeftList). That display
    // rank no longer doubles as the fresh-open SELECTION priority
    // (defaultSelectionRank, home.mjs): an unapproved ordinary block now
    // wins over a no-regel comment item — explicit reviewer request,
    // reversing the earlier "comment wins" behaviour this test used to
    // assert. See defaultSelectionRank's own doc comment for the reversal
    // note.
    const commentRow = page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' })
    await expect(commentRow).not.toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('comment-detail-card')).toHaveCount(0)
    // The selected block isn't necessarily the FIRST rendered row — display
    // order is category rank (recomputeLeftList), while the fresh-open pick's
    // own tie-break among ordinary blocks is file order (defaultSelectionRank)
    // — so locate the highlighted row instead of assuming it's row 0.
    const highlighted = page.locator(
      '[data-testid="block-row"].bg-indigo-50, [data-testid="block-row"].dark\\:bg-indigo-500\\/15',
    )
    await expect(highlighted).toHaveCount(1)

    // Selecting the comment item explicitly still shows its thread to the
    // right, exactly as before.
    await commentRow.click()
    await expect(commentRow).toHaveClass(/bg-indigo-50/)
    const card = page.getByTestId('comment-detail-card').first()
    await expect(card).toBeVisible()
    // The body is shown once, as the first message of the thread (no separate
    // duplicated title above it — see commentDetailCard's own doc comment).
    await expect(card.getByTestId('reaction-bubble').first()).toContainText('Overall this looks great')
  })

  // The fallback case — a fresh open lands on the comment item when there is
  // no unapproved ordinary block left at all — is covered on the small,
  // purpose-built PR 108 fixture instead (approving every real block here via
  // the UI would need many more keystrokes than this spec's own scope):
  // see tests/fresh-open-default-selection.spec.mjs, "everything approved,
  // plus an unresolved comment → lands on the comment, not the toggle row".

  test('↑/↓ selects it like any other Start row', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // A fresh open now lands on an unapproved ORDINARY block instead
    // (applyDefaultUnapprovedSelection, reversed 2026-08-20) — select the
    // PR-wide comment item directly first.
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()
    // The anchored comment now sorts under "Comments op regels" — no longer
    // right next to the PR-wide item at the top — so select it directly by
    // its own row rather than assuming an adjacent index.
    const anchoredRow = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
    await anchoredRow.click()
    // It resolves to a real block (ContractController::index) — no longer
    // shows commentDetailCard at all: selecting it opens that block "as if
    // fully expanded" (see openCommentAnchorDrill, home.mjs), collapsing the
    // comment card's own spot into a rail instead. See
    // comment-anchor-expanded-view.spec.mjs for that behaviour in full; here
    // just confirm ↑/↓ still moves the selection onto/off of it.
    await expect(page.getByTestId('comment-detail-card')).toHaveCount(0)
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')
    await expect(anchoredRow).toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('ArrowUp')
    await expect(anchoredRow).not.toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('drill-column')).toHaveCount(0)

    await page.keyboard.press('ArrowDown')
    await expect(anchoredRow).toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')
  })

  test('Enter opens the action menu', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // comment item directly (reversed 2026-08-20, see defaultSelectionRank).
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Beantwoorden')
    await expect(menu).toContainText('Resolve comment')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // On the reviewer's OWN comment — placed in this app, so it carries no
  // explicit `source` at all (a real in-app comment is never posted with
  // `source: 'ui'`, see isOwnComment/CodeCommentInput's own doc comment) —
  // "Resolve comment" becomes the default-selected FIRST real item instead of
  // "Beantwoorden", while "Beantwoorden" stays in the menu (just second). See
  // isOwnComment/prCommentCommandsFor (home.mjs) and detail-layout.md
  // ("Comment-index items").
  test('Enter on my OWN comment default-selects "Resolve comment" first; "Beantwoorden" stays available', async ({
    page,
  }) => {
    const now = new Date().toISOString()
    await page.route('**/api/comments?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'own-1',
            runId: 'run-own-1',
            pr: 12903,
            file: '',
            line: 0,
            author: 'reviewer',
            body: 'a note I left myself on the whole PR',
            createdAt: now,
            reactionCount: 0,
            status: 'open',
            // No `source` field at all — an in-app comment stores none (see
            // isOwnComment's doc comment in home.mjs).
            kind: 'issue',
            reactions: [],
            rowStart: -1,
            rowEnd: -1,
          },
        ]),
      }),
    )
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // comment item directly (reversed 2026-08-20, see defaultSelectionRank).
    await page.locator('[data-idx]').filter({ hasText: 'a note I left myself on the whole PR' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = menu.getByTestId('command-row')
    // "Sluit menu", "Resolve comment" (now default, index 1), "Beantwoorden"
    // (still present, index 2), "Ignore".
    await expect(rows.nth(1)).toContainText('Resolve comment')
    await expect(rows.nth(2)).toContainText('Beantwoorden')
    await expect(rows.nth(1)).toHaveClass(/bg-indigo-50/)
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
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // comment item directly (reversed 2026-08-20, see defaultSelectionRank).
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

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
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // PR-wide comment item directly (reversed 2026-08-20, see
    // defaultSelectionRank).
    const prWideRow = page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' })
    await prWideRow.click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()
    await expect(prWideRow).toHaveClass(/bg-indigo-50/)

    // → steps into the thread — rest position, nothing highlighted yet, but
    // already at the "newest message" end (pos === 0).
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('comment-detail-thread').first()).toHaveClass(/ring-indigo-200/)

    // ↓ from here falls through immediately: the thread cursor releases and
    // the sidebar selection advances to the next row in the flat list — which
    // is now the anchored comment's own index row (it sorts right after the
    // PR-wide section, at rank 2.5 under "Comments op regels" — the real
    // block itself sorts BEFORE the PR-wide section now, at a real category
    // rank, so it is no longer the next row after it).
    await page.keyboard.press('ArrowDown')
    const anchoredRow = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
    await expect(anchoredRow).toHaveClass(/bg-indigo-50/)
    // Selecting that row resolves to its real block (ContractController::index)
    // shown "as if fully expanded" (openCommentAnchorDrill) — not
    // commentDetailCard, same as the anchored-row selection exercised in the
    // test above.
    await expect(page.getByTestId('comment-detail-card')).toHaveCount(0)
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')
    await expect(page.getByTestId('inline-comments').getByText('please rename this variable')).toBeVisible()
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
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // comment item directly (reversed 2026-08-20, see defaultSelectionRank).
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

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

  // Regression: the open reply field used to be closed by the very next
  // comment poll (RelatedPanel.mjs's 5s refreshTimer), even though the
  // selection never moved — arrow.js's reactive `set` notifies subscribers on
  // every assignment, including a same-value no-op, and recomputeLeftList()
  // unconditionally reassigns state.selected on every poll tick. See the
  // "watch() fires even on an unchanged value" entry in arrowjs-pitfalls.md
  // and the lastFiredSelectionRef guard in home.mjs. Wait past one real 5s
  // poll tick before asserting the field survived and can still send.
  test('"Beantwoorden" survives a comment-poll tick (reply field must not vanish)', async ({ page }) => {
    await mockComments(page)
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      replyBody = route.request().postDataJSON()
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // comment item directly (reversed 2026-08-20, see defaultSelectionRank).
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('Enter') // run "Beantwoorden"
    const reply = page.getByTestId('comment-detail-reply')
    await expect(reply).toBeFocused()
    await reply.fill('nog aanwezig?')

    // Wait past a full 5s refreshTimer tick — the mocked route keeps serving
    // the same payload, so this exercises exactly the "poll re-fires with an
    // unchanged list" case the guard exists for.
    await page.waitForTimeout(5300)

    await expect(reply).toBeVisible()
    await expect(reply).toHaveValue('nog aanwezig?')

    await reply.press('Enter')
    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.body).toBe('nog aanwezig?')
  })

  test('resolving moves the item into "Toon N goedgekeurde blocks" (1/1)', async ({ page }) => {
    const mock = mockComments(page)
    await mock
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      replyBody = route.request().postDataJSON()
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // A fresh open lands on an unapproved ordinary block now — select the
    // comment item directly (reversed 2026-08-20, see defaultSelectionRank).
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown') // "Resolve comment"
    await page.keyboard.press('Enter')

    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.done).toBe(true)
    expect(replyBody.body).toBe('/resolve')

    // The mocked GET /api/comments never actually flips the row to
    // status:'resolved' server-side (it's a static route mock) — serve it as
    // resolved from here on and reload, proving the item folds into the
    // approved section once its status is (same as any other fully-approved
    // block). Swapping the payload through the existing handler
    // (mock.serve) rather than unroute+route is load-bearing — see
    // mockComments' own comment for the flake that caused.
    const now = new Date().toISOString()
    mock.serve([
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
    ])
    // Force a fresh comments load (mirrors the poll cycle) via a resolve on a
    // no-op signal — simplest robust trigger here is just to wait for the
    // existing 5s poll, but that's slow; instead reload the page against the
    // now-resolved fixture, which re-runs recomputeLeftList from scratch.
    await page.reload()
    await expect(page.getByTestId('toggle-approved')).toBeVisible()
    await expect(page.getByTestId('toggle-approved')).toContainText('1')
    // A comment selection now survives a refresh (?sel=comment:<id>, see
    // applyCommentRefRestore/detail-layout.md) — the reviewer's own restored
    // position on this now-resolved comment stays visible/selected via the
    // same revealSelectedIfHidden pin an already-approved block gets, instead
    // of folding away into "Toon N goedgekeurde blocks" like every OTHER
    // resolved comment still would.
    await expect(page.getByTestId('comment-heading')).toBeVisible()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()
  })

  // Reviewer report: "Nog geen eigen comment... moet niet in de index, moet
  // ook gewoon niet zichtbaar zijn." A comment created solely to anchor a
  // Claude conversation, never replaced with the reviewer's own text, is not
  // something anyone wrote — see isChatAnchorPlaceholder (RelatedPanel.mjs).
  test('a bare Claude-chat anchor comment gets no index row and no detail card', async ({ page }) => {
    const now = new Date().toISOString()
    mockComments(page, [
      {
        id: 'chat-anchor-1',
        runId: 'run-chat-anchor-1',
        pr: 12903,
        file: 'app/Http/Controllers/Api/ContractController.php',
        label: 'Gone::method',
        line: 5,
        author: 'reviewer',
        body: '(Nog geen eigen comment getypt — gesprek met Claude gestart.)',
        createdAt: now,
        reactionCount: 0,
        status: 'open',
        source: 'ui',
        kind: '',
        anchorState: 'orphan',
        reactions: [],
        rowStart: -1,
        rowEnd: -1,
      },
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // The ordinary PR-wide comment still has its row — so the list really did
    // render — but the bare anchor has none, orphan badge or not.
    await expect(page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' })).toHaveCount(1)
    await expect(page.locator('[data-idx]').filter({ hasText: 'Nog geen eigen comment' })).toHaveCount(0)
    await expect(page.getByText('Nog geen eigen comment')).toHaveCount(0)
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
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await expect(page.getByTestId('comment-heading')).toBeVisible()
    // Two no-regel comment-index rows here: the plain issue comment (index 0)
    // and the ai_warning finding (index 1) — right after it, both PR-wide/
    // no-regel items. The anchored comment mockComments always adds sorts
    // under "Comments op regels" instead (see the tests above), so it no
    // longer sits between them. A fresh open now lands on an unapproved
    // ordinary block instead of index 0 (reversed 2026-08-20, see
    // defaultSelectionRank) — select it directly, then step down to the
    // ai_warning finding.
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await page.keyboard.press('ArrowDown')
    const card = page.getByTestId('comment-detail-card').filter({ hasText: 'this call no longer matches' }).first()
    await expect(card).toBeVisible()
    await expect(card.getByTestId('comment-ai-warning')).toBeVisible()
    await expect(card).toContainText('this call no longer matches')

    // → steps into the thread exactly like it does for any other
    // comment-index item (enterPrCommentThread/isPrCommentThreadFocused —
    // the mechanism is generic over every kind, ai_warning included), not
    // just an imported issue/review comment — see the "→ steps into the
    // comment thread" test above for the same assertion on kind:'issue'.
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('command-menu')).toHaveCount(0)
    await expect(card.getByTestId('comment-detail-thread')).toHaveClass(/ring-indigo-200/)
  })
})
