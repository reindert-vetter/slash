import { test, expect, appReady } from './_fixtures.mjs'

// The review tree (/pr/<id>) used to have no way at all to surface "something
// went wrong out of sight" — a mirrored glue-log line (no workflow run of its
// own) only ever showed up in the /pr-overview "Mislukte taken" drawer, so a
// reviewer sitting on the PR page never saw it (see
// .claude/docs/detail-layout.md). ProblemsPanel (home.mjs) now reuses the
// exact same rows from src/problems.mjs, read from the same repo-wide
// GET /api/problems, filtered client-side to the open PR.
//
// PR 12903 is the block-fixture-backed worktree PR (pre-existing, read-only —
// see .claude/docs/testing-playwright.md); 970099 is the reserved
// "no real data, /api/problems mock only" PR number other specs already use
// for a log-only problem (see overview-problems.spec.mjs).
const PROBLEMS_FOR_12903 = {
  ok: true,
  failedRuns: [
    {
      runId: 'run-boom-page',
      workflow: 'task_code_comment',
      pr: 12903,
      updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      error: 'tembed: workflow failed: save reaction: database is locked (5)',
    },
  ],
  logErrors: [
    {
      at: new Date(Date.now() - 90_000).toISOString(),
      scope: 'import comments',
      pr: 970099, // a different PR — must NOT show up on 12903's page
      message: 'import comments: fetch review comments pr=970099: gh api ...: exit status 1',
    },
  ],
  prTitles: {},
}

function stubProblems(page, body) {
  return page.route('**/api/problems', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  )
}

test.describe('review tree — page-scoped "Mislukte taken"', () => {
  test('shows a failed run scoped to THIS pr, filters out one for another pr, no PR chip', async ({ page }) => {
    await stubProblems(page, PROBLEMS_FOR_12903)
    await page.goto('/pr/12903')
    await appReady(page)
    await page.keyboard.press('ArrowLeft') // stop 1 — the PR-description column, where TasksPanel/ProblemsPanel live
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    const panel = page.getByTestId('page-problems')
    await expect(panel).toBeVisible()

    // The failed run for PR 12903 shows, with its own error message.
    const run = panel.getByTestId('problem-run')
    await expect(run).toHaveCount(1)
    await expect(run).toContainText('database is locked')

    // The log line belongs to PR 970099, not 12903 — filtered out entirely.
    await expect(panel.getByTestId('problem-log')).toHaveCount(0)

    // No PR chip anywhere in here — the page is already scoped to this PR
    // (problemPrChip's own "#<pr> · title" text would just repeat that).
    await expect(panel).not.toContainText('#12903')
  })

  test('renders nothing at all when there is nothing wrong for this pr', async ({ page }) => {
    await stubProblems(page, {
      ok: true,
      failedRuns: [{ runId: 'x', workflow: 'build_relations', pr: 970099, updatedAt: new Date().toISOString(), error: 'x' }],
      logErrors: [],
      prTitles: {},
    })
    await page.goto('/pr/12903')
    await appReady(page)
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    await expect(page.getByTestId('page-problems')).toHaveCount(0)
  })
})
