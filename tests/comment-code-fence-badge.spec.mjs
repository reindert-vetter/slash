import { test, expect, seededPr } from './_fixtures.mjs'

// This file is not about the comment↔Claude rail-collapse feature (see
// "Vertical inklappen" in .claude/docs/comments-panel.md), which only kicks
// in below the comment↔Claude row's own 1920px width threshold and would otherwise collapse
// whichever half of comment-claude-row these tests aren't currently
// driving. A wide viewport keeps every half always fully rendered, exactly
// as before that feature existed — the collapse itself has its own
// dedicated tests in comment-claude-column-widths.spec.mjs.
test.use({ viewport: { width: 2000, height: 1100 } })

// Verifies fenced code blocks inside a comment/reply body (markdown.mjs,
// RelatedPanel.mjs): a language badge + a running "Codeblok N" number, a
// ```suggestion fence rendering as a visually distinct "Suggestie N" instead
// of a language — and, load-bearing per Reindert's explicit request, that the
// SAME numbering (not a fresh count per bubble) also reaches the embedded
// Claude conversation's own copy of the context, since that number is the
// ONLY way a reviewer ever acts on a fenced block/suggestion: there is no
// accept button or menu action, only "pas codeblok 3 toe: ..." typed into the
// Claude composer. This fixture only ever uses ONE comment thread, so the
// badge numbering and the chat context numbering coincide here — they no
// longer necessarily do across SIBLING comment threads on the same
// block/line, an accepted divergence, see "Codeblok numbering diverges from
// chat context (on purpose)" in .claude/docs/claude-chat-panel.md.
//
// The Claude round-trip is done FIRST, right after entering the column, and
// the (slower, several-assertions-deep) visible-badge checks come after —
// InlineComments' own 5s comment-list refresh (RelatedPanel.mjs's
// refreshTimer) can otherwise land between filling the composer and pressing
// Enter, remounting ClaudeChatPanel (claudeChatVisible() re-derives from
// hasVisibleComments()) and silently dropping the typed text.
test('fenced code blocks get a language badge + a running, Claude-matching number', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body:
        'kijk hier:\n```sql\nSELECT * FROM users WHERE id = 1;\n```\n' +
        'en dit stel ik voor:\n```suggestion\nreturn $this->repository->find($id);\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()

  // A reply on the SAME thread carries a third fence — its own number must
  // continue the count (3), not restart at 1.
  await page.request.post('/api/workflows/' + runId + '/signals/reply', {
    data: {
      author: 'octocat',
      body:
        'nog een idee:\n```bash\necho "ok"\n```\n' +
        'en de spec:\n```yaml\nOrderInclude:\n  name: include\n  in: query\n```',
      done: false,
    },
  })

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  // Reach the Claude composer via the SAME key dance
  // tests/claude-chat-panel.spec.mjs uses (↑ into the thread, → into Claude,
  // ← back to the comment, → into Claude again) rather than a single →
  // straight from 'comment' — the Claude column (claude-chat-compose) is
  // already present in the DOM regardless (claudeChatVisible() only checks
  // hasVisibleComments(), not cs.focus), so a bare toBeVisible() check
  // doesn't prove the keyboard actually reached it, and Playwright's own
  // fill()/press() force DOM focus onto whatever locator they're given
  // regardless of the app's internal cs.focus — so a premature send attempt
  // can silently target a composer the app itself doesn't consider entered
  // yet. This exact single-→ ordering was independently confirmed to hang
  // even for a plain-text comment with no fences at all — a pre-existing
  // test-writing pitfall, not something this feature introduced.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // The first turn's invisible context must carry the SAME numbering the
  // reviewer sees on screen, so "codeblok 3" in the chat names the bash fence
  // above, not something Claude counted differently on its own.
  await composer.fill('Wat vind je van codeblok 3?')
  const [msgReq] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    composer.press('Enter'),
  ])
  const context = msgReq.postDataJSON().context
  expect(context).toContain('[Codeblok 1]')
  expect(context).toContain('[Suggestie 2]')
  expect(context).toContain('[Codeblok 3]')

  const fences = page.getByTestId('code-fence')
  await expect(fences).toHaveCount(4)

  // #1 — an ordinary ```sql fence: numbered, labelled with its own language.
  await expect(fences.nth(0)).toHaveAttribute('data-fence-index', '1')
  await expect(fences.nth(0)).toHaveAttribute('data-fence-lang', 'sql')
  await expect(fences.nth(0)).not.toHaveAttribute('data-fence-suggestion', 'true')
  await expect(fences.nth(0)).toContainText('Codeblok 1')
  await expect(fences.nth(0)).toContainText('sql')

  // #2 — a ```suggestion fence: its own distinct "Suggestie" label, no
  // language word, and a marker attribute a click-affordance could key off of
  // later (there is none today — see the doc section above).
  await expect(fences.nth(1)).toHaveAttribute('data-fence-index', '2')
  await expect(fences.nth(1)).toHaveAttribute('data-fence-suggestion', 'true')
  await expect(fences.nth(1)).toContainText('Suggestie 2')

  // #3 — a fence in the REPLY (a later message in the same thread): the
  // running count continues rather than resetting to 1 in the new bubble.
  await expect(fences.nth(2)).toHaveAttribute('data-fence-index', '3')
  await expect(fences.nth(2)).toHaveAttribute('data-fence-lang', 'bash')

  // #4 — a ```yaml fence: the grammar is vendored (src/vendor/prism.js), so it
  // is really tokenised, not shown as colourless escaped text like a language
  // Prism has no grammar for. Asserting a `.token` node is the only way to see
  // the difference — the badge/label look identical either way.
  await expect(fences.nth(3)).toHaveAttribute('data-fence-index', '4')
  await expect(fences.nth(3)).toHaveAttribute('data-fence-lang', 'yaml')
  await expect(fences.nth(3).locator('code .token').first()).toBeVisible()
})
