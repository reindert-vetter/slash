import { test, expect } from './_fixtures.mjs'

// Syntax highlighting of the code panes. The real /api/code path needs the
// base/head worktrees (absent for the seeded fixture DB), so we mount a Block
// directly with an inline code fixture and assert Prism tokenised it. This
// guards the vendored Prism bundle (src/vendor/prism.js), the .innerHTML binding
// in Block.mjs, and the scoped token colours in index.html together.
test.describe('PR Review Tree — code highlighting', () => {
  test('renders Prism-tokenised PHP in both code panes', async ({ page }) => {
    await page.goto('/pr/12903')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::bar',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        name: 'bar',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: {
            start: 26,
            end: 29,
            text: "public function bar(): ?int {\n    $x = 'hi';\n    return $x;\n}",
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'highlight-host'
      document.body.appendChild(host)
      Block(b)(host)
    })

    const host = page.locator('#highlight-host')
    const codes = host.locator('code.language-php')
    await expect(codes).toHaveCount(2)

    // Both panes carry Prism token spans (not escaped text).
    await expect(host.locator('span.token').first()).toBeVisible()
    expect(await host.locator('span.token').count()).toBeGreaterThan(10)

    // The scoped theme colours the PHP keyword (#d73a49 → rgb(215,58,73), the
    // GitHub-light keyword red set in index.html).
    const keyword = host.locator('.token.keyword').first()
    await expect(keyword).toHaveText('public')
    await expect(keyword).toHaveCSS('color', 'rgb(215, 58, 73)')
  })
})
