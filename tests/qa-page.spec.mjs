import { test, expect, appReady, seededPr } from './_fixtures.mjs'

// The /qa/<pr> page (src/qa.mjs, .claude/docs/qa-page.md): a QA report of the
// qa_run workflow as a one-step-at-a-time stage (dot strip, ←/→, before/after
// pairs with mermaid diagrams), with a comments dock
// at the bottom scoped to the focused step — the review tree's own
// RelatedPanel comment + Claude block, with the tree's own menus. The report
// itself is mocked (a real qa_run drives a browser against the local admin);
// the comment is a real write through task_code_comment against the
// per-worker server.
const RUN = 'abcdef0123456789abcdef01'

function mockQA(page, pr, ...extraSteps) {
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
                  ...extraSteps,
                ],
              },
            },
          },
        ],
      },
    }),
  )
}

// placeLocal: Enter on the filled composer opens the QA compose menu; pick
// "Alleen voor mij" and return the task_code_comment POST body.
async function placeLocal(page, text) {
  await page.getByTestId('comment-compose').fill(text)
  await page.getByTestId('comment-compose').press('Enter')
  const rows = page.getByTestId('command-row')
  await expect(rows.filter({ hasText: 'Plaats op GitHub' })).toBeVisible()
  const req = page.waitForRequest((r) => r.method() === 'POST' && (r.url().includes('/api/workflows/task_code_comment') || r.url().includes('/signals/reply')))
  await rows.filter({ hasText: 'Alleen voor mij' }).click()
  return (await req).postDataJSON()
}

const comments = (page) => page.getByTestId('inline-comments').getByTestId('comment-item')

test('→ walks the steps on the stage, the comments dock follows the step, and the step survives a refresh', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockQA(page, pr)
  await page.goto(`/qa/${pr}`)
  await appReady(page)

  const overview = page.getByTestId('qa-overview')
  await expect(overview).toContainText('QA: gepauzeerd traject')
  // A deviation from the assignment is on the FIRST page, named in words.
  await expect(page.getByTestId('qa-deviations')).toContainText('Mailpit was niet bereikbaar')
  // One page at a time: the overview, no step yet; a dot per page.
  await expect(page.getByTestId('qa-step')).toHaveCount(0)
  await expect(page.getByTestId('qa-dot')).toHaveCount(3)
  await expect(page.getByTestId('qa-dock-title')).toContainText('Overzicht')

  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/[?&]step=1\b/)
  await expect(page.getByTestId('qa-dock-title')).toContainText('1. Pauzeren midden in het traject')

  // A local comment on step 1 lands in the dock of step 1 only.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('comment-compose')).toBeFocused()
  const posted = await placeLocal(page, 'Klopt het label?')
  expect(posted.kind).toBe('issue')
  expect(posted.local).toBe(true)
  expect(posted.gran).toBe('qa')
  expect(posted.seg).toBe(`qa:${RUN}:1`)
  expect(posted.body).toContain('QA ronde 1 · stap 1')
  // Placing hands the keyboard back to the columns (like the tree hands it
  // back to the diff); ↓ then lands on the new comment.
  await expect(comments(page)).toHaveCount(1)
  await expect(page.getByTestId('qa-dock')).toHaveAttribute('data-open', 'false')
  await page.keyboard.press('ArrowDown')
  await expect(comments(page)).toContainText('Klopt het label?')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()

  // The tree's own comment menu (Enter on an empty reply field).
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-row').filter({ hasText: 'Resolve comment' })).toBeVisible()
  await expect(page.getByTestId('command-row').filter({ hasText: 'Bewerk bericht' })).toBeVisible()
  await page.keyboard.press('Escape')

  for (let i = 0; i < 4 && (await page.getByTestId('qa-dock').getAttribute('data-open')) === 'true'; i++) await page.keyboard.press('Escape')
  await expect(page.getByTestId('qa-dock')).toHaveAttribute('data-open', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('qa-dock-title')).toContainText('2. Cron een dag later')
  await page.keyboard.press('ArrowDown')
  await expect(comments(page)).toHaveCount(0)

  await page.reload()
  await appReady(page)
  await expect(page.getByTestId('qa-dock-title')).toContainText('2. Cron een dag later')
  for (let i = 0; i < 4 && (await page.getByTestId('qa-dock').getAttribute('data-open')) === 'true'; i++) await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowDown')
  await expect(comments(page)).toHaveCount(1)
})

test('the Claude chat sits right of the comment thread; a first message on an empty step makes a local anchor carrying the step context', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockQA(page, pr)
  // Never reach a real Claude turn: only the message Signal is intercepted.
  let sent = null
  await page.route('**/api/workflows/*/signals/message', (route) => {
    const body = route.request().postDataJSON()
    if (body.body) sent = body
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto(`/qa/${pr}`)
  await appReady(page)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('qa-dock-title')).toContainText('1.')
  await page.keyboard.press('ArrowDown')

  // No comment yet: the composer and the Claude column sit side by side.
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeVisible()
  const anchorReq = page.waitForRequest((r) => r.url().includes('/api/workflows/task_code_comment') && r.method() === 'POST')
  await compose.fill('Wat doet deze stap?')
  await compose.press('Enter')
  const anchor = (await anchorReq).postDataJSON()
  expect(anchor.local).toBe(true)
  expect(anchor.kind).toBe('issue')
  expect(anchor.body).toContain('gesprek met Claude gestart')
  expect(anchor.seg).toBe(`qa:${RUN}:1`)
  await expect.poll(() => sent && sent.body).toBe('Wat doet deze stap?')
  expect(sent.context).toContain('stap 1')
  // The tree's Claude menu, with "Comment hiervan maken" on the bare anchor.
  await compose.focus()
  await compose.press('Enter')
  await expect(page.getByTestId('command-row').filter({ hasText: 'Wis Claude-gesprek' })).toBeVisible()
  await expect(page.getByTestId('command-row').filter({ hasText: 'Comment hiervan maken' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('the dock stays collapsed until ↓', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockQA(page, pr)
  let chatStarts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/workflows/claude_chat')) chatStarts++
  })
  await page.goto(`/qa/${pr}`)
  await appReady(page)

  const dock = page.getByTestId('qa-dock')
  const panel = dock.getByTestId('detail-panel')
  await expect(dock).toHaveAttribute('data-open', 'false')
  await expect(panel).toBeHidden()
  // Only the bar while collapsed.
  expect((await dock.boundingBox()).height).toBeLessThan(60)

  // Browsing the columns selects nothing and starts no chat.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('qa-dock-title')).toContainText('2.')
  await expect(panel).toBeHidden()

  // ↓ opens it on the new-comment composer of this step.
  await page.keyboard.press('ArrowDown')
  await expect(dock).toHaveAttribute('data-open', 'true')
  await expect(page.getByTestId('comment-compose')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  expect(chatStarts).toBe(0)

})

test('the header strip and ←/→ buttons navigate, and a before/after pair renders two mermaid diagrams', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockQA(page, pr, {
    group: 'r1',
    status: 'info',
    eyebrow: 'Backend',
    title: 'Wat verandert er',
    body: 'De flow.',
    images: [],
    compare: {
      before: { mermaid: 'flowchart LR\n  A[Hervatten] --> B[nu + 1 dag]', caption: 'Oud' },
      after: { mermaid: 'flowchart LR\n  A[Hervatten] --> B[morgen 00:00]' },
    },
  }, {
    group: 'r1',
    status: 'warn',
    title: 'Kapot diagram',
    images: [],
    compare: { after: { mermaid: 'this is not mermaid ((' } },
  })
  await page.goto(`/qa/${pr}`)
  await appReady(page)

  await expect(page.getByTestId('qa-prev')).toBeDisabled()
  await page.getByTestId('qa-next').click()
  await expect(page.getByTestId('qa-counter')).toHaveText('1 / 4')
  await expect(page.getByTestId('qa-step-title')).toHaveText('Pauzeren midden in het traject')
  // A dot jumps straight to its step; it carries the status glyph, not only a colour.
  const dot = page.getByTestId('qa-dot').nth(3)
  await expect(dot).toHaveText('i')
  await dot.click()
  await expect(page.getByTestId('qa-counter')).toHaveText('3 / 4')
  await expect(page.getByTestId('qa-dot').nth(3)).toHaveAttribute('data-current', 'true')

  const cmp = page.getByTestId('qa-compare')
  await expect(cmp.getByTestId('qa-compare-side')).toHaveCount(2)
  await expect(cmp.locator('[data-side=before] figcaption')).toHaveText('Voorheen')
  await expect(cmp.locator('[data-side=after] figcaption')).toHaveText('Nu')
  await expect(cmp.getByTestId('qa-diagram').locator('svg')).toHaveCount(2)
  await expect(cmp.locator('[data-side=after]')).toContainText('morgen 00:00')

  // A diagram that does not parse says so in words and shows its source.
  await page.keyboard.press('ArrowRight')
  const side = page.getByTestId('qa-compare')
  await expect(side.locator('[data-side=before]')).toContainText('Bestond nog niet')
  await expect(side.getByTestId('qa-diagram-error')).toBeVisible()
  await expect(side).toContainText('this is not mermaid')
  await expect(page.getByTestId('qa-next')).toBeDisabled()
})
