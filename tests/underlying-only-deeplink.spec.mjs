import { test, expect } from './_fixtures.mjs'

// Regression for recomputeLeftList's clamp (home.mjs): a `?sel=` deep link to
// a block that exists in the PR but is a resolved-call TARGET (panel-only
// "Onderliggende code" reference under its caller — resolvedCallTargetIds
// hides its standalone index row) used to land silently on row 0.
// applyBlockRefRestore resolves the ref fine against the pre-callresolve
// list; moments later the callresolve load re-derives the left list, the
// restored row is gone, and the clamp reset the selection to the top with no
// signal at all (measured 8/8 on the round-2 fixture PR:
// ?sel=app/Support/TaxCalculator.php:17 → routes/api.php:1). The fix lands on
// the CALLER's row instead — the one index row where the target is actually
// visible, in its Onderliggende-code panel.
//
// PR 91's seeded callresolve rows point at children that are NOT PR blocks
// (so nothing is ever hidden there) — this test patches /api/blocks to add
// AlphaTarget::resolveAlpha as a real PR block, which puts it in
// resolvedCallTargetIds' hidden set exactly like TaxCalculator on the real
// fixture PR.
const CHILD_REF = 'app/Services/AlphaService.php:42'

test('a ?sel= deep link to a panel-only resolved-call target lands on its caller', async ({ page }) => {
  await page.route('**/api/blocks?pr=91', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    const proto = json.find((b) => b.pr === 91) || json[0]
    json.push({
      ...proto,
      id: '91:app/Services/AlphaService.php:AlphaTarget::resolveAlpha',
      file: 'app/Services/AlphaService.php',
      class: 'AlphaTarget',
      name: 'resolveAlpha',
      label: 'AlphaTarget::resolveAlpha',
      category: 'SERVICE',
      line: 42,
      endLine: 45,
      status: 'modified',
      side: 'new',
    })
    json.push({
      ...proto,
      id: '91:app/Services/BetaService.php:BetaTarget::resolveBeta',
      file: 'app/Services/BetaService.php',
      class: 'BetaTarget',
      name: 'resolveBeta',
      label: 'BetaTarget::resolveBeta',
      category: 'SERVICE',
      line: 77,
      endLine: 80,
      status: 'modified',
      side: 'new',
    })
    json.push({
      ...proto,
      id: '91:app/Services/GammaService.php:GammaTarget::resolveGamma',
      file: 'app/Services/GammaService.php',
      class: 'GammaTarget',
      name: 'resolveGamma',
      label: 'GammaTarget::resolveGamma',
      category: 'SERVICE',
      line: 10,
      endLine: 12,
      status: 'modified',
      side: 'new',
    })
    await route.fulfill({ response: res, json })
  })

  // Give BetaAction a SECOND resolved child that is also a PR block, so
  // Beta's file outranks Alpha's ("hoe meer onderliggende blokken, hoe verder
  // naar boven") and row 0 is NOT the caller this deep link should land on —
  // without this, the buggy clamp-to-0 coincidentally hits the caller anyway
  // and the test cannot fail.
  await page.route('**/api/callresolve?pr=91', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    json.push({
      pr: 91,
      callerId: '91:app/Actions/BetaAction.php:BetaAction::run',
      callKey: 'resolveGamma',
      status: 'resolved',
      kind: 'method_call',
      childFile: 'app/Services/GammaService.php',
      childClass: 'GammaTarget',
      childMethod: 'resolveGamma',
      childLine: 10,
      childCode: 'public function resolveGamma(): int { return 3; }',
    })
    await route.fulfill({ response: res, json })
  })

  await page.goto('/pr/91?sel=' + encodeURIComponent(CHILD_REF))

  // The caller's row ends up selected — not row 0's arbitrary top entry.
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' }).first(),
  ).toHaveClass(/bg-indigo-50/, { timeout: 10000 })
})
