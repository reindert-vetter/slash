import { test, expect, appReady } from './_fixtures.mjs'

// Reviewer request (task 43): the plan page's example-code column
// ("VOORGESTELDE CODE" pane) used to mark a changed line new IN FULL, even
// when only part of it actually changed. `newProposedLines`/`codeLinesHTML`
// (src/plan.mjs) now token-diff a paired changed line (via the shared
// tokenize/diffChars/markChars in src/lineDiff.mjs) so only the new FRAGMENT
// is tinted/underlined — an unrelated, unchanged line (or the unchanged part
// of a partially-changed line) stays plain. This is exactly the kind of
// regression-sensitive rendering logic worth a targeted test.
test.describe('Plan page — partial-line new-code marking', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/plan?*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          key: 'PARTIALDIFF-1',
          doc: {
            key: 'PARTIALDIFF-1',
            title: 'Partial line diff test',
            description: 'desc',
            url: '',
            questions: [],
            tasks: [
              {
                id: 't1',
                text: 'Voeg een parameter toe',
                explanation: '',
                blocks: [
                  {
                    title: 'app/Foo.php',
                    label: '',
                    lang: 'php',
                    note: '',
                    code: 'function foo($a, $b)\n{\n    return $a;\n}',
                    children: [],
                  },
                ],
              },
            ],
            answers: [],
            error: '',
            chat: [],
          },
          runs: [],
          generating: false,
        },
      }),
    )
    await page.route('**/api/plan/current*', (route) =>
      route.fulfill({
        json: {
          found: true,
          code: 'function foo($a)\n{\n    return $a;\n}',
          dir: '/tmp/werkmap',
          truncated: false,
        },
      }),
    )
  })

  test('only the new fragment of a partially-changed line is tinted, unchanged lines stay plain', async ({ page }) => {
    await page.goto('/plan/PARTIALDIFF-1')
    await appReady(page)
    await page.getByTestId('plan-task').click()

    const proposed = page.getByTestId('plan-block-proposed')
    await expect(proposed).toBeVisible()
    const html = await proposed.locator('code').innerHTML()

    // The new fragment (", $b") is wrapped in a marked span…
    expect(html).toMatch(/<span class="bg-emerald-50[^"]*">[^<]*,[^<]*<\/span>/)
    expect(html).toContain('$b')
    // …but the unchanged lines ("return $a;" and the closing brace) carry no
    // marker span at all — a whole-line tint would wrap ALL of them too.
    const markedSegments = [...html.matchAll(/<span class="bg-emerald-50[^"]*">([^<]*)<\/span>/g)].map((m) => m[1])
    for (const seg of markedSegments) {
      expect(seg).not.toContain('return')
    }

    // Gutter '+' shows only for the one changed line, not for every line.
    const plusCount = (await proposed.innerText()).split('\n').filter((l) => l.trim().startsWith('+')).length
    expect(plusCount).toBe(1)
  })
})
