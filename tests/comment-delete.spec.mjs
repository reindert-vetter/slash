import { test, expect } from './_fixtures.mjs'

// Enter on a focused comment row (reply field empty) opens a small menu with a
// "Verwijder comment" option. Choosing it signals the task_code_comment
// workflow to delete: the comment first flips to "deleting" (see
// TestTaskCodeCommentDelete in workflows_test.go for that ordering), then is
// removed from GitHub (best-effort) and from the read-model — so the UI ends
// up polling/refetching an empty comment. See RelatedPanel.mjs
// (isCommentFocused/commentReplyEmpty/deleteFocusedComment) and home.mjs
// (onKeydown's relatedActive branch, menu.mode 'comment', COMMENT_COMMANDS).
test.describe('PR Review Tree — delete a comment', () => {
  // Use a PR of its own (unseeded, no ingested blocks) so this doesn't share the
  // comments read-model with other specs seeding on their own dedicated PRs
  // (970001 in comment-thread.spec.mjs, 970002 in navigate.spec.mjs — tests run
  // fully parallel). The delete flow doesn't need real blocks: clicking a
  // comment row focuses it (relatedActive() becomes true) independently of the
  // block sidebar.
  const PR = 970003

  async function seedComment(page, body) {
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: PR, file: 'test.php', line: 1, author: 'reviewer', body },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    return runId
  }

  test('Enter opens a menu with "Verwijder comment"; running it deletes the comment', async ({
    page,
  }) => {
    const body = 'verwijder-mij ' + Math.random().toString(36).slice(2)
    await seedComment(page, body)

    await page.goto('/pr/' + PR)
    // The comments/taken sidebar is a fixed overlay toggled with Cmd+ArrowRight (see
    // detail-layout.md), collapsed by default.
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('Meta+ArrowRight')
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
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Verwijder comment')

    await page.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()

    // The comment disappears from the list once the delete flow completes.
    await expect(page.getByTestId('comment-item').filter({ hasText: body })).toHaveCount(0)
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + PR)).json()
        return list.some((c) => c.body === body)
      })
      .toBe(false)
  })

  test('Enter with a typed reply sends the reply instead of opening the delete menu', async ({
    page,
  }) => {
    const body = 'niet-verwijderen ' + Math.random().toString(36).slice(2)
    const runId = await seedComment(page, body)

    await page.goto('/pr/' + PR)
    // The comments/taken sidebar is a fixed overlay toggled with Cmd+ArrowRight (see
    // detail-layout.md), collapsed by default.
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('Meta+ArrowRight')
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.fill('bedankt voor de review')

    await page.keyboard.press('Enter')

    // No delete menu — the reply field's own Enter handler (sendReaction) ran.
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + PR)).json()
        const c = list.find((x) => x.id === runId)
        return c && c.reactionCount
      })
      .toBe(1)
  })
})
