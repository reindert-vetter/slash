import { test, expect } from './_fixtures.mjs'

// The "Taken" (workflow runs) column's per-row description + timestamp
// (workflowNote/relTime in RelatedPanel.mjs). Like blockstats.spec.mjs, we
// mount RelatedPanel directly with synthetic state on a live page (needed for
// the Tailwind/Prism CSS from index.html) rather than driving a real
// build_relations Execution end-to-end: build_relations only ever gets an
// Execution via a full `POST /api/ingest` (git/gh, offline-unfriendly in this
// harness — see the SLASH_GITHUB=off note in conventions.md), so this is the
// established, lower-cost way to exercise the actual rendering code against a
// realistic API-shaped run object.
test.describe('PR Review Tree — Taken panel: waiting note + relative update time', () => {
  test('a build_relations "wacht" row summarises what was built instead of saying "opbouwen…", and shows a relative update time', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const RelatedPanel = (await import('/src/RelatedPanel.mjs')).default
      const state = reactive({
        pr: 12903,
        workflows: [
          {
            runId: 'wf-relations-test',
            workflow: 'build_relations',
            status: 'waiting',
            createdAt: new Date(Date.now() - 10 * 60000).toISOString(),
            updatedAt: new Date(Date.now() - 4 * 60000).toISOString(),
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
      RelatedPanel(state, null, {}, null)(host)
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

    // New: a relative "last updated" line, derived from run.updatedAt (~4
    // minutes ago above).
    const updated = row.getByTestId('workflow-updated')
    await expect(updated).toHaveText(/\d+ min geleden/)
  })

  test('a task_code_comment row also shows a relative update time', async ({ page, request }) => {
    // Real run (not synthetic state) — the generic relTime mechanism applies
    // to every workflow type, not just build_relations.
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
    const row = page.locator(`[data-testid=workflow-row][data-run-id="${runId}"]`)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('workflow-updated')).toHaveText(/net nu|\d+ min geleden/)
  })
})
