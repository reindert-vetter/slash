import { test, expect, appReady, seededPr } from './_fixtures.mjs'

// The /qa/<pr> page (src/qa.mjs, .claude/docs/qa-page.md): a QA report of the
// qa_run workflow as columns that continue to the right, with a comments dock
// at the bottom scoped to the focused step. The report itself is mocked (a
// real qa_run drives a browser against the local admin); the comment is a
// real write through task_code_comment against the per-worker server.
const RUN = 'abcdef0123456789abcdef01'

function mockQA(page, pr) {
  return page.route(`**/api/qa?pr=${pr}*`, (route) =>
    route.fulfill({
      json: {
        ok: true,
        pr,
        rounds: [
          {
            runId: RUN,
            round: 1,
            status: 'completed',
            createdAt: '2026-10-08T10:00:00Z',
            updatedAt: '2026-10-08T10:30:00Z',
            result: {
              round: 1,
              report: {
                title: 'QA: gepauzeerd traject',
                kicker: `PR #${pr} · BUG-1`,
                headSha: '397d6f9',
                summary: 'Alles getest in de **lokale admin**.',
                deviations: ['Mailpit was niet bereikbaar; mails via de database gecontroleerd.'],
                scenarios: [{ name: 'Pauzeren', result: 'Geen mail', status: 'ok' }],
                groups: [{ id: 'r1', label: 'Ronde 1' }],
                steps: [
                  { group: 'r1', status: 'ok', eyebrow: 'Scenario 1', title: 'Pauzeren midden in het traject', body: 'Tag **Paused**.', images: [] },
                  { group: 'r1', status: 'warn', eyebrow: 'Bevinding', title: 'Cron een dag later', body: 'Zie tijd.', pre: 'cron 25-10 → niets', images: [] },
                ],
              },
            },
          },
        ],
      },
    }),
  )
}

test('steps are columns to the right, the comments dock follows the step, and the step survives a refresh', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockQA(page, pr)
  await page.goto(`/qa/${pr}`)
  await appReady(page)

  const overview = page.getByTestId('qa-overview')
  await expect(overview).toContainText('QA: gepauzeerd traject')
  // A deviation from the assignment is on the FIRST page, named in words.
  await expect(page.getByTestId('qa-deviations')).toContainText('Mailpit was niet bereikbaar')
  await expect(page.getByTestId('qa-step')).toHaveCount(2)
  await expect(page.getByTestId('qa-dock-title')).toContainText('Overzicht')

  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/[?&]step=1\b/)
  await expect(page.getByTestId('qa-dock-title')).toContainText('1. Pauzeren midden in het traject')

  // A local comment on step 1 lands in the dock of step 1 only.
  await page.getByTestId('qa-comment-compose').fill('Klopt het label?')
  const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
  await page.getByTestId('qa-comment-local').click()
  const posted = (await postPromise).postDataJSON()
  expect(posted.kind).toBe('issue')
  expect(posted.local).toBe(true)
  expect(posted.seg).toBe(`qa:${RUN}:1`)
  await expect(page.getByTestId('qa-comment')).toHaveCount(1)
  await expect(page.getByTestId('qa-comment')).toContainText('Klopt het label?')

  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('qa-dock-title')).toContainText('2. Cron een dag later')
  await expect(page.getByTestId('qa-comment')).toHaveCount(0)

  await page.reload()
  await appReady(page)
  await expect(page.getByTestId('qa-dock-title')).toContainText('2. Cron een dag later')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('qa-comment')).toHaveCount(1)
})

test('the Claude chat sits right of the comment thread, opens by itself, and a first message on an empty step makes a local anchor', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockQA(page, pr)
  // Never reach a real Claude turn: only the message Signal is intercepted.
  let sent = null
  await page.route('**/api/workflows/*/signals/message', (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto(`/qa/${pr}`)
  await appReady(page)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('qa-dock-title')).toContainText('1.')

  // No comment yet: the chat card is there anyway (no hint text instead).
  const chat = page.getByTestId('qa-chat')
  await expect(chat.getByTestId('claude-chat-compose')).toBeVisible()
  const anchorReq = page.waitForRequest((r) => r.url().includes('/api/workflows/task_code_comment') && r.method() === 'POST')
  await chat.getByTestId('claude-chat-compose').fill('Wat doet deze stap?')
  await chat.getByTestId('claude-chat-compose').press('Enter')
  const anchor = (await anchorReq).postDataJSON()
  expect(anchor.local).toBe(true)
  expect(anchor.body).toContain('gesprek met Claude gestart')
  expect(anchor.seg).toBe(`qa:${RUN}:1`)
  await expect.poll(() => sent && sent.body).toBe('Wat doet deze stap?')
  expect(sent.context).toContain('stap 1')
  // The bare placeholder has no row of its own.
  await expect(page.getByTestId('qa-comment')).toHaveCount(0)

  // A real comment on that step takes the placeholder over and publishes as a reply.
  await page.getByTestId('qa-comment-compose').fill('Echte comment')
  const replyReq = page.waitForRequest((r) => r.url().includes('/signals/reply'))
  await page.getByTestId('qa-comment-local').click()
  const reply = (await replyReq).postDataJSON()
  expect(reply.body).toContain('Echte comment')
  await expect(page.getByTestId('qa-comment')).toHaveCount(1)
  await expect(page.getByTestId('qa-comment')).toContainText('Echte comment')
  // The chat stays open on the same conversation, right of the thread.
  await expect(page.getByTestId('qa-chat').getByTestId('claude-chat-compose')).toBeVisible()
})
