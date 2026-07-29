import { test, expect, evaluateSettled } from './_fixtures.mjs'

// Coverage for the test harness itself: evaluateSettled (_fixtures.mjs) retries
// a mounting page.evaluate() on the cold-start mount race, and 14 specs now
// depend on it. Its subtle part is the cleanup between attempts — the tear-down
// can land AFTER the body has already appended and mounted its host, and a
// naive retry then leaves two identical hosts behind, which reads as a component
// bug ("expected 1 pane, received 2" with two <article>s in the snapshot — the
// shape that flaked diffview.spec.mjs) rather than as harness collateral.
//
// This drives that path deterministically: the body mounts a host and then, on
// its FIRST attempt only, throws the exact error Playwright reports for the
// race. Verified non-vacuous — with the cleanup removed, this fails with two
// hosts.
test('evaluateSettled: a retry after a partial mount leaves exactly one host', async ({ page }) => {
  await page.goto('/pr/12903')
  await page.waitForLoadState('networkidle')

  await evaluateSettled(page, async () => {
    const { reactive } = await import('/src/vendor/arrow.js')
    const Block = (await import('/src/Block.mjs')).default
    const b = reactive({
      category: 'ACTION',
      label: 'Foo::qux',
      status: 'removed',
      file: 'app/Foo.php',
      line: 50,
      approved: false,
      code: { old: { start: 50, end: 51, text: 'function qux(): int {\n}' }, new: null },
    })
    const host = document.createElement('div')
    host.id = 'evalsettled-host'
    document.body.appendChild(host)
    Block(b, { viewMode: () => 'split' })(host)
    if (!window.__evalSettledSelfTestFailed) {
      window.__evalSettledSelfTestFailed = true
      throw new Error('Execution context was destroyed, most likely because of a navigation')
    }
  })

  await expect(page.locator('#evalsettled-host')).toHaveCount(1)
  await expect(page.locator('#evalsettled-host article')).toHaveCount(1)
})
