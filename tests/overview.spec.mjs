import { test, expect } from './_fixtures.mjs'

// The PR overview (/pr-overview) is a live GitHub-style inbox. Under test the Go
// bridge serves tests/fixtures/inbox.json (SLASH_GITHUB=off + SLASH_INBOX), so
// the sections/rows/pills are deterministic and never touch the network. Every
// row (ingested or not) opens the same click-to-popover menu; an ingested PR
// (hasGraph, from the seeded blocks DB) shows "Open review-boom" to reach
// /pr/<id>. See src/overview.mjs + inbox.go/inbox_api.go.
test.describe('PR Review Tree — PR inbox', () => {
  test('renders sections and rows from the live inbox', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="inbox"]')).toBeVisible()

    // Sections mirror GitHub's /pulls.
    await expect(
      page.locator('[data-testid="section"][data-title="Needs your review"]')
    ).toBeVisible()

    // Every fixture PR renders as a row (12888 standalone, 12903+12904 stacked,
    // 12801 ready-to-merge).
    const rows = page.locator('[data-testid="pr-row"]')
    await expect(rows).toHaveCount(4)
  })

  test('the popover on a lone row in a short section is fully clickable, not clipped', async ({ page }) => {
    // "Ready to merge" has exactly one PR (12801) in the fixture. This used
    // to reproduce two compounding bugs (see overview.mjs):
    //  1. paintSelection() toggled the row's `relative` class in and out
    //     alongside its keyboard-highlight ring, stripping it from every
    //     non-selected row on the very first paint (selIndex starts at -1) —
    //     the popover then positioned itself relative to <body> instead of
    //     its own row.
    //  2. listBox's `overflow-hidden` container is exactly one row tall for
    //     a lone-PR section, so once the row correctly re-established itself
    //     as the popover's containing block, the popover (rendering below
    //     the row) fell outside the container's box and got clipped away —
    //     invisible and unclickable, a real click landed on whatever sat
    //     behind it (e.g. the "Recent gegenereerd" button) instead.
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await row.click()

    const githubLink = page.locator('[data-testid="pr-popover"] a', { hasText: 'Open op GitHub' })
    await expect(githubLink).toBeVisible()

    // Resolve the point under the link's center back to the link itself —
    // this is what actually catches the bug: a clipped/mispositioned element
    // still reports a bounding box and passes toBeVisible(), but a real
    // click there would hit whatever's underneath instead.
    const hitsLink = await githubLink.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && (el === hit || el.contains(hit))
    })
    expect(hitsLink).toBe(true)

    // And a real click should actually activate it (new-tab open, not the
    // element behind it) — belt and suspenders on top of the geometry check.
    const [popup] = await Promise.all([page.context().waitForEvent('page'), githubLink.click()])
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    expect(popup.url()).toContain('github.com/blog-org/blog-platform/pull/12801')
    await popup.close()
  })

  test('stacked PRs surface as their own group', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const stack = page.locator('[data-testid="stack"]')
    await expect(stack).toHaveCount(1)
    // The chain (12903 → 12904) lives in the stack group, lifted out of the
    // flat section lists.
    await expect(stack.locator('[data-testid="pr-row"]')).toHaveCount(2)
    await expect(stack.locator('[data-pr="12903"]')).toBeVisible()
    await expect(stack.locator('[data-pr="12904"]')).toBeVisible()
  })

  test('an ingested PR opens a popover with "Open review-boom"', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const ingested = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await ingested.click()
    const openTree = page.locator('[data-testid="pr-popover"] [data-testid="open-tree"]')
    await expect(openTree).toBeVisible()
    await expect(openTree).toHaveText(/Open review-boom/)

    await openTree.click()
    await expect(page).toHaveURL(/\/pr\/12903/)
    const firstRow = page.locator('[data-testid="block-row"]').first()
    await expect(firstRow).toBeVisible()
    // No `sel` param is carried over, so state.selected keeps its default (0):
    // the first block is selected on arrival, not whatever was selected on a
    // previous visit to this PR (see the nav-chain "eerste blok" plan).
    await expect(firstRow).toHaveAttribute('data-idx', '0')
    await expect(firstRow).toHaveClass(/bg-indigo-50/)
  })

  test('status pills backfill after first paint', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    // The approved "Ready to merge" PR shows its review chip once status lands.
    const chip = page
      .locator('[data-testid="pr-row"][data-pr="12801"] [data-testid="review-chip"]')
    await expect(chip).toBeVisible()
  })

  test('search filters over all open PRs', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.locator('[data-testid="search"]').fill('scheduling')
    const results = page.locator('[data-testid="search-results"]')
    await expect(results).toBeVisible()
    await expect(results.locator('[data-testid="pr-row"]')).toHaveCount(2)
  })

  test('bare / redirects to the overview', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  // 12801 has no graph yet (not seeded into the blocks DB), so its row opens
  // the popover instead of linking straight into /pr/<id>.
  test('generating a review tree from the popover redirects into /pr/<id>', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.route('**/api/ingest', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      expect(body.pr).toBe(12801)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await row.click()
    const generate = page.locator('[data-testid="pr-popover"] [data-testid="generate-page"]')
    await expect(generate).toBeVisible()
    await expect(generate).toHaveText(/Genereer review-boom/)

    await generate.click()
    await expect(page).toHaveURL(/\/pr\/12801$/)
  })

  // The busy button polls GET /api/ingest/progress (a real, ephemeral
  // server-side stage tracker — see ingest_progress.go) instead of just
  // showing a static "Bezig met genereren…". Route-mock both endpoints to
  // control the timing deterministically.
  test('generating shows the real ingest stage while busy', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    let resolveIngest
    const ingestDone = new Promise((resolve) => {
      resolveIngest = resolve
    })
    await page.route('**/api/ingest', async (route) => {
      await ingestDone
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.route('**/api/ingest/progress*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"stage":"scan"}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await row.click()
    const generate = page.locator('[data-testid="pr-popover"] [data-testid="generate-page"]')
    await generate.click()

    await expect(generate).toHaveText(/Blocks scannen/)

    resolveIngest()
    await expect(page).toHaveURL(/\/pr\/12801$/)
  })

  test('a failed generate keeps the popover open with an inline error', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.route('**/api/ingest', async (route) => {
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"gh unreachable"}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await row.click()
    const generate = page.locator('[data-testid="pr-popover"] [data-testid="generate-page"]')
    await generate.click()

    await expect(page.locator('[data-testid="generate-error"]')).toHaveText(/gh unreachable/)
    // Still on the overview, the row is untouched (no graph yet).
    await expect(page).toHaveURL(/\/pr-overview$/)
    await expect(generate).toBeEnabled()
  })

  // An already-ingested row (12903) opens the same click-to-popover menu as
  // every other row; its menu carries "Open review-boom" (see the test above)
  // plus "Opnieuw genereren", which re-runs the same ingest workflow without
  // navigating away.
  test('regenerating an already-ingested PR reruns ingest without navigating', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    let ingestCalls = 0
    await page.route('**/api/ingest', async (route) => {
      ingestCalls++
      const body = JSON.parse(route.request().postData() || '{}')
      expect(body.pr).toBe(12903)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await row.click()
    const regenerate = page.locator('[data-testid="pr-popover"] [data-testid="regenerate-page"]')
    await regenerate.click()

    await expect.poll(() => ingestCalls).toBe(1)
    // No navigation — the "Opnieuw genereren" action stays on the overview.
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  test('a failed regenerate shows an inline error under the button, row stays put', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.route('**/api/ingest', async (route) => {
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"gh unreachable"}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await row.click()
    const regenerate = page.locator('[data-testid="pr-popover"] [data-testid="regenerate-page"]')
    await regenerate.click()

    await expect(page.locator('[data-testid="pr-popover"] [data-testid="regenerate-error"]')).toHaveText(
      /gh unreachable/,
    )
    await expect(page).toHaveURL(/\/pr-overview$/)
    await expect(regenerate).toBeEnabled()
  })

  // selectRowByKeyboard drives the page's own keyboard-nav (Home + ArrowDown,
  // see setupKeyboard/move in src/overview.mjs) to land selIndex on a given
  // PR's row, purely via the keyboard — no synthetic hover/mouseenter, which
  // proved unreliable to trigger deterministically under Playwright.
  async function selectRowByKeyboard(page, pr) {
    const row = page.locator(`[data-testid="pr-row"][data-pr="${pr}"]`)
    const idx = Number(await row.getAttribute('data-nav-index'))
    await page.keyboard.press('Home')
    for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown')
  }

  // Enter and ArrowRight must be interchangeable on the keyboard-selected row
  // (src/overview.mjs's setupKeyboard: both call activateSelected()). On a
  // non-generated row (12801, no graph yet) that means both keys open the
  // popover with "Genereer review-boom" first, same as a mouse click would.
  for (const key of ['Enter', 'ArrowRight']) {
    test(`${key} opens the popover on a non-generated row, same as a click`, async ({ page }) => {
      await page.goto('/pr-overview')
      await page.waitForLoadState('networkidle')

      await selectRowByKeyboard(page, 12801)
      await page.keyboard.press(key)

      const generate = page.locator('[data-testid="pr-popover"] [data-testid="generate-page"]')
      await expect(generate).toBeVisible()
      await expect(generate).toHaveText(/Genereer review-boom/)
      // No navigation happened — a non-generated row never links anywhere.
      await expect(page).toHaveURL(/\/pr-overview$/)
    })
  }

  // On an already-generated row (12903 has a graph), both keys must open the
  // same popover as a click would — but with the ingested action set
  // ("Open review-boom" / "Opnieuw genereren") instead of "Genereer".
  for (const key of ['Enter', 'ArrowRight']) {
    test(`${key} opens the popover on a generated row, same as a click`, async ({ page }) => {
      await page.goto('/pr-overview')
      await page.waitForLoadState('networkidle')

      await selectRowByKeyboard(page, 12903)
      await page.keyboard.press(key)

      const openTree = page.locator('[data-testid="pr-popover"] [data-testid="open-tree"]')
      await expect(openTree).toBeVisible()
      await expect(openTree).toHaveText(/Open review-boom/)
      // No navigation happened yet — only the popover opened.
      await expect(page).toHaveURL(/\/pr-overview$/)
    })
  }
})
