import { test, expect, appReady } from './_fixtures.mjs'

// The generation/topics run's live pane is a status bar + progress bar, not the
// raw streamed JSON (.claude/docs/plan-page.md, "Live progress"). The snapshot
// is pushed straight into the shared claudeTurns store, as the SSE handler does.
const PARTIAL =
  '{"tasks":[{"title":"Eerste taak","explanation":"Dit is de uitleg. Het schaduwschrijven gaat achter een toggle.","children":[]},' +
  '{"title":"Tweede taak","explanation":"Kill switch toevoegen zodat het per shop kan'

async function push(page, convId, snap) {
  await page.evaluate(
    async ([id, s]) => {
      const m = await import('/src/claudeTurns.mjs')
      m.setTurnProgress(id, s)
    },
    [convId, snap],
  )
}

test('generation pane shows a progress bar and the last readable sentence, no raw JSON', async ({ page }) => {
  await page.goto('/plan/TEST-901')
  await appReady(page)
  await push(page, 'plangen:TEST-901', {
    running: true,
    phase: 'writing',
    label: 'plan opstellen',
    startedAt: Date.now(),
    partial: PARTIAL,
  })
  const pane = page.getByTestId('plan-generate-live')
  await expect(pane.getByTestId('plan-generate-live-progress')).toHaveAttribute('aria-valuenow', '50')
  await expect(pane.getByTestId('plan-generate-live-progress-text')).toContainText('schrijven')
  await expect(pane.getByTestId('plan-generate-live-progress-text')).toContainText('2 taken geschreven')
  const last = pane.getByTestId('plan-generate-live-last')
  await expect(last).toContainText('Kill switch toevoegen zodat het per shop kan')
  await expect(last).not.toContainText(/[{}"]/)
  await expect(pane.getByTestId('plan-generate-live-partial')).toHaveCount(0)

  await push(page, 'plangen:TEST-901', { running: false, phase: 'writing', startedAt: Date.now(), partial: PARTIAL })
  await expect(pane.getByTestId('plan-generate-live-progress')).toHaveAttribute('aria-valuenow', '100')
  await expect(pane.getByTestId('plan-generate-live-progress-text')).toContainText('klaar')
})
