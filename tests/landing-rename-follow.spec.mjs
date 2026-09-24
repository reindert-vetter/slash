import { test, expect } from './_fixtures.mjs'

// An own Claude landing that RENAMES or REMOVES the block on screen
// (refreshBlocksAfterOwnLanding → landingSuccessor, home.mjs). Reviewer
// report: a drilled column went blank after an edit renamed its method — the
// old name has no source any more. See "An open drilled column" in
// .claude/docs/pending-push.md.
//
// /api/blocks is mocked after the landing (same technique as
// refreshing-pill.spec.mjs); /api/code for a renamed name is served from the
// old name's real source, since the fixture worktree never changes on disk.

function mockCheckout(page, pr) {
  return page.route('**/api/chat/checkout?*', (route) =>
    route.fulfill({ json: { ok: true, checkout: { [pr]: { pr, runId: 'chatmerge-' + pr, refreshingFiles: [] } } } }),
  )
}

// Fires one blocks.changed for `file` once release() is called; flips
// state.landed first so the blocks/code mocks switch over.
function mockLanding(page, pr, file, flag) {
  let release
  const released = new Promise((r) => (release = r))
  page.route('**/api/events*', async (route) => {
    await released
    flag.landed = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body:
        'retry: 300\n\n' +
        `data: ${JSON.stringify({ type: 'blocks.changed', pr, seq: 1, data: { landedFiles: [file] } })}\n\n`,
    })
  })
  return () => release()
}

// Serves /api/code for a renamed name from another name's real source.
function mockRenamedCode(page, aliases) {
  return page.route('**/api/code?*', async (route) => {
    const url = new URL(route.request().url())
    const alias = aliases[url.searchParams.get('name')]
    if (!alias) return route.continue()
    url.searchParams.set('name', alias)
    const res = await route.fetch({ url: url.toString() })
    await route.fulfill({ response: res })
  })
}

const block = (pr, file, cls, name, line, endLine) => ({
  id: `${pr}:${file}:${cls}::${name}`,
  pr,
  file,
  class: cls,
  name,
  label: `${cls}::${name}`,
  category: 'ACTION',
  line,
  endLine,
  status: 'modified',
  side: 'new',
})

test('several renamed candidates: the index follows the one holding the last approved line, cursor on it', async ({
  page,
}) => {
  const flag = { landed: false }
  const FILE = 'app/Actions/RangeSelectAction.php'
  await page.route('**/api/blocks?pr=102*', async (route) => {
    if (!flag.landed) return route.continue()
    const res = await route.fetch()
    const json = (await res.json()).filter((b) => b.name !== 'execute')
    // Two new blocks, neither on execute's start line: only the approved line
    // found back ($b = 2, the last approved row) tells them apart.
    json.push(block(102, FILE, 'RangeSelectAction', 'renamedA', 900, 905))
    json.push(block(102, FILE, 'RangeSelectAction', 'renamedB', 910, 920))
    await route.fulfill({ json })
  })
  await mockRenamedCode(page, { renamedA: 'other', renamedB: 'execute' })
  await page.route('**/api/approvals?pr=102*', (route) =>
    route.fulfill({ json: [{ blockId: `102:${FILE}:RangeSelectAction::execute`, rows: [2, 3], calls: [] }] }),
  )
  await mockCheckout(page, 102)
  const release = mockLanding(page, 102, FILE, flag)

  await page.goto('/pr/102')
  const execute = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::execute' })
  await execute.click()
  await expect(page.locator('[data-testid="block-column"] article').first()).toContainText('$a = 1;')

  release()

  const renamedB = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::renamedB' })
  await expect(renamedB).toHaveClass(/bg-indigo-50/)
  // Rows 2/3 ($a/$b) were approved: the cursor lands on $b, the second line unit.
  await expect.poll(() => new URL(page.url()).searchParams.get('gran')).toBe('line')
  await expect.poll(() => new URL(page.url()).searchParams.get('chg')).toBe('1')
})

// PR 12903: findOrCreateCustomer → (synthetic relation) → execute, same
// fixture chain as drill-refresh-multi-level.spec.mjs.
const PAY_FILE = 'app/Actions/CreatePaymentAction.php'
const PARENT_ID = `12903:${PAY_FILE}:CreatePaymentAction::findOrCreateCustomer`
const EXECUTE_ID = `12903:${PAY_FILE}:CreatePaymentAction::execute`

async function drillIntoExecute(page, blocksAfter) {
  const flag = { landed: false }
  await page.route('**/api/blocks?pr=12903', async (route) => {
    if (!flag.landed) return route.continue()
    const res = await route.fetch()
    await route.fulfill({ json: blocksAfter(await res.json()) })
  })
  await page.route('**/api/relations?pr=12903', (route) =>
    route.fulfill({ json: [{ pr: 12903, parentId: PARENT_ID, childId: EXECUTE_ID, kind: 'event_listener' }] }),
  )
  await mockCheckout(page, 12903)
  const release = mockLanding(page, 12903, PAY_FILE, flag)

  await page.goto('/pr/12903')
  await page.getByTestId('block-row').filter({ hasText: 'findOrCreateCustomer' }).click()
  await expect(page.getByTestId('detail-panel').locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('execute')
  await child.click()
  await expect(page.getByTestId('drill-column')).toContainText('execute')
  await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toBe(EXECUTE_ID)
  return release
}

test('a drilled column follows its renamed block instead of going blank', async ({ page }) => {
  await mockRenamedCode(page, { executeRenamed: 'execute' })
  const release = await drillIntoExecute(page, (json) => {
    const old = json.find((b) => b.id === EXECUTE_ID)
    return json
      .filter((b) => b.id !== EXECUTE_ID)
      .concat([block(12903, PAY_FILE, 'CreatePaymentAction', 'executeRenamed', old.line, old.endLine)])
  })

  release()

  await expect
    .poll(() => new URL(page.url()).searchParams.get('drill'))
    .toBe(`12903:${PAY_FILE}:CreatePaymentAction::executeRenamed`)
  const col = page.getByTestId('drill-column')
  await expect(col).toContainText('executeRenamed')
  await expect(col.locator('code.language-php').first()).toContainText('findOrCreateCustomer')
})

test('a drilled column whose block was really removed steps one level back', async ({ page }) => {
  const release = await drillIntoExecute(page, (json) => json.filter((b) => b.id !== EXECUTE_ID))

  release()

  await expect(page.getByTestId('drill-column')).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toBe(null)
  await expect(page).toHaveURL(/mode=diff/)
})
