import { test, expect, appReady } from './_fixtures.mjs'

// The Jira-comments panel at the top of the questions index (task 23b, see
// .claude/docs/plan-page.md, "Jira-opmerkingen: lezen, beantwoorden,
// @-mentions") — the frontend half of what commit 751b490 built on the
// backend (GET /api/jira/comments, GET /api/jira/users, the jira_comment
// workflow). The harness runs with SLASH_JIRA=off (no acli calls, see
// tests/_fixtures.mjs), so the Fake jira client answers a zero-value,
// comment-less issue for any (unprogrammed) key — this only smoke-tests the
// READ path and the panel's own wiring. Whether canPost/canMention read true
// or false here depends on whether SLASH_JIRA_EMAIL/SLASH_JIRA_TOKEN happen
// to be set in the ambient environment the test runner inherits (a real
// token unlocks the reply/mention UI even under SLASH_JIRA=off, since that
// only skips `acli`, not the token-configured check) — deliberately not
// asserted either way here. The reply composer/mention picker were verified
// by hand against the real Jira integration instead (see the task's own
// report).
test.describe('Plan page — Jira comments panel', () => {
  test('renders at the top of the questions index', async ({ page }) => {
    await page.goto('/plan/TEST-801')
    await appReady(page)

    const panel = page.getByTestId('plan-comments-panel')
    await expect(panel).toBeVisible()
    // Sits above the questions column's own question cards.
    await expect(page.getByTestId('plan-questions-column')).toContainText('Jira-opmerkingen')

    const group = page.getByTestId('plan-comment-group')
    await expect(group).toBeVisible()
    await expect(group).toContainText('TEST-801')
    await expect(group).toContainText('dit ticket')
    await expect(group).toContainText('geen opmerkingen')
  })

  test('the "Ververs" button re-reads the panel without throwing', async ({ page }) => {
    await page.goto('/plan/TEST-802')
    await appReady(page)

    const refresh = page.getByTestId('plan-comments-refresh')
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(page.getByTestId('plan-comment-group')).toContainText('TEST-802')
  })
})

// The comments block is now a stop of its own in the → chain, and Enter on
// it hands ↑/↓ to the individual comments — reviewer request: "als ik naar
// rechts ga, wil ik eerst jira opmerkingen blok volledig selecteren, als ik
// enter druk, wil ik tussen de opmerkingen heen kunnen navigeren" (see
// .claude/docs/plan-page.md). The Fake jira client always answers a
// comment-less issue (see the header comment above), so this mocks
// GET /api/jira/comments directly at the HTTP layer — the one seam the
// harness offers for a real, non-empty comment list — rather than adding a
// backend-only test fixture for a purely frontend nav-chain change.
test.describe('Plan page — Jira comments as a nav-chain stop', () => {
  test('→ selects the whole block first; Enter walks the individual comments; ← leaves it', async ({ page }) => {
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [
            {
              key: 'TEST-901',
              title: 'Nav-chain test ticket',
              relation: 'self',
              comments: [
                { id: 'c1', author: 'Alice', created: '2026-01-01T10:00:00Z', body: 'Eerste opmerking' },
                { id: 'c2', author: 'Bob', created: '2026-01-02T10:00:00Z', body: 'Tweede opmerking' },
              ],
            },
          ],
          canPost: false,
          canMention: false,
        },
      }),
    )

    await page.goto('/plan/TEST-901')
    await appReady(page)

    const panel = page.getByTestId('plan-comments-panel')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('plan-comment-row')).toHaveCount(2)

    // A fresh page load lands the default cursor on the comments block
    // itself (rows[0] of navRows()), block-level, not yet drilled in.
    await expect(page.getByTestId('plan-comments-state')).toHaveText('◆ blok geselecteerd')
    await expect(panel).toHaveAttribute('data-cursor', 'true')

    // Enter hands ↑/↓ to the comments themselves, and (being the reviewer's
    // own Enter press) opens the one it lands on.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('plan-comments-state')).toHaveText('◆ opmerking actief')
    const rows = page.getByTestId('plan-comment-row')
    await expect(rows.nth(0)).toHaveAttribute('data-comment-cursor', 'true')

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('data-comment-cursor', 'true')
    await expect(rows.nth(0)).toHaveAttribute('data-comment-cursor', 'false')

    // ↓ clamps at the last comment instead of leaving the block.
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('data-comment-cursor', 'true')

    // ← leaves the per-comment cursor and hands ↑/↓ back to the block row,
    // without stepping state.col back to the ticket column.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('plan-comments-state')).toHaveText('◆ blok geselecteerd')
    await expect(page.getByTestId('plan-questions-column')).toHaveAttribute('data-column-focused', 'true')

    // A click on one comment jumps straight to it, focused (mouse-navigation
    // rule 2: still reachable via → then Enter then ↓).
    await rows.nth(0).click()
    await expect(page.getByTestId('plan-comments-state')).toHaveText('◆ opmerking actief')
    await expect(rows.nth(0)).toHaveAttribute('data-comment-cursor', 'true')
  })
})

// Reviewer request, corrected after an earlier, wrong reading of "opmerkingen
// inklappen" (a per-comment text clamp — reverted): *"niet verticaal
// inklappen … comments moeten horizontaal inklappen tot 2,5 laatste comments
// … breedte blijft altijd hetzelfde"*. The PANEL folds by HEIGHT only, over
// the whole flattened list, never per comment (a comment's own body is
// always shown in full, see commentRow) and never by width.
test.describe('Plan page — the comments panel folds to the last ~2.5 comments', () => {
  test('collapsed by default (data-collapsed=true), Enter expands it, ← folds it back', async ({ page }) => {
    const body = (n) => `Opmerking nummer ${n}. `.repeat(10)
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [
            {
              key: 'TEST-902',
              title: 'Fold test ticket',
              relation: 'self',
              comments: [1, 2, 3, 4, 5].map((n) => ({ id: 'c' + n, author: 'Alice', created: '2026-01-0' + n + 'T10:00:00Z', body: body(n) })),
            },
          ],
          canPost: false,
          canMention: false,
        },
      }),
    )

    await page.goto('/plan/TEST-902')
    await appReady(page)

    const list = page.getByTestId('plan-comments-list')
    await expect(list).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByTestId('plan-comments-expand-hint')).toBeVisible()
    // No comment body is ever clamped, collapsed or not — this fold is
    // purely a container height, never a per-comment text cut.
    for (const row of await page.getByTestId('plan-comment-row').all()) {
      await expect(row.getByTestId('plan-comment-body')).not.toHaveClass(/line-clamp/)
    }

    // Enter (on the block-level row) hands ↑/↓ to the comments AND unfolds
    // the whole list — the same action, no separate toggle.
    await page.keyboard.press('Enter')
    await expect(list).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByTestId('plan-comments-expand-hint')).toHaveCount(0)

    // ← leaves per-comment navigation and folds the list back down.
    await page.keyboard.press('ArrowLeft')
    await expect(list).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByTestId('plan-comments-expand-hint')).toBeVisible()
  })

  test('the expand-hint button itself unfolds the list', async ({ page }) => {
    const body = (n) => `Opmerking nummer ${n}. `.repeat(10)
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [
            {
              key: 'TEST-904',
              title: 'Fold test ticket 2',
              relation: 'self',
              comments: [1, 2, 3, 4].map((n) => ({ id: 'c' + n, author: 'Bob', created: '2026-02-0' + n + 'T10:00:00Z', body: body(n) })),
            },
          ],
          canPost: false,
          canMention: false,
        },
      }),
    )

    await page.goto('/plan/TEST-904')
    await appReady(page)

    const list = page.getByTestId('plan-comments-list')
    await expect(list).toHaveAttribute('data-collapsed', 'true')
    await page.getByTestId('plan-comments-expand-hint').click()
    await expect(list).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByTestId('plan-comments-state')).toHaveText('◆ opmerking actief')
  })

  test('a short list (nothing to fold) shows no expand-hint at all', async ({ page }) => {
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [
            {
              key: 'TEST-905',
              title: 'Short list',
              relation: 'self',
              comments: [
                { id: 'c1', author: 'Alice', created: '2026-01-01T10:00:00Z', body: 'Korte opmerking een.' },
                { id: 'c2', author: 'Bob', created: '2026-01-02T10:00:00Z', body: 'Korte opmerking twee.' },
              ],
            },
          ],
          canPost: false,
          canMention: false,
        },
      }),
    )

    await page.goto('/plan/TEST-905')
    await appReady(page)

    await expect(page.getByTestId('plan-comments-list')).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByTestId('plan-comments-expand-hint')).toHaveCount(0)
  })
})

// Reviewer request: "chat message zijn soms onderliggende van andere message,
// dat moet je dan laten indenten". Jira threads one level deep (parentId,
// filled server-side by plan_comments.go's withCommentParents); a reply is NOT
// always adjacent to its parent in Jira's flat list, so the panel reorders
// each reply under its parent, indents it, and ↓ walks that same order. Enter
// on a comment replies to it: posted under the thread's ROOT (Jira rejects a
// reply to a reply), with the replied-to author pre-mentioned.
test.describe('Plan page — threaded Jira comments', () => {
  test('a reply sits indented under its parent; Enter replies to the thread root', async ({ page }) => {
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [
            {
              key: 'TEST-903',
              title: 'Threaded comments',
              relation: 'self',
              comments: [
                { id: '1', author: 'Alice', created: '2026-01-01T10:00:00Z', body: 'Root A' },
                { id: '2', author: 'Bob', created: '2026-01-02T10:00:00Z', body: 'Root B' },
                { id: '3', author: 'Carol', accountId: 'acc-carol', created: '2026-01-03T10:00:00Z', body: 'Reply to A', parentId: '1' },
                { id: '4', author: 'Dave', created: '2026-01-04T10:00:00Z', body: 'Orphan reply', parentId: '99' },
              ],
            },
          ],
          canPost: true,
          canMention: false,
        },
      }),
    )
    let posted = null
    await page.route('**/api/workflows/jira_comment', (route) => {
      posted = route.request().postDataJSON()
      return route.fulfill({ json: { ok: true, runId: 'r1' } })
    })

    await page.goto('/plan/TEST-903')
    await appReady(page)
    const rows = page.getByTestId('plan-comment-row')
    await expect(rows).toHaveCount(4)
    // Thread order: A, its reply, then B; the orphan (parent cut off) stays top-level.
    await expect(rows.nth(0)).toContainText('Root A')
    await expect(rows.nth(1)).toContainText('Reply to A')
    await expect(rows.nth(1)).toHaveAttribute('data-comment-depth', '1')
    await expect(rows.nth(2)).toContainText('Root B')
    await expect(rows.nth(2)).toHaveAttribute('data-comment-depth', '0')
    await expect(rows.nth(3)).toHaveAttribute('data-comment-depth', '0')
    const rootBox = await rows.nth(0).boundingBox()
    const replyBox = await rows.nth(1).boundingBox()
    expect(replyBox.x).toBeGreaterThan(rootBox.x + 10)

    // Enter into the comments, ↓ to the reply: the walk follows thread order.
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toHaveAttribute('data-comment-cursor', 'true')
    await expect(page.getByTestId('plan-comment-row-reply')).toHaveCount(1)

    // Enter replies: composer under the thread, Carol pre-mentioned.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('plan-comment-thread-composer')).toBeVisible()
    await expect(page.getByTestId('plan-comment-reply-to')).toContainText('Carol')
    const input = page.getByTestId('plan-comment-reply-input')
    await expect(input).toHaveValue('@Carol ')
    await input.pressSequentially('eens')
    await page.getByTestId('plan-comment-reply-send').click()
    await expect.poll(() => posted).not.toBeNull()
    expect(posted.parentId).toBe('1')
    expect(posted.key).toBe('TEST-903')
    expect(posted.mentions).toEqual([{ accountId: 'acc-carol', text: '@Carol' }])
  })
})
