import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Unresolving a comment thread, and how the two state-change messages look.
//
// A resolve no longer ends the thread's Workflow Execution (see
// workflows-comments.md), so a resolved thread can be reopened: the same
// comment menu that offers "Resolve comment" on an open thread offers
// "Unresolve comment" on a resolved one — never both — and running it sends
// `action:'unresolve'` on the SAME reply Signal.
//
// The trace those two actions leave in the conversation ("/resolve" and
// "/reopen") is stored verbatim but rendered as a status line
// (threadStatusSentinel/commentBody, RelatedPanel.mjs), so a reviewer never
// reads a raw command in a chat bubble — including in the "/resolve" reactions
// stored long before that rendering existed.

// mockComments serves a single PR-wide comment item whose status/reactions the
// test picks, through ONE route handler (see comment-index-items.spec.mjs for
// why unroute+route would flake against the ongoing poll).
function mockComments(page, { status = 'open', reactions = [] } = {}) {
  const now = new Date().toISOString()
  const state = {
    comments: [
      {
        id: 'ur-1',
        runId: 'run-ur-1',
        pr: 12903,
        file: '',
        line: 0,
        author: 'octocat',
        body: 'Overall this looks great, one nit below',
        createdAt: now,
        reactionCount: reactions.length,
        status,
        source: 'github',
        kind: 'issue',
        reactions,
        rowStart: -1,
        rowEnd: -1,
      },
    ],
  }
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.comments),
    }),
  )
}

test.describe('Unresolving a comment', () => {
  test('a resolved thread offers "Unresolve comment" and signals action:unresolve', async ({ page }) => {
    await mockComments(page, {
      status: 'resolved',
      reactions: [
        {
          id: 'r-1',
          source: 'ui',
          author: 'reviewer',
          body: '/resolve',
          createdAt: new Date().toISOString(),
        },
      ],
    })
    let replyBody = null
    await page.route('**/signals/reply', (route) => {
      replyBody = route.request().postDataJSON()
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // A resolved comment folds into the approved section, so reveal it first
    // and select it (a click runs the same selection a key would).
    await page.getByTestId('toggle-approved').click()
    await page.getByTestId('block-row').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Unresolve comment')
    await expect(menu).not.toContainText('Resolve comment')

    await page.getByTestId('command-row').filter({ hasText: 'Unresolve comment' }).click()

    await expect.poll(() => replyBody).not.toBeNull()
    expect(replyBody.action).toBe('unresolve')
    // Not a resolve, and no sentinel text of its own — the workflow writes the
    // trace message itself.
    expect(replyBody.done).toBeFalsy()
    expect(replyBody.body).toBeFalsy()
  })

  test('the /resolve and /reopen messages render as a status line, not as raw text', async ({ page }) => {
    const now = new Date().toISOString()
    await mockComments(page, {
      status: 'open',
      reactions: [
        { id: 'r-1', source: 'ui', author: 'reviewer', body: '/resolve', createdAt: now },
        { id: 'r-2', source: 'ui', author: 'reviewer', body: '/reopen', createdAt: now },
      ],
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const card = page.getByTestId('comment-detail-card')
    await expect(card).toBeVisible()

    const lines = card.getByTestId('thread-status-line')
    await expect(lines).toHaveCount(2)
    await expect(lines.nth(0)).toContainText('Thread opgelost')
    await expect(lines.nth(1)).toContainText('Thread heropend')
    // The stored command itself is never shown.
    await expect(card).not.toContainText('/resolve')
    await expect(card).not.toContainText('/reopen')
  })
})
