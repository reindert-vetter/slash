import { test, expect } from './_fixtures.mjs'

// PR 129 (tests/fixtures/enumtranslation-blocks.json + enumtranslation-callresolve.json,
// worktree in _setup.mjs' materializeEnumTranslationWorktrees). Covers the
// regression this spec is named for: OrderSummaryInclude::getLabel returns
// trans('includes.orders.' . $this->value) — a translation key resolved by
// resolveEnumValueTranslations (callresolve_analysis.go, one child per backed
// enum case x locale) whose FULL resolved key ("includes.orders.billing")
// never appears as a literal anywhere in the caller's own source — only its
// static PREFIX ("includes.orders.") does. findCallSites' translation:
// branch (home.mjs) must match that prefix too, or callScopeMethods'
// hideOutOfScope filter hides every such child at every diff granularity —
// reported bug: the Onderliggende-code panel showed "Geen onderliggende
// code." even though the callresolve read-model already carried the rows.
test.describe('a translation child resolved from an enum case still scopes to its trans() call', () => {
  test('shows the resolved translation children, not "Geen onderliggende code"', async ({ page }) => {
    await page.goto('/pr/129?mode=diff')

    const items = page.getByTestId('related-item')
    // Two cases x two locales = four translation children.
    await expect(items).toHaveCount(4)
    await expect(page.getByText('Geen onderliggende code.')).toHaveCount(0)

    const nlBilling = items.filter({ hasText: 'nl · includes.orders.billing' })
    await expect(nlBilling).toContainText('Facturatiegegevens')

    const enItems = items.filter({ hasText: 'en · includes.orders.items' })
    await expect(enItems).toContainText('Order lines')
  })
})
