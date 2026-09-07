import { test, expect, appReady } from './_fixtures.mjs'

// The ONE Jira issue list on /pr-overview: "Planning" and "Todo" merged into a
// single list whose planning lane sits above its todo lane. Reviewer request
// ("bij nader inzien, gooi todo en planning bij elkaar, maar dan todo items
// onder de planning items"), plus the three things he asked to see per row:
// the avatar on the LEFT like the PR rows above, every Sub-task naming its
// main task, and no `↳` connector between them. See "Planning": the one list
// of sprint work before a PR exists" in .claude/docs/pr-overview.md.
//
// The ORDER itself is the backend's (groupIssues, pinned by the Go tests in
// jira_issues_test.go), so this mock serves the list already ordered — what is
// asserted here is that the page renders it verbatim and how a row reads.
test.describe('PR overview — the merged Jira issue list', () => {
  const rows = [
    { key: 'INTEG-445', title: 'Rules pauzeren', type: 'Story', status: 'In Progress', lane: 'planning', assignee: 'Reindert Vetter' },
    { key: 'PROD-216', title: 'Productgroepen', type: 'Story', lane: 'todo', assignee: 'Dennis Sloove', context: true },
    {
      key: 'PROD-254',
      title: 'Statistieken in clickhouse',
      type: 'Sub-task',
      status: 'To Do',
      lane: 'todo',
      assignee: 'Reindert Vetter',
      parentKey: 'PROD-216',
    },
    { key: 'STAT-1081', title: 'Herimporteer subscriptions', type: 'Story', status: 'To Do', lane: 'todo', assignee: 'Reindert Vetter' },
  ]

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/jira/issues**', (route) => route.fulfill({ json: { ok: true, fetchedAt: '', issues: rows } }))
  })

  test('one section, planning lane first, avatar left, every Sub-task naming its parent', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    // ONE section, not two: the old build rendered "Planning" and "Todo".
    await expect(page.locator('[data-testid="issue-section"]')).toHaveCount(1)

    const all = page.locator('[data-testid="jira-issue-row"], [data-testid="jira-context-row"]')
    await expect(all).toHaveCount(4)
    // Rendered verbatim in the backend's order: the planning lane on top.
    await expect(all.nth(0).locator('[data-testid="jira-issue-key"]')).toHaveText('INTEG-445')
    await expect(all.nth(0)).toHaveAttribute('data-jira-lane', 'planning')
    await expect(all.nth(3)).toHaveAttribute('data-jira-lane', 'todo')

    // The Sub-task names its main task in WORDS — the `↳` glyph that used to
    // carry it is gone, from the key as well as from the row as a whole.
    const sub = page.locator('[data-jira-issue="PROD-254"]')
    await expect(sub.locator('[data-testid="jira-issue-meta"]')).toHaveText('Sub-task • To Do • onderdeel van PROD-216')
    await expect(sub).not.toContainText('↳')

    // The main task itself is there as an unclickable context row, saying so
    // in a word, and it is somebody else's — which is what it is here for.
    const ctx = page.locator('[data-testid="jira-context-row"]')
    await expect(ctx).toContainText('hoofdtaak, alleen ter context')
    await expect(ctx.locator('[data-testid="assignee"]')).toHaveAttribute('data-assignee', 'Dennis Sloove')
    // Not navigable: there is nothing of yours to open on it.
    await expect(page.locator('[data-testid="jira-context-row"][data-nav-row]')).toHaveCount(0)

    // The assignee opens every row, like authorMark does on the PR rows above.
    for (let i = 0; i < 4; i++) {
      const row = all.nth(i)
      const box = await row.boundingBox()
      const mark = await row.locator('[data-testid="assignee"]').boundingBox()
      const key = await row.locator('[data-testid="jira-issue-key"]').boundingBox()
      expect(mark.x).toBeLessThan(key.x)
      expect(mark.x - box.x).toBeLessThan(60)
    }
  })

  test('a row opens the ticket’s planning page and joins the row navigation', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const row = page.locator('[data-testid="jira-issue-row"][data-jira-issue="INTEG-445"]')
    await expect(row).toHaveAttribute('href', '/plan/INTEG-445')
    await expect(row).toHaveAttribute('data-nav-row', '')
  })
})
