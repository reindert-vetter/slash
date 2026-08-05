import { test, expect } from './_fixtures.mjs'

// The class-member cards: a <class-header> block's declared properties and
// constants shown as their own "Onderliggende code" cards (rule 9 in
// .claude/docs/workflows-analysis.md), plus a Foo::MAX_TRIES reference resolved
// to its declaration (rule 6b). Driven by mocking /api/callresolve, like
// callresolve-live-update.spec.mjs — the Go side has its own unit tests
// (TestResolveClassMembers / TestResolveCallsConstRef), so what needs proving
// here is purely the render contract: which badge each kind gets, and that none
// of them leaks into the block index.
const CALLER = '91:app/Actions/AlphaAction.php:AlphaAction::run'

const memberRows = [
  {
    pr: 91,
    callerId: CALLER,
    callKey: 'class_member:prop:$listen',
    status: 'resolved',
    kind: 'class_property',
    childFile: 'app/Actions/AlphaAction.php',
    childClass: 'AlphaAction',
    childMethod: '$listen',
    childLine: 9,
    childCode: "protected $listen = [\n    OrderPaid::class => [SendReceipt::class],\n]",
  },
  {
    pr: 91,
    callerId: CALLER,
    callKey: 'class_member:const:MAX_TRIES',
    status: 'resolved',
    kind: 'class_constant',
    childFile: 'app/Actions/AlphaAction.php',
    childClass: 'AlphaAction',
    childMethod: 'MAX_TRIES',
    childLine: 6,
    childCode: 'public const MAX_TRIES = 3',
  },
  {
    pr: 91,
    callerId: CALLER,
    callKey: 'class_member:const:OLD_VALUE',
    status: 'resolved',
    kind: 'class_constant_changed',
    childFile: 'app/Actions/AlphaAction.php',
    childClass: 'AlphaAction',
    childMethod: 'OLD_VALUE',
    childLine: 7,
    childCode: "private const OLD_VALUE = 'b'",
  },
]

async function openWithRows(page, rows) {
  await page.route('**/api/callresolve?pr=91', (route) => route.fulfill({ json: rows }))
  await page.goto('/pr/91')
  await page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' }).click()
}

test('changed and unchanged members each get a WORD badge, and a changed one sorts first', async ({ page }) => {
  await openWithRows(page, memberRows)

  const items = page.getByTestId('related-item')
  await expect(items).toHaveCount(3)

  // Changed members (prio 0) lead; the untouched constant sinks to the bottom.
  await expect(items.nth(0)).toContainText('AlphaAction::$listen')
  await expect(items.nth(2)).toContainText('AlphaAction::MAX_TRIES')

  // The status is carried by a word, never by colour alone.
  const listen = items.filter({ hasText: 'AlphaAction::$listen' })
  await expect(listen.getByTestId('related-member-status')).toHaveText('Gewijzigd')
  await expect(listen).toContainText('property')
  await expect(listen).toContainText('OrderPaid::class') // the whole multi-line default

  const changedConst = items.filter({ hasText: 'AlphaAction::OLD_VALUE' })
  await expect(changedConst.getByTestId('related-member-status')).toHaveText('Gewijzigd')
  await expect(changedConst).toContainText('constante')

  const untouched = items.filter({ hasText: 'AlphaAction::MAX_TRIES' })
  await expect(untouched.getByTestId('related-member-status')).toHaveText('Ongewijzigd')

  // A member is not a block: it never gains a row in the index, and the caller
  // block it belongs to stays there untouched.
  await expect(page.getByTestId('block-row').filter({ hasText: '$listen' })).toHaveCount(0)
  await expect(page.getByTestId('block-row').filter({ hasText: 'MAX_TRIES' })).toHaveCount(0)
  await expect(page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' })).toHaveCount(1)
})

test('a const_ref card shows the declaration without claiming a changed/unchanged status', async ({ page }) => {
  await openWithRows(page, [
    {
      pr: 91,
      callerId: CALLER,
      callKey: 'MAX_TRIES',
      status: 'resolved',
      kind: 'const_ref',
      childFile: 'app/Support/Config.php',
      childClass: 'Config',
      childMethod: 'MAX_TRIES',
      childLine: 6,
      childCode: 'public const MAX_TRIES = 5',
    },
  ])

  const item = page.getByTestId('related-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('Config::MAX_TRIES')
  await expect(item).toContainText('const MAX_TRIES = 5')
  await expect(item).toContainText('constante')
  // Pure reference material — no gewijzigd/ongewijzigd claim, and no
  // "Ongewijzigd" diffstat badge either (it has no diff concept at all).
  await expect(item.getByTestId('related-member-status')).toHaveCount(0)
  await expect(item.getByTestId('related-diffstat')).toHaveCount(0)
})
