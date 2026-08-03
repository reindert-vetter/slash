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
})
