import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// rangeCommandsFor's three newer actions ("Plaats comment over dit bereik",
// "Chat met Claude over dit bereik", "Ignore … in dit bereik") — see
// .claude/docs/command-palette.md's "A multi-row selection replaces the block
// palette" section. The bulk approve action itself
// (tests/list-range-select.spec.mjs) is unaffected by any of this.

// Both anchor on the CURSOR's own block, not the literal first item of the
// selection (rangeChatEligible/startRangeComment/startRangeChat, home.mjs +
// RelatedPanel.mjs) — deliberate, see command-palette.md.
test('"Plaats comment over dit bereik" anchors on the cursor block and lists every covered block in the posted body', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)

  // Three rows selected, cursor on the third — stay in list mode, never →
  // into the diff (the range palette only exists in state.mode === 'list').
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveCount(3)

  await page.keyboard.press('Enter')
  await page
    .getByTestId('command-row')
    .filter({ hasText: 'Plaats comment over deze 3 blokken' })
    .click()

  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('graag deze drie samen bekijken')

  await page.keyboard.press('Enter') // opens the compose-kind menu (COMPOSE_COMMANDS)
  const composeMenu = page.getByTestId('command-menu')
  await expect(composeMenu).toBeVisible()
  await expect(composeMenu.getByTestId('command-row').nth(1)).toHaveText(/Plaats comment/)

  const [createRes, postReq] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.waitForRequest((req) => req.url().includes('/api/workflows/task_code_comment') && req.method() === 'POST'),
    page.keyboard.press('Enter'), // "Plaats comment" is the compose menu's default item
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()

  const posted = postReq.postDataJSON()
  // The manifest prefix names the range, the reviewer's own text follows it
  // verbatim — never silently rewritten or dropped.
  expect(posted.body).toMatch(/^_Comment over 3 blokken: .+_\n\ngraag deze drie samen bekijken$/)
  // Anchored on the CURSOR's own block (the third row) — a real file/line,
  // not a PR-wide/unanchored comment.
  expect(posted.kind).not.toBe('issue')
  expect(posted.file).toBeTruthy()

  // Clean up: never leave a real, non-mocked comment behind on the shared
  // PR 12903 fixture (see place-comment-return-focus.spec.mjs).
  await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
})

// The Claude-chat twin: same anchor, but the wider scope reaches Claude via an
// invisible MANIFEST context on the first turn instead of a visible body
// prefix — label + file + line per block, deliberately NO source code (see
// "Chat over een heel bereik" in .claude/docs/claude-chat-panel.md).
test('"Chat met Claude over dit bereik" sends a manifest (no source code) covering every block', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)

  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveCount(3)

  await page.keyboard.press('Enter')
  await page
    .getByTestId('command-row')
    .filter({ hasText: 'Chat met Claude over deze 3 blokken' })
    .click()

  const claudeComposer = page.getByTestId('claude-chat-compose')
  await expect(claudeComposer).toBeFocused()
  await claudeComposer.fill('waar moet ik hier op letten?')

  const [createRes, firstMsgReq] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    claudeComposer.press('Enter'),
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()

  try {
    const sent = firstMsgReq.postDataJSON()
    expect(sent.body).toBe('waar moet ik hier op letten?') // the visible bubble never carries the context
    expect(sent.context).toContain('Bereik van 3 blokken')
    // A manifest line per block: at least 3 "- " entries.
    expect((sent.context.match(/^- /gm) || []).length).toBe(3)
    // The whole point of the manifest: no fenced source code anywhere.
    expect(sent.context).not.toContain('```')
  } finally {
    // Never leave this real, non-mocked comment/conversation behind on the
    // shared PR 12903 fixture.
    await page.request.post('/api/workflows/' + runId + '/signals/delete', {
      data: { author: 'reviewer' },
    })
  }
})

// The Ignore action only ever touches PR-comment index rows in the
// selection — the only kind of row the pre-existing single-item Ignore
// (toggleIgnoreComment) applies to at all. Own PR number: two PR-wide
// comments, no ordinary blocks, so nothing here can collide with another
// spec's exact row-count assertion (see the APPROVAL_RESET_PRS note in
// _fixtures.mjs).
test('"Ignore N comments in dit bereik" ignores every comment row of the selection, durably', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const placeComment = async (body) => {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'app/Http/Controllers/RangeIgnoreController.php', line: 1, kind: 'issue', author: 'octocat', body, local: true },
    })
    expect(res.ok()).toBeTruthy()
  }
  await placeComment('eerste opmerking over deze PR')
  await placeComment('tweede opmerking over deze PR')

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)

  const rows = page.getByTestId('block-row')
  await expect(rows).toHaveCount(2)

  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveCount(2)

  // Cursor sits on the second (bottom) comment row — a comment item, so
  // "Plaats comment"/"Chat met Claude" are absent (rangeChatEligible()),
  // only approve + ignore remain.
  await page.keyboard.press('Enter')
  const menuRows = page.getByTestId('command-row')
  await expect(menuRows.filter({ hasText: 'Plaats comment over' })).toHaveCount(0)
  await expect(menuRows.filter({ hasText: 'Chat met Claude over' })).toHaveCount(0)
  const ignoreRow = menuRows.filter({ hasText: 'Ignore 2 comments in dit bereik' })
  await expect(ignoreRow).toHaveCount(1)
  await ignoreRow.click()

  // Both disappear from the index right away (the optimistic local toggle).
  await expect(page.getByTestId('block-row')).toHaveCount(0)
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/commentignores?pr=${pr}`)
      if (!res.ok()) return -1
      return ((await res.json()).ignored || []).length
    })
    .toBe(2)

  // Durable: still hidden after a reload.
  await page.reload()
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row')).toHaveCount(0)
  await expect(page.getByTestId('toggle-ignored')).toBeVisible()
})
