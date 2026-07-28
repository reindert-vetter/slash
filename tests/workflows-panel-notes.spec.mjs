import { test, expect } from './_fixtures.mjs'

// The "Taken" (workflow runs) block's per-row description + timestamp
// (workflowNote/relTime in RelatedPanel.mjs), and its 5-minute visibility
// filter (visibleWorkflowRuns/TasksPanel, RelatedPanel.mjs — see
// detail-layout.md): a run shows only while it's genuinely `running`, or once
// it hasn't been updated in over 5 minutes. Taken now lives under the
// PR-description column (stop 1 of the nav chain), not the Onderliggende-code
// default export. Like blockstats.spec.mjs, we mount TasksPanel directly with
// synthetic state on a live page (needed for the Tailwind/Prism CSS from
// index.html) rather than driving a real build_relations Execution end-to-end
// (that only ever gets an Execution via a full `POST /api/ingest` — git/gh,
// offline-unfriendly in this harness, see the SLASH_GITHUB=off note in
// conventions.md) — this is the established, lower-cost way to exercise the
// actual rendering code against realistic API-shaped run objects.
test.describe('PR Review Tree — Taken panel: waiting note + relative update time + 5-minute filter', () => {
  test('a stale build_relations "wacht" row summarises what was built instead of saying "opbouwen…", and shows a relative update time', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const state = reactive({
        pr: 12903,
        workflows: [
          {
            // 'waiting' + updated 6 minutes ago: not running, and stale
            // (> 5 min) — visible per visibleWorkflowRuns' filter.
            runId: 'wf-relations-test',
            workflow: 'build_relations',
            status: 'waiting',
            createdAt: new Date(Date.now() - 10 * 60000).toISOString(),
            updatedAt: new Date(Date.now() - 6 * 60000).toISOString(),
          },
        ],
        // build_relations already produced these — the note should describe
        // them instead of claiming it's still building.
        relations: [
          { parentId: 'a', childId: 'b', kind: 'event_listener' },
          { parentId: 'c', childId: 'd', kind: 'event_listener' },
        ],
        callResolve: [{ status: 'resolved' }, { status: 'found' }, { status: 'unresolved' }],
        testCovers: [],
      })
      const host = document.createElement('div')
      host.id = 'wf-notes-host'
      document.body.appendChild(host)
      mod.TasksPanel(state, null)(host)
    })

    const host = page.locator('#wf-notes-host')
    const row = host.getByTestId('workflow-row')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('workflow-status')).toHaveText('wacht')

    // Bugfix under test: "wacht" must never read as active work.
    const note = row.getByTestId('workflow-note')
    await expect(note).not.toContainText('opbouwen')
    await expect(note).toContainText('2 relaties')
    await expect(note).toContainText('2 calls opgelost')
    await expect(note).toContainText('wacht op wijzigingen')

    // A relative "last updated" line, derived from run.updatedAt (~6 minutes
    // ago above).
    const updated = row.getByTestId('workflow-updated')
    await expect(updated).toHaveText(/\d+ min geleden/)
  })

  test('a freshly-placed comment task does not show up yet (not running, not stale)', async ({ page, request }) => {
    const blocks = await (await request.get('/api/blocks?pr=12903')).json()
    const b = blocks[0]
    const start = await request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: b.file,
        line: 1,
        author: 'reviewer',
        body: 'workflows-panel-notes comment',
        label: b.class + '::' + b.name,
        rowStart: -1,
        rowEnd: -1,
      },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()

    await page.goto('/pr/12903')
    await page.keyboard.press('ArrowLeft') // block-index → stop 1 (description, where Taken now lives)
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    // The run is `waiting` (task_code_comment loops on a reply Signal right
    // after saving) and was updated just now — neither running nor stale, so
    // visibleWorkflowRuns hides it.
    await expect(page.locator(`[data-testid=workflow-row][data-run-id="${runId}"]`)).toHaveCount(0)
  })

  test('a genuinely running run shows a relative update time immediately, regardless of freshness', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const state = reactive({
        pr: 12903,
        workflows: [
          {
            runId: 'wf-running-test',
            workflow: 'resolve_call',
            status: 'running',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      })
      const host = document.createElement('div')
      host.id = 'wf-running-host'
      document.body.appendChild(host)
      mod.TasksPanel(state, null)(host)
    })

    const row = page.locator('#wf-running-host').getByTestId('workflow-row')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('workflow-status')).toHaveText('draait')
    await expect(row.getByTestId('workflow-updated')).toHaveText(/net nu/)
  })
})
