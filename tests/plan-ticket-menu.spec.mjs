import { test, expect, appReady } from './_fixtures.mjs'

// Enter on the ticket/description column (stop 0 of /plan/<KEY>) opens a small
// command menu — reviewer request: "enter op pr description blok moet een
// menu geven om bijvoorbeeld jira ticket te kunnen openen". Mirrors the review
// tree's own "Enter at stop 1 opens the PR-wide menu" rule (CommandMenu.mjs,
// reused as-is), at the scale this page actually needs: no submenus, just
// "Open in Jira" and "Terug naar overzicht". See .claude/docs/plan-page.md.
test.describe('Plan page — Enter-menu on the ticket column', () => {
  test('Enter opens the menu, ↓ + Enter opens Jira, Escape closes it', async ({ page }) => {
    await page.goto('/plan/TEST-1')
    await appReady(page)

    // Stub window.open instead of letting a real popup navigate to the real
    // atlassian.net host — this sandboxed suite must never depend on (or
    // wait on) outside network access.
    await page.evaluate(() => {
      window.__openedUrl = null
      window.open = (url) => {
        window.__openedUrl = url
        return null
      }
    })

    const ticket = page.getByTestId('plan-ticket-card')
    await expect(ticket).toBeVisible()
    // The page starts with column 1 (questions) focused, not the ticket
    // column — click it first, exactly like a reviewer would.
    await ticket.click()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-row')).toContainText(['Sluit menu', 'Open in Jira', 'Terug naar overzicht'])

    // The menu opens on the 2nd row (the pinned "Sluit menu" is never the
    // default Enter action) — same convention as the review tree's own
    // command palette.
    const jiraRow = page.getByTestId('command-row').nth(1)
    await expect(jiraRow).toContainText('Open in Jira')

    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect.poll(() => page.evaluate(() => window.__openedUrl)).toContain('TEST-1')
  })

  test('Escape closes the menu without navigating', async ({ page }) => {
    await page.goto('/plan/TEST-2')
    await appReady(page)

    await page.getByTestId('plan-ticket-card').click()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-menu')).toBeHidden()
    // The ticket column still owns the keyboard — a second Enter reopens it.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
  })

  test('the mouse entry point (plan-menu-button) opens the same menu', async ({ page }) => {
    await page.goto('/plan/TEST-3')
    await appReady(page)
    await page.getByTestId('plan-menu-button').click()
    await expect(page.getByTestId('command-menu')).toBeVisible()
  })
})
