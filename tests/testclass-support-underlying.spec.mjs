import { test, expect } from './_fixtures.mjs'

// A changed TEST block that another changed TEST block calls — a
// #[DataProvider] method, a same-class helper — is test-support code: it shows
// only as Onderliggende code under the test that uses it, never as its own
// row in the methodes-kolom (testSupportTargetIds / resolvedCallTargetIds in
// home.mjs, "Test-support code" in .claude/docs/underlying-code.md).
//
// Fixture: PR 110 (tests/fixtures/testclassgroup-blocks.json) —
// TriggersIndexTest has two changed methods. /api/callresolve is mocked so
// one "uses" the other.
const PR = 110
const FILE = 'tests/Feature/TriggersIndexTest.php'
const INDEX = `${PR}:${FILE}:TriggersIndexTest::it_should_index_triggers`
const FILTER = `${PR}:${FILE}:TriggersIndexTest::it_should_filter_triggers`

function row(callerId, childMethod, kind, callKey) {
  return {
    pr: PR,
    callerId,
    callKey,
    status: 'resolved',
    kind,
    childFile: FILE,
    childClass: 'TriggersIndexTest',
    childMethod,
    childLine: 12,
    childCode: 'function x() {}',
    model: '',
    confidence: '',
    updatedAt: new Date().toISOString(),
  }
}

async function mockCalls(page, rows) {
  await page.route(`**/api/callresolve?pr=${PR}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }),
  )
}

test('a data provider used by a changed test leaves the methodes-kolom and shows as Onderliggende code', async ({
  page,
}) => {
  await mockCalls(page, [
    row(INDEX, 'it_should_filter_triggers', 'data_provider', 'data_provider:it_should_filter_triggers'),
  ])
  await page.goto(`/pr/${PR}`)
  await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()

  const methodRows = page.getByTestId('test-method-row')
  await expect(methodRows).toHaveCount(1)
  await expect(methodRows.nth(0)).toContainText('it_should_index_triggers')
  // It is not an "Onderliggende code" index row either.
  await expect(page.getByTestId('block-row').filter({ hasText: 'it_should_filter_triggers' })).toHaveCount(0)
  // ...but it is a child card under the test that uses it.
  await expect(page.getByTestId('related-item').filter({ hasText: 'it_should_filter_triggers' })).toHaveCount(1)
})

test('two test helpers calling each other with no other caller both stay visible (cycle guard)', async ({
  page,
}) => {
  await mockCalls(page, [
    row(INDEX, 'it_should_filter_triggers', 'method_call', 'it_should_filter_triggers'),
    row(FILTER, 'it_should_index_triggers', 'method_call', 'it_should_index_triggers'),
  ])
  await page.goto(`/pr/${PR}`)
  await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
  await expect(page.getByTestId('test-method-row')).toHaveCount(2)
})
