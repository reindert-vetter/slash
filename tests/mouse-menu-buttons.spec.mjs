import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// This file is not about the comment↔Claude rail-collapse feature (see
// "Vertical inklappen" in .claude/docs/comments-panel.md), which only kicks
// in below the 1400px `narrow` breakpoint and would otherwise collapse
// whichever half of comment-claude-row these tests aren't currently
// driving. A wide viewport keeps every half always fully rendered, exactly
// as before that feature existed — the collapse itself has its own
// dedicated tests in comment-claude-column-widths.spec.mjs.
test.use({ viewport: { width: 1600, height: 900 } })

// Every command palette used to be reachable only via the keyboard (Enter/`/`)
// — see the "mouse-navigation audit" that led to this file. Each button below
// runs the exact same openMenu(...) call the matching key already runs; per
// mouse-navigation.md rule 1, a click is the Enter-equivalent, never its own
// implementation. This spec only checks that each button OPENS the right
// menu — the menu's own contents/actions are already covered by
// pr-menu.spec.mjs, comments-panel tests and claude-chat-panel.spec.mjs.

test('block card menu button opens the block palette (COMMANDS)', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // Select the first real diff block (block 0 has no local diff to preview).
  await page.locator('[data-idx="1"]').click()
  await expect(page.locator('[data-change-active]').first()).toBeVisible()

  const menu = page.getByTestId('command-menu')
  await expect(menu).not.toBeVisible()

  // Hover-revealed (opacity-0 group-hover:opacity-100, see Block.mjs) — the
  // button exists in the DOM regardless, so a plain dispatchEvent click
  // (not .click(), which would park the pointer, see mouse-navigation.md)
  // exercises the same handler a real hover+click would.
  await page.getByTestId('block-open-menu').first().dispatchEvent('click')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('command-row').getByText('Comment op deze regel', { exact: true })).toBeVisible()
})

test('PR-info menu button opens the PR-wide palette (PR_COMMANDS)', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // Stop 1 (the PR description column) is where pr-info-theme-row lives.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('pr-info-column')).toBeVisible()

  const menu = page.getByTestId('command-menu')
  await expect(menu).not.toBeVisible()

  await page.getByTestId('pr-menu-button').dispatchEvent('click')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('command-row').getByText('GitHub', { exact: true })).toBeVisible()
  await expect(menu.getByTestId('command-row').getByText('Jira', { exact: true })).toBeVisible()
})

test('comment-index detail card menu button opens prCommentCommandsFor()', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'app/Http/Controllers/Api/ContractController.php',
      line: 0,
      author: 'AI check',
      body: 'Dit endpoint valideert de invoer niet.',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('comment-detail-card')).toBeVisible()

  const menu = page.getByTestId('command-menu')
  await expect(menu).not.toBeVisible()

  await page.getByTestId('comment-detail-menu').dispatchEvent('click')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('command-row').getByText('Beantwoorden', { exact: true })).toBeVisible()
})

test('Claude chat column menu button opens claudeChatCommandsFor()', async ({ page }, testInfo) => {
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
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  const claudeCard = page.getByTestId('claude-chat-card')
  await expect(claudeCard).toBeVisible()

  const menu = page.getByTestId('command-menu')
  await expect(menu).not.toBeVisible()

  await page.getByTestId('claude-chat-menu').dispatchEvent('click')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('command-row').getByText('Wis Claude-gesprek', { exact: true })).toBeVisible()
})
