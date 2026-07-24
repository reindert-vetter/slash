import { test, expect } from './_fixtures.mjs'

// The collapsed comments/tasks sidebar rail (sidebarHintRail, RelatedPanel.mjs)
// shows a task count next to a clock icon. That count — and its color — must
// only reflect genuinely active (`running`) work, not a long-lived tracker
// (build_relations/approve/pr_status) that merely sits `waiting` forever.
// See runningTaskCount's own comment + detail-layout.md ("Collapsed").
test.describe('PR Review Tree — sidebar hint rail: task indicator only colors on real activity', () => {
  test('all-waiting runs show 0 and gray; a running run shows the count and amber', async ({ page }) => {
    await page.goto('/pr/12903')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const state = reactive({
        pr: 12903,
        footerVisible: false,
        workflows: [
          { runId: 'wf-1', workflow: 'build_relations', status: 'waiting', updatedAt: new Date().toISOString() },
          { runId: 'wf-2', workflow: 'approve', status: 'waiting', updatedAt: new Date().toISOString() },
        ],
        relations: [],
        callResolve: [],
        testCovers: [],
      })
      window.__wfState = state
      const host = document.createElement('div')
      host.id = 'wf-color-host'
      document.body.appendChild(host)
      mod.CommentsSidebar(state, null, null, null)(host)
      // Left collapsed on purpose — the hint rail is exactly the collapsed state.
    })

    const host = page.locator('#wf-color-host')
    const countEl = host.getByTestId('sidebar-hint-tasks-count')
    const wrapEl = host.getByTestId('sidebar-hint-tasks')

    await expect(countEl).toHaveText('0')
    await expect(wrapEl).toHaveClass(/text-slate-500/)
    await expect(wrapEl).not.toHaveClass(/text-amber-600/)

    await page.evaluate(() => {
      window.__wfState.workflows = [
        ...window.__wfState.workflows,
        { runId: 'wf-3', workflow: 'resolve_call', status: 'running', updatedAt: new Date().toISOString() },
      ]
    })

    await expect(countEl).toHaveText('1')
    await expect(wrapEl).toHaveClass(/text-amber-600/)
  })
})
