import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A wide viewport so the block card's right-edge handle sits well clear of
// the window's own right edge — a +150px drag at the default 1280px
// viewport would try to move the pointer past the window boundary.
test.use({ viewport: { width: 2200, height: 900 } })

// Manual column resize (see .claude/docs/column-resize.md): dragging the
// right-edge handle of the selected block-diff card sets an inline
// `style="width:...px"` that wins over the card's own Tailwind width class,
// persists across a reload (a 30-day cookie, not the URL/localStorage), and
// can be reset either by dragging back close to the auto width (snap-back)
// or by double-clicking the handle. PR 12903 is the shared, read-only anchor
// fixture (no write happens here, so no APPROVAL_RESET_PRS/seededPr concern —
// see testing-playwright.md).
test('dragging the block-card handle sets a width override that persists and resets', async ({ page }) => {
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // Block 1 (CreatePaymentAction::execute) carries a real diff, unlike block
  // 0 — see step-preview-stability.spec.mjs's own note on this fixture.
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  // Let scrollFocusIntoView's auto-scroll (200ms, see keyboard-navigation.md)
  // settle before measuring the handle's position — otherwise the drag
  // targets stale coordinates from before the card finished sliding into view.
  await page.waitForTimeout(300)

  // Only the non-preview card renders the handle (!preview, not gated on
  // diffActive()/mode — see below) — never the look-ahead preview card next
  // to it.
  const handle = page.locator('[data-testid="block-column"] [data-testid="col-resize-handle"]')
  await expect(handle).toHaveCount(1)
  const article = page.locator('[data-testid="block-column"] article:has([data-testid="col-resize-handle"])')
  await expect(article).toHaveCount(1)

  // No override yet: the class-driven width applies, no inline style.
  expect(await article.getAttribute('style')).toBe('')

  const box = await handle.boundingBox()
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  // Drag +150px to the right — comfortably past the 10px snap-back window.
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 150, startY, { steps: 5 })
  await page.mouse.up()

  const styleAfterDrag = await article.getAttribute('style')
  expect(styleAfterDrag).toMatch(/width:\d+px/)
  const pxAfterDrag = Number(/width:(\d+)px/.exec(styleAfterDrag)[1])
  expect(pxAfterDrag).toBeGreaterThan(box.width) // wider than the card was

  // Persists across a reload — a cookie, not the URL/localStorage (see
  // column-resize.md) — the same selection/mode is restored via URL state.
  await page.reload()
  await leaveSearchBox(page)
  const handleAfterReload = page.locator('[data-testid="block-column"] [data-testid="col-resize-handle"]')
  await expect(handleAfterReload).toHaveCount(1)
  const articleAfterReload = page.locator('[data-testid="block-column"] article:has([data-testid="col-resize-handle"])')
  const styleAfterReload = await articleAfterReload.getAttribute('style')
  expect(Number(/width:(\d+)px/.exec(styleAfterReload)[1])).toBe(pxAfterDrag)

  // Double-click the handle resets to auto (the other of the two reset paths).
  await handleAfterReload.dispatchEvent('dblclick')
  await expect(async () => {
    expect(await articleAfterReload.getAttribute('style')).toBe('')
  }).toPass()

  expect(errors, `no page errors: ${errors.join('; ')}`).toEqual([])
})

test('dragging back close to the auto width snaps back instead of committing an override', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  await page.waitForTimeout(300)

  const handle = page.locator('[data-testid="block-column"] [data-testid="col-resize-handle"]')
  const article = page.locator('[data-testid="block-column"] article:has([data-testid="col-resize-handle"])')
  const box = await handle.boundingBox()
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  // A tiny drag (well within the 10px snap-back window) must never commit an
  // override at all.
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 3, startY, { steps: 2 })
  await page.mouse.up()

  expect(await article.getAttribute('style')).toBe('')
})

// Resize must also work BEFORE stepping → into a diff session — the selected
// block card already renders next to the block-index/sidebar in list mode
// (see step-preview-stability.spec.mjs's own note: list mode shows the
// selected card + its look-ahead preview side by side), and the handle used
// to be gated on diffActive() (state.mode === 'diff'), which made it vanish
// there even though the card is visibly on screen. See column-resize.md.
test('the handle also works in list mode, before entering the diff session', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await expect(page).not.toHaveURL(/mode=diff/)

  // Only the selected card gets a handle — never the look-ahead preview.
  const handle = page.locator('[data-testid="block-column"] [data-testid="col-resize-handle"]')
  await expect(handle).toHaveCount(1)
  const article = page.locator('[data-testid="block-column"] article:has([data-testid="col-resize-handle"])')
  expect(await article.getAttribute('style')).toBe('')

  const box = await handle.boundingBox()
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 150, startY, { steps: 5 })
  await page.mouse.up()

  const style = await article.getAttribute('style')
  expect(style).toMatch(/width:\d+px/)
  expect(Number(/width:(\d+)px/.exec(style)[1])).toBeGreaterThan(box.width)
})
