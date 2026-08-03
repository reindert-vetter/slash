import { test, expect, appReady } from './_fixtures.mjs'

// Regression test for: "ready-confirm" (the "Zet om naar review" button in a
// draft PR's popover, see readyForReviewSection in src/overview.mjs) used to
// only be dimmed with `?disabled=` while ui.readySubmitting — an arrow.js
// binding that silently does nothing (it sets a literal attribute named
// "?disabled", never the real `disabled`). A stray extra click during
// submission could thus fire a second POST /api/workflows/ready_for_review.
//
// We serve a synthetic /api/inbox snapshot (a draft PR, PR 90210 — a number
// that doesn't exist in the seeded blocks DB, so kickOffStatuses/
// kickOffApprovals' unmocked real requests just resolve to "no data" without
// interfering with anything) instead of touching the shared, worker-wide
// SLASH_INBOX fixture every other overview test counts rows against — see
// the note in tests/overview-stack-fanout.spec.mjs for why a second inbox
// fixture can't coexist there.
test.describe('PR Review Tree — ready for review', () => {
  test('ready-confirm is really disabled while submitting, not just dimmed', async ({ page }) => {
    await page.route('**/api/inbox', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          live: true,
          repo: 'blog-org/blog-platform',
          generatedFor: 'reindert-vetter',
          runId: '',
          sections: [
            {
              title: 'Your drafts',
              prs: [
                {
                  number: 90210,
                  title: 'Draft: work in progress',
                  author: 'reindert-vetter',
                  updatedAt: '2026-07-11T08:00:00Z',
                  url: 'https://github.com/blog-org/blog-platform/pull/90210',
                  isDraft: true,
                  baseRefName: 'develop',
                  headRefName: 'feature/wip',
                  additions: 3,
                  deletions: 1,
                  changedFiles: 1,
                  comments: 0,
                  hasGraph: false,
                },
              ],
            },
          ],
        }),
      })
    })
    await page.route('**/api/reviewers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, reviewers: [{ login: 'alice', avatarUrl: '', count: 2 }] }),
      })
    })

    let readyCalls = 0
    let resolveReady
    const readyDone = new Promise((resolve) => {
      resolveReady = resolve
    })
    await page.route('**/api/workflows/ready_for_review', async (route) => {
      readyCalls++
      await readyDone
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"runId":"r1"}' })
    })

    await page.goto('/pr-overview')
    await appReady(page)

    const row = page.locator('[data-testid="pr-row"][data-pr="90210"]')
    await row.click()
    await page.locator('[data-testid="pr-popover"] [data-testid="ready-for-review"]').click()

    const confirm = page.locator('[data-testid="pr-popover"] [data-testid="ready-confirm"]')
    await expect(confirm).toBeVisible()
    await confirm.click()

    await expect(confirm).toHaveText(/Bezig…/)
    // Really disabled (a native `disabled` attribute) — a stray extra click
    // can't fire a second ready_for_review submission while one is already
    // in flight. See the ?disabled= vs disabled= note in
    // .claude/rules/conventions.md.
    await expect(confirm).toBeDisabled()
    await expect(confirm.click({ trial: true, timeout: 500 })).rejects.toThrow()

    resolveReady()
    await expect.poll(() => readyCalls).toBe(1)
  })
})
