import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression: otherRunningClaudeTasks() (RelatedPanel.mjs) used to exclude the
// currently open conversation via chatAnchorComment() -> selComment() =
// visibleComments()[cs.sel] — a raw INDEX into the (block-scoped) comment
// list — instead of the stable cc.commentId the panel is actually anchored
// to. syncClaudeAnchorForSelection deliberately does NOT resync cc while
// cs.focus === 'claude' (it must not fight an active conversation, see
// claude-chat-panel.md's "Parallel conversations" section), so a comment-poll
// reorder while chatting (a new comment landing ahead of the current
// selection, shifting every index — the same class of bug conventions.md's
// "Snapshot a selection by stable ID" already warns about) could leave
// cs.sel pointing at a DIFFERENT comment than the one still loaded/busy in
// cc. The truly open, busy conversation was then no longer excluded and
// showed up as its own "Ook bezig elders" row — with a title/status that
// (correctly, for that id) matched the "Selected: …" line above it, because
// it WAS that same conversation. Reported bug, not a hypothetical.
test('a comment-list reorder while chatting must not list the open conversation as "elsewhere"', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)

  // Block idx 1 has a real local diff (see comment-nav-race.spec.mjs) — place
  // a genuine inline comment on it so it lands in cs.view's block-scoped,
  // INDEX-based list. A PR-wide/`kind` comment never does (see
  // otherRunningClaudeTasks' own doc comment) — the bug is specific to an
  // ordinary, block-anchored conversation.
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff

  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('is dit de juiste aanpak?')
  await page.keyboard.press('Enter') // posts directly — no comment-kind menu
  // placeComment's own POST/reload tail is fired without being awaited
  // (COMPOSE_COMMANDS' run(), home.mjs) — wait for the real comment to
  // actually land before navigating into it.
  await expect(page.getByTestId('comment-item').filter({ hasText: 'is dit de juiste aanpak?' })).toBeVisible()

  // Hold the Claude Signal POST open so the conversation stays "busy" for the
  // rest of the test — same trick as claude-chat-other-tasks.spec.mjs.
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/signals/message', async (route) => {
    await held
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
  })

  await page.keyboard.press('ArrowRight') // diff -> comment head (hasVisibleComments())
  await page.keyboard.press('ArrowRight') // comment -> claude
  const chatCompose = page.getByTestId('claude-chat-compose')
  await expect(chatCompose).toBeFocused()
  await chatCompose.fill('leg dit uit')
  await chatCompose.press('Enter') // held above, so this conversation stays "busy"

  // The Signal POST is held indefinitely (still in flight), so cc.messages
  // never gets the reviewer's own "leg dit uit" turn — "Selected: …" falls
  // back to the anchor comment's own body (ownMessageTitle's documented
  // fallback), same as the existing "eerste vraag over total" case in
  // claude-chat-other-tasks.spec.mjs. That fallback text is enough to prove
  // which conversation cc is anchored to.
  await expect(page.getByTestId('claude-selected-line').first()).toContainText('is dit de juiste aanpak?')

  // Read back the just-created comment's own shape so the injected synthetic
  // comment below lands in the exact same block-scoped list.
  const real = await page.request.get('/api/comments?pr=12903').then((r) => r.json())
  const anchor = real.find((c) => c.body === 'is dit de juiste aanpak?')
  expect(anchor).toBeTruthy()

  // From the next poll onward, a SECOND, synthetic comment on the same
  // file/label is inserted BEFORE the real anchor — the "a comment arriving
  // ahead of the current selection shifts everything" reorder, applied here
  // to the comment list itself. cs.sel (still 0, still the only card ever
  // selected) now resolves to this new comment instead of the one actually
  // anchored/busy in cc.
  await page.route('**/api/comments?pr=12903*', async (route) => {
    const synthetic = { ...anchor, id: anchor.id + 100000, body: 'een heel andere, latere vraag' }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([synthetic, ...real]),
    })
  })

  // Wait past the comment poll's 5s cadence (RelatedPanel.mjs's refreshTimer)
  // so the reordered list is actually picked up.
  await page.waitForTimeout(5300)

  // The real, still-open, still-busy conversation must NOT list itself as
  // "elsewhere" — it's the one currently in view (the "Selected: …" line),
  // not another task to jump to.
  await expect(page.getByTestId('claude-selected-line').first()).toContainText('is dit de juiste aanpak?')
  const otherTasks = page.getByTestId('claude-other-tasks')
  if (await otherTasks.count()) {
    await expect(otherTasks.first()).not.toContainText('is dit de juiste aanpak?')
  }

  release()
})
