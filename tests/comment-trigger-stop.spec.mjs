import { test, expect } from './_fixtures.mjs'

// The always-present "+ Nieuwe comment" trigger is now also a genuine ↑/↓
// stop (previously it was click/Enter-only, deliberately outside arrow
// browsing — see detail-layout.md): ↑ from the first comment conversation
// (or, when the unit has none, from Onderliggende code's first child) lands
// on the trigger itself, SELECTED but not yet composing (cs.focus ===
// 'trigger', distinct from 'new' once the composer is actually open). Enter
// on it opens the composer, same as a click; ← exits to the diff; ↓
// re-enters whatever sits below it (the first comment, or straight to
// Onderliggende code). See RelatedPanel.mjs' enterTrigger/isTriggerFocused
// and handleRelatedKey's 'trigger'/'code'/'comment' branches.
test.describe('PR Review Tree — the "+ Nieuwe comment" trigger as a ↑/↓ stop', () => {
  const relFoc = (page) => new URL(page.url()).searchParams.get('rel.foc')
  const trigger = (page) => page.getByTestId('new-comment')

  test('↑ from the first comment lands on the trigger; Enter opens the composer; ← exits and ↓ re-enters the comment', async ({
    page,
  }) => {
    // Same fixture/seeding shape as related-nav.spec.mjs: block 1
    // (CreatePaymentAction::execute — block 0, ContractController::index,
    // sorts first as the sole CONTROLLER but carries no local diff).
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'trigger-nav comment', label, rowStart: -1, rowEnd: -1 },
    })
    expect(await start.json()).toHaveProperty('runId')

    // Reload so the just-seeded comment is present from the start (avoids
    // racing the frontend's own 5s poll cadence).
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → the (only) comment conversation
    await expect.poll(() => relFoc(page)).toBe('comment')

    // ↑ on the first (and only) conversation lands on the trigger instead of
    // exiting straight to the diff — selected, not yet composing.
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => relFoc(page)).toBe('trigger')
    await expect(trigger(page)).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('comment-composer')).toHaveCount(0)

    // Enter opens the composer, exactly like a click.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('comment-composer')).toBeVisible()
    await expect(page.getByTestId('comment-compose')).toBeFocused()

    // Escape closes it and exits straight to the diff (a full "get me out").
    await page.keyboard.press('Escape')
    await expect.poll(() => relFoc(page)).toBe(null)

    // Re-navigate up to the trigger again; ← from there exits to the diff.
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => relFoc(page)).toBe('comment')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => relFoc(page)).toBe('trigger')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => relFoc(page)).toBe(null)

    // Once more, but this time ↓ from the trigger re-enters the comment below it.
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => relFoc(page)).toBe('comment')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => relFoc(page)).toBe('trigger')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => relFoc(page)).toBe('comment')
  })

  test('with no comments on the unit, ↑ from Onderliggende code also lands on the trigger, and ↓ steps back in', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → Onderliggende code (no comments here)
    const relFoc2 = () => relFoc(page)
    await expect.poll(relFoc2).toBe('code')

    await page.keyboard.press('ArrowUp')
    await expect.poll(relFoc2).toBe('trigger')
    await expect(trigger(page)).toHaveAttribute('data-active', 'true')

    // ← from the trigger exits to the diff (same as always).
    await page.keyboard.press('ArrowLeft')
    await expect.poll(relFoc2).toBe(null)

    // Re-enter and this time step back down with ↓ instead.
    await page.keyboard.press('ArrowRight')
    await expect.poll(relFoc2).toBe('code')
    await page.keyboard.press('ArrowUp')
    await expect.poll(relFoc2).toBe('trigger')
    await page.keyboard.press('ArrowDown')
    await expect.poll(relFoc2).toBe('code')
  })
})
