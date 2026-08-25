import { test, expect, leaveSearchBox, seededPr, appReady } from './_fixtures.mjs'

// This file is not about the comment↔Claude rail-collapse feature (see
// "Vertical inklappen" in .claude/docs/comments-panel.md), which only kicks
// in below the comment↔Claude row's own 1920px width threshold and would otherwise collapse
// whichever half of comment-claude-row these tests aren't currently
// driving. A wide viewport keeps every half always fully rendered, exactly
// as before that feature existed — the collapse itself has its own
// dedicated tests in comment-claude-column-widths.spec.mjs.
test.use({ viewport: { width: 2000, height: 1100 } })

// Verifies the standalone code-preview column showing every fenced code
// block inside a comment/Claude-chat body full-size (markdown.mjs's
// extractCodeFences + RelatedPanel.mjs's recomputeCodePreviews/
// CodePreviewPanel — see "A full-size code-preview column" in
// .claude/docs/claude-chat-panel.md for D1-D4, the reviewer follow-up
// reversing D2/D3 (no click needed, always on), and the later follow-up
// reversing D3 again — stacked BELOW comment-claude-row instead of a sibling
// to its right — plus dropping D4's `suggestion`-fence exclusion). This
// synthetic PR has no ingested worktree, so the comment renders as an orphan
// (unscoped) item — commentTarget() therefore resolves to null and the
// preview must show only the "new" side, no "Huidig (PR)" comparison pane
// (D4). The Claude-chat side reuses the exact same fence markup/data
// attributes, so this one comment-side test covers the shared mechanism.
test('every fenced code block, suggestion included, shows a full-size preview stacked below the comment/Claude block', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body:
        'kijk hier eens naar:\n```php\n$hasRestrictions = $order->products->count() > 0;\n```\n' +
        'en dit is een suggestie:\n```suggestion\n$hasRestrictions = false;\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  // Both the plain `php` fence AND the `suggestion` fence are picked up — the
  // suggestion fence's own distinct in-bubble header ("Suggestie 1") is
  // untouched, only the underlying preview was added. The wrapper element
  // itself carries the preview's data (there is no "Bekijk volledig" button
  // any more, see markdown.mjs).
  const fenceEls = page.getByTestId('code-fence')
  await expect(fenceEls).toHaveCount(2)
  await expect(page.getByTestId('code-fence-open')).toHaveCount(0)

  // No click needed — the preview column appears automatically as soon as
  // the comment/Claude block (holding the fences) is visible, and shows
  // both fences' code.
  const column = page.getByTestId('code-preview-column')
  await expect(column).toBeVisible()
  await expect(column).toContainText('$hasRestrictions = $order->products->count() > 0;')
  await expect(column).toContainText('$hasRestrictions = false;')
  await expect(page.getByTestId('code-preview-card')).toHaveCount(2)

  // No anchor block for this orphan comment (see file-level comment above) —
  // so no "Huidig (PR)" comparison pane, only each fence's own code.
  await expect(column).not.toContainText('Huidig (PR)')
  await expect(page.getByTestId('code-preview-body').first()).toContainText('Codeblok')

  // Stacked BELOW comment-claude-row, not a sibling to its right any more:
  // the preview column sits at (roughly) the same left edge and starts below
  // the merged comment/Claude card's own bottom edge.
  const row = page.getByTestId('comment-claude-row')
  const rowBox = await row.boundingBox()
  const columnBox = await column.boundingBox()
  expect(columnBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1)
  expect(Math.abs(columnBox.x - rowBox.x)).toBeLessThan(2)

  // Always on: there is no close button any more, and the preview stays
  // visible while the comment holding the fence stays visible.
  await expect(page.getByTestId('code-preview-close')).toHaveCount(0)
})

// A comment index item can be SELECTED (its block auto-expands) without being
// CLICKED/focused — see "A block-anchored index item auto-expands its block…"
// in .claude/docs/comments-panel.md. Its card then renders compactConversation
// (line-clamp-3), which still carries the fence's `data-fence-code` in the
// DOM. recomputeCodePreviews must not pick that up: a preview card must only
// appear once the card is actually expanded (clicked/focused).
test('a collapsed (not yet clicked) comment card shows no preview card', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'zie voorstel:\n```suggestion\n$hasRestrictions = false;\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await expect(item).toHaveAttribute('data-expanded', 'false')

  // The fence wrapper is present in the collapsed card, but no preview card
  // must render for it yet.
  await expect(page.getByTestId('code-fence')).toHaveCount(1)
  await expect(page.getByTestId('code-preview-card')).toHaveCount(0)

  // Clicking the card expands it and the preview card now appears.
  await item.click()
  await expect(item).toHaveAttribute('data-expanded', 'true')
  await expect(page.getByTestId('code-preview-card')).toHaveCount(1)
})

// D1's answer to "wat is oud/nieuw": the "Huidig (PR)" pane is the CURRENT
// code of the unit the comment is scoped to (commentTarget().code), not the
// comment's own file/line in the abstract — only present when such a unit
// actually resolves (unlike the orphan-comment case above) AND the fence is a
// ```suggestion one (the sharpened D4: for an ordinary fence the comparison
// compared two unrelated things, so it now shows a single pane — asserted in
// the same test, since both fences sit in one body). Uses the shared
// anchor fixture (PR 12903), whose comments are wiped before every test (see
// "Shared state is reset per test" in testing-playwright.md).
test('only a suggestion fence gets the "Huidig (PR)" comparison pane', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // By label, not by raw index — see "Sort order of the left list" in
  // blocks-and-ingest.md. CreatePaymentAction::execute reliably carries a
  // real changed group — see materializeMainWorktrees in tests/_setup.mjs.
  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
  await leaveSearchBox(page)
  const card = page.getByTestId('block-column').locator('article').first()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const file = fileLine.split(':')[0]

  const res = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file,
      line: 1,
      author: 'reviewer',
      body:
        'ter illustratie:\n```php\n$dit = "een gewoon voorbeeld";\n```\n' +
        'zie voorstel:\n```suggestion\n$hasRestrictions = false;\n```',
      label,
      gran: 'group',
      rowStart: 0,
      rowEnd: 0,
    },
  })
  expect(res.ok()).toBeTruthy()

  // ?sel= carries the block's own file:line ref (see CLAUDE.md's URL-state
  // section) so this reload lands back on block 1 directly — commentTarget()
  // resolves the group-0 unit's code in LIST mode too (gran/idx don't depend
  // on state.mode being 'diff', see commentTarget's own doc comment).
  await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-column').locator('article').first().locator('h2').first()).toHaveText(label)
  const item = page.getByTestId('comment-item').filter({ hasText: 'zie voorstel' })
  await expect(item).toBeVisible()
  await item.click()

  const column = page.getByTestId('code-preview-column')
  await expect(column).toBeVisible()
  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(2)

  // Card 1 — the ordinary ```php fence: its own code, one pane, no comparison
  // against the anchored unit (which has nothing to do with this snippet).
  await expect(cards.nth(0).getByTestId('code-preview-title')).toContainText('Codeblok 1')
  await expect(cards.nth(0)).not.toContainText('Huidig (PR)')
  await expect(cards.nth(0)).not.toContainText('Voorgesteld (chat)')
  await expect(cards.nth(0)).toContainText('$dit = "een gewoon voorbeeld";')

  // Card 2 — the ```suggestion fence: really is a proposed replacement for the
  // unit, so it keeps both panes.
  await expect(cards.nth(1).getByTestId('code-preview-title')).toContainText('Suggestie 2')
  await expect(cards.nth(1)).toContainText('Huidig (PR)')
  await expect(cards.nth(1)).toContainText('Voorgesteld (chat)')
  await expect(cards.nth(1)).toContainText('$hasRestrictions = false;')
})

// The INLINE fence (inside the comment bubble itself) is capped to a couple
// of lines with a fading last line — the full code is already duplicated in
// the preview card below (see "The INLINE fence is capped to ~2 lines, faded"
// in .claude/docs/claude-chat-panel.md). `data-fence-code` (the preview
// card's own data source) must still carry the FULL code regardless.
test('a >2-line fence renders truncated + faded inline, full code stays in the preview card', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const fullCode = '$a = 1;\n$b = 2;\n$c = 3;\n$d = 4;'
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kijk hier eens naar:\n```php\n' + fullCode + '\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  // Inline: only up to 3 source lines rendered (2 full + 1 fading), never the
  // whole 4-line block, and the fade class/marker are present. Only one place
  // renders the full body with fence markup while the comment is focused (see
  // the sibling test above, which asserts exactly 2 `code-fence` wrappers for
  // 2 fences, not 4), so a page-wide lookup is unambiguous here.
  const inlineFence = page.getByTestId('code-fence')
  await expect(inlineFence).toHaveCount(1)
  await expect(inlineFence).toHaveAttribute('data-fence-truncated', 'true')
  await expect(inlineFence.locator('pre.code')).toHaveClass(/code-fence-fade-bottom/)
  const inlineText = (await inlineFence.locator('code').innerText()).trim()
  expect(inlineText.split('\n').length).toBeLessThanOrEqual(3)
  expect(inlineText).not.toContain('$d = 4;')

  // data-fence-code (the preview card's data source) still carries the FULL
  // code, never shortened.
  await expect(inlineFence).toHaveAttribute('data-fence-code', fullCode)

  // The preview card below shows the FULL code, all 4 lines.
  const previewBody = page.getByTestId('code-preview-body').first()
  await expect(previewBody).toContainText('$a = 1;')
  await expect(previewBody).toContainText('$d = 4;')
})

// ↓ at the bottom of the Claude chat walks the chat's own code blocks before
// advancing to the next block (reviewer request, see "↓ walks the chat's own
// code blocks" in .claude/docs/claude-chat-panel.md): cs.previewPos 1..n, top
// to bottom, ↑ back up into the composer, and only ↓ past the LAST card still
// releases the panel. Same two-fence seed as the first test above, so this one
// only asserts the cursor, not what the cards contain.
test('↓/↑ at the bottom of the Claude chat walk the code-preview cards', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body:
        'kijk hier eens naar:\n```php\n$first = 1;\n```\n' +
        'en dit ook nog:\n```php\n$second = 2;\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click() // -> cs.focus = 'comment'

  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(2)
  // No cursor while the comment (not the chat) owns the keyboard.
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'false')

  await page.keyboard.press('ArrowRight') // comment -> claude
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

  // ↓ from the composer's rest position lands on the FIRST card (reading
  // order), blurring the composer — the highlighted card reads as focused.
  await page.keyboard.press('ArrowDown')
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(cards.nth(1)).toHaveAttribute('data-active', 'false')
  await expect(page.getByTestId('claude-chat-compose')).not.toBeFocused()
  // The word/shape carries the state, not only the ring colour.
  await expect(page.getByTestId('code-preview-title').first()).toContainText('▸')

  await page.keyboard.press('ArrowDown')
  await expect(cards.nth(1)).toHaveAttribute('data-active', 'true')
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'false')

  // ↑ walks them back up and hands the composer its caret back.
  await page.keyboard.press('ArrowUp')
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'false')
  await expect(cards.nth(1)).toHaveAttribute('data-active', 'false')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

  // ↓ past the LAST card still releases the panel entirely (the 'advance'
  // sentinel): the keyboard goes back to the diff, so the Claude card loses
  // its focused border and no card keeps the cursor. This synthetic PR has no
  // ingested blocks to advance onto, so the exit itself is all there is to
  // assert here.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(cards.nth(1)).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('claude-chat-card')).not.toHaveClass(/border-indigo-300/)
  // Counted, not read per card: releasing the panel collapses the comment
  // card again, so whether the cards themselves are still rendered at that
  // moment is exactly the kind of transient state a spec must not assert.
  await expect(page.locator('[data-testid=code-preview-card][data-active=true]')).toHaveCount(0)
})

// ↓ from the BOTTOM OF A COMMENT (not the chat itself) walks the same
// code-preview cards first, before falling through further — reviewer
// request: "als ik in een comment naar beneden ga, en er zijn code blocks
// gegenereerd door de chat, dan wil ik ook eerst door die code blokken heen,
// net als dat ik vanuit de chat naar beneden ga" (advanceFromComment,
// RelatedPanel.mjs). Same single-conversation seed as the fixture above —
// the fence lives directly in the comment's own body, which is enough:
// recomputeCodePreviews reads every fence in the comment/Claude columns
// alike, so this only exercises the NEW entry point (↓ from 'comment'), not
// a new preview mechanism.
test('↓ from the bottom of a comment thread walks its Claude conversation\'s code blocks before advancing', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kijk hier eens naar:\n```php\n$first = 1;\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click() // -> cs.focus = 'comment'

  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(1)

  // A bare ↓ from the comment (only one conversation, so this is already
  // "the bottom") lands directly on the card — no ArrowRight into 'claude'
  // first.
  await page.keyboard.press('ArrowDown')
  await expect(cards.first()).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('claude-chat-compose')).not.toBeFocused()

  // ↑ hands the composer its caret back, exactly like the chat's own rest
  // position — this only changed the entry point, not what's downstream.
  await page.keyboard.press('ArrowUp')
  await expect(cards.first()).toHaveAttribute('data-active', 'false')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
})

// ↓ past the last code-preview card INSIDE A DRILLED COLUMN must stay inside
// that same column's own Onderliggende-code panel (its next sibling child),
// not jump the top-level sidebar selection — reported bug: it used to land on
// an unrelated block elsewhere in the PR (home.mjs's advanceToNextBlockFrom-
// ClaudeChat ignored state.focusLevel/state.drill). Real PR 12903 fixture,
// same relations mock drill-refresh-multi-level.spec.mjs uses: drill from
// findOrCreateCustomer into execute, which itself resolves to Order::address.
test('↓ past a drilled column\'s own Claude code blocks stays inside that column\'s Underlying code, and ↑ returns to the same card', async ({
  page,
}) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          kind: 'event_listener',
        },
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Models/Order.php:Order::address',
          kind: 'event_listener',
        },
      ],
    })
  })

  await page.goto('/pr/12903')
  await appReady(page)

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'findOrCreateCustomer' }).click()
  await page.keyboard.press('ArrowRight') // -> diff
  await expect(page).toHaveURL(/mode=diff/)
  await page.waitForTimeout(200)

  await page.keyboard.press('ArrowRight') // -> its Onderliggende-code panel
  await page.waitForTimeout(150)
  const child1 = page.getByTestId('related-item').first()
  await expect(child1).toContainText('execute')
  await child1.click() // drill into execute

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(drillColumn).toContainText('execute')

  // Place the comment through the real UI flow (the palette's own "Comment
  // op deze regel", landing it on whichever row/unit the diff is already on
  // — see enterDiff's firstUnapprovedChange) rather than guessing the row
  // index blockRows() would assign to execute's one changed line: that index
  // depends on exactly how many unchanged lines precede it in this fixture's
  // file, which is exactly the kind of thing "snapshot a selection by stable
  // ID, never reverse-engineer a raw index" (conventions.md) warns against.
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('kijk hier eens naar:\n```php\n$sessionTimeout = 7200;\n```')
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.getByTestId('comment-send').click(),
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()

  try {
    const item = page.getByTestId('comment-item')
    await expect(item).toHaveCount(1)

    // execute now has its own comment, holding one code fence — the preview
    // card only appears once that comment card is actually focused/expanded
    // (see "A preview card only shows for a fence inside the FOCUSED comment
    // card" in claude-chat-panel.md); placing it does not itself focus it.
    await item.click() // -> cs.focus = 'comment'
    const cards = page.getByTestId('code-preview-card')
    await expect(cards).toHaveCount(1)

    await page.keyboard.press('ArrowDown') // comment (only one) -> its code block
    await expect(cards.first()).toHaveAttribute('data-active', 'true')

    // ↓ past the last (only) card must land on execute's OWN Underlying-code
    // child (Order::address) — never move the top-level sidebar selection.
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(150)
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page).toHaveURL(/sel=app%2FActions%2FCreatePaymentAction\.php/)
    const related = page.getByTestId('related-item').first()
    await expect(related).toContainText('address')
    await expect(related).toHaveAttribute('data-active', 'true')

    // ↑ from that first (only) child returns to the exact card just left, not
    // to some ordinary comment-tail landing.
    await page.keyboard.press('ArrowUp')
    await expect(cards.first()).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('claude-chat-compose')).not.toBeFocused()
  } finally {
    // Never leave this real, non-mocked comment behind on the shared PR
    // 12903 fixture (see place-comment-return-focus.spec.mjs/claude-chat-
    // panel.spec.mjs for the same leftover-state rationale).
    await page.request.post('/api/workflows/' + runId + '/signals/delete', {
      data: { author: 'reviewer' },
    })
  }
})
