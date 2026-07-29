import { test, expect } from './_fixtures.mjs'

// Test methods group into one row per class ("Start"-index) with a
// methodes-kolom (stop 2b of the left→right nav chain) between the pr-index
// and the diff — see testClassRowItem/recomputeLeftList and
// TestMethodsColumn.mjs in home.mjs, and "Grouping test methods per class" in
// .claude/rules/detail-layout.md.
//
// Fixture: PR 110 (tests/fixtures/testclassgroup-blocks.json, worktrees
// materialized in _setup.mjs via materializeTestClassGroupWorktrees) —
// TriggersIndexTest (two changed methods) and SettingsStoreTest (a single
// changed method, proving a class groups even with just one method).
const PR = 110

test.describe('test methods group per class', () => {
  test('the sidebar shows one row per class, not one per method', async ({ page }) => {
    await page.goto(`/pr/${PR}`)
    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)
    const triggersRow = rows.filter({ hasText: 'TriggersIndexTest' })
    await expect(triggersRow).toHaveCount(1)
    await expect(triggersRow).not.toContainText('it_should_index_triggers')
    await expect(rows.filter({ hasText: 'SettingsStoreTest' })).toHaveCount(1)
  })

  test('selecting a class row already shows the methodes-kolom + a diff preview in list mode', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()

    // Decision: visible in list mode already, next to the existing diff
    // preview — no → needed first.
    const column = page.getByTestId('test-methods-column')
    await expect(column).toBeVisible()
    const methodRows = page.getByTestId('test-method-row')
    await expect(methodRows).toHaveCount(2)
    await expect(methodRows.nth(0)).toContainText('it_should_index_triggers')
    await expect(methodRows.nth(1)).toContainText('it_should_filter_triggers')

    // A real diff card for the active (first) method already renders too.
    await expect(page.getByTestId('detail-card').locator('code.language-php').first()).toBeVisible()
    // 'list' is the default mode, so bindUrlState omits `mode=` from the URL
    // entirely (see urlState.mjs) — the absence of `mode=diff` is the
    // observable signal that we never stepped into the diff.
    await expect(page).not.toHaveURL(/mode=diff/)
  })

  test('→ opens the methodes-kolom, ↓ moves the active method, → again enters its diff', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()

    // First →: focus moves onto the methodes-kolom (stop 2b) — stays in list
    // mode, does NOT step straight into the diff.
    await page.keyboard.press('ArrowRight')
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(page.getByTestId('test-methods-column')).toHaveClass(/border-indigo-300|dark:border-indigo-500/)

    // ↓ moves the active method within the column.
    await page.keyboard.press('ArrowDown')
    const activeRow = page.getByTestId('test-method-row').nth(1)
    await expect(activeRow).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)

    // Second → enters the diff of the now-active (second) method.
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.getByTestId('detail-card')).toContainText('it_should_filter_triggers')

    // ← steps back to the methodes-kolom (not all the way to the pr-index).
    await page.keyboard.press('ArrowLeft')
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(page.getByTestId('test-methods-column')).toBeVisible()

    // A second ← finally leaves the column, back to the pr-index.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-index')).toHaveClass(/border-indigo-300|dark:border-indigo-500/)
  })

  test('↓ past the last method flows to the first method of the next class row', async ({ page }) => {
    await page.goto(`/pr/${PR}`)
    // SettingsStoreTest has exactly one method — the very first ↓ inside its
    // (one-item) methodes-kolom already runs off the end, so it must flow
    // straight to the first method of the OTHER class row (TriggersIndexTest).
    await page.getByTestId('block-row').filter({ hasText: 'SettingsStoreTest' }).click()
    await page.keyboard.press('ArrowRight') // focus the methodes-kolom
    await page.keyboard.press('ArrowDown') // flows on to the other class row

    await expect(
      page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }),
    ).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
    const methodRows = page.getByTestId('test-method-row')
    await expect(methodRows).toHaveCount(2)
    await expect(methodRows.nth(0)).toContainText('it_should_index_triggers')
  })

  test('a class with a single changed method still groups into its own row + column', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'SettingsStoreTest' }).click()
    await expect(page.getByTestId('test-methods-column')).toBeVisible()
    await expect(page.getByTestId('test-method-row')).toHaveCount(1)
  })

  test('approving a method rolls up into the class pill, and the PR-wide total stays correct', async ({
    page,
  }) => {
    const runId = await (
      await page.request.post('/api/workflows/approve', { data: { pr: PR } })
    ).json()
    const methodId =
      '110:tests/Feature/TriggersIndexTest.php:TriggersIndexTest::it_should_index_triggers'
    await page.request.post(`/api/workflows/${runId.runId}/signals/set`, {
      data: { blockId: methodId, rows: [0], calls: [] },
    })
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/approvals?pr=${PR}`)
        const rows = await res.json()
        const row = Array.isArray(rows) ? rows.find((r) => r.blockId === methodId) : null
        return row ? row.rows.length : 0
      })
      .toBeGreaterThan(0)

    await page.goto(`/pr/${PR}`)
    // The class row's own pill (methods-only, decision 9) shows SOME progress
    // — not 0/N — once one of its methods has an approved row.
    const row = page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' })
    const pill = row.getByTestId('block-approval')
    await expect(pill).toBeVisible()
    await expect(pill).not.toContainText('0/')

    // The PR-wide header counter must still count that approved row exactly
    // once (never lost, never doubled) — it shows at least 1 done.
    const summary = page.getByTestId('approval-summary')
    await expect(summary).toBeVisible()
    const text = await summary.textContent()
    const [done] = text.match(/(\d+)\/(\d+)/).slice(1).map(Number)
    expect(done).toBeGreaterThanOrEqual(1)
  })
})
