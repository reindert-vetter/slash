import { test, expect } from './_fixtures.mjs'

// The task inbox (/inbox, src/inbox.mjs) aggregates three sources into one
// scored, points-first list: PR reviews ("Needs your review" in the shared
// tests/fixtures/inbox.json), unread comments on the reviewer's own open PRs,
// and Jira tickets assigned to them (tests/fixtures/jira-assigned.json, via
// SLASH_JIRA_ASSIGNED — see _fixtures.mjs). PR 12903 already sits under
// "Needs your review" and PR 12801 under "Ready to merge" (authored by
// reindert-vetter, the fixture's generatedFor login) — placing an unread
// comment from a different author on PR 12801 turns it into a comment_unread
// task deterministically, without touching the network.
test.describe('Task inbox (/inbox)', () => {
  async function placeUnreadComment(page) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12801,
        file: 'app/Markdown/Renderer.php',
        line: 10,
        author: 'alice',
        body: 'Kun je dit nog even checken voor je m’n review afrondt?',
        label: 'Renderer::render',
        gran: 'group',
        code: 'public function render(string $md): string\n{\n    return $this->parser->parse($md);\n}',
        rowStart: 0,
        rowEnd: 2,
      },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.runId).toBeTruthy()
    return body.runId
  }

  test('shows all three task kinds with a points badge + breakdown', async ({ page }) => {
    await placeUnreadComment(page)

    await page.goto('/inbox')
    await expect(page.getByTestId('task-index')).toBeVisible()

    const prRow = page.getByTestId('task-row').filter({ hasText: 'Refactor post scheduling' })
    const jiraRow = page.getByTestId('task-row').filter({ hasText: 'Add retry backoff for comment webhook' })
    const commentRow = page.getByTestId('task-row').filter({ hasText: 'Onbeantwoorde reactie · PR #12801' })

    await expect(prRow).toBeVisible({ timeout: 15000 })
    await expect(jiraRow).toBeVisible()
    await expect(commentRow).toBeVisible()

    // Points badge is a positive number for every row (base score alone is
    // already > 0 for every kind, see baseScore in taskinbox_analysis.go).
    for (const row of [prRow, jiraRow, commentRow]) {
      const points = Number((await row.getByTestId('task-points').innerText()).trim())
      expect(points).toBeGreaterThan(0)
    }

    // pr_review detail + breakdown. PR 12903 is the shared main blocks fixture
    // (seeded by every worker, see tests/_fixtures.mjs's seed()) — hasGraph is
    // overlaid from the real blocks table (overlayGraph/ingestedSet in
    // inbox.go), so it's actually `true` here despite the static
    // tests/fixtures/inbox.json row itself saying `false` — "Open review
    // tree" is thus expected to show, unlike an unseeded PR.
    await prRow.click()
    await expect(page.getByTestId('task-detail-pr')).toBeVisible()
    await expect(page.getByTestId('task-open-tree')).toHaveCount(1)
    await expect(page.getByTestId('task-open-tree')).toHaveAttribute('href', '/pr/12903')
    const prNotes = page.getByTestId('task-point-note')
    await expect(prNotes.filter({ hasText: 'basis' })).toBeVisible()

    // jira detail + breakdown (renders the description as markdown text).
    await jiraRow.click()
    await expect(page.getByTestId('task-detail-jira')).toBeVisible()
    await expect(page.getByTestId('task-detail-jira')).toContainText('BLOG-2001')
    await expect(page.getByTestId('task-open-jira')).toBeVisible()
    await expect(page.getByTestId('task-point-note').filter({ hasText: 'basis' })).toBeVisible()

    // comment_unread detail: the thread message + the relative code fragment
    // (composeTargetHint, reused from RelatedPanel.mjs) both show up.
    await commentRow.click()
    await expect(page.getByTestId('task-detail-comment')).toBeVisible()
    await expect(page.getByTestId('task-comment-message')).toContainText('Kun je dit nog even checken')
    await expect(page.getByTestId('comment-target')).toBeVisible()
    await expect(page.getByTestId('comment-target')).toContainText('Renderer::render')
  })

  test('snoozing a task hides it from the index, un-snoozing brings it back', async ({ page }) => {
    await page.goto('/inbox')
    await expect(page.getByTestId('task-index')).toBeVisible()

    const jiraRow = page.getByTestId('task-row').filter({ hasText: 'Add retry backoff for comment webhook' })
    await expect(jiraRow).toBeVisible({ timeout: 15000 })

    await jiraRow.getByTestId('task-snooze-btn').click()
    await expect(page.getByTestId('task-snooze-popover')).toBeVisible()
    await page.getByTestId('task-snooze-forever').click()

    // Optimistic hide — the row disappears right away, no reload needed.
    await expect(jiraRow).toHaveCount(0)

    // The snoozed drawer shows it, with a way back.
    await page.getByTestId('task-snoozed-toggle').click()
    const snoozedRow = page.getByTestId('task-snoozed-row').filter({ hasText: 'Add retry backoff for comment webhook' })
    await expect(snoozedRow).toBeVisible()
    await snoozedRow.getByTestId('task-snoozed-unsnooze').click()

    await expect(page.getByTestId('task-row').filter({ hasText: 'Add retry backoff for comment webhook' })).toBeVisible()

    // Persisted server-side too — a fresh load still shows it snoozed... i.e.
    // un-snoozed, since we just cleared it. Reload to prove it's durable, not
    // just an optimistic local flag.
    await page.reload()
    await expect(
      page.getByTestId('task-row').filter({ hasText: 'Add retry backoff for comment webhook' })
    ).toBeVisible({ timeout: 15000 })
  })

  // Regression for a bug where init() awaited the "refresh" Signal (which
  // tembed runs INLINE/blocking — it can take several seconds for a live
  // Jira lookup, see tembed-workflows.md's Recovery-priority section) before
  // ever loading the already-available read-model, leaving the whole page
  // stuck on "Laden…" for that entire time. init() must show whatever
  // GET /api/tasks/GET /api/tasksnoozes already have right away and only
  // refresh in the background (mirrors overview.mjs's
  // sendRefresh()/repollAfterRefresh()) — this test proves that ordering by
  // holding the refresh Signal open indefinitely and asserting the task list
  // still renders anyway.
  test('shows the existing task list without waiting for a slow refresh signal', async ({ page }) => {
    let releaseRefresh
    const refreshHeld = new Promise((resolve) => {
      releaseRefresh = resolve
    })
    await page.route('**/signals/refresh', async (route) => {
      await refreshHeld
      await route.continue()
    })

    await page.goto('/inbox')

    // The read-model already has data (seeded by an earlier POST/the fixture)
    // and must render well before the held-open refresh signal ever resolves.
    await expect(page.getByTestId('task-row').first()).toBeVisible({ timeout: 5000 })

    releaseRefresh()
  })

  test('reply and resolve on a comment_unread task use the existing reply signal', async ({ page }) => {
    const runId = await placeUnreadComment(page)

    await page.goto('/inbox')
    // Matched on this comment's own data-task-id ("comment:<runId>"), not on
    // its title text: the earlier "shows all three task kinds" test in this
    // file leaves its own unread comment unresolved, so by the time this test
    // runs there can be TWO "Onbeantwoorde reactie · PR #12801" rows in the
    // same worker's DB — a plain text filter would then hit Playwright's
    // strict-mode ambiguity. Titles legitimately collide in real usage too
    // (two distinct unread comments on the same PR read identically) — this
    // is a test-isolation fix, not a change in app behavior.
    const commentRow = page.locator('[data-testid="task-row"][data-task-id="' + 'comment:' + runId + '"]')
    await expect(commentRow).toBeVisible({ timeout: 15000 })
    await commentRow.click()
    await expect(page.getByTestId('task-detail-comment')).toBeVisible()

    const [replyReq] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes(`/api/workflows/${runId}/signals/reply`) && req.method() === 'POST'
      ),
      (async () => {
        await page.getByTestId('task-reply-input').fill('Ja, ziet er goed uit.')
        await page.getByTestId('task-reply-send').click()
      })(),
    ])
    const replyBody = replyReq.postDataJSON()
    expect(replyBody.done).toBe(false)
    expect(replyBody.body).toBe('Ja, ziet er goed uit.')

    // After the reply, the thread grows with the reviewer's own message.
    await expect(page.getByTestId('task-comment-message')).toHaveCount(2)

    const [resolveReq] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes(`/api/workflows/${runId}/signals/reply`) && req.method() === 'POST'
      ),
      page.getByTestId('task-reply-resolve').click(),
    ])
    const resolveBody = resolveReq.postDataJSON()
    expect(resolveBody.done).toBe(true)

    // Resolved ⇒ no longer "unread" ⇒ the task disappears from the inbox.
    // Scoped to this comment's own row (not every "Onbeantwoorde reactie" row)
    // for the same isolation reason as above — an earlier test's own,
    // still-unresolved comment must not make this assertion fail.
    await expect(commentRow).toHaveCount(0, { timeout: 15000 })
  })
})
