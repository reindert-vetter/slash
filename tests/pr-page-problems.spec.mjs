import { test, expect, appReady, evaluateSettled } from './_fixtures.mjs'

// The review tree (/pr/<id>) used to have no way at all to surface "something
// went wrong out of sight" — a mirrored glue-log line (no workflow run of its
// own) only ever showed up in the /pr-overview "Mislukte taken" drawer, so a
// reviewer sitting on the PR page never saw it. That first landed as a SECOND
// card below "Taken"; it is now merged INTO that block (buildTaskRows in
// RelatedPanel.mjs — see "One block: runs, failures and skipped log lines" in
// .claude/docs/detail-layout.md), with a per-row menu and a refresh button.
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
      retryable: false, // a per-item Run ID — see retryableWorkflow (run_errors.go)
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

// openTaken walks to stop 1 (the PR-description column), where the Taken block
// lives, and waits for the column itself.
async function openTaken(page) {
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('pr-info-column')).toBeVisible()
}

test.describe('review tree — failures inside the merged "Taken" block', () => {
  test('shows a failure scoped to THIS pr, filters out one for another pr, no PR chip', async ({ page }) => {
    await stubProblems(page, PROBLEMS_FOR_12903)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    const panel = page.getByTestId('workflows-panel')
    await expect(panel).toBeVisible()

    // The failed run for PR 12903 shows inside the Taken list, with its own
    // error message and the "⚠ mislukt" WORD (never colour alone).
    const failed = panel.locator('[data-testid=workflow-row][data-status=failed]')
    await expect(failed).toHaveCount(1)
    await expect(failed).toContainText('database is locked')
    await expect(failed.getByTestId('workflow-status')).toContainText('mislukt')

    // The log line belongs to PR 970099, not 12903 — filtered out entirely.
    await expect(panel.locator('[data-testid=workflow-row][data-task-kind=log]')).toHaveCount(0)

    // No PR chip anywhere in here — the page is already scoped to this PR.
    await expect(panel).not.toContainText('#12903')
  })

  test('the Taken block itself still renders when nothing is wrong for this pr', async ({ page }) => {
    await stubProblems(page, {
      ok: true,
      failedRuns: [
        { runId: 'x', workflow: 'build_relations', pr: 970099, updatedAt: new Date().toISOString(), error: 'x', retryable: true },
      ],
      logErrors: [],
      prTitles: {},
    })
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    // The failure belongs to another PR, so no problem row here — but the
    // block is a permanent part of the column now, not a card that vanishes.
    await expect(page.getByTestId('workflows-panel')).toBeVisible()
    await expect(page.locator('[data-testid=workflow-row][data-task-problem=true]')).toHaveCount(0)
  })

  test('a click on a failure opens its menu; a non-retryable one says so', async ({ page }) => {
    await stubProblems(page, PROBLEMS_FOR_12903)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await page.locator('[data-testid=workflow-row][data-status=failed]').click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Kan niet opnieuw proberen')
    await expect(menu).toContainText('Kopieer foutmelding')
    await expect(menu.getByTestId('command-row').filter({ hasText: /^Opnieuw proberen$/ })).toHaveCount(0)
  })

  test('a retryable failure offers "Opnieuw proberen", POSTs it and says so right away', async ({ page }) => {
    await stubProblems(page, {
      ok: true,
      failedRuns: [
        {
          runId: 'run-status-boom',
          workflow: 'pr_status',
          pr: 12903,
          updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          error: 'pr_status: gh pr view 12903: exit status 1',
          retryable: true,
        },
      ],
      logErrors: [],
      prTitles: {},
    })
    const retried = []
    await page.route('**/api/workflows/retry', async (route) => {
      retried.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: 'fresh' }) })
    })

    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await page.locator('[data-testid=workflow-row][data-status=failed]').click()
    await page.getByTestId('command-row').filter({ hasText: 'Opnieuw proberen' }).click()

    await expect.poll(() => retried.length).toBeGreaterThan(0)
    expect(retried[0].runId).toBe('run-status-boom')

    // The row itself reports it immediately — the failure is only actually gone
    // once /api/problems has seen it superseded (which this stub never does),
    // so without the optimistic mark the click would look like it did nothing.
    const row = page.locator('[data-testid=workflow-row][data-status=retrying]')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('workflow-status')).toContainText('opnieuw gestart')
    await expect(row).toContainText('bezig')
  })

  test('"Verberg deze melding" drops a log row, and the refresh button is there', async ({ page }) => {
    await stubProblems(page, {
      ok: true,
      failedRuns: [],
      logErrors: [
        {
          at: new Date(Date.now() - 60_000).toISOString(),
          scope: 'pr_status',
          pr: 12903,
          message: 'pr_status: ingest refresh check pr=12903: gh pr view 12903: exit status 1',
        },
      ],
      prTitles: {},
    })
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await expect(page.getByTestId('tasks-refresh')).toBeVisible()

    const logRow = page.locator('[data-testid=workflow-row][data-task-kind=log]')
    await expect(logRow).toHaveCount(1)
    await logRow.click()
    await page.getByTestId('command-row').filter({ hasText: 'Verberg deze melding' }).click()

    // Hidden for this tab, and it stays hidden across the next poll (the stub
    // keeps serving the same line).
    await expect(logRow).toHaveCount(0)
  })

  test('a recently finished run sorts above a day-old failure — recency, not problem-first', async ({ page }) => {
    // Reported bug: three day-old "mislukt" rows sat above a run that had
    // finished 5 minutes ago. buildTaskRows now sorts the whole merged list
    // by recency (`at`), not problems-first — see detail-layout.md.
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const state = reactive({
        pr: 12903,
        workflows: [
          {
            runId: 'wf-just-finished',
            workflow: 'explain_code',
            status: 'done',
            // Comfortably past TASK_STALE_MS (5 min) so it reliably shows,
            // and far more recent than the day-old failure below.
            createdAt: new Date(Date.now() - 11 * 60000).toISOString(),
            updatedAt: new Date(Date.now() - 10 * 60000).toISOString(),
          },
        ],
        pageProblems: {
          failedRuns: [
            {
              runId: 'wf-old-failure',
              workflow: 'task_code_comment',
              pr: 12903,
              updatedAt: new Date(Date.now() - 24 * 60 * 60000).toISOString(),
              error: 'a day-old failure',
              retryable: false,
            },
          ],
          logErrors: [],
        },
      })
      const host = document.createElement('div')
      host.id = 'wf-recency-host'
      document.body.appendChild(host)
      mod.TasksPanel(state, null)(host)
    })

    const rows = page.locator('#wf-recency-host [data-testid=workflow-row]')
    await expect(rows).toHaveCount(2)
    // The recently finished run must be first, the day-old failure second.
    await expect(rows.nth(0)).toHaveAttribute('data-run-id', 'wf-just-finished')
    await expect(rows.nth(1)).toHaveAttribute('data-run-id', 'wf-old-failure')
  })

  test('more rows than fit report "nog N meer"', async ({ page }) => {
    const at = (min) => new Date(Date.now() - min * 60_000).toISOString()
    await stubProblems(page, {
      ok: true,
      failedRuns: [],
      logErrors: [1, 2, 3, 4, 5].map((n) => ({
        at: at(n),
        scope: 'pr_status',
        pr: 12903,
        message: 'pr_status: overgeslagen melding nummer ' + n,
      })),
      prTitles: {},
    })
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await expect(page.locator('[data-testid=workflow-row][data-task-kind=log]')).toHaveCount(5)
    // 3 rows are fully visible, the 4th is the half-row hint — so 2 are past
    // the fully visible ones.
    await expect(page.getByTestId('tasks-more')).toContainText('nog 2 meer')
  })
})
