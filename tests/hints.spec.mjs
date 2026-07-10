import { test, expect } from '@playwright/test'

// Out-of-view change hints. When a diff is taller than its viewport, Block.mjs
// floats a small bar with a chevron at the top/bottom edge of the code body to
// signal there are still *changed* lines out of sight in that direction. The
// bars start hidden (opacity 0) and updateHints toggles them per scroll position
// (see syncScroll + home.mjs's refreshHints). We mount a Block with a tall diff
// inside a short, fixed-height host so the body actually overflows, then drive
// the scroll and assert which hint shows.
test.describe('PR Review Tree — out-of-view change hints', () => {
  test('shows a down hint when a change is below the fold and an up hint when it is above', async ({
    page,
  }) => {
    await page.goto('/')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // A 30-line function whose FIRST and LAST lines differ between old and new,
      // with 28 identical lines in between. That yields one changed row at the
      // very top and one at the very bottom — far enough apart that in a short
      // viewport one is always out of view.
      const middle = Array.from({ length: 28 }, (_, i) => `    $step${i} = ${i};`)
      const old = ['function big(): int {', ...middle, '    return 0;']
      const neu = ['function big(): ?int {', ...middle, '    return 1;']
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::big',
        status: 'modified',
        file: 'app/Foo.php',
        line: 10,
        name: 'big',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 10, end: 39, text: old.join('\n') },
          new: { start: 10, end: 39, text: neu.join('\n') },
        },
      })
      const host = document.createElement('div')
      host.id = 'hint-host'
      // A flex box shorter than the diff, so the code body must scroll.
      host.style.display = 'flex'
      host.style.height = '160px'
      document.body.appendChild(host)
      // Selected + in diff mode: hints are allowed to show.
      Block(b, { hintsEnabled: () => true })(host)
    })

    const container = page.locator('#hint-host [data-testid="code-diff"]')
    const up = container.locator('[data-hint="up"]')
    const down = container.locator('[data-hint="down"]')
    await expect(container).toBeVisible()

    // The hint pill uses the same green as an added line.
    await expect(down.locator('span')).toHaveClass(/bg-emerald-500/)
    await expect(up.locator('span')).toHaveClass(/bg-emerald-500/)

    // Scrolled to the top: the top change is visible, the bottom one is below the
    // fold → down hint on, up hint off. (Compute hints as home.mjs would.)
    await page.evaluate(async () => {
      const { updateHints } = await import('/src/Block.mjs')
      updateHints(document.querySelector('#hint-host [data-testid="code-diff"]'))
    })
    await expect(down).toHaveCSS('opacity', '1')
    await expect(up).toHaveCSS('opacity', '0')

    // Scroll to the bottom: now the bottom change is visible and the top one is
    // above the fold → up hint on, down hint off. Setting scrollTop fires a
    // scroll event, which syncScroll relays and which re-runs updateHints.
    await page.evaluate(() => {
      const p = document.querySelector('#hint-host [data-scrollsync]')
      p.scrollTop = p.scrollHeight
      p.dispatchEvent(new Event('scroll'))
    })
    await expect(up).toHaveCSS('opacity', '1')
    await expect(down).toHaveCSS('opacity', '0')
  })

  test('shows no hints when the whole diff fits in view', async ({ page }) => {
    await page.goto('/')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::small',
        status: 'modified',
        file: 'app/Foo.php',
        line: 10,
        name: 'small',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 10, end: 11, text: 'function small(): int {\n    return 0;\n}' },
          new: { start: 10, end: 11, text: 'function small(): ?int {\n    return 1;\n}' },
        },
      })
      const host = document.createElement('div')
      host.id = 'hint-host'
      // Tall enough that the three-line diff fits with room to spare.
      host.style.display = 'flex'
      host.style.height = '400px'
      document.body.appendChild(host)
      Block(b, { hintsEnabled: () => true })(host)
      const { updateHints } = await import('/src/Block.mjs')
      updateHints(document.querySelector('#hint-host [data-testid="code-diff"]'))
    })

    const container = page.locator('#hint-host [data-testid="code-diff"]')
    await expect(container).toBeVisible()
    await expect(container.locator('[data-hint="up"]')).toHaveCSS('opacity', '0')
    await expect(container.locator('[data-hint="down"]')).toHaveCSS('opacity', '0')
  })

  test('shows no hints for a non-selected card even when its diff overflows', async ({
    page,
  }) => {
    await page.goto('/')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const middle = Array.from({ length: 28 }, (_, i) => `    $step${i} = ${i};`)
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::big',
        status: 'modified',
        file: 'app/Foo.php',
        line: 10,
        name: 'big',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 10, end: 39, text: ['function big(): int {', ...middle, '    return 0;'].join('\n') },
          new: { start: 10, end: 39, text: ['function big(): ?int {', ...middle, '    return 1;'].join('\n') },
        },
      })
      const host = document.createElement('div')
      host.id = 'hint-host'
      host.style.display = 'flex'
      host.style.height = '160px'
      document.body.appendChild(host)
      // hintsEnabled defaults to false — a preview / non-selected card. Even
      // though the diff overflows, the hints must stay hidden.
      Block(b)(host)
      const { updateHints } = await import('/src/Block.mjs')
      updateHints(document.querySelector('#hint-host [data-testid="code-diff"]'))
    })

    const container = page.locator('#hint-host [data-testid="code-diff"]')
    await expect(container).toBeVisible()
    await expect(container).toHaveAttribute('data-hints', 'off')
    await expect(container.locator('[data-hint="up"]')).toHaveCSS('opacity', '0')
    await expect(container.locator('[data-hint="down"]')).toHaveCSS('opacity', '0')
  })
})
