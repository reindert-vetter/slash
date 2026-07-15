import { test, expect } from './_fixtures.mjs'

// renderMarkdown (src/markdown.mjs) wraps the vendored snarkdown
// (src/vendor/snarkdown.js) for the PR-info column's summary/body/Jira text.
// The real prMeta flows through a workflow-backed read-model (see
// tembed-workflows.md), so — same pattern as highlight.spec.mjs — we mount
// the renderer directly against a live app page (needed for the Tailwind/
// Prism CSS from index.html) instead of round-tripping the pr_status
// workflow just to get a specific body string in.
test.describe('PR Review Tree — Markdown rendering', () => {
  test('renders headings, lists, bold, links, images and Prism-highlighted code fences', async ({ page }) => {
    await page.goto('/pr/12903')

    await page.evaluate(async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md = [
        '# Title',
        '',
        'Some **bold** and *italic* text with a [link](https://example.com).',
        '',
        '- one',
        '- two',
        '',
        '![alt text](https://example.com/pic.png)',
        '',
        '```php',
        '<?php',
        'function foo() { return 1; }',
        '```',
      ].join('\n')
      const host = document.createElement('div')
      host.id = 'markdown-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    const host = page.locator('#markdown-host')
    await expect(host.locator('h1')).toHaveText('Title')
    await expect(host.locator('strong')).toHaveText('bold')
    await expect(host.locator('em')).toHaveText('italic')
    const link = host.locator('a')
    await expect(link).toHaveAttribute('href', 'https://example.com')
    await expect(host.locator('li')).toHaveCount(2)
    const img = host.locator('img')
    await expect(img).toHaveAttribute('src', 'https://example.com/pic.png')
    await expect(img).toHaveAttribute('alt', 'alt text')

    // The fenced code block is Prism-highlighted (same `.language-php` +
    // token-span pipeline as the diff panes), not snarkdown's bare escape.
    await expect(host.locator('code.language-php')).toHaveCount(1)
    await expect(host.locator('.token.keyword').first()).toBeVisible()
  })

  test('escapes a raw <script> in the source and never executes it', async ({ page }) => {
    await page.goto('/pr/12903')

    const alerted = []
    page.on('dialog', async (d) => {
      alerted.push(d.message())
      await d.dismiss()
    })

    await page.evaluate(async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md = 'Before <script>alert("xss")</script> after, and <img src=x onerror="alert(1)"> too.'
      const host = document.createElement('div')
      host.id = 'markdown-xss-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    // No alert dialog ever fired.
    expect(alerted).toHaveLength(0)

    const host = page.locator('#markdown-xss-host')
    // No live <script> or <img> element was created from the raw HTML.
    await expect(host.locator('script')).toHaveCount(0)
    await expect(host.locator('img')).toHaveCount(0)
    // The tags show up as inert, escaped text instead.
    await expect(host).toContainText('<script>alert("xss")</script>')
    await expect(host).toContainText('<img src=x onerror="alert(1)">')
  })

  test('neutralises a javascript: URL scheme on a real Markdown link', async ({ page }) => {
    await page.goto('/pr/12903')

    await page.evaluate(async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md = '[click me](javascript:alert(1))'
      const host = document.createElement('div')
      host.id = 'markdown-scheme-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    const link = page.locator('#markdown-scheme-host a')
    await expect(link).toHaveText('click me')
    await expect(link).toHaveAttribute('href', '#')
  })
})
