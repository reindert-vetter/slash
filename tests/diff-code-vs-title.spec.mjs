import { test, expect } from './_fixtures.mjs'

// Regression test for a title/code mismatch: the selected card's header
// (class::method) always tracked the current block correctly, but the diff
// pane underneath could freeze on a *previous* block's code — stale content
// silently shown as if it belonged to the currently-selected block, with no
// visible error. Reported symptom: navigate ↓ repeatedly, land back on a
// same-file block after cycling through its neighbour, and the diff shows the
// neighbour's code under this block's own title.
//
// Root cause: the same arrow.js keyed-list chunk-ref corruption fixed for the
// step-chevron slot ("Give the step-chevron slot a stable element root to fix
// keyed-list corruption" — see step-preview-stability.spec.mjs). Both
// stepChevronSlot (home.mjs) and codeDiff (Block.mjs, embedded as
// `${() => codeDiff(...)}`) are nested-reconciler-in-a-keyed-array
// embeddings; the chunk-ref staleness that toggling stepChevronSlot's bare
// expression left behind corrupted the *whole* block-column list reconcile,
// derailing the codeDiff slot's update on a subsequent same-file down/up
// cycle too — even though codeDiff's own key correctly changes every step.
// Fixing stepChevronSlot's ref (a stable `<div class="contents">` root)
// incidentally fixed this too; confirmed by reverting just that one line on
// top of current `main` and reproducing the exact mismatch (plus the
// documented "Cannot read properties of null (reading 'after')" arrow.js
// crash) with this same down/up cycle.
//
// This walks the exact down/up cycle from step-preview-stability.spec.mjs
// (PR 12903, blocks 0+1 same-file) and asserts the rendered diff text always
// matches the *currently selected* card's own block — verified against that
// block's own source from /api/code — never a neighbour's stale code.
test("diff pane never shows a neighbour block's code after a down/up cycle", async ({ page }) => {
  test.setTimeout(120000)
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/pr/12903')
  await page.waitForLoadState('networkidle')
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)

  const blocks = await page.evaluate(async () => (await fetch('/api/blocks?pr=12903')).json())
  const byLabel = new Map(blocks.map((b) => [b.label, b]))

  const selectedCard = () => page.locator('[data-testid="block-column"] article').first()
  const normalize = (s) => s.replace(/\s+/g, ' ').trim()

  // assertMatches fetches the currently-selected card's title + rendered diff
  // text and checks the diff text is really a prefix of *that block's own*
  // new-side source (fetched independently via /api/code) — not frozen on
  // whatever was previously selected.
  async function assertMatches(when) {
    const label = normalize(await selectedCard().locator('h2').innerText())
    const codeDiff = selectedCard().locator('[data-testid="code-diff"]')
    if ((await codeDiff.count()) === 0) return // nothing to check
    const text = normalize(await codeDiff.innerText())
    if (text === 'loading code…') return // honest fallback, never a mismatch

    const b = byLabel.get(label)
    if (!b) return
    const own = await page.evaluate(async ({ file, name, cls }) => {
      const params = new URLSearchParams({ pr: '12903', file, name })
      if (cls) params.set('class', cls)
      const res = await fetch(`/api/code?${params}`)
      if (!res.ok) return null
      const body = await res.json()
      return body && body.new && body.new.text
    }, { file: b.file, name: b.name, cls: b.class })
    if (!own) return

    const normalizedOwn = normalize(own)
    const renderedStart = text.slice(0, 40)
    expect(
      renderedStart.length === 0 || normalizedOwn.includes(renderedStart),
      `${when}: card titled "${label}" rendered code that doesn't belong to its own source:\n` +
        `rendered: ${renderedStart}\nown source starts: ${normalizedOwn.slice(0, 80)}`,
    ).toBe(true)
  }

  for (let cycle = 0; cycle < 4; cycle++) {
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(60)
    }
    await assertMatches(`cycle ${cycle} after ↓`)

    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowUp')
      await page.waitForTimeout(60)
    }
    await assertMatches(`cycle ${cycle} after ↑`)
  }

  expect(errors, 'no page errors during the cycles').toEqual([])
})
