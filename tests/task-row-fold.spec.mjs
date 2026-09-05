import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// buildTaskRows folds several indistinguishable rows (same workflow type,
// same status, same generic note, no comment ref) into one row with a
// "· N×" count — see foldIdenticalRuns in RelatedPanel.mjs. Reported bug: 22
// separate, pixel-identical "klaar | AI-omschrijving | … | omschrijving
// gegenereerd" rows for one PR's explain_code runs.
test.describe('PR Review Tree — Taken panel folds identical rows', () => {
  test('many completed explain_code runs fold into one row with a count', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const stale = new Date(Date.now() - 6 * 60000).toISOString()
      const workflows = []
      for (let i = 0; i < 22; i++) {
        workflows.push({
          runId: 'wf-explain-' + i,
          workflow: 'explain_code',
          status: 'completed',
          createdAt: stale,
          updatedAt: stale,
        })
      }
      const state = reactive({ pr: 12903, workflows })
      const host = document.createElement('div')
      host.id = 'wf-fold-host'
      document.body.appendChild(host)
      mod.TasksPanel(state, null)(host)
    })

    const host = page.locator('#wf-fold-host')
    // Folded into exactly one row, not 22.
    await expect(host.getByTestId('workflow-row')).toHaveCount(1)
    await expect(host.getByTestId('workflow-label')).toHaveText(/AI-omschrijving.*22×/)
  })

  test('runs with a different note are never folded together', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const stale = new Date(Date.now() - 6 * 60000).toISOString()
      const state = reactive({
        pr: 12903,
        workflows: [
          { runId: 'wf-cw-1', workflow: 'code_warning', status: 'completed', createdAt: stale, updatedAt: stale, warningsFound: 0 },
          { runId: 'wf-cw-2', workflow: 'code_warning', status: 'completed', createdAt: stale, updatedAt: stale, warningsFound: 3 },
        ],
      })
      const host = document.createElement('div')
      host.id = 'wf-fold-distinct-host'
      document.body.appendChild(host)
      mod.TasksPanel(state, null)(host)
    })

    const host = page.locator('#wf-fold-distinct-host')
    // Different findings counts → different notes → stay separate rows.
    await expect(host.getByTestId('workflow-row')).toHaveCount(2)
  })
})
