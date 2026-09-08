import { test, expect, appReady } from './_fixtures.mjs'

// Reviewer report (screenshot): the phase card kept reading "1. intent … nu"
// while Claude was already generating specs — indistinguishable from
// "nothing is happening yet" for the phase right after the current one. This
// asserts the fourth "bezig" state on that next phase's row while generation
// is in flight (data-phase-state="busy", word "bezig") — see phaseRow's own
// doc comment in src/plan.mjs and "Three stages, three files" in
// .claude/docs/plan-page.md.
test.describe('Plan page — the phase card shows a busy marker while generating', () => {
  const baseDoc = {
    key: 'STAT-1124',
    title: 'Iets in clickhouse',
    description: 'desc',
    url: '',
    questions: [],
    tasks: [],
    answers: [],
    error: '',
    chat: [],
  }
  const artifacts = {
    dir: 'data/plans/STAT-1124',
    phase: 'intent',
    files: [
      { phase: 'intent', file: 'intent.md', path: 'data/plans/STAT-1124/intent.md', exists: true },
      { phase: 'specs', file: 'spec.md', path: 'data/plans/STAT-1124/spec.md', exists: false },
      { phase: 'plan', file: 'plan.md', path: 'data/plans/STAT-1124/plan.md', exists: false },
    ],
  }

  test('the "specs" row shows "bezig" while the tracker is generating', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({ json: { ok: true, key: 'STAT-1124', doc: baseDoc, runs: [], generating: true, artifacts } }),
    )

    await page.goto('/plan/STAT-1124')
    await appReady(page)

    const row = page.locator('[data-testid="plan-phase-row"][data-phase="specs"]')
    await expect(row).toHaveAttribute('data-phase-state', 'busy')
    await expect(row).toContainText('bezig')
  })

  test('the "specs" row stays "nog niet" once generation is done', async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({ json: { ok: true, key: 'STAT-1124', doc: baseDoc, runs: [], generating: false, artifacts } }),
    )

    await page.goto('/plan/STAT-1124')
    await appReady(page)

    const row = page.locator('[data-testid="plan-phase-row"][data-phase="specs"]')
    await expect(row).toHaveAttribute('data-phase-state', 'todo')
    await expect(row).toContainText('nog niet')
  })
})
