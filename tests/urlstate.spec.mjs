import { test, expect } from './_fixtures.mjs'

// URL-state persistence: the navigation position (selected block, mode, change)
// is mirrored into the query string via history.replaceState, so a refresh
// reopens the exact same spot. See src/urlState.mjs + home.mjs (bindUrlState).
test.describe('PR Review Tree — URL state persistence', () => {
  // fileLineOf reads the `file:line` reference off the currently-selected
  // card's meta line — exactly the format `sel` now carries (see
  // CLAUDE.md/blockRef: the block reference, not its index into state.blocks).
  async function fileLineOf(page) {
    const card = page.getByTestId('block-column').locator('article').first()
    return (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  }

  // normalizeQuery sorts a query string's params so two URLs that carry the
  // same state compare equal regardless of param insertion order. blockRef's
  // write-back watch (a plain arrow.js `watch`, distinct from bindUrlState's
  // own mirror-watch) can flush in a different relative order than the other
  // fields' — e.g. `sel` landing before or after `mode` — depending on timing,
  // without the restored state itself differing.
  function normalizeQuery(search) {
    return [...new URLSearchParams(search)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')
  }

  test('navigation writes the query string and survives a reload', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    // `sel` mirrors the selected block's `file:line` from the very first render
    // (blockRef is only '' — the bindUrlState default that gets dropped — before
    // any block is loaded), unlike the old index-based `sel` whose default 0
    // matched the first block and so stayed out of the URL.
    const first = await fileLineOf(page)
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(first)

    // The PR lives in the path (/pr/12903), not the query. Stepping the sidebar
    // selection writes `sel` into the query string as the block's `file:line`.
    await page.keyboard.press('ArrowDown')
    const second = await fileLineOf(page)
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(second)
    // Step back to the first block to prove the round trip, then step down
    // again onto the second block: the first block (ContractController::index,
    // CONTROLLER-first — see categoryRank in home.mjs) has no local diff, but
    // the second (CreatePaymentAction::execute) reliably carries a change to
    // step into (the diff content comes from the base/head worktrees).
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(first)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(second)

    // enterDiff needs the block's code loaded to know its change groups; wait for
    // the lazy fetch to settle before stepping in.
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('diff')
    const before = new URL(page.url()).search

    // Reload from the exact URL — state must come back.
    await page.reload()
    await page.waitForLoadState('networkidle')
    expect(normalizeQuery(new URL(page.url()).search)).toBe(normalizeQuery(before))

    // Diff mode restored → the detail panel is in its full-width (left-6) layout.
    const panel = page.locator('[data-testid="detail-panel"]')
    await expect(panel).toHaveClass(/left-6/)
    expect(new URL(page.url()).searchParams.get('mode')).toBe('diff')
  })

  test('stepping back to the first block restores its sel again', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const first = await fileLineOf(page)

    await page.keyboard.press('ArrowDown')
    const second = await fileLineOf(page)
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(second)
    await page.keyboard.press('ArrowUp') // back to the first block

    // sel mirrors whichever block is selected — unlike other fields (mode/chg/
    // gran) it has no "default" that drops out of the URL once any block has
    // loaded, since every block (including the first) has a real file:line.
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(first)
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
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related panel
  }

  test('stepping into the related-code card writes rel.foc and survives a reload', async ({ page }) => {
    await intoRelated(page)
    // The related-code card has no outer focus border anymore (removed so its
    // children read as loose blocks); the code stop owning the keyboard shows as
    // cs.focus === 'code', mirrored to the URL as rel.foc.
    await expect.poll(() => new URL(page.url()).searchParams.get('rel.foc')).toBe('code')

    // Reload from the exact URL — rel.foc must still be there and the panel must
    // re-own the keyboard (the async data-push must not clobber it —
    // applyRelRestore re-applies it once the children load).
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect
      .poll(() => new URL(page.url()).searchParams.get('rel.foc'))
      .toBe('code')
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
    // Seed a block-level comment (rowStart -1 = shown for the whole block) on
    // the same block intoRelated below will select (block 1,
    // CreatePaymentAction::execute), the same way related-nav does — writes go
    // through the workflow endpoint, so the write-boundary holds.
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
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

    // Step into the panel, then g ↓ : `g` opens the comments/taken sidebar
    // (lands on the new-comment button) and ↓ steps onto the seeded comment.
    await intoRelated(page)
    await page.keyboard.press('g')
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
