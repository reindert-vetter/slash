import { test, expect, leaveSearchBox, evaluateSettled, appReady } from './_fixtures.mjs'

// Two PR-wide comment index items whose LABEL is identical must still be two
// separate keyed rows. A comment item (commentRowItem, home.mjs) has no `file`
// and no `side`, and its label is only the first 60 characters of the body, so
// BlockList's old `.key(b.file + ':' + b.label + ':' + b.side)` produced the
// exact same key twice — `undefined:<same snippet>:undefined`. arrow.js's keyed
// reconciler maps `_k` → chunk, so a duplicate key made it adopt one chunk for
// both entries and then insert against a node that had already moved:
// "Failed to execute 'after' on 'CharacterData'" / "insertBefore … is not a
// child of this node" / "Cannot read properties of null (reading 'after')".
//
// The throw was not cosmetic. It escaped arrow's microtask flush (`Vt`), which
// clears an effect's "already queued" flag one effect at a time — so every
// effect still queued behind the throwing one stayed flagged forever and was
// never flushed again. The whole page went numb: stepping through the index no
// longer moved the diff column, the card title or the `?sel=` URL mirror, even
// though the keydown handler kept writing state.selected. Reported on PR 12112,
// which has two review threads that both begin with the same ```suggestion
// fence.
//
// Both halves of the fix are asserted here at once: rowKey (BlockList.mjs) keys
// by the item's stable id, and LOCAL PATCH 5 (src/vendor/arrow.js) keeps any
// future render throw from freezing navigation. Deliberately asserted as
// "zero page errors AND the selection really moves", because the freeze was
// silent — the rows still LOOKED right.
const PREFIX = '```suggestion\nreturn $this->merchantFeedIsEligible($checkout, $tenant);\n```'

function mockCollidingPrComments(page) {
  const now = new Date().toISOString()
  const base = {
    pr: 12903,
    file: '',
    label: '',
    line: 0,
    author: 'reviewer',
    createdAt: now,
    reactionCount: 0,
    status: 'open',
    source: 'github',
    // A non-empty kind is what makes a comment PR-wide (comment_import.go
    // stores "issue" | "review_summary"), i.e. an index row with no block
    // anchor at all — the shape that has no file/side to key on.
    kind: 'issue',
    reactions: [],
    rowStart: -1,
    rowEnd: -1,
  }
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { ...base, id: 'collide-1', runId: 'run-collide-1', body: `${PREFIX}\n\nEerste opmerking.` },
        { ...base, id: 'collide-2', runId: 'run-collide-2', body: `${PREFIX}\n\nTweede opmerking.` },
      ]),
    }),
  )
}

test.describe('two index rows with an identical label', () => {
  test('render as two rows, throw nothing, and keep ↓ moving the selection', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))

    await mockCollidingPrComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // Both comments really are in the index, as two distinct rows — the label
    // they share is the truncated snippet both bodies start with.
    const rows = page.locator('[data-testid=block-row]')
    const commentRows = rows.filter({ hasText: 'suggestion' })
    await expect(commentRows).toHaveCount(2)

    // A click resets the sidebar's own ↑/↓ loop to a known row (same idiom as
    // blocks.spec.mjs), so the step below is unambiguous.
    await rows.nth(0).click()
    await expect(rows.nth(0)).toHaveClass(/bg-indigo-50/)
    const before = new URL(page.url()).searchParams.get('sel')

    // The actual regression: ↓ still navigates. Under the duplicate key the
    // reactive graph was already dead by now and this never changed anything.
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toHaveClass(/bg-indigo-50/)
    await expect
      .poll(() => new URL(page.url()).searchParams.get('sel'))
      .not.toBe(before)

    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(2)).toHaveClass(/bg-indigo-50/)

    expect(errors).toEqual([])
  })
})

// The vendor half on its own (LOCAL PATCH 5, src/vendor/arrow.js): one throwing
// subscriber may cost its own update, never everyone else's — and never the
// whole queue. Without the patch the first throw escapes `Vt`, leaving every
// effect still queued behind it flagged as "already queued" forever, so no
// later mutation is ever delivered again. Asserted directly against the
// vendored module (no app state involved) so it stays true for every future
// variant of a render that throws, not just the duplicate-key one above.
test.describe('a throwing reactive subscriber', () => {
  test('does not stop the other subscribers or later updates', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)
    const result = await evaluateSettled(page, async () => {
      const { reactive, watch } = await import('/src/vendor/arrow.js')
      const st = reactive({ n: 0 })
      const seen = []
      let thrown = 0
      watch(
        () => st.n,
        (v) => {
          // Skip the synchronous first run watch() does at registration time
          // (that one is not a flush, so a throw there would just reject the
          // evaluate) — only the queued, microtask-flushed updates throw.
          if (v === 0) return
          thrown++
          throw new Error('deliberate: subscriber ' + v)
        },
      )
      watch(
        () => st.n,
        (v) => seen.push(v),
      )
      st.n = 1
      await new Promise((r) => setTimeout(r, 0))
      st.n = 2
      await new Promise((r) => setTimeout(r, 0))
      return { seen, thrown }
    })
    // Both later mutations reached the healthy watch — the queue kept draining.
    expect(result.seen).toContain(1)
    expect(result.seen).toContain(2)
    // And the broken one really did keep throwing (the test would pass
    // vacuously if the throw had somehow stopped happening).
    expect(result.thrown).toBeGreaterThanOrEqual(2)
  })
})
