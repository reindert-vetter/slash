import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Regression test for: "ik kan niet <-, ->, s, d of f typen in de comment" — the
// composer's own focus-tracking (cs.focus) has to stay in lockstep with real DOM
// focus, otherwise onKeydown's global shortcuts (s/d/f/a/arrows) steal the
// keystroke instead of letting it flow into the textarea. See the "Generieke
// input-focus-guard" section in .claude/docs/keyboard-navigation.md.
//
// This used to open the composer via a direct click on the always-present
// "+ Comment op deze regel" trigger row, specifically to exercise a fixed
// click handler (openComposer()/toNew(), as opposed to an earlier, buggy bare
// cs.composing toggle that left cs.focus out of sync with real DOM focus).
// That trigger row has since been removed entirely (see "Inline comment
// blocks" in .claude/docs/detail-layout.md) — the composer now opens
// exclusively through the command palette's "Comment op deze regel" item
// (startComment), which has always routed through the same toNew() and thus
// never had this bug to begin with. The regression this test actually
// guards — typing s/d/f/a lands as text instead of firing a shortcut, and
// Escape reliably exits — is independent of *how* the composer was opened,
// so it's kept, just opened via the palette (openNewComment) instead of a
// now-nonexistent click target.
test.describe('PR Review Tree — composer typing guard', () => {
  test('typing s/d/f/a in the composer (opened via the command palette) lands in the field, not as a shortcut, and Escape gets you out', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    // Block 0 (ContractController::index) carries no local diff on this seeded
    // PR — select block 1 (CreatePaymentAction::execute) so → actually enters
    // diff mode (mirrors nav-chain.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff

    const granOf = () => new URL(page.url()).searchParams.get('gran')
    const granBeforeOpen = granOf()

    // Open via the command palette's "Comment op deze regel" item.
    const composer = page.getByTestId('comment-compose')
    await openNewComment(page)
    await expect(composer).toBeFocused()

    // Letters that double as global shortcuts (f/d/s zoom, `a` diff-view toggle)
    // must land as text, not fire the shortcut — and the underlying diff
    // granularity must stay untouched while typing them.
    await page.keyboard.type('sdf a')
    await expect(composer).toHaveValue('sdf a')
    expect(granOf()).toBe(granBeforeOpen)

    // Escape gets the reviewer out of the field — the composer closes (the
    // existing handleRelatedKey Escape → exitRelated behavior, now reliably
    // reached because cs.focus is in sync) and DOM focus leaves the textarea.
    await page.keyboard.press('Escape')
    await expect(composer).toHaveCount(0)

    // Global shortcuts resume once the field no longer holds DOM focus: `f`
    // should now zoom the diff in (from 'group', the default) instead of typing
    // anywhere — the exact next level ('line' or, for a single-line group,
    // straight to 'call' — see keyboard-navigation.md) depends on this block's
    // diff shape, so just assert it actually moved off the default.
    expect(granBeforeOpen).toBeNull()
    await page.keyboard.press('f')
    await expect.poll(granOf).not.toBeNull()
  })

  // Shift+Enter must insert a newline (not open the comment-kind menu, see
  // isComposeOpen's own doc comment in home.mjs) and the field must grow
  // taller as it fills up (textareaAutoGrow.mjs, shared with the Claude
  // composer — see .claude/docs/claude-chat-panel.md).
  test('Shift+Enter adds a newline in the comment composer, and it grows with content', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff

    const composer = page.getByTestId('comment-compose')
    await openNewComment(page)
    await expect(composer).toBeFocused()

    const startHeight = (await composer.boundingBox()).height
    await composer.type('regel een')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Shift')
    await composer.type('regel twee')
    await expect(composer).toHaveValue('regel een\nregel twee')
    // The composer stayed open — a real send would close it — confirming
    // Shift+Enter never triggered the comment-kind menu's Enter path.
    await expect(composer).toBeVisible()

    // Two lines still fit inside the field's own min-h-20 floor, so keep
    // adding Shift+Enter'd lines until the content genuinely needs more room
    // than that floor gives it — only then does the box visibly grow.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('Shift')
      await page.keyboard.press('Enter')
      await page.keyboard.up('Shift')
      await composer.type('regel ' + i)
    }

    await expect(async () => {
      const grownHeight = (await composer.boundingBox()).height
      expect(grownHeight).toBeGreaterThan(startHeight)
    }).toPass()
  })
})
