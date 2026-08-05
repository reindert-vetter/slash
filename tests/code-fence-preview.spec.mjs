import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// Verifies the standalone code-preview column opened from a "Bekijk volledig
// ↗" button inside a comment's fenced code block (markdown.mjs's
// extractCodeFences + RelatedPanel.mjs's openCodePreview/CodePreviewPanel —
// see "A full-size code-preview column" in .claude/docs/claude-chat-panel.md
// for D1-D4). This synthetic PR has no ingested worktree, so the comment
// renders as an orphan (unscoped) item — commentTarget() therefore resolves
// to null and the preview must show only the "new" side, no "Huidig (PR)"
// comparison pane (D4). The Claude-chat side reuses the exact same delegated
// click handler and button markup, so this one comment-side test covers the
// shared mechanism.
test('a fenced code block opens a full-size preview column, a suggestion fence gets no button', async ({
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

  // Only the plain `php` fence gets the button — the `suggestion` fence is
  // GitHub's own "replace these lines" convention, not a code example.
  const openButtons = page.getByTestId('code-fence-open')
  await expect(openButtons).toHaveCount(1)

  await openButtons.first().click()
  const column = page.getByTestId('code-preview-column')
  await expect(column).toBeVisible()
  await expect(column).toContainText('$hasRestrictions = $order->products->count() > 0;')

  // No anchor block for this orphan comment (see file-level comment above) —
  // so no "Huidig (PR)" comparison pane, only the fence's own code.
  await expect(column).not.toContainText('Huidig (PR)')
  await expect(page.getByTestId('code-preview-body')).toContainText('Codeblok')

  await page.getByTestId('code-preview-close').click()
  await expect(column).not.toBeVisible()
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

  await page.getByTestId('code-fence-open').first().click()
  const column = page.getByTestId('code-preview-column')
  await expect(column).toBeVisible()
  await expect(column).toContainText('Huidig (PR)')
  await expect(column).toContainText('Voorgesteld (chat)')
  await expect(column).toContainText('$hasRestrictions = false;')
})
