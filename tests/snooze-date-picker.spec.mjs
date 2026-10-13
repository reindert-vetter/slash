import { test, expect, seededPr, appReady } from './_fixtures.mjs'

// Every snooze menu has a date picker below its fixed moments
// (src/SnoozeDatePicker.mjs) — Reindert: "ik wil bij snoozen (overal) ook een
// date picker hebben". The picked moment travels as option "at:<ISO>".

// A local datetime-local value N days out at 09:30.
function pickValue(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T09:30'
}

test.describe('snooze date picker', () => {
  test.afterEach(async ({ page }) => {
    const res = await page.request.post('/api/workflows/pr_snooze')
    const { runId } = await res.json()
    await page.request.post('/api/workflows/' + runId + '/signals/pr_snooze', { data: { pr: 12888, option: 'clear' } })
  })

  test('a PR snoozed to a picked moment lands in "Gesnoozed" with that moment', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)
    const inSection = page.locator('[data-testid="section"][data-title="Needs your review"] [data-testid="pr-row"][data-pr="12888"]')
    await inSection.click()
    const popover = page.locator('[data-testid="pr-popover"]')
    await popover.locator('[data-testid="snooze-pr"]').click()

    const input = popover.locator('[data-testid="snooze-date-input"]')
    await input.fill(pickValue(10))
    // The field keeps its own arrow keys; the popover stays open around it.
    await input.focus()
    await page.keyboard.press('ArrowDown')
    await expect(input).toBeFocused()
    await input.fill(pickValue(10))
    // A moment in the past cannot be confirmed.
    await input.fill('2020-01-01T08:00')
    await expect(popover.locator('[data-testid="snooze-date-confirm"]')).toBeDisabled()
    await input.fill(pickValue(10))

    const sig = page.waitForRequest((r) => r.url().includes('/signals/pr_snooze') && r.method() === 'POST')
    await popover.locator('[data-testid="snooze-date-confirm"]').click()
    const body = JSON.parse((await sig).postData())
    expect(body.option).toMatch(/^at:\d{4}-\d{2}-\d{2}T/)

    await expect(inSection).toHaveCount(0)
    // Durable, and the server kept the picked moment itself.
    await page.reload()
    await appReady(page)
    await page.locator('[data-testid="snoozed-toggle"]').click()
    const row = page.locator('[data-testid="snoozed-section"] [data-testid="pr-row"][data-pr="12888"]')
    await expect(row.locator('[data-testid="snooze-mark"]')).toContainText('09:30')
  })

  test('a bell row and the reminder composer both offer the picker', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const feed = { items: [], snoozed: [] }
    await page.route('**/api/jira/notifications', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: 'fake-run', ...feed }) }),
    )
    await page.route('**/api/workflows/jira_inbox', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: 'fake-run' }) }),
    )
    const signals = []
    await page.route('**/signals/jira_notify', async (route) => {
      const sig = JSON.parse(route.request().postData() || '{}')
      signals.push(sig)
      if (sig.kind === 'reminder_add') {
        feed.items = [{ id: 'rem:1', kind: 'reminder', at: new Date().toISOString(), title: sig.text, unread: true }]
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    await page.goto('/pr/' + pr)
    await appReady(page)
    const url = page.url()

    await page.locator('[data-testid="jira-bell-button"]').click()
    await page.locator('[data-testid="reminder-add"]').click()
    await page.locator('[data-testid="reminder-text"]').fill('deploy checken')
    await page.locator('[data-testid="reminder-option"][data-option="now"]').click()
    await expect(page.locator('[data-testid="reminder-row"]')).toContainText('deploy checken')

    await page.locator('[data-testid="reminder-row"] [data-testid="notify-snooze"]').click()
    const input = page.locator('[data-testid="notify-snooze-date-input"]')
    await input.click()
    await input.fill(pickValue(3))
    await page.locator('[data-testid="notify-snooze-date-confirm"]').click()
    await expect(page.locator('[data-testid="reminder-row"]')).toHaveCount(0)
    expect(page.url()).toBe(url)

    await page.locator('[data-testid="reminder-add"]').click()
    await page.locator('[data-testid="reminder-text"]').fill('later kijken')
    await page.locator('[data-testid="reminder-date-input"]').fill(pickValue(5))
    await page.locator('[data-testid="reminder-date-confirm"]').click()

    await expect.poll(() => signals.map((s) => s.kind + ':' + (s.option || '').slice(0, 3))).toEqual([
      'reminder_add:now',
      'snooze:at:',
      'reminder_add:at:',
    ])
  })

  // A Jira row is an <a>: clicking into the picker must not follow the link.
  test('the picker inside a Jira row of the overview bell never opens the row', async ({ page, context }) => {
    await page.route('**/api/jira/notifications', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          runId: 'fake-run',
          items: [{ id: '1', at: new Date().toISOString(), title: 'X', issueKey: 'AB-1', actor: 'A', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-1', unread: true }],
        }),
      }),
    )
    await page.route('**/api/workflows/jira_inbox', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: 'fake-run' }) }),
    )
    const signals = []
    await page.route('**/signals/jira_notify', async (route) => {
      signals.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    let popups = 0
    context.on('page', () => popups++)
    await page.goto('/pr-overview')
    await appReady(page)
    const url = page.url()
    await page.locator('[data-testid="jira-bell-button"]').click()
    await page.locator('[data-testid="jira-row"] [data-testid="notify-snooze"]').click()
    const input = page.locator('[data-testid="notify-snooze-date-input"]')
    await input.click()
    await input.fill(pickValue(2))
    await page.locator('[data-testid="notify-snooze-date-confirm"]').click()
    await expect.poll(() => signals.map((s) => s.kind + ':' + (s.option || '').slice(0, 3))).toEqual(['snooze:at:'])
    expect(page.url()).toBe(url)
    expect(popups).toBe(0)
  })
})
