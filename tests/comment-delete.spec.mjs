import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// Enter on a focused comment row (reply field empty) opens a small menu with a
// "Verwijder comment" option. Choosing it signals the task_code_comment
// workflow to delete: the comment first flips to "deleting" (see
// TestTaskCodeCommentDelete in workflows_test.go for that ordering), then is
// removed from GitHub (best-effort) and from the read-model — so the UI ends
// up polling/refetching an empty comment. See RelatedPanel.mjs
// (isCommentFocused/commentReplyEmpty/deleteFocusedComment) and home.mjs
// (onKeydown's relatedActive branch, menu.mode 'comment', COMMENT_COMMANDS).
test.describe('PR Review Tree — delete a comment', () => {
  // Every test gets a PR of its own from seededPr (unseeded, no ingested
  // blocks) so it never shares the comments read-model with another spec — or
  // with its own earlier retry — on the same worker. The delete flow needs no
  // real blocks: clicking a comment row focuses it (relatedActive() becomes
  // true) independently of the block sidebar.
  async function seedComment(page, pr, body) {
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    return runId
  }

  test('Enter opens a menu with "Verwijder comment"; running it deletes the comment', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'verwijder-mij ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    // Landing on the row focuses the reply field, empty — the precondition for
    // Enter to open the delete menu instead of falling through to a reply.
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
    await expect(page.getByTestId('reaction-compose')).toHaveValue('')

    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await page.keyboard.press('Enter')

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    // Five items: "Sluit menu" (pinned first), "Resolve comment" (default,
    // 2nd — where the selection opens), "Verwijder comment", "Bewerk bericht"
    // (this comment is the reviewer's own, see comments-panel.md's "Editing
    // an own message"), and "Open op GitHub" (the comment posted successfully
    // via the github Fake, so it has a non-zero githubId — see
    // comment-view-on-github.spec.mjs for the case where that item is
    // absent).
    await expect(rows).toHaveCount(5)
    await expect(rows.first()).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Resolve comment')
    await expect(rows.nth(2)).toContainText('Verwijder comment')
    await expect(rows.nth(3)).toContainText('Bewerk bericht')
    await expect(rows.nth(4)).toContainText('Open op GitHub')

    // Move to the delete row before running it (resolve is the default).
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()

    // The comment disappears from the list once the delete flow completes.
    await expect(page.getByTestId('comment-item').filter({ hasText: body })).toHaveCount(0)
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + pr)).json()
        return list.some((c) => c.body === body)
      })
      .toBe(false)
  })

  test('Enter with a typed reply sends the reply, and opens no menu (not a stray delete)', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'niet-verwijderen ' + Math.random().toString(36).slice(2)
    const runId = await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.fill('bedankt voor de review')

    await page.keyboard.press('Enter')

    // The reply field's own Enter handler (sendReaction) ran — the reply is
    // sent — and no action menu opens (see "A reply no longer auto-opens the
    // comment's own menu" in comments-panel.md), so it definitely doesn't
    // open a straight-to-delete action either.
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + pr)).json()
        const c = list.find((x) => x.id === runId)
        return c && c.reactionCount
      })
      .toBe(1)
  })

  test('choosing "Resolve comment" resolves the comment (status resolved)', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'resolve-mij ' + Math.random().toString(36).slice(2)
    const runId = await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    await expect(page.getByTestId('reaction-compose')).toBeFocused()
    await expect(page.getByTestId('reaction-compose')).toHaveValue('')

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // "Resolve comment" is the default item (2nd row, after the pinned "Sluit
    // menu") — a plain Enter runs it.
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Resolve comment')
    await page.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()

    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + pr)).json()
        const c = list.find((x) => x.id === runId)
        return c && c.status
      })
      .toBe('resolved')
  })
})
