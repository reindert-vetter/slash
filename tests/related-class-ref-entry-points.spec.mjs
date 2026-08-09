import { test, expect } from './_fixtures.mjs'

// A bare `Foo::class` reference shows the class header AND — rule 6c-bis, on
// explicit request — the class's own __construct plus its first other method,
// even though this PR changed neither ("laat ook 2 blokken als onderliggende
// code zien, ook al zijn ze niet aangepast"). Driven by mocking
// /api/callresolve, like related-class-members.spec.mjs: the resolution itself
// has its own Go unit test (TestResolveCallsClassRefEntryPoints), so what needs
// proving here is the render contract — both cards appear, each with its own
// role badge, at the DEFAULT granularity (their synthetic call keys have no
// literal call site in the caller, so a missing isBlockLevelCallKey entry would
// silently scope them away).
const CALLER = '91:app/Actions/AlphaAction.php:AlphaAction::run'

const rows = [
  {
    pr: 91,
    callerId: CALLER,
    callKey: 'RunCommandActivity',
    status: 'resolved',
    kind: 'class_ref',
    childFile: 'app/Workflows/Activities/RunCommandActivity.php',
    childClass: 'RunCommandActivity',
    childMethod: '<class-header>',
    childLine: 5,
    childCode: 'final class RunCommandActivity\n{\n    private const TRIES = 3;',
  },
  {
    pr: 91,
    callerId: CALLER,
    callKey: 'class_ctor:RunCommandActivity',
    status: 'resolved',
    kind: 'class_ctor',
    childFile: 'app/Workflows/Activities/RunCommandActivity.php',
    childClass: 'RunCommandActivity',
    childMethod: '__construct',
    childLine: 9,
    childCode: 'public function __construct(private Runner $runner)\n{\n}',
  },
  {
    pr: 91,
    callerId: CALLER,
    callKey: 'class_method:RunCommandActivity',
    status: 'resolved',
    kind: 'class_first_method',
    childFile: 'app/Workflows/Activities/RunCommandActivity.php',
    childClass: 'RunCommandActivity',
    childMethod: 'run',
    childLine: 13,
    childCode: 'public function run(string $command): array\n{\n    return [];\n}',
  },
]

test('a Foo::class reference also shows the class constructor and its first method', async ({ page }) => {
  await page.route('**/api/callresolve?pr=91', (route) => route.fulfill({ json: rows }))
  await page.goto('/pr/91')
  await page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' }).click()

  const items = page.getByTestId('related-item')
  await expect(items).toHaveCount(3)

  const header = items.filter({ hasText: 'RunCommandActivity::<class-header>' })
  await expect(header).toContainText('klasse')

  // The constructor: shown with its own role word (never colour alone) and its
  // real body, though the PR doesn't touch it.
  const ctor = items.filter({ hasText: 'RunCommandActivity::__construct' })
  await expect(ctor).toContainText('constructor')
  await expect(ctor).toContainText('private Runner $runner')

  // The first other method of the class, same deal.
  const first = items.filter({ hasText: 'RunCommandActivity::run' })
  await expect(first).toContainText('eerste method')
  await expect(first).toContainText('return [];')
})
