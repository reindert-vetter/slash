import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// A thin, contextual key-hint line under the active card (ShortcutHintBar,
// src/shortcutHints.mjs) — reviewer request: "onder elke kaart wil ik een
// lijn met hints wat je op dat moment voor keys kan typen". See "A
// contextual keyboard-hint line under each card" in
// .claude/docs/keyboard-navigation.md. `↑`/`↓` and `Shift+↑`/`↓` are
// deliberately never listed (reviewer follow-up: "hint pijltjes omhoog en
// naar beneden kan weg, shift met pijltjes mag ook weg" — too obvious/basic
// to spell out).
// At 'line'/'call' granularity the s/d/f zoom keys ARE the whole hint line —
// every other hint (←→/a/Space/Enter) drops out, and each of s/d/f gets its
// own entry instead of one combined 'f/d/s' key (reviewer follow-up: "als je
// line hebt geselecteerd, laat dan niets zien behalve sdf... omschrijf sd, f
// dan los van elkaar... als het een call is, laat dan alleen s, d, f
// omschrijven, de rest mag dan weg"), listed in KEYBOARD order — s, d, then f
// (reviewer follow-up: "dit moet in volgorde van je keyboard: s d f... en bij
// call moet de volgorde zijn s d f"). `d` still only shows up while it would
// actually do something (dHintUsable — never at the coarsest 'group' level).
// At 'group' the combined zoom key drops `s` too (reviewer follow-up: "bij
// een groep mag s weg" — s is a no-op there, same reasoning as d), leaving
// only `f` under the 'Ga dieper' label; 'group' is otherwise the one stand that
// keeps the fuller ←→/a/Space/Enter set.
test.describe('Contextual shortcut-hint line', () => {
  test('list mode and diff mode show different hints, and switching back and forth never leaves the OTHER mode\'s text behind', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()

    const hints = page.getByTestId('shortcut-hints').first()
    await expect(hints).toContainText('PR-menu')
    await expect(hints).not.toContainText('zoom')
    await expect(hints).not.toContainText('↑')

    // This is the exact bug this test guards against: arrow.js's patch path
    // for a reactive slot that keeps returning a non-empty template (never
    // toggling through '' in between) did not reliably re-diff its content
    // on a plain re-run, leaving the PREVIOUS mode's hint text on screen
    // forever — see ShortcutHintBar's own doc comment for the full story.
    await page.keyboard.press('ArrowRight') // list -> diff
    await expect(hints).toContainText('Ga dieper')
    await expect(hints).not.toContainText('PR-menu')
    // 'group' keeps only `f` under the 'Ga dieper' label — `s` dropped, a no-op
    // at the coarsest level (reviewer follow-up: "bij een groep mag s weg").
    await expect(hints).not.toContainText('f/s')

    await page.keyboard.press('ArrowLeft') // diff -> list
    await expect(hints).toContainText('PR-menu')
    await expect(hints).not.toContainText('zoom')
  })

  test('at line/call granularity only s/d/f show, each its own hint, no other keys, in keyboard order', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // group — the fuller set

    const hints = page.getByTestId('shortcut-hints').first()
    await expect(hints).toContainText('kolom')
    await expect(hints).toContainText('menu')

    await page.keyboard.press('f') // zoom in — line (or call on a single-row group)
    await expect(hints).not.toContainText('kolom')
    await expect(hints).not.toContainText('weergave')
    await expect(hints).not.toContainText('goedkeuren')
    await expect(hints).toContainText('inzoomen')
    await expect(hints).toContainText('terug')
    await expect(hints).toContainText('uitzoomen')

    // Keyboard order (reviewer follow-up: "dit moet in volgorde van je
    // keyboard: s d f"), not "which key fires first when zooming in".
    const visibleHints = hints.locator('[data-testid="shortcut-hint"]:visible kbd')
    await expect(visibleHints).toHaveText(['s', 'd', 'f'])
  })

  test('only the active card shows a hint line, never the look-ahead preview', async ({ page }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')

    const visible = await page.getByTestId('shortcut-hints').filter({ hasText: 'Ga dieper' }).count()
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

    const commentHints = page.getByTestId('shortcut-hints').filter({ hasText: 'Claude' })
    await expect(commentHints).toHaveCount(1)
    await expect(commentHints).not.toContainText('↑')

    await page.keyboard.press('ArrowRight') // comment -> claude
    const claudeHints = page.getByTestId('shortcut-hints').filter({ hasText: 'versturen' })
    await expect(claudeHints).toHaveCount(1)
    await expect(claudeHints).not.toContainText('↑')
    await expect(page.getByTestId('shortcut-hints').filter({ hasText: 'Claude' })).toHaveCount(0)
  })
})
