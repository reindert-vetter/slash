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

  test('a fence nested inside a longer-backtick-run fence renders as one card, nothing leaks as text', async ({ page }) => {
    await page.goto('/pr/12903')

    await appReady(page)

    await evaluateSettled(page, async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      // Mirrors the reported real message: Claude posting the full contents
      // of a file that itself contains a ```bash fence, wrapped in an outer
      // fence opened with a LONGER (4-backtick) run — CommonMark's own way
      // to nest one fence inside another. See "A fence can nest another
      // fence" in .claude/rules/conventions.md.
      const md = [
        '````markdown',
        '# Title',
        '',
        '```bash',
        'php artisan test SomeTest.php',
        '```',
        '',
        'trailing line inside the outer fence',
        '````',
        '',
        'Normal prose after the outer fence.',
      ].join('\n')
      const host = document.createElement('div')
      host.id = 'markdown-nested-fence-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    const host = page.locator('#markdown-nested-fence-host')
    // Exactly ONE fence card — the inner ```bash fence must NOT be extracted
    // as its own card, it stays verbatim inside the outer fence's content.
    await expect(host.locator('[data-testid="code-fence"]')).toHaveCount(1)
    const codeText = await host.locator('[data-testid="code-fence"] pre').innerText()
    expect(codeText).toContain('```bash')
    expect(codeText).toContain('php artisan test SomeTest.php')
    expect(codeText).toContain('trailing line inside the outer fence')
    // The trailing prose must render as ordinary, clean text OUTSIDE the
    // fence card — a single line, no leftover stray backticks and no
    // flattened bash-command text glued onto it (the pre-fix symptom).
    // snarkdown emits no wrapping element for a bare trailing line (see its
    // own "no paragraph handling at all" note in conventions.md), so it's a
    // raw trailing text node after the card, read directly.
    const trailing = await host.evaluate((el) => el.lastChild.textContent.trim())
    expect(trailing).toBe('Normal prose after the outer fence.')
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
  // block description (Block.mjs, per paragraph);
  // renderMarkdown(text, 0, true) for a comment body
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

  // Reviewer report: GitHub's own drag-and-drop screenshot upload writes a
  // literal `<img width height alt src />` tag into the PR body instead of
  // `![]()` syntax, so it used to show up as a wall of escaped tag text (see
  // the task screenshot). `extractRawImages` (markdown.mjs) recognises this
  // ONE tag shape via a strict attribute allow-list and re-emits it as a
  // plain image, which `enhanceImages` then styles/groups exactly like a
  // Markdown-syntax image — same mechanism, no second implementation.
  test('renders a raw GitHub-style <img> tag as a real, styled image and groups a run of them', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    await appReady(page)

    await evaluateSettled(page, async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md =
        'Some text\n\n' +
        '<img width="1500" height="950" alt="1-overzicht" src="https://github.com/user-attachments/assets/aaa" /> ' +
        '<img width="1500" height="950" alt="2-tooltip" src="https://github.com/user-attachments/assets/bbb" />'
      const host = document.createElement('div')
      host.id = 'markdown-raw-img-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    const host = page.locator('#markdown-raw-img-host')
    const imgs = host.locator('img[data-md-image]')
    await expect(imgs).toHaveCount(2)
    await expect(imgs.first()).toHaveAttribute(
      'src',
      'https://github.com/user-attachments/assets/aaa',
    )
    await expect(imgs.first()).toHaveAttribute('alt', '1-overzicht')
    // The two adjacent images (only whitespace between them) are wrapped in
    // the same grouping row enhanceImages already produces for a Markdown
    // `![]()` run.
    const group = host.locator('div:has(> img[data-md-image])').first()
    await expect(group.locator('img[data-md-image]')).toHaveCount(2)
  })

  test('drops an unsafe raw <img> tag instead of rendering it live', async ({ page }) => {
    await page.goto('/pr/12903')

    const alerted = []
    page.on('dialog', async (d) => {
      alerted.push(d.message())
      await d.dismiss()
    })

    await evaluateSettled(page, async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md =
        'Unsafe scheme: <img src="javascript:alert(1)" alt="x" /> ' +
        'and unquoted with a handler: <img src=x onerror="alert(2)">'
      const host = document.createElement('div')
      host.id = 'markdown-raw-img-unsafe-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    expect(alerted).toHaveLength(0)
    const host = page.locator('#markdown-raw-img-unsafe-host')
    await expect(host.locator('img')).toHaveCount(0)
    await expect(host).toContainText('<img src="javascript:alert(1)" alt="x" />')
    await expect(host).toContainText('<img src=x onerror="alert(2)">')
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

  // GFM tables: snarkdown has no table support at all, so `extractTables`
  // (markdown.mjs) recognises the header/delimiter/body-row shape itself and
  // renders real <table> HTML directly, with each cell still run through
  // snarkdown for inline formatting (bold, link, inline code).
  test('renders a GFM table with alignment and inline formatting in a cell', async ({ page }) => {
    await page.goto('/pr/12903')

    await appReady(page)

    await evaluateSettled(page, async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md = [
        '| Name | Count | Notes |',
        '| :--- | :---: | ----: |',
        '| **foo** | 1 | see [docs](https://example.com) |',
        '| `bar` | 2 | plain |',
      ].join('\n')
      const host = document.createElement('div')
      host.id = 'markdown-table-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    const host = page.locator('#markdown-table-host')
    await expect(host.locator('table')).toHaveCount(1)
    const headerCells = host.locator('thead th')
    await expect(headerCells).toHaveCount(3)
    await expect(headerCells.nth(0)).toHaveText('Name')
    await expect(headerCells.nth(1)).toHaveText('Count')
    await expect(headerCells.nth(2)).toHaveText('Notes')
    // Alignment from the delimiter row's `:` markers.
    await expect(headerCells.nth(0)).toHaveAttribute('style', /text-align:\s*left/)
    await expect(headerCells.nth(1)).toHaveAttribute('style', /text-align:\s*center/)
    await expect(headerCells.nth(2)).toHaveAttribute('style', /text-align:\s*right/)

    const bodyRows = host.locator('tbody tr')
    await expect(bodyRows).toHaveCount(2)
    // Inline formatting inside a cell still works.
    await expect(bodyRows.nth(0).locator('td').nth(0).locator('strong')).toHaveText('foo')
    await expect(bodyRows.nth(0).locator('td').nth(2).locator('a')).toHaveAttribute(
      'href',
      'https://example.com',
    )
    await expect(bodyRows.nth(1).locator('td').nth(0).locator('code')).toHaveText('bar')
  })

  test('escapes an XSS attempt inside a table cell instead of rendering it live', async ({ page }) => {
    await page.goto('/pr/12903')

    const alerted = []
    page.on('dialog', async (d) => {
      alerted.push(d.message())
      await d.dismiss()
    })

    await evaluateSettled(page, async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md = ['| A | B |', '| --- | --- |', '| <script>alert(1)</script> | <img src=x onerror="alert(2)"> |'].join(
        '\n',
      )
      const host = document.createElement('div')
      host.id = 'markdown-table-xss-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    expect(alerted).toHaveLength(0)
    const host = page.locator('#markdown-table-xss-host')
    await expect(host.locator('table')).toHaveCount(1)
    await expect(host.locator('script')).toHaveCount(0)
    await expect(host.locator('img')).toHaveCount(0)
    await expect(host).toContainText('<script>alert(1)</script>')
    await expect(host).toContainText('<img src=x onerror="alert(2)">')
  })

  test('does not render a table-shaped block found inside a fenced code block', async ({ page }) => {
    await page.goto('/pr/12903')

    await appReady(page)

    await evaluateSettled(page, async () => {
      const { renderMarkdown } = await import('/src/markdown.mjs')
      const md = ['```md', '| A | B |', '| --- | --- |', '| 1 | 2 |', '```'].join('\n')
      const host = document.createElement('div')
      host.id = 'markdown-table-in-fence-host'
      host.innerHTML = renderMarkdown(md)
      document.body.appendChild(host)
    })

    const host = page.locator('#markdown-table-in-fence-host')
    // The fence renders as an ordinary highlighted code card, not a table.
    await expect(host.locator('table')).toHaveCount(0)
    await expect(host.locator('[data-testid="code-fence"]')).toHaveCount(1)
    await expect(host.locator('[data-testid="code-fence"]')).toContainText('| A | B |')
  })
})
