import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Reviewer request, a SECOND reversal of this chord's mechanism: (1)
// originally a remap onto the ←/→ nav chain, (2) reversed to real browser
// history.back()/forward() (c2acbc7) — which only ever jumped between real
// page loads, never between two blocks visited on the same page, since the
// app only writes its own navigation position with history.replaceState —
// and (3) THIS version: "met cmd + [ wil ik naar het vorige blok waar ik
// iets had geselecteerd. en anders terug naar pr overzicht. dus niet per
// groep,line,call terug, maar voor de rest waar ik net/daarvoor was". See
// "Cmd+[ / Cmd+] ... a previous selected block stack" in
// .claude/docs/keyboard-navigation.md — do not flip this back to real
// browser history again.
//
// Cmd(Mac)/Ctrl(Windows-Linux)+[ steps to the previously SELECTED top-level
// block (state.selected moving to a different row) — never a group/line/call
// granularity step, a drilled column, or a comment thread/Claude focus within
// the SAME block, none of which touch state.selected at all. An empty stack
// falls through to a real navigation to /pr-overview. Cmd+] mirrors it
// forward. The stack is ephemeral — explicit reviewer answer, "de stack hoeft
// een refresh niet te overleven" — so a reload always starts it empty again.
test.describe('Cmd+[ / Cmd+] step through the previously selected blocks', () => {
  test('Meta+[ with nothing visited yet goes straight to /pr-overview', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)

    await page.keyboard.press('Meta+[')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  test('Meta+[ steps back through selected blocks, Meta+[ again reaches /pr-overview once the stack is empty', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)

    const selParam = () => new URL(page.url()).searchParams.get('sel')

    await page.locator('[data-idx="0"]').click()
    const ref0 = selParam()
    await page.locator('[data-idx="1"]').click()
    const ref1 = selParam()
    await page.locator('[data-idx="2"]').click()
    expect(selParam()).not.toBe(ref1)

    await page.keyboard.press('Meta+[')
    await expect.poll(selParam).toBe(ref1)

    await page.keyboard.press('Meta+[')
    await expect.poll(selParam).toBe(ref0)

    // Every recorded step is now undone — the next Meta+[ has nothing left
    // to go back to, so it falls through to /pr-overview, same as a
    // completely fresh session.
    await page.keyboard.press('Meta+[')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  test('Meta+] mirrors Meta+[ forward again', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)
    const selParam = () => new URL(page.url()).searchParams.get('sel')

    await page.locator('[data-idx="0"]').click()
    const ref0 = selParam()
    await page.locator('[data-idx="1"]').click()
    const ref1 = selParam()

    await page.keyboard.press('Meta+[')
    await expect.poll(selParam).toBe(ref0)

    await page.keyboard.press('Meta+]')
    await expect.poll(selParam).toBe(ref1)

    // Nothing left to redo — a plain no-op, not a stray navigation anywhere.
    await page.keyboard.press('Meta+]')
    await page.waitForTimeout(200)
    expect(selParam()).toBe(ref1)
  })

  test('a group/line/call step within the SAME block never counts as a move — Meta+[ still steps to the previous BLOCK', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)
    const selParam = () => new URL(page.url()).searchParams.get('sel')

    await page.locator('[data-idx="0"]').click()
    const ref0 = selParam()
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode (mirrors other specs' own convention).
    await page.locator('[data-idx="1"]').click()
    const ref1 = selParam()
    await page.keyboard.press('ArrowRight') // list -> diff, same block
    await page.keyboard.press('ArrowDown') // step a change group, same block
    expect(selParam()).toBe(ref1) // still the same top-level block

    await page.keyboard.press('Meta+[')
    await expect.poll(selParam).toBe(ref0)
  })

  test("Shift+Meta+[ does NOT trigger this stack (left for the browser's own tab-switch)", async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.locator('[data-idx="0"]').click()
    await page.locator('[data-idx="1"]').click()
    const selBefore = new URL(page.url()).searchParams.get('sel')

    await page.keyboard.press('Shift+Meta+[')
    // Must not have moved: still on the same block, still on the same page.
    await expect(page).toHaveURL(/\/pr\/12903/)
    expect(new URL(page.url()).searchParams.get('sel')).toBe(selBefore)
  })

  test('Meta+[ is not swallowed by a focused comment composer mid-text', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.locator('[data-idx="0"]').click()
    const ref0 = new URL(page.url()).searchParams.get('sel')
    // Block 1 carries a local diff on this seeded PR — pick it so → actually
    // enters diff mode.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()

    await composer.type('hello world')
    await expect(composer).toHaveValue('hello world')

    // Meta+[ must still trigger the stack step, regardless of the caret
    // sitting mid-text in the composer — the guard for a native Cmd/Ctrl
    // caret command (isNativeTextEditKey) never applies to this chord,
    // since it's checked first and returns on its own.
    await page.keyboard.press('Meta+[')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(ref0)
  })

  test('the stack does not survive a refresh — Meta+[ right after a reload goes to /pr-overview', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.locator('[data-idx="0"]').click()
    await page.locator('[data-idx="1"]').click()

    await page.reload()
    await page.waitForLoadState('load')
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('Meta+[')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })
})
