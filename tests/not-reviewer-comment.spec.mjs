import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A new inline comment on a PR where the reviewer is not a reviewer yet first
// asks (menu mode 'notReviewer', home.mjs's NOT_REVIEWER_COMMANDS): GitHub
// turns an inline comment into a COMMENTED review, which lists its author
// under Reviewers for good. "Plaats toch inline" is the default; the PR-wide
// item posts the same text with Kind "issue" and its file:line on top. See
// "Placing an inline comment on a PR you don't review" in
// .claude/docs/comments-panel.md. /api/reviewer-status is mocked (the harness
// runs with SLASH_GITHUB=off, where it answers {ok:false} and nothing asks).
async function setup(page, reviewer) {
  await page.route('**/api/reviewer-status**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, reviewer }) }),
  )
  const posted = []
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('mijn comment')
  return posted
}

test('not a reviewer: Enter asks first, and Enter again posts inline (the default)', async ({ page }) => {
  const posted = await setup(page, false)
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('command-row').nth(1)).toContainText('Plaats toch inline')
  expect(posted).toHaveLength(0) // held until the reviewer chooses
  await page.keyboard.press('Enter')
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0].file).not.toBe('')
  expect(posted[0].kind || '').toBe('')
  expect(posted[0].body).toBe('mijn comment')
})

test('not a reviewer: "algemene comment" posts PR-wide with the location on top', async ({ page }) => {
  const posted = await setup(page, false)
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Plaats als algemene comment' }).click()
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0].kind).toBe('issue')
  expect(posted[0].file).toBe('')
  expect(posted[0].body).toMatch(/^`[^`]+:\d+(-\d+)?`\n\nmijn comment$/)
})

test('already a reviewer: Enter posts straight away, no question', async ({ page }) => {
  const posted = await setup(page, true)
  await page.keyboard.press('Enter')
  await expect.poll(() => posted.length).toBe(1)
  await expect(page.getByTestId('command-menu')).toHaveCount(0)
  expect(posted[0].kind || '').toBe('')
})

// Publishing a still-local inline thread through the replyPublish menu also
// creates a new inline comment on GitHub, so on a PR the reviewer doesn't
// review that menu says so and offers to post only the reply PR-wide instead.
test('not a reviewer: the replyPublish menu offers the reply as a general comment', async ({ page }) => {
  await page.route('**/api/reviewer-status**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"reviewer":false}' }),
  )
  await page.goto('/pr/12903')
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const aiBody = 'deze aanroep valideert de invoer niet meer'
  const seeded = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file: fileLine.split(':')[0], line: 1, author: 'AI check', body: aiBody, source: 'ai', local: true, label, gran: 'group', rowStart: 0, rowEnd: 0 },
  })
  expect(seeded.ok()).toBeTruthy()
  await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
  await expect(card.locator('h2').first()).toHaveText(label)

  const posted = []
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })
  const row = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: aiBody })
  await row.click()
  const field = page.getByTestId('reaction-compose')
  await expect(field).toBeFocused()
  await field.fill('mijn antwoord')
  await field.press('Enter')
  const rows = page.getByTestId('command-menu').getByTestId('command-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(1)).toContainText('Alleen mijn antwoord op GitHub (je wordt reviewer)')
  await rows.nth(3).click()
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0].kind).toBe('issue')
  expect(posted[0].body).toMatch(/^`[^`]+:1`\n\nmijn antwoord$/)
})

// "Zet op GitHub" from the comment menu (empty reply field) publishes a local
// inline thread the same way, so it asks too: inline (default, "je wordt
// reviewer") or as a general comment, after which the local thread is removed
// through the ordinary delete Signal. Everything is mocked, nothing hits GitHub.
test('not a reviewer: "Zet op GitHub" offers a general comment and then deletes the local thread', async ({ page }) => {
  await page.route('**/api/reviewer-status**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"reviewer":false}' }),
  )
  await page.goto('/pr/12903')
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const body = 'lokale inline thread zonder antwoord'
  const seeded = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file: fileLine.split(':')[0], line: 1, author: 'reviewer', body, local: true, label, gran: 'group', rowStart: 0, rowEnd: 0 },
  })
  expect(seeded.ok()).toBeTruthy()
  await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
  await expect(card.locator('h2').first()).toHaveText(label)

  const posted = []
  const deleted = []
  const published = []
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })
  await page.route('**/api/workflows/*/signals/delete', async (route) => {
    deleted.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await page.route('**/api/workflows/*/signals/reply', async (route) => {
    published.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  const row = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body })
  await row.click()
  const field = page.getByTestId('reaction-compose')
  await expect(field).toBeFocused()
  await field.press('Enter') // empty -> comment menu
  const menu = page.getByTestId('command-menu')
  await menu.getByTestId('command-row').filter({ hasText: 'Zet op GitHub' }).click()
  const rows = menu.getByTestId('command-row')
  await expect(rows.nth(1)).toContainText('(je wordt reviewer)')
  await rows.filter({ hasText: 'als algemene comment' }).click()
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0].kind).toBe('issue')
  expect(posted[0].file).toBe('')
  expect(posted[0].body).toMatch(/^`[^`]+:1`\n\nlokale inline thread zonder antwoord$/)
  await expect.poll(() => deleted.length).toBe(1)
  expect(published).toHaveLength(0)
})
