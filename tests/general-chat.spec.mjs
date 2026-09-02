import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// The general (PR-wide, code-less) chat — reviewer request: "hier wil ik een
// algemene chat kunnen starten, net zo werken als chat op regel. het moet dan
// ook los in de blokken index komen zonder dat het gekoppeld is aan code",
// shown as an overlay over everything ("esc moet alles weer hidden"), one per
// PR, reachable from `/` anywhere. See "The general chat" in
// .claude/docs/claude-chat-panel.md and "`/` always opens the PR menu" in
// .claude/docs/command-palette.md.
//
// Real writes against the per-worker server/DB (like prwide-comment.spec.mjs):
// the anchor really is created through the ordinary task_code_comment
// workflow, so this also pins its shape — PR-wide (kind "issue", no file) and
// local, i.e. never posted to GitHub.
const ANCHOR_BODY = '(Nog geen eigen comment getypt — gesprek met Claude gestart.)'

test('`/` + a no-match query starts the one general chat, in an overlay, with its own index row', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)

  // `/` opens the PR menu even with a block selected (no ArrowLeft first).
  await page.keyboard.press('/')
  await expect(page.getByTestId('command-menu')).toBeVisible()
  const rows = page.getByTestId('command-row')
  await expect(rows.filter({ hasText: 'Chat met Claude over deze PR' })).toHaveCount(1)

  // A query no PR command matches falls back to the general chat instead of
  // "Geen commando's." — the reported dead end.
  await page.getByTestId('command-input').fill('fix tests in pr')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Chat over deze PR')

  const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
  await page.keyboard.press('Enter')

  // The anchor: PR-wide, no file, invisible-as-a-comment placeholder body,
  // and local so nothing ever reaches GitHub.
  const posted = (await postPromise).postDataJSON()
  expect(posted.kind).toBe('issue')
  expect(posted.file).toBe('')
  expect(posted.local).toBe(true)
  expect(posted.body).toBe(ANCHOR_BODY)

  // The overlay is the surface: the chat card plus the code-preview column
  // to its right.
  const overlay = page.getByTestId('general-chat-overlay')
  await expect(overlay).toBeVisible()
  await expect(page.getByTestId('general-chat-card')).toBeVisible()
  await expect(page.getByTestId('general-chat-previews')).toBeAttached()

  // The typed text is SENT straight away as the conversation's first turn —
  // the same thing "Chat over deze regel" does for a code line, not a
  // prefilled composer waiting for a second Enter.
  // (the offline claude stub echoes the prompt back, so don't pin a count)
  await expect(page.getByTestId('claude-message').filter({ hasText: 'fix tests in pr' }).first()).toBeVisible()

  // Escape hides everything again; the conversation itself stays.
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()

  // …as its own row in the block index, under "Openstaande chats", named for
  // what it is instead of showing the placeholder sentence.
  const row = page.getByTestId('block-row').filter({ hasText: 'Algemene chat' })
  await expect(row).toHaveCount(1)
  await expect(page.getByTestId('open-chats-heading')).toBeVisible()
  await expect(row).not.toContainText('Nog geen eigen comment')

  // → on that row reopens the same overlay (one surface, one conversation).
  await row.click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight')
  await expect(overlay).toBeVisible()

  // Still exactly one general chat: starting it again reuses the anchor.
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
  await page.keyboard.press('/')
  await page.getByTestId('command-row').filter({ hasText: 'Chat met Claude over deze PR' }).click()
  await expect(overlay).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('block-row').filter({ hasText: 'Algemene chat' })).toHaveCount(1)
})

// A running turn must show live progress in the overlay too — the same
// shared status line the per-line chat shows below its own columns
// (CommentClaudeFooter, RelatedPanel.mjs). Reported bug: the overlay showed
// the reviewer's own message and then an empty column down to the composer,
// with no "Claude denkt na…"/tool status anywhere while a turn was running.
// Mirrors tests/claude-chat-progress.spec.mjs's mocked-SSE approach exactly,
// just against the general (PR-wide, code-less) anchor instead of a
// code-anchored comment.
test('general chat overlay: a running turn shows the shared live status line', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: '', line: 0, author: 'reviewer', body: ANCHOR_BODY, kind: 'issue', local: true },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const frame = (data) => `data: ${JSON.stringify(data)}\n\n`
  const progress = (extra) => ({
    type: 'chat.progress',
    pr,
    key: conversationId,
    seq: 1,
    data: { running: true, startedAt: Date.now() - 3000, updatedAt: Date.now(), ...extra },
  })

  let connections = 0
  await page.route('**/api/events*', async (route) => {
    connections++
    const body =
      connections === 1
        ? 'retry: 300\n\n'
        : 'retry: 300\n\n' + frame(progress({ phase: 'tool', tool: 'Read', detail: 'src/Order.php' }))
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    })
  })
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )

  await page.goto('/pr/' + pr)
  await expect(page.getByTestId('block-row').filter({ hasText: 'Algemene chat' })).toBeVisible()
  await leaveSearchBox(page)

  await page.keyboard.press('/')
  await page.getByTestId('command-row').filter({ hasText: 'Chat met Claude over deze PR' }).click()

  const overlay = page.getByTestId('general-chat-overlay')
  await expect(overlay).toBeVisible()

  // Scoped to the overlay's own card: the same status also shows in the
  // tree's own (now hidden, but still mounted) comment-claude-row for this
  // conversation, so a bare page-wide getByTestId matches twice.
  const status = page.getByTestId('general-chat-card').getByTestId('claude-chat-status')
  await expect(status).toBeVisible()
  await expect(status).toContainText('src/Order.php')
  await expect(status).toContainText(/\d+s/)

  // Stop button lives in the same footer, next to the status text.
  await expect(page.getByTestId('general-chat-card').getByTestId('claude-chat-cancel')).toBeVisible()
})
