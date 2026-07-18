import { test, expect } from './_fixtures.mjs'

// PR 101 (tests/fixtures/migrationmodel-blocks.json + migrationmodel-callresolve.json)
// seeds a single caller with two class-level callresolve children: one
// "model_usage" (a controller using an Eloquent model via new/static) and one
// "migration_model" (a changed migration's Schema::create/table mapped to its
// model — see .claude/rules/tembed-workflows.md, "migration → model"). Both
// point at the WHOLE model class (childMethod == ""), so the panel must show a
// bare model-name label ("ProductGroup"/"Order") and a "model" badge — never
// the "Class::" template a regular method_call child gets (resolvedCallChildren
// in home.mjs, KIND_LABEL in RelatedPanel.mjs).
test.describe('PR Review Tree — migration→model / model-usage children', () => {
  test('both class-level children show a bare model name and a "model" badge', async ({
    page,
  }) => {
    await page.goto('/pr/101')

    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(2)

    const productGroup = items.filter({ hasText: 'ProductGroup' })
    const order = items.filter({ hasText: 'Order' })
    await expect(productGroup).toHaveCount(1)
    await expect(order).toHaveCount(1)

    // Bare model name — never the method_call "Class::method" template (no
    // trailing "::" from an empty childMethod).
    await expect(productGroup).toContainText('ProductGroup')
    await expect(productGroup).not.toContainText('ProductGroup::')
    await expect(order).toContainText('Order')
    await expect(order).not.toContainText('Order::')

    // Both carry the "model" KIND_LABEL badge.
    await expect(productGroup.getByText('model', { exact: true })).toBeVisible()
    await expect(order.getByText('model', { exact: true })).toBeVisible()
  })
})
