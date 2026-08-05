import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

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

  // Both the plain `php` fence AND the `suggestion` fence now get the
  // button — the suggestion fence's own distinct in-bubble header
  // ("Suggestie 1") is untouched, only the underlying preview was added.
  const openButtons = page.getByTestId('code-fence-open')
  await expect(openButtons).toHaveCount(2)

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

// D1's answer to "wat is oud/nieuw": the "Huidig (PR)" pane is the CURRENT
// code of the unit the comment is scoped to (commentTarget().code), not the
// comment's own file/line in the abstract — only present when such a unit
// actually resolves (unlike the orphan-comment case above). Uses the shared
// anchor fixture (PR 12903), whose comments are wiped before every test (see
// "Shared state is reset per test" in testing-playwright.md).
test('a block-scoped comment\'s fence gets a "Huidig (PR)" comparison pane', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // Block 1 (CreatePaymentAction::execute) reliably carries a real changed
  // group — see materializeMainWorktrees in tests/_setup.mjs — unlike block 0,
  // which has nothing to preview and would leave commentTarget().code empty.
  await page.locator('[data-idx="1"]').click()
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
      body: 'zie voorstel:\n```php\n$hasRestrictions = false;\n```',
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
  await expect(column).toContainText('Huidig (PR)')
  await expect(column).toContainText('Voorgesteld (chat)')
  await expect(column).toContainText('$hasRestrictions = false;')
})
