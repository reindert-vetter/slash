import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression for a stale cs.focus: home.mjs's state.selected watch releases
// the right-hand panel (leaveRelated()) on a genuine switch to a different
// ordinary block, tracked via lastSelectedBlockRef (see that variable's own
// doc comment). That variable is deliberately never touched while a
// comment/comment_group item is selected — but that also meant returning to
// the EXACT SAME ordinary block visited right before such a comment read as
// "nothing changed" (`ref === lastSelectedBlockRef`) and skipped
// leaveRelated() entirely, even though visiting the comment's own Claude
// chat in between had moved cs.focus to 'claude'. Reported bug: chat with
// Claude on a PR-wide comment elsewhere, click back on the ordinary block you
// started on, and its keyboard stays stuck on the comment's own chat
// (isClaudeChatFocused() === true) instead of that block's own (here: none
// at all) — the DOM itself looks unaffected (claudeChatVisible() depends on
// the CURRENTLY selected block's own comments, which stay none), so the only
// directly observable symptom is the next keypress being swallowed by the
// stale 'claude' focus instead of doing what the block's own state implies.
// Fixed by visitedCommentSinceOrdinary, which widens that condition to also
// fire on an unchanged ref whenever a comment was visited since the last
// ordinary selection.
//
// PR 127 (footertasks-blocks.json/-relations.json, see
// claude-task-footer-no-comment-nav.spec.mjs) gives a real, comment-less
// block (FooterTasksParentAction::run) to return to, and its own PR-wide
// ai_warning comment as the "elsewhere" conversation to visit in between.
test('returning to the exact same block after a comment conversation drops the stale Claude focus', async ({
  page,
}) => {
  const pr = 127
  const parentLabel = 'FooterTasksParentAction::run'

  const res = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'other.php',
      line: 0,
      author: 'AI check',
      body: 'losse vraag elders in de pr',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  expect((await res.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)

  // A fresh open already default-selects the parent (the only ordinary
  // block) — establishing the very baseline this bug depends on being stale.
  await page.getByTestId('block-row').filter({ hasText: parentLabel }).first().click()

  // Chat with the OTHER conversation.
  await page.getByTestId('block-row').filter({ hasText: 'losse vraag elders in de pr' }).first().click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeFocused()
  await compose.fill('kun je dit uitleggen?')
  await compose.press('Enter')
  await expect(page.getByTestId('claude-message').filter({ hasText: 'kun je dit uitleggen?' })).toBeVisible()

  // Return to the EXACT SAME block as before — the case that used to skip
  // leaveRelated() entirely.
  await page.getByTestId('block-row').filter({ hasText: parentLabel }).first().click()

  // The direct symptom: cs.focus must no longer be stuck on the OTHER
  // conversation's own 'claude' chat. RelatedPanel.mjs is the same live
  // module instance the page already runs (a dynamic import hits the
  // browser's module cache, not a fresh copy), so this reads real state,
  // not a mount of a new component — same technique as the read-only
  // predicate checks in navigate.spec.mjs/approval.spec.mjs.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const m = await import('/src/RelatedPanel.mjs')
        return m.isClaudeChatFocused()
      }),
    )
    .toBe(false)

  // The panel must behave normally again: →→ reaches Onderliggende code (no
  // comment on this unit) instead of the stuck 'claude' focus swallowing the
  // key.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const m = await import('/src/RelatedPanel.mjs')
        return m.isCodeFocused()
      }),
    )
    .toBe(true)
  await expect(page.getByTestId('related-item').first()).toBeVisible()
})
