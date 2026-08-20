import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

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

    await appReady(page)

    await evaluateSettled(page, async () => {
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

    await evaluateSettled(page, async () => {
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

  // Two reviewer-reported bugs on text nobody wrote as Markdown, fixed in the
  // ONE renderMarkdown pipeline (src/markdown.mjs is the only importer of the
  // vendored snarkdown, so every render point below shares this fix):
  //
  //  1. `payment_external_id` came out as payment<em>external</em>id — an
  //     intra-word `_` must stay literal, like on GitHub.
  //  2. "wat via __toString een volledige datum ..." (a real code_warning body)
  //     turned bold from `toString` to the END of the comment: one unpaired
  //     `__` that snarkdown opens and then auto-closes in its own flush().
  //
  // Both are asserted against the exact argument shapes the real call sites
  // use: renderMarkdown(text) for the PR summary/description (home.mjs), the
  // block description (Block.mjs, per paragraph) and the inbox task
  // description (inbox.mjs); renderMarkdown(text, 0, true) for a comment body
  // (RelatedPanel.mjs's commentBody) and a Claude bubble (ClaudeChat.mjs); and
  // hardBreaks() + renderMarkdown for the reviewer's own chat bubble.
  test('keeps an intra-word underscore and an unpaired ** / __ literal, at every render point', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    await appReady(page)

    await evaluateSettled(page, async () => {
      const { renderMarkdown, hardBreaks } = await import('/src/markdown.mjs')
      const cases = [
        // 1 — intra-word underscores, every call-site shape.
        ['plain', () => renderMarkdown('payment_external_id en external_id')],
        ['truncating', () => renderMarkdown('payment_external_id en external_id', 0, true)],
        ['hardbreaks', () => renderMarkdown(hardBreaks('payment_external_id en external_id'), 0, true)],
        // 2 — the real unpaired `__` from the AI risk warning, plus the same
        // shape with `**`.
        [
          'stray-underscores',
          () =>
            renderMarkdown(
              'wat via __toString een volledige datum met tijd oplevert, dus payment_external_id verschilt.',
              0,
              true,
            ),
        ],
        ['stray-stars', () => renderMarkdown('type de **parameter als CarbonInterface', 0, true)],
      ]
      for (const [name, render] of cases) {
        const host = document.createElement('div')
        host.id = 'md-lit-' + name
        host.innerHTML = render()
        document.body.appendChild(host)
      }
      // Paired emphasis must still work — this fix may not turn Markdown off.
      const ok = document.createElement('div')
      ok.id = 'md-lit-paired'
      ok.innerHTML = renderMarkdown('_cursief_ en **vet** en __ook vet__\n\n- een\n- twee')
      document.body.appendChild(ok)
    })

    for (const name of ['plain', 'truncating', 'hardbreaks']) {
      const host = page.locator('#md-lit-' + name)
      await expect(host).toContainText('payment_external_id en external_id')
      await expect(host.locator('em')).toHaveCount(0)
      await expect(host.locator('strong')).toHaveCount(0)
    }

    // The unpaired delimiter shows as text and nothing after it goes bold.
    const stray = page.locator('#md-lit-stray-underscores')
    await expect(stray).toContainText('via __toString een volledige datum')
    await expect(stray).toContainText('payment_external_id')
    await expect(stray.locator('strong')).toHaveCount(0)
    await expect(stray.locator('em')).toHaveCount(0)

    const strayStars = page.locator('#md-lit-stray-stars')
    await expect(strayStars).toContainText('type de **parameter als CarbonInterface')
    await expect(strayStars.locator('strong')).toHaveCount(0)

    const paired = page.locator('#md-lit-paired')
    await expect(paired.locator('em')).toHaveText('cursief')
    await expect(paired.locator('strong')).toHaveCount(2)
    await expect(paired.locator('li')).toHaveCount(2)

    // No placeholder codepoint ever survives into the rendered HTML.
    const leaked = await page.evaluate(() =>
      ['plain', 'truncating', 'hardbreaks', 'stray-underscores', 'stray-stars', 'paired']
        .map((n) => document.getElementById('md-lit-' + n).innerHTML)
        .join('')
        .match(/[\uE000-\uE002]/g),
    )
    expect(leaked).toBeNull()
  })

  test('neutralises a javascript: URL scheme on a real Markdown link', async ({ page }) => {
    await page.goto('/pr/12903')

    await appReady(page)

    await evaluateSettled(page, async () => {
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
