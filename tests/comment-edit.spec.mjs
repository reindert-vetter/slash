import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// Editing an own already-placed message: reachable via the Enter command
// palette's "Bewerk bericht" item (never primarily a hover-only affordance —
// see .claude/docs/comments-panel.md, "Editing an own message"), for both the
// root/opening message and a later reply. A click on the reaction's own edit
// pencil runs the exact same function (mouse-navigation.md's "click runs the
// same function a key runs").
test.describe('PR Review Tree — editing an own message', () => {
  async function seedComment(page, pr, body) {
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    return runId
  }

  test('Enter → "Bewerk bericht" edits the root comment\'s own body', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'oorspronkelijke-tekst ' + Math.random().toString(36).slice(2)
    const runId = await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    await expect(page.getByTestId('reaction-compose')).toBeFocused()
    await page.keyboard.press('Enter')

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Bewerk bericht')
    await menu.getByTestId('command-row').filter({ hasText: 'Bewerk bericht' }).click()
    await expect(menu).not.toBeVisible()

    const editor = page.getByTestId('message-edit-compose')
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(body)

    const newBody = 'bijgewerkte-tekst ' + Math.random().toString(36).slice(2)
    await editor.fill(newBody)
    await page.getByTestId('message-edit-save').click()

    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)
    await expect(page.getByTestId('reaction-bubble').first()).toContainText(newBody)
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + pr)).json()
        const c = list.find((x) => x.id === runId)
        return c && c.body
      })
      .toBe(newBody)
  })

  test('Enter → "Bewerk bericht" on a stepped-into reply edits that reply, not the root', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const rootBody = 'root-bericht ' + Math.random().toString(36).slice(2)
    const runId = await seedComment(page, pr, rootBody)

    // A UI reply — the reviewer's own, so it's also editable.
    await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'reviewer', body: 'oorspronkelijke-reactie', done: false },
    })

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: rootBody })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByTestId('reaction-bubble')).toHaveCount(2)

    // Step into the thread (↑) and walk to the newest bubble (the reply).
    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.press('ArrowUp')
    await expect(page.getByTestId('reaction-bubble').nth(1)).toHaveClass(/ring-indigo-400/)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await menu.getByTestId('command-row').filter({ hasText: 'Bewerk bericht' }).click()

    const editor = page.getByTestId('message-edit-compose')
    await expect(editor).toHaveValue('oorspronkelijke-reactie')
    await editor.fill('bijgewerkte-reactie')
    await page.getByTestId('message-edit-save').click()

    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)
    await expect(page.getByTestId('reaction-bubble').nth(1)).toContainText('bijgewerkte-reactie')
    // The root's own body must be untouched.
    await expect(page.getByTestId('reaction-bubble').nth(0)).toContainText(rootBody)
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=' + pr)).json()
        const c = list.find((x) => x.id === runId)
        return c && c.reactions && c.reactions[0] && c.reactions[0].body
      })
      .toBe('bijgewerkte-reactie')
  })

  test('a click on a bubble\'s own edit pencil opens the same editor as the palette item', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'klik-om-te-bewerken ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    await page.getByTestId('reaction-edit').first().click()
    await expect(page.getByTestId('message-edit-compose')).toBeFocused()
    await expect(page.getByTestId('message-edit-compose')).toHaveValue(body)

    await page.getByTestId('message-edit-cancel').click()
    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)
    await expect(page.getByTestId('reaction-bubble').first()).toContainText(body)
  })

  test('Escape while editing a block-scoped message cancels the edit and hands the keyboard back to the block', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'blok-comment ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    await page.getByTestId('reaction-edit').first().click()
    const editor = page.getByTestId('message-edit-compose')
    await expect(editor).toBeFocused()
    await editor.fill('deze-tekst-mag-niet-blijven-staan')

    await page.keyboard.press('Escape')

    // The edit is discarded, not saved.
    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)

    // The keyboard is handed back to the block (exitRelated → cs.focus =
    // null), so the conversation collapses back to its compact,
    // not-currently-focused form — it no longer renders the expanded thread's
    // reaction-bubble list at all.
    await expect(page.getByTestId('reaction-bubble')).toHaveCount(0)
    await expect(row).toHaveAttribute('data-expanded', 'false')
    await expect(row).toContainText(body)
  })

  test('Enter while editing a block-scoped message saves the edit without opening the action menu', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'enter-om-op-te-slaan ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    await page.getByTestId('reaction-edit').first().click()
    const editor = page.getByTestId('message-edit-compose')
    await expect(editor).toBeFocused()
    const newBody = 'bijgewerkt-met-enter ' + Math.random().toString(36).slice(2)
    await editor.fill(newBody)

    await page.keyboard.press('Enter')

    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)
    await expect(page.getByTestId('reaction-bubble').first()).toContainText(newBody)
    // The keydown must not bubble into onKeydown's Enter-opens-menu branch.
    await expect(page.getByTestId('command-menu')).toHaveCount(0)
  })

  test('Escape while editing a comment-index item\'s message releases the thread cursor back to the row', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'pr-wide-comment ' + Math.random().toString(36).slice(2)
    const start = await page.request.post('/api/workflows/task_code_comment', {
      // kind:'issue' (not file:'') is what makes this a PR-wide "Start" row
      // (recomputeLeftList/prWideComments filter on kind !== '') — file/line
      // still need real values to pass the backend's validation.
      data: { pr, file: 'test.php', line: 1, kind: 'issue', author: 'reviewer', body },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    // A UI reply, so the thread has more than just the root message to walk.
    await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'reviewer', body: 'een-reactie', done: false },
    })

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.locator('[data-testid=block-row]').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    // Step into the thread and walk up to the reply (the newest message).
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('reaction-bubble')).toHaveCount(2)

    await page.getByTestId('reaction-edit').nth(1).click()
    const editor = page.getByTestId('message-edit-compose')
    await expect(editor).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)

    // The thread cursor (pct) is released: ArrowDown now moves the sidebar
    // cursor along the ordinary block-index loop instead of walking the
    // (now exited) thread again. This comment (kind:'issue', open, not an AI
    // finding) is comment_batch-eligible, so the loop's next stop is the
    // batch-action row (state.batchRowFocused, see stepListSelection in
    // home.mjs) rather than the search box straight away.
    await page.keyboard.press('ArrowDown')
    const batchRow = page.getByTestId('batch-action-row')
    await expect(batchRow).toHaveClass(/bg-indigo-50/)

    // One more step reaches the search box — the loop's final stop, since
    // there's nothing else below the batch row here.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('block-search')).toBeFocused()
  })

  test('Shift+Enter while editing a message inserts a newline instead of opening the action menu', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const body = 'meerdere-regels ' + Math.random().toString(36).slice(2)
    await seedComment(page, pr, body)

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const row = page.getByTestId('comment-item').filter({ hasText: body })
    await expect(row).toBeVisible()
    await row.click()

    await page.getByTestId('reaction-edit').first().click()
    const editor = page.getByTestId('message-edit-compose')
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(body)

    await editor.press('End')
    await editor.press('Shift+Enter')
    await page.keyboard.type('tweede-regel')

    // The menu must NOT have opened — the reply field being empty (a
    // different element from the edit textarea) used to make Shift+Enter
    // match the same branch a bare Enter uses to open it.
    await expect(page.getByTestId('command-menu')).toHaveCount(0)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(body + '\ntweede-regel')

    // The edit is still fully functional afterwards — saving persists the
    // multi-line body.
    await page.getByTestId('message-edit-save').click()
    await expect(page.getByTestId('message-edit-compose')).toHaveCount(0)
    await expect(page.getByTestId('reaction-bubble').first()).toContainText('tweede-regel')
  })
})
