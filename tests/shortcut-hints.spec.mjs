import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// A thin, contextual key-hint line under the active card (ShortcutHintBar,
// src/shortcutHints.mjs) — reviewer request: "onder elke kaart wil ik een
// lijn met hints wat je op dat moment voor keys kan typen". See "A
// contextual keyboard-hint line under each card" in
// .claude/docs/keyboard-navigation.md.
test.describe('Contextual shortcut-hint line', () => {
  test('list mode and diff mode show different hints, and switching back and forth never leaves the OTHER mode\'s text behind', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()

    const hints = page.getByTestId('shortcut-hints').first()
    await expect(hints).toContainText('navigeren')
    await expect(hints).not.toContainText('regel/groep')

    // This is the exact bug this test guards against: arrow.js's patch path
    // for a reactive slot that keeps returning a non-empty template (never
    // toggling through '' in between) did not reliably re-diff its content
    // on a plain re-run, leaving the PREVIOUS mode's hint text on screen
    // forever — see ShortcutHintBar's own doc comment for the full story.
    await page.keyboard.press('ArrowRight') // list -> diff
    await expect(hints).toContainText('regel/groep')
    await expect(hints).not.toContainText('navigeren')

    await page.keyboard.press('ArrowLeft') // diff -> list
    await expect(hints).toContainText('navigeren')
    await expect(hints).not.toContainText('regel/groep')
  })

  test('only the active card shows a hint line, never the look-ahead preview', async ({ page }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')

    const visible = await page.getByTestId('shortcut-hints').filter({ hasText: 'regel/groep' }).count()
    expect(visible).toBe(1)
  })

  test('the comment/Claude column shows its own hints once the keyboard is on it', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body: 'hint bar test' },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').first()
    await expect(row).toBeVisible()
    await row.click()

    const commentHints = page.getByTestId('shortcut-hints').filter({ hasText: 'oudere berichten' })
    await expect(commentHints).toHaveCount(1)

    await page.keyboard.press('ArrowRight') // comment -> claude
    const claudeHints = page.getByTestId('shortcut-hints').filter({ hasText: 'versturen' })
    await expect(claudeHints).toHaveCount(1)
    await expect(page.getByTestId('shortcut-hints').filter({ hasText: 'oudere berichten' })).toHaveCount(0)
  })
})
