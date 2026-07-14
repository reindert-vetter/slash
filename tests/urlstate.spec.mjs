import { test, expect } from '@playwright/test'

// URL-state persistence: the navigation position (selected block, mode, change)
// is mirrored into the query string via history.replaceState, so a refresh
// reopens the exact same spot. See src/urlState.mjs + home.mjs (bindUrlState).
test.describe('PR Review Tree — URL state persistence', () => {
  test('navigation writes the query string and survives a reload', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    // The PR lives in the path (/pr/12903), not the query. Step down once in the list.
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('1')

    // enterDiff needs the block's code loaded to know its change groups; wait for
    // the lazy fetch to settle before stepping in.
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('diff')

    // Walk to the next change group → chg is recorded (if the block has >1 group).
    await page.keyboard.press('ArrowDown')
    const before = new URL(page.url()).search

    // Reload from the exact URL — state must come back.
    await page.reload()
    await page.waitForLoadState('networkidle')
    expect(new URL(page.url()).search).toBe(before)

    // Diff mode restored → the detail panel is in its full-width (left-6) layout.
    const panel = page.locator('[data-testid="detail-panel"]')
    await expect(panel).toHaveClass(/left-6/)
    expect(new URL(page.url()).searchParams.get('sel')).toBe('1')
    expect(new URL(page.url()).searchParams.get('mode')).toBe('diff')
  })

  test('stepping back to defaults clears the params again', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.keyboard.press('ArrowDown')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('1')
    await page.keyboard.press('ArrowUp') // back to sel=0, the default

    // Default values are dropped, keeping the URL canonical/short.
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBeNull()
  })
})

// The right-hand RelatedPanel binds its own cursor (cs.focus/codeSel/sel/threadPos)
// under the `rel` namespace, so a refresh restores where the cursor sat in the
// panel — not just which block/diff-line. See RelatedPanel.mjs (bindUrlState +
// applyRelRestore) and .claude/rules/keyboard-navigation.md.
test.describe('PR Review Tree — panel cursor URL state (rel.*)', () => {
  // intoRelated: list → diff → hand the keyboard to the panel (focus 'code').
  async function intoRelated(page) {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related panel
  }

  test('stepping into the related-code card writes rel.foc and survives a reload', async ({ page }) => {
    await intoRelated(page)
    const related = page.getByTestId('related-code')
    await expect(related).toHaveClass(/border-indigo-300/)
    await expect.poll(() => new URL(page.url()).searchParams.get('rel.foc')).toBe('code')

    // Reload from the exact URL — the panel must own the keyboard again (blue
    // border), and rel.foc must still be there (the async data-push must not clobber
    // it — applyRelRestore re-applies it once the children load).
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('related-code')).toHaveClass(/border-indigo-300/)
    expect(new URL(page.url()).searchParams.get('rel.foc')).toBe('code')
    expect(new URL(page.url()).searchParams.get('mode')).toBe('diff')
  })

  test('leaving the panel clears rel.foc again (canonical URL)', async ({ page }) => {
    await intoRelated(page)
    await expect.poll(() => new URL(page.url()).searchParams.get('rel.foc')).toBe('code')
    await page.keyboard.press('ArrowLeft') // related → back to diff (focus null)
    await expect.poll(() => new URL(page.url()).searchParams.get('rel.foc')).toBeNull()
  })

  test('landing on a comment survives a reload (restore via the comments load)', async ({ page }) => {
    // Seed a block-level comment on whatever block loads first (rowStart -1 = shown
    // for the whole block), the same way related-nav does — writes go through the
    // workflow endpoint, so the write-boundary holds.
    await page.goto('/pr/12903')
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'refresh-restore comment', label, rowStart: -1, rowEnd: -1 },
    })
    const runId = (await start.json()).runId
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        return list.some((x) => x.runId === runId)
      })
      .toBe(true)

    // Step into the panel, then ↓ ↓ : related block → new-comment → the comment.
    await intoRelated(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('comment-item').first()).toHaveClass(/bg-indigo-50/)
    await expect.poll(() => new URL(page.url()).searchParams.get('rel.foc')).toBe('comment')

    // Reload: the comment focus must come back once loadComments re-populates the
    // list (applyRelRestore's comments trigger) — the row is highlighted and the
    // reply field regains focus.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('comment-item').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
    expect(new URL(page.url()).searchParams.get('rel.foc')).toBe('comment')
  })
})
