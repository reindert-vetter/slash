import { test, expect } from './_fixtures.mjs'

// Test methods group into one row per class ("Start"-index) with a
// methodes-kolom (stop 2b of the left→right nav chain) between the pr-index
// and the diff — see testClassRowItem/recomputeLeftList and
// TestMethodsColumn.mjs in home.mjs, and "Grouping test methods per class" in
// .claude/docs/detail-layout.md.
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
    // 3 rows: the non-test StoreHelper block plus one row per test class
    // (groupTestClasses appends class rows after the non-test rest).
    await expect(rows).toHaveCount(3)
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

  test('Enter on the methodes-kolom opens the command menu instead of stepping into the diff; → still steps in', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()

    // First →: focus moves onto the methodes-kolom (stop 2b), stays in list mode.
    await page.keyboard.press('ArrowRight')
    await expect(page).not.toHaveURL(/mode=diff/)

    // Enter here opens the ordinary block-scoped command palette — the same
    // one that already opens on Enter when the test_class row itself is
    // selected, before ever stepping right — instead of mirroring →.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page).not.toHaveURL(/mode=diff/)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // → still steps into the diff of the active (first) method, unchanged.
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.getByTestId('detail-card')).toContainText('it_should_index_triggers')
  })

  test('→ slides the pr-index away; a second → hides the methodes-kolom; ← reverses both', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
    const index = page.getByTestId('pr-index')
    const column = page.getByTestId('test-methods-column')
    await expect(index).not.toHaveClass(/pointer-events-none/)

    // First →: focus onto the methodes-kolom — the pr-index slides fully away
    // (same translate/opacity treatment as diff mode), while mode stays list.
    await page.keyboard.press('ArrowRight')
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(index).toHaveClass(/pointer-events-none/)
    await expect(column).toBeVisible()

    // Second →: the active method's diff — the methodes-kolom disappears too.
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/mode=diff/)
    await expect(column).toHaveCount(0)
    await expect(index).toHaveClass(/pointer-events-none/)

    // ← back from the diff: the methodes-kolom returns, the pr-index stays
    // hidden (testColumnFocused survives the diff→list transition).
    await page.keyboard.press('ArrowLeft')
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(column).toBeVisible()
    await expect(index).toHaveClass(/pointer-events-none/)

    // A second ← leaves the column: the pr-index slides back in.
    await page.keyboard.press('ArrowLeft')
    await expect(index).not.toHaveClass(/pointer-events-none/)
    await expect(column).toBeVisible()
  })

  // Sidebar order (groupTestClasses appends class rows after the non-test
  // rest): StoreHelper (non-test), SettingsStoreTest, TriggersIndexTest. The
  // old stepTestMethod flow-through walked per METHOD across class rows and
  // skipped every non-test row along the way; on explicit request the
  // methodes-kolom's ↑/↓ now exit at the class edges back to the index and
  // step exactly ONE row — index navigation is always per row/class. (The
  // diff-mode flow-through, stepTestMethodChange, deliberately keeps the old
  // behaviour.)
  test('↓ past the last method exits to the index, one row further — never into the next class column', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    // SettingsStoreTest has exactly one method — the very first ↓ inside its
    // (one-item) methodes-kolom already runs off the class edge.
    await page.getByTestId('block-row').filter({ hasText: 'SettingsStoreTest' }).click()
    await page.keyboard.press('ArrowRight') // focus the methodes-kolom
    await page.keyboard.press('ArrowDown') // class edge: exit to the index, ONE row down

    // Lands on the next index row (TriggersIndexTest) as an ordinary stop-2
    // selection: the pr-index owns the keyboard again (slid back in, focus
    // border), NOT the class's methodes-kolom.
    await expect(
      page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }),
    ).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
    const index = page.getByTestId('pr-index')
    await expect(index).not.toHaveClass(/pointer-events-none/)
    await expect(index).toHaveClass(/border-indigo-300|dark:border-indigo-500/)
    await expect(page.getByTestId('test-methods-column')).not.toHaveClass(
      /border-indigo-300|dark:border-indigo-500/,
    )

    // Clamp at the very end: TriggersIndexTest is the last row — walk its
    // column to the last method, then one more ↓ does nothing (column keeps
    // the keyboard, no fall-through into the toggle-rows/search loop).
    await page.keyboard.press('ArrowRight') // focus TriggersIndexTest's methodes-kolom
    await page.keyboard.press('ArrowDown') // method 2 of 2
    await page.keyboard.press('ArrowDown') // past the last method of the last row: clamp
    await expect(page.getByTestId('test-methods-column')).toHaveClass(
      /border-indigo-300|dark:border-indigo-500/,
    )
    await expect(page.getByTestId('test-method-row').nth(1)).toHaveClass(
      /bg-indigo-50|dark:bg-indigo-500\/15/,
    )
  })

  test('↑ past the first method exits to the previous index row — also a non-test row', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'SettingsStoreTest' }).click()
    await page.keyboard.press('ArrowRight') // focus the methodes-kolom
    await page.keyboard.press('ArrowUp') // class edge: exit to the index, ONE row up

    // Lands on the plain non-test StoreHelper block right above it — the old
    // flow-through could never reach it (it only ever scanned for other
    // test_class rows and clamped here).
    await expect(page.getByTestId('block-row').filter({ hasText: 'StoreHelper' })).toHaveClass(
      /bg-indigo-50|dark:bg-indigo-500\/15/,
    )
    await expect(page.getByTestId('pr-index')).toHaveClass(
      /border-indigo-300|dark:border-indigo-500/,
    )
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

  // Approving a method straight from the list (Space, mirroring the palette's
  // "Keur ... goed" → "Ga door") must behave exactly like the general blokken
  // index: jump straight to the next not-yet-approved method with no menu, AND
  // keep the methodes-kolom itself focused so ↑/↓ keeps walking its methods —
  // see applyNextUnapproved's `keepList` branch in home.mjs. Regression: that
  // branch used to reset state.testColumnFocused to false right after the
  // jump, silently handing keyboard ownership of ↑/↓ back to the pr-index.
  test('Space on a method row jumps to the next unapproved method and keeps the column focused', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
    await page.keyboard.press('ArrowRight') // focus the methodes-kolom, method 0 active

    const column = page.getByTestId('test-methods-column')
    const rows = page.getByTestId('test-method-row')
    await page.keyboard.press(' ') // approve method 0, jump to method 1

    await expect(rows.nth(0)).toContainText('✓ 1/1')
    await expect(rows.nth(1)).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(page).not.toHaveURL(/mode=diff/)
    // The column itself must still show as focused (not just the active row
    // inside it) — otherwise the next ↑/↓ would move the sidebar instead.
    await expect(column).toHaveClass(/border-indigo-300|dark:border-indigo-500/)

    // Proof the column, not the pr-index, still owns ↑/↓: it walks back to
    // method 0 instead of moving the top-level selection.
    await page.keyboard.press('ArrowUp')
    await expect(rows.nth(0)).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
    await expect(
      page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }),
    ).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
  })

  // Regression: spaceKey's own "already approved → just continue" branch used
  // to call applyNextUnapproved without `keepList`, which unconditionally sets
  // state.mode = 'diff' — so Space on an already-done unit while still in the
  // list forced the diff open instead of just moving the cursor.
  test('Space on an already-approved method row stays in the list instead of forcing the diff open', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
    await page.keyboard.press('ArrowRight')
    const rows = page.getByTestId('test-method-row')
    await page.keyboard.press(' ') // approve method 0, jump to method 1

    // Re-select the already-approved method 0 (still list mode).
    await rows.nth(0).click()
    await expect(page).not.toHaveURL(/mode=diff/)

    await page.keyboard.press(' ') // "Ga door" only: method 0 is already done

    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(page.getByTestId('test-methods-column')).toBeVisible()
    await expect(rows.nth(1)).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
  })

  // The methodes-kolom header checkbox approves every method of the class in
  // one action (toggleTestClassApproval, home.mjs) — the class-level
  // counterpart of Block.mjs's top checkbox. Only the ACTIVE method's code is
  // loaded up front, so approving must first fetch the other method's code
  // (ensureCode) before it can compute its changed rows — this is the
  // regression the async wait guards against (approving used to be a no-op
  // for a never-opened method). Every method is still persisted through the
  // existing single-block `approve` Signal, never a direct/batch write.
  test('the class checkbox approves every method, and clears them again', async ({ page }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()

    const checkbox = page.getByTestId('test-class-approve-checkbox').locator('input[type=checkbox]')
    const methodRows = page.getByTestId('test-method-row')
    await expect(checkbox).toBeVisible()
    await expect(checkbox).not.toBeChecked()
    // Method 1 (it_should_filter_triggers) is not the active one, so its code
    // has never been fetched yet.
    await expect(methodRows.nth(1)).not.toContainText('✓')

    const method0 = '110:tests/Feature/TriggersIndexTest.php:TriggersIndexTest::it_should_index_triggers'
    const method1 = '110:tests/Feature/TriggersIndexTest.php:TriggersIndexTest::it_should_filter_triggers'
    const approvedRowCounts = async () => {
      const res = await page.request.get(`/api/approvals?pr=${PR}`)
      const rows = await res.json()
      const rowsFor = (id) => (Array.isArray(rows) ? rows.find((r) => r.blockId === id) : null)?.rows.length || 0
      return [rowsFor(method0), rowsFor(method1)]
    }

    await checkbox.click()

    await expect
      .poll(async () => {
        const [a, b] = await approvedRowCounts()
        return a > 0 && b > 0
      })
      .toBe(true)

    await expect(checkbox).toBeChecked()
    await expect(methodRows.nth(0)).toContainText('✓')
    await expect(methodRows.nth(1)).toContainText('✓')

    // Clicking again clears every method's approval.
    await checkbox.click()
    await expect
      .poll(async () => {
        const [a, b] = await approvedRowCounts()
        return a + b
      })
      .toBe(0)
    await expect(checkbox).not.toBeChecked()
    await expect(methodRows.nth(0)).not.toContainText('✓')
    await expect(methodRows.nth(1)).not.toContainText('✓')
  })
})
