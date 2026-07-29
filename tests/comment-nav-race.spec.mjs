import { test, expect } from './_fixtures.mjs'

// Regression test for the reported bug: "after placing a comment, navigating
// away with the keyboard and then back in sometimes shows the wrong thing to
// the right of the index". Root cause: COMPOSE_COMMANDS' run() is fired
// without being awaited (home.mjs's runCommand), so placeComment/
// createComment's own POST+GET round-trip can still be in flight well after
// the reviewer has already moved the keyboard elsewhere — and cs (the panel
// state in RelatedPanel.mjs) is a module-level singleton shared by every
// block. Before the fix, placeComment's delayed tail unconditionally called
// exitRelated() once its network round-trip settled, clobbering whatever the
// reviewer had since focused (here: a DIFFERENT block's Onderliggende-code
// panel) — even though nothing about that stale comment placement should
// affect it. See the focusToken doc comment in RelatedPanel.mjs.

test('a stale placeComment tail must not clobber a later, unrelated Onderliggende-code focus', async ({
  page,
}) => {
  // Delay the workflow POST so the race window is deterministic instead of
  // depending on real network timing — and so this test never leaves a real
  // comment behind on the shared PR 12903 fixture (see
  // place-comment-return-focus.spec.mjs for the same mocking rationale).
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })

  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

  // Block A: idx 1 (ContractController::index at idx 0 has no local diff, see
  // place-comment-return-focus.spec.mjs) — place a comment on it.
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff

  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('stale-tail-repro')

  await page.keyboard.press('Enter') // opens the compose-kind menu
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.keyboard.press('Enter') // "Plaats comment" (default, 2nd item) — fires
  // placeComment's async tail WITHOUT awaiting it (runCommand); the mocked
  // POST above is still 800ms away from resolving at this point.
  await expect(page.getByTestId('command-menu')).not.toBeVisible()
  // runCommand defers cmd.run() by one requestAnimationFrame — give it a
  // moment to actually start (and thus read the still-mounted composer)
  // before navigating away closes/unmounts it.
  await page.waitForTimeout(60)

  // The reviewer immediately leaves the (still-open, per the fire-and-forget
  // run()) composer — a legitimate, user-driven exit, distinct from the stale
  // tail that's still pending in the background.
  await page.keyboard.press('Escape')
  // Back to the block index (the sidebar is translated off-screen while
  // state.mode === 'diff', see detail-layout.md — a click on a data-idx row
  // only works once it's visible again).
  await page.keyboard.press('ArrowLeft')

  // Navigate to a DIFFERENT block (idx 0) and open ITS Onderliggende-code
  // panel — the exact "singleton cs gets used for something unrelated"
  // scenario. A mouse click sidesteps any composer-specific key handling.
  await page.locator('[data-idx="0"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff on block B
  await page.keyboard.press('ArrowRight') // diff -> Onderliggende-code panel on block B

  const blockCardB = page.locator('[data-testid="block-column"] article').first()
  // Owning the Onderliggende-code panel, block B's diff card has no active
  // border (diffActive() is false while relatedActive() is true) — this is
  // the pre-existing, correct baseline.
  await expect(blockCardB).not.toHaveClass(/border-indigo-300/)

  // Wait well past the mocked POST's 800ms delay — placeComment's tail (for
  // the UNRELATED block A comment) has now definitely settled.
  await page.waitForTimeout(1200)

  // The stale tail must be a no-op by now: block B's Onderliggende-code panel
  // must still own the keyboard. Before the fix, placeComment's unconditional
  // exitRelated() reset cs.focus to null here, and block B's diff card
  // wrongly regained its active border.
  await expect(blockCardB).not.toHaveClass(/border-indigo-300/)
})
