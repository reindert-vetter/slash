import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The footer's own box height (Footer.mjs's footerBoxPx) is content-driven —
// no longer a fixed 90/140px tier: it's derived purely from known counts (how
// many '-'/'+' rows the focused unit renders, and whether an AI description
// is showing), never a DOM measurement (see the module doc comment in
// Footer.mjs). home.mjs's <main> reserves the EXACT same figure at its own
// bottom edge, so the two can never drift apart. See "Footer" in
// keyboard-navigation.md.
//
// tests/footer-explanation.spec.mjs already exercises the with-description
// cases end to end against a real fixture (PR 97); this test isolates the
// diff-only case (no AI description at all) across a growing row count, on a
// small, disposable PR (this test's own PR number, per the
// "give a spec that seeds comments its own synthetic PR number" note in
// conventions.md — not that this spec seeds comments, but a routed fixture
// still shouldn't share a number other specs assert exact counts against).
test.describe('footer height fits its actual content', () => {
  test('a single-line unit sizes down to the content floor, a multi-row group grows with it', async ({
    page,
  }) => {
    await page.route('**/api/code**', async (route) => {
      const oldLines = ['    $a = 1;', '    $b = 2;', '    $c = 3;', '    $d = 4;', '    $e = 5;']
      const newLines = ['    $a = 10;', '    $b = 20;', '    $c = 30;', '    $d = 4;', '    $e = 5;']
      await route.fulfill({
        json: {
          file: 'app/Actions/CreatePaymentAction.php',
          old: { start: 1, end: 5, text: oldLines.join('\n') },
          new: { start: 1, end: 5, text: newLines.join('\n') },
        },
      })
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // group -> line: land on the first changed line

    const footer = page.getByTestId('footer')
    const description = footer.getByTestId('footer-description')
    await expect(footer).toBeVisible()
    // No explanation is seeded for this routed fixture — offline
    // (SLASH_CLAUDE=off), the auto-launched explain_code run settles on
    // 'failed' and the description hides; wait for that settled state before
    // measuring (mirrors tests/footer-explanation.spec.mjs), otherwise the box
    // still reserves room for the transient 'searching' text.
    await expect(description).toBeHidden()
    // One changed line, a real old→new pair (2 rendered rows) — the box sizes
    // to content, at or above the floor (FOOTER_MIN_PX), well below the old
    // fixed 90px tier.
    const lineClass = await footer.getAttribute('class')
    const lineHeight = Number(lineClass.match(/h-\[(\d+)px\]/)[1])
    expect(lineHeight).toBeLessThan(90)
    expect(lineHeight).toBeGreaterThanOrEqual(56)

    // Zoom back out to the whole group (3 changed lines, 6 rendered rows) —
    // the box grows accordingly, and stays under the unchanged 140px ceiling.
    await page.keyboard.press('s')
    await expect(description).toBeHidden()
    const groupClass = await footer.getAttribute('class')
    const groupHeight = Number(groupClass.match(/h-\[(\d+)px\]/)[1])
    expect(groupHeight).toBeGreaterThan(lineHeight)
    expect(groupHeight).toBeLessThanOrEqual(140)

    // <main>'s own bottom reservation always matches the footer's real
    // height exactly (footerBoxPx is the single source of truth for both).
    const main = page.getByTestId('detail-panel')
    const mainClass = await main.getAttribute('class')
    expect(mainClass).toContain(`bottom-[${groupHeight}px]`)
  })
})
