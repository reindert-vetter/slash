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

// Reviewer report (screenshot): the chat bubble above renders an inline-code
// identifier (`` `whereHas` ``) as a styled pill, but the SAME text reduced
// to a plain string on the preview card below showed no styling at all — and
// the card's own pane header said the bare word "Codeblok", no number/
// language, unlike the fence's own header a few lines above it. Both fixed
// by carrying the fence's raw markdown context through `renderMarkdown`
// (CodePreview.mjs) instead of a plain-text hint, and reading the SAME
// `data-fence-label`/`data-fence-lang` markdown.mjs already stamps on the
// wrapper for the pane title (`fenceTitle`).
test('the preview card styles its context text the same as the chat, and its pane header carries the fence label + language', async ({
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
        'Voorstel: filter de pauze mee in de `whereHas`-closure van `RetryRateLimitedRules`.\n' +
        '```php\n$hasRestrictions = $order->products->count() > 0;\n```',
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

  const card = page.getByTestId('code-preview-card').first()
  await expect(card).toBeVisible()

  // The identifiers render as real inline-code pills, exactly like the same
  // text does in the chat bubble above — not as inert plain text.
  const context = card.getByTestId('code-preview-context')
  await expect(context.locator('code')).toHaveText(['whereHas', 'RetryRateLimitedRules'])

  // The pane header shows the fence's own running label AND language word,
  // matching the inline fence's own header text — not the bare word
  // "Codeblok" with no number/language.
  await expect(card.getByTestId('code-preview-body')).toContainText('Codeblok 1')
  await expect(card.getByTestId('code-preview-body')).toContainText('php')
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
  // Neither snippet here declares a class, so the card shows no title line
  // at all any more (the redundant "Codeblok N · PHP" header was removed —
  // that number/word already shows on the fence's own inline badge in the
  // chat bubble above, see "Default-collapsed cards…" in
  // .claude/docs/claude-chat-panel.md).
  await expect(cards.nth(0).getByTestId('code-preview-title')).toHaveCount(0)
  await expect(cards.nth(0)).not.toContainText('Huidig (PR)')
  await expect(cards.nth(0)).not.toContainText('Voorgesteld (chat)')
  await expect(cards.nth(0)).toContainText('$dit = "een gewoon voorbeeld";')

  // Card 2 — the ```suggestion fence: really is a proposed replacement for the
  // unit, so it keeps both panes.
  await expect(cards.nth(1).getByTestId('code-preview-title')).toHaveCount(0)
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

// A long code LINE wraps instead of being silently clipped — reviewer report
// on a generated TS block (see "A long code line wraps instead of being
// silently clipped" in .claude/rules/conventions.md): a line wider than the
// bubble used to run off the right edge with nothing to show it was cut
// (the fence wrapper's own `overflow-hidden` inline, an invisible
// `no-scrollbar` horizontal scroll in the expanded preview card). Not
// TS-specific — this seeds TWO different extensions (a `ts` fence with a
// long, space-separated line typical of a type signature, and a `bash`
// fence with one long UNBROKEN token, so `break-words`' forced mid-token
// break is exercised too, not just ordinary whitespace wrapping) to prove
// the fix is general, per the task's own "onderzoek ook andere
// extensies" instruction.
test('a long code line wraps in both the inline fence and the expanded preview card, for any extension', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const tsLine =
    'export const firePurchaseEvent = (orderData: OrderSummaryResponse, trackedOrderIds: ReadonlyArray<string>): void => {'
  const bashLine = '/very/long/unbroken/path/without/any/spaces/that/would/otherwise/overflow/the/narrow/chat/bubble/column/xyz'
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'ts voorbeeld:\n```ts\n' + tsLine + '\n```\nbash voorbeeld:\n```bash\n' + bashLine + '\n```',
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

  const inlineFences = page.getByTestId('code-fence')
  await expect(inlineFences).toHaveCount(2)

  // Neither inline fence's <pre> lets its content scroll past its own box —
  // whitespace-pre-wrap/break-words wrapped the long line instead of the
  // wrapper's overflow-hidden silently clipping it.
  for (let i = 0; i < 2; i++) {
    const pre = inlineFences.nth(i).locator('pre.code')
    const overflow = await pre.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    const whiteSpace = await pre.evaluate((el) => getComputedStyle(el).whiteSpace)
    expect(whiteSpace).toBe('pre-wrap')
  }

  // The full-size preview cards below show the same, unwrapped-looking-but-
  // actually-wrapped behaviour once expanded (a lone/last comment starts
  // expanded by default).
  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(2)
  for (let i = 0; i < 2; i++) {
    await expect(cards.nth(i)).toHaveAttribute('data-expanded', 'true')
    const pre = cards.nth(i).locator('pre.code')
    const overflow = await pre.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  }
})

// Reviewer request: "dus alles moet ik terug kunnen vinden in de gegeneerde
// blokken" — every piece of a message's text that carries a code example
// must be reachable from SOME card: the FULL text before the first fence
// (not just its last paragraph, the earlier behaviour), the full text
// between two fences, and the text after the LAST fence (new
// `code-preview-trailing`). Two fences in one comment body also get a
// dashed divider between their two cards (`code-preview-group-divider`) —
// they came from the same message, so they "stick together" instead of
// getting the ordinary gap.
test('a message with code examples shows its full leading/middle/trailing text, and a dashed divider between two cards from the same message', async ({
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
        'Eerste alinea met wat uitleg.\n\n' +
        'Tweede alinea, vlak boven het eerste voorbeeld.\n' +
        '```php\n$first = 1;\n```\n' +
        'Tekst tussen de twee code blokken.\n' +
        '```php\n$second = 2;\n```\n' +
        'De afsluitende tekst na de laatste code.',
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

  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(2)

  // Card 1's context carries BOTH paragraphs before the first fence, not
  // just the last one.
  const context1 = cards.nth(0).getByTestId('code-preview-context')
  await expect(context1).toContainText('Eerste alinea met wat uitleg.')
  await expect(context1).toContainText('Tweede alinea, vlak boven het eerste voorbeeld.')

  // Card 2's context carries the text between the two fences.
  const context2 = cards.nth(1).getByTestId('code-preview-context')
  await expect(context2).toContainText('Tekst tussen de twee code blokken.')

  // Card 2 (the LAST fence) also shows the trailing text after it — nothing
  // typed after the code is silently dropped.
  await expect(cards.nth(0).getByTestId('code-preview-trailing')).toHaveCount(0)
  await expect(cards.nth(1).getByTestId('code-preview-trailing')).toContainText(
    'De afsluitende tekst na de laatste code.',
  )

  // Both fences came from the SAME message: a dashed divider sits between
  // their two cards, and there is exactly one (never one per card).
  await expect(page.getByTestId('code-preview-group-divider')).toHaveCount(1)
})

// Two fences from TWO DIFFERENT messages (a PR comment and a Claude-chat
// reply) get the ordinary gap, never a divider — the divider is only for
// cards that share the SAME message (see the test above).
test('two cards from different messages get no dashed divider between them', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kijk hier eens naar:\n```php\n$fromComment = 1;\n```',
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
  await item.click() // -> cs.focus = 'comment', its own fence card appears

  await expect(page.getByTestId('code-preview-card')).toHaveCount(1)

  // Drive the shared Claude-chat turn fixture (tests/fixtures/claude-chat-
  // turns.json) up to turn 4, which carries its own php fence — same
  // sequence tests/claude-chat-panel.spec.mjs already uses.
  await page.keyboard.press('ArrowRight') // comment -> claude
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()
  await composer.fill('Kun je hier iets over zeggen?')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  await composer.fill('Stel een aanpak voor.')
  await composer.press('Enter')
  await page.getByTestId('claude-question-option').nth(1).click()
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Bedankt, ik ga verder met Optie B.')
  await composer.fill('Laat een voorbeeld zien.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('class FirstExample')

  // Now two cards: one from the comment, one from the Claude reply — two
  // different messages, so no divider between them.
  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(2)
  await expect(page.getByTestId('code-preview-group-divider')).toHaveCount(0)
})

// Reviewer report (screenshot data/review-shots/task-comment-code-preview-
// below.png): "laat code ook onder de comment zien, net als chat" — the
// comment thread's own latest fence used to start COLLAPSED (title + an
// "uitklappen" affordance only, no code) as soon as the Claude chat next to
// it also carried a fence, because `isLast` used to be computed against one
// flat "last fence in the whole comment-claude-columns container" — the
// comment column always renders before the Claude column in DOM order, so a
// comment's own fence could never win that comparison. Fixed by tracking
// "last" PER SIDE (comment vs. Claude) — see "Default-collapsed cards…" in
// .claude/docs/claude-chat-panel.md. Reuses the exact same fixture flow as
// "two cards from different messages get no dashed divider between them"
// right above.
test("a comment's own latest fence defaults to expanded too, not just the Claude chat's", async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kijk hier eens naar:\n```php\n$fromComment = 1;\n```',
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
  await item.click() // -> cs.focus = 'comment', its own fence card appears

  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(1)
  // Still the only fence around — expanded on its own, same as before.
  await expect(cards.first()).toHaveAttribute('data-expanded', 'true')

  // Drive the shared Claude-chat turn fixture up to turn 4, which carries
  // its own php fence — same sequence as the test right above.
  await page.keyboard.press('ArrowRight') // comment -> claude
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()
  await composer.fill('Kun je hier iets over zeggen?')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  await composer.fill('Stel een aanpak voor.')
  await composer.press('Enter')
  await page.getByTestId('claude-question-option').nth(1).click()
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Bedankt, ik ga verder met Optie B.')
  await composer.fill('Laat een voorbeeld zien.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('class FirstExample')

  // Both the comment's own card AND the Claude reply's card default to
  // expanded now — neither one demotes the other just for sitting in an
  // earlier DOM position.
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveAttribute('data-expanded', 'true')
  await expect(cards.nth(1)).toHaveAttribute('data-expanded', 'true')
})

// Reviewer report (screenshot): the code-preview card's trailing text
// abruptly stopped mid-sentence ("Eén ding om te checken vo…") even though
// the chat bubble right above it already showed the full, final answer.
// Root cause: `claudePartialBubble` (ClaudeChat.mjs) is deliberately kept
// mounted for a moment AFTER the real, complete message has already landed
// (so the bubble doesn't blink out before the transcript refetch) — a
// genuine overlap window, not a race. Its own fence is necessarily
// mid-stream/truncated, and `recomputeCodePreviews` used to have no filter
// against it, so it could contribute a stale card of its own. Reproduced here
// entirely via mocked network (the real transcript GET and the ONE
// `GET /api/chat/progress?commentId=` resync read `loadChatProgress` fires the
// moment the conversation opens — deterministic, unlike the SSE stream's own
// reconnect timing), so it needs no real Claude turn and stays fast/deterministic.
test('a truncated streaming partial answer never leaves a stale, cut-off code-preview card once the real message has landed', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kan dit sneller?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const FULL_TRAILING =
    'Eén ding om te checken voor de worker: dit werkt alleen als het build-image de dev-dependencies meeneemt.'
  const CUT_TRAILING = 'Eén ding om te checken vo'

  // The real, ALREADY-LANDED transcript: one assistant turn with two fences,
  // the second followed by the full trailing sentence above.
  await page.route('**/api/chat?commentId=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        messages: [
          {
            id: 'm1',
            conversationId,
            pr,
            role: 'assistant',
            body:
              'Eerste voorbeeld:\n```php\n$first = 1;\n```\n' +
              'Call site wordt dan:\n```php\n$second = 2;\n```\n' +
              FULL_TRAILING,
          },
        ],
        summary: '',
        summaryStatus: '',
        seenAt: '',
      }),
    }),
  )
  // loadChatProgress (RelatedPanel.mjs) fetches this ONE resync read the
  // moment the conversation is opened — deterministic, unlike the SSE
  // stream's reconnect timing, which made an earlier version of this test
  // flap between catching and missing the bug depending on exactly when the
  // partial bubble's own repeated remount cycle (the arrow.js pitfall noted
  // on claudePartialBubble in ClaudeChat.mjs) happened to land. This single
  // resync response is enough to reproduce the real overlap: the transcript
  // above already carries the full, final message, and this snapshot says a
  // turn is STILL running with an OLDER, truncated answer — exactly the
  // window where both are mounted at once.
  await page.route('**/api/chat/progress?commentId=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        running: true,
        progress: {
          running: true,
          phase: 'writing',
          startedAt: Date.now() - 1000,
          updatedAt: Date.now(),
          partial:
            'Eerste voorbeeld:\n```php\n$first = 1;\n```\n' +
            'Call site wordt dan:\n```php\n$second = 2;\n```\n' +
            CUT_TRAILING,
        },
      }),
    }),
  )

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude

  // Both the real message (full trailing sentence) and the live partial
  // bubble (cut off) are visible at once — the deliberate overlap window.
  await expect(page.getByTestId('claude-message-body').last()).toContainText(FULL_TRAILING)
  await expect(page.getByTestId('claude-partial-body')).toContainText(CUT_TRAILING)

  // Exactly 2 preview cards — the real message's two fences — never a third
  // one contributed by the partial bubble, and card 2's trailing text is the
  // FULL sentence, never cut off. Asserted twice with a pause in between so
  // a transient pre-recompute tick (recomputeCodePreviews is debounced onto
  // a MutationObserver + rAF) can't hide a later flip-flop behind a lucky
  // first poll.
  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(2)
  await page.waitForTimeout(300)
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(1).getByTestId('code-preview-trailing')).toContainText(FULL_TRAILING)
})

// Once a chat's answer has put a code block in the preview column, the WHOLE
// text of later answers (streaming, including a half-written fence) is shown
// there too — RelatedPanel.mjs's liveAnswerCard.
test('a chat that already has a code card also shows its streaming answer in full below the chat', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kan dit sneller?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  await page.route('**/api/chat?commentId=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        messages: [
          { id: 'm1', conversationId, pr, role: 'assistant', body: 'Eerste:\n```php\n$first = 1;\n```\nklaar' },
        ],
        summary: '',
        summaryStatus: '',
        seenAt: '',
      }),
    }),
  )
  // A turn is running with a plain-text start and a still-OPEN fence.
  await page.route('**/api/chat/progress?commentId=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        running: true,
        progress: {
          running: true,
          phase: 'writing',
          startedAt: Date.now() - 1000,
          updatedAt: Date.now(),
          partial: 'Tweede antwoord met uitleg\n```php\n$second = 2;',
        },
      }),
    }),
  )

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight')

  const live = page.getByTestId('live-answer-card')
  await expect(live).toBeVisible()
  await expect(live.getByTestId('live-answer-body')).toContainText('Tweede antwoord met uitleg')
  // The half-written fence is closed visually, so it renders as code.
  await expect(live.getByTestId('code-fence')).toHaveCount(1)
  await expect(live.getByTestId('live-answer-body')).toContainText('$second = 2;')
})
