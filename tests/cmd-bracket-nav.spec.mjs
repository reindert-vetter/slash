import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Reviewer request, reversing an earlier version of this chord: "met cmd + [
// wil ik terug naar de vorige url" — Cmd(Mac)/Ctrl(Windows-Linux)+[ / +] no
// longer remaps onto the left-right nav chain (`ArrowLeft`/`ArrowRight`); it
// triggers a REAL browser history back/forward (`history.back()` /
// `history.forward()`), checked first in `onKeydown` (home.mjs), before every
// other branch — see "Cmd+[ / Cmd+] ... real browser back/forward" in
// .claude/docs/keyboard-navigation.md.
//
// Load-bearing consequence: the app only ever writes its own navigation
// position with `history.replaceState` (urlState.mjs), never `pushState`, so
// in-page navigation (selecting a block, stepping a change group, …) leaves
// no browser-history entry to go back through. `history.back()` therefore
// jumps to whichever real page load preceded the current one, not one step
// back in the nav chain — which is exactly what these tests exercise by
// doing two real navigations (page.goto) before pressing the chord.
//
// Follow-up reviewer request (unchanged by the reversal): Shift+Cmd+[/] must
// NOT trigger this — it's excluded so the browser's own native
// Shift+Cmd+[/] (tab-switching in Chrome/Safari on Mac) keeps working.
test.describe('Cmd+[ / Cmd+] drive real browser history back/forward', () => {
  test('Meta+[ goes back to the real previous URL', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.keyboard.press('Meta+[')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  test('Meta+] goes forward again to the real next URL', async ({ page }) => {
    // Both real navigations land on a page that binds this chord (unlike
    // /pr-overview, which has no keyboard nav at all), so pressing Meta+]
    // right after Meta+[ exercises history.forward() the same way it would
    // stepping forward through two /pr/<id> pages.
    await page.goto('/pr/12903')
    await page.goto('/pr/12903?debugMark=1')
    await leaveSearchBox(page)

    await page.keyboard.press('Meta+[')
    await expect(page).toHaveURL(/\/pr\/12903$/)

    await page.keyboard.press('Meta+]')
    await expect(page).toHaveURL(/debugMark=1/)
  })

  test("Shift+Meta+[ does NOT trigger history back (left for the browser's own tab-switch)", async ({ page }) => {
    await page.goto('/pr-overview')
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.keyboard.press('Shift+Meta+[')
    // Real browser back must not have fired: still on the same PR.
    await expect(page).toHaveURL(/\/pr\/12903/)
  })

  test('Meta+[ is not swallowed by a focused comment composer mid-text', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()

    await composer.type('hello world')
    await expect(composer).toHaveValue('hello world')

    // Meta+[ must still trigger a real navigation back, regardless of the
    // caret sitting mid-text in the composer — the guard for a native
    // Cmd/Ctrl caret command (isNativeTextEditKey) never applies to this
    // chord, since it's checked first and returns on its own.
    await page.keyboard.press('Meta+[')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })
})
