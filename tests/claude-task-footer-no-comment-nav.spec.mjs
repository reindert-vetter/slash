import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The nav path that claude-task-footer-no-anchor-and-linger.spec.mjs left as
// "manual verification only": reaching "Ook bezig elders" (cs.focus==='tasks',
// enterFooterTasks) with ↑ from the very top of the Onderliggende-code panel
// (codeSel===0) on a unit that has NO comment of its own at all — so there is
// no 'comment'/'claude' stop to fall back on, only the footer-only card. See
// "Reachable with NO anchor at all, not just as a nested rung of 'claude'" in
// .claude/docs/claude-chat-panel.md.
//
// PR 127 (materialized via tests/fixtures/footertasks-blocks.json/
// -relations.json, no worktree — see tests/_fixtures.mjs) gives a real block
// (FooterTasksParentAction::run) with a real "Onderliggende code" child
// (FooterTasksChildService::assist) via a plain relation, and no comment on
// the parent — so →→ from its diff lands straight on cs.focus==='code' at
// codeSel===0 (enterDiff, then enterCommentsOrRelated skipping straight to
// enterRelated: no comments, no Claude anchor).
//
// The "other" running task is a PR-wide ai_warning comment (task_code_comment,
// same shape as claude-chat-other-tasks.spec.mjs), answered for REAL against
// the offline `claude` stub — same reliable mechanism as
// claude-task-footer-no-anchor-and-linger.spec.mjs: the busy→not-busy
// transition that round trip stamps `finishedAt` with is exactly what keeps
// otherRunningClaudeTasks().length > 0 (the 2-minute linger window), with no
// held/mocked POST needed.
//
// The child row (FooterTasksChildService::assist) is selected FIRST, before
// ever touching the comment's own conversation — deliberately, not just to
// warm up the fixture. home.mjs's own state.selected watch only calls
// leaveRelated() (releasing a stale cs.focus='claude' from whatever was
// selected before) on a genuine change of `lastSelectedBlockRef`, and that
// baseline is never updated while a comment-index item is selected (see the
// watch's own doc comment in home.mjs) — so going comment -> back to the
// exact SAME ordinary block already selected before the comment (here: the
// parent, the fresh-open default) leaves cs.focus wrongly stuck on the
// comment's own 'claude' chat. Selecting the child first makes the parent a
// genuinely different `lastSelectedBlockRef` than whatever was selected
// before the comment, so the watch's leaveRelated() actually fires — the
// same reason a real reviewer, having looked at a comment elsewhere, would
// only see this reset go wrong if they returned to the IDENTICAL block they
// started on, not just any other one.
test('↑ from the top of Onderliggende code with no comment on the unit reaches "Ook bezig elders"', async ({
  page,
}) => {
  const pr = 127
  const parentLabel = 'FooterTasksParentAction::run'
  const childLabel = 'FooterTasksChildService::assist'

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
  const runId = (await res.json()).runId
  expect(runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)

  await page.getByTestId('block-row').filter({ hasText: childLabel }).first().click()

  // Answer it for real (the offline stub is fast) so the busy → not-busy
  // transition stamps finishedAt and the task starts lingering.
  await page.getByTestId('block-row').filter({ hasText: 'losse vraag elders in de pr' }).first().click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeFocused()
  await compose.fill('kun je dit uitleggen?')
  await compose.press('Enter')
  await expect(page.getByTestId('claude-message').filter({ hasText: 'kun je dit uitleggen?' })).toBeVisible()

  // Now the real block, with no comment of its own but a real Onderliggende-
  // code child.
  await page.getByTestId('block-row').filter({ hasText: parentLabel }).first().click()
  await page.keyboard.press('ArrowRight') // stop 3: diff
  await page.keyboard.press('ArrowRight') // no comment on this unit -> straight to stop 6: Onderliggende code
  await expect(page.getByTestId('related-item').first()).toBeVisible()

  await page.keyboard.press('ArrowUp')
  const row = page.getByTestId('claude-task-row').first()
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-active', 'true')

  // Enter runs the same jump action as everywhere else this rung appears —
  // it lands the keyboard back on the other conversation's own composer.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  await expect(page.getByTestId('claude-message').filter({ hasText: 'kun je dit uitleggen?' })).toBeVisible()
})
