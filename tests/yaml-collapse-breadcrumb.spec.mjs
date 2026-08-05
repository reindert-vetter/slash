import { test, expect, evaluateSettled, leaveSearchBox, appReady } from './_fixtures.mjs'

// A huge yaml/yml whole-file fallback block (e.g. an OpenAPI spec) collapses
// long unchanged runs into a spacer just like any other huge block (see
// diff-trim-collapse.spec.mjs), but loses the surrounding key hierarchy in
// the process — a changed `description:` line gives no clue it sits under
// `paths > /products/{id}/clone > post`. yamlBreadcrumbsForSegs (Block.mjs)
// adds that hierarchy as a second line inside the spacer, yaml/yml files
// only. See ".claude/docs/diff-render.md" ("Huge blocks").
test.describe('yaml collapsed-run breadcrumb', () => {
  test('a collapsed run in a .yaml block shows the key-hierarchy breadcrumb', async ({ page }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await appReady(page)
    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const N = 300 // pushes total rows well over COLLAPSE_MIN_ROWS (300)
      const pre = Array.from({ length: N }, (_, i) => `      key${i}: value${i}`)
      const lines = [
        'paths:',
        "  /products/{id}/clone:",
        '    post:',
        ...pre,
        '      summary: Clone Product',
        '      operationId: cloneProduct',
        '      x-internal: false',
        "      description: 'Old description'",
        '      responses:',
        "        '201':",
        '          description: Created',
      ]
      const oldText = lines.join('\n')
      const newText = oldText.replace(
        "description: 'Old description'",
        "description: 'Clones the product together with its prices'",
      )
      const b = reactive({
        category: 'OTHER',
        label: 'openapi.yaml',
        status: 'modified',
        file: 'docs/openapi.yaml',
        line: 1,
        approved: false,
        code: {
          old: { start: 1, text: oldText },
          new: { start: 1, text: newText },
        },
      })
      const host = document.createElement('div')
      host.id = 'yaml-collapse-host'
      document.body.appendChild(host)
      Block(b, { activeGroup: () => null })(host)

      // Same fixture, but a non-yaml (.json) file — the breadcrumb must NOT
      // appear there even though the run collapses identically.
      const bJson = reactive({ ...JSON.parse(JSON.stringify(b)), file: 'docs/openapi.json' })
      const hostJson = document.createElement('div')
      hostJson.id = 'json-collapse-host'
      document.body.appendChild(hostJson)
      Block(bJson, { activeGroup: () => null })(hostJson)
    })

    const yaml = page.locator('#yaml-collapse-host')
    const jsonHost = page.locator('#json-collapse-host')

    // Still collapses (unaffected by the yaml-specific addition).
    await expect(yaml.locator('[data-testid=collapsed-run]').first()).toBeVisible()
    // The breadcrumb reflects the ancestor chain of the next visible line
    // (summary:), not the last hidden key's own siblings.
    await expect(yaml.locator('[data-testid=collapsed-run-breadcrumb]').first()).toHaveText(
      'Pad: paths > /products/{id}/clone > post',
    )

    // A non-yaml file collapses the same run but never gets a breadcrumb.
    await expect(jsonHost.locator('[data-testid=collapsed-run]').first()).toBeVisible()
    await expect(jsonHost.locator('[data-testid=collapsed-run-breadcrumb]')).toHaveCount(0)
  })
})
