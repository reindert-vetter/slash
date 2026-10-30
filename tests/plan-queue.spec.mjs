import { test, expect, appReady } from './_fixtures.mjs'

// The "after the planning" queue (plan_queue.go, .claude/docs/plan-page.md):
// one click queues an action, the state is spelled out in words, the same
// button cancels it while it still waits. The page only sends a Signal — the
// tracker holds the intent — so the mock below plays the tracker's read model.
const KEY = 'QUEUE-1'

function planBody(queue, extra = {}) {
  return {
    ok: true,
    key: KEY,
    doc: {
      key: KEY,
      title: 'Queue me',
      description: 'desc',
      url: '',
      questions: [],
      tasks: [{ id: 't1', title: 'Een taak', explanation: 'Waarom', blocks: [] }],
      answers: [],
      error: '',
      chat: [],
      defaultsBase: true,
      baseBranch: 'develop',
      defaultBranch: 'develop',
      hotfixBranch: 'master',
      queue,
      ...extra,
    },
    runs: [{ runId: 'plan-' + KEY, workflow: 'plan', status: 'waiting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    generating: true,
  }
}

test('queues the execution while the planning is busy, shows it in words and cancels it', async ({ page }) => {
  let queue = []
  const signals = []
  await page.route('**/api/plan?*', (route) => route.fulfill({ json: planBody(queue) }))
  await page.route('**/api/workflows/plan-*/signals/*', (route) => {
    const body = route.request().postDataJSON()
    if (body.kind === 'queue') {
      signals.push(body)
      queue = body.topicOff ? [] : [{ action: body.text, status: 'queued' }]
    }
    route.fulfill({ json: { status: 'answered' } })
  })
  await page.goto('/plan/' + KEY)
  await appReady(page)

  const button = page.getByTestId('plan-execute-button')
  await expect(button).toContainText('Uitvoeren zodra de planning klaar is')
  await expect(page.getByTestId('plan-execute-status')).toContainText('nog niet uitgevoerd')

  await button.click()
  await expect.poll(() => signals.length).toBe(1)
  expect(signals[0]).toMatchObject({ kind: 'queue', text: 'execute', topicOff: false })
  await expect(page.getByTestId('plan-execute-status')).toContainText('in de wachtrij: start direct als de planning klaar is')
  await expect(page.getByTestId('plan-queue-hint')).toBeVisible()
  await expect(button).toContainText('Annuleren')

  await button.click()
  await expect.poll(() => signals.length).toBe(2)
  expect(signals[1]).toMatchObject({ kind: 'queue', text: 'execute', topicOff: true })
  await expect(page.getByTestId('plan-execute-status')).toContainText('nog niet uitgevoerd')
  await expect(page.getByTestId('plan-queue-hint')).toHaveCount(0)
})

test('the review chain shows its steps and a failed self-review reads "mislukt"', async ({ page }) => {
  const queue = [
    { action: 'execute', status: 'done', pr: 7 },
    { action: 'review', status: 'started' },
    { action: 'selfreview', status: 'failed', note: 'pushen is geweigerd' },
    { action: 'ingest', status: 'started' },
    { action: 'qa', status: 'queued' },
  ]
  await page.route('**/api/plan?*', (route) => route.fulfill({ json: planBody(queue, {}) }))
  await page.goto('/plan/' + KEY)
  await appReady(page)
  await expect(page.getByTestId('plan-queue-status-review')).toContainText('draait…')
  const self = page.getByTestId('plan-queue-step-selfreview')
  await expect(self).toContainText('mislukt')
  await expect(self).toContainText('pushen is geweigerd')
  await expect(page.getByTestId('plan-queue-step-ingest')).toContainText('draait…')
  await expect(page.getByTestId('plan-queue-toggle-review')).toBeDisabled()
})

test('the scope gate keeps the queue waiting, visibly', async ({ page }) => {
  await page.route('**/api/plan?*', (route) =>
    route.fulfill({
      json: planBody([{ action: 'execute', status: 'queued' }], {
        needsScope: true,
        tasks: [],
        subtasks: [{ key: 'QUEUE-2', title: 'Deel', status: 'To Do' }],
      }),
    }),
  )
  await page.goto('/plan/' + KEY)
  await appReady(page)
  await expect(page.getByTestId('plan-execute-status')).toContainText('wacht op jouw keuze: subtaak-scope')
})

test('a finished draft PR links to its review tree, with the PR number and its state in words', async ({ page }) => {
  let tree = { action: 'tree', status: 'started', pr: 4242 }
  await page.route('**/api/plan?*', (route) => {
    const body = planBody([{ action: 'execute', status: 'done', pr: 4242 }, tree], {})
    body.exec = { runId: 'r1', status: 'completed', prUrl: 'https://github.com/o/r/pull/4242', prNumber: 4242, branch: 'queue-1-x', base: 'develop' }
    route.fulfill({ json: body })
  })
  await page.goto('/plan/' + KEY)
  await appReady(page)
  const link = page.getByTestId('plan-execute-tree')
  await expect(link).toHaveAttribute('href', '/pr/4242')
  await expect(link).toContainText('Review-tree #4242 (wordt gegenereerd…)')
  tree = { action: 'tree', status: 'done', pr: 4242 }
  await page.reload()
  await appReady(page)
  await expect(page.getByTestId('plan-execute-tree')).toContainText('Review-tree #4242 (klaar)')
})
