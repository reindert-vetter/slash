import { test, expect } from './_fixtures.mjs'

// The comment-command-menu (Enter on a focused, not-yet-replied-to comment
// row) gets a fourth item, "Open op GitHub", pinned at the bottom — but ONLY
// when the focused comment actually has a GitHub anchor (a non-zero
// githubId, see comments.Comment.GithubID / focusedCommentGithubId in
// RelatedPanel.mjs). A local/private note (Local: true, never posted) has
// none, so the item must not appear at all — no dead/no-op menu row.
test.describe('PR Review Tree — "Open op GitHub" in the comment menu', () => {
  // Its own PR (unseeded, no ingested blocks) so this doesn't share the
  // comments read-model with other specs — see comment-delete.spec.mjs.
  const PR = 970005

  async function seedComment(page, body, extra = {}) {
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: PR, file: 'test.php', line: 1, author: 'reviewer', body, ...extra },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    return runId
  }

  async function openCommentMenu(page, body) {
    await page.addInitScript(() => {
      window.__opened = []
      window.open = (url, target) => {
        window.__opened.push({ url, target })
        return null
      }
    })
    await page.goto('/pr/' + PR)
    // The comments/taken sidebar is a fixed overlay toggled with Cmd+ArrowRight
    // (see detail-layout.md), collapsed by default.
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('Meta+ArrowRight')
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
    await expect(page.getByTestId('reaction-compose')).toHaveValue('')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
  }

  test('a comment with a real GitHub id shows "Open op GitHub" and opens the right discussion URL', async ({
    page,
  }) => {
    // An imported comment: Source "github" + a known ImportedRootID (as a real
    // gh-<id> import would carry, see comment_import.go) — the workflow skips
    // posting (it already exists on GitHub) and records githubId = 555 right
    // away (saveCommentGithubID).
    const body = 'github-comment ' + Math.random().toString(36).slice(2)
    await seedComment(page, body, { source: 'github', importedRootId: 555 })

    await openCommentMenu(page, body)
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(3)).toContainText('Open op GitHub')

    await rows.nth(3).click()
    // runCommand defers a clicked row's `run()` to the next animation frame
    // (see runCommand in home.mjs), so poll rather than reading immediately.
    await expect
      .poll(() => page.evaluate(() => window.__opened.length))
      .toBe(1)
    const opened = await page.evaluate(() => window.__opened)
    expect(opened[0].url).toMatch(/\/pull\/970005#discussion_r555$/)
    expect(opened[0].target).toBe('_blank')
  })

  test('a local/private note has no "Open op GitHub" item', async ({ page }) => {
    const body = 'lokale-notitie ' + Math.random().toString(36).slice(2)
    await seedComment(page, body, { local: true })

    await openCommentMenu(page, body)
    const rows = page.getByTestId('command-row')
    // Only the three usual items — no dead/no-op GitHub row for a comment
    // that was never posted.
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Resolve comment')
    await expect(rows.nth(2)).toContainText('Verwijder comment')
    for (const r of await rows.allTextContents()) {
      expect(r).not.toContain('Open op GitHub')
    }
  })
})
