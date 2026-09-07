import { test, expect, appReady } from './_fixtures.mjs'

// The Jira-comments panel at the top of the questions index (task 23b, see
// .claude/docs/plan-page.md, "Jira-opmerkingen: lezen, beantwoorden,
// @-mentions") — the frontend half of what commit 751b490 built on the
// backend (GET /api/jira/comments, GET /api/jira/users, the jira_comment
// workflow). The harness runs with SLASH_JIRA=off (no acli calls, see
// tests/_fixtures.mjs), so the Fake jira client answers a zero-value,
// comment-less issue for any (unprogrammed) key — this only smoke-tests the
// READ path and the panel's own wiring. Whether canPost/canMention read true
// or false here depends on whether SLASH_JIRA_EMAIL/SLASH_JIRA_TOKEN happen
// to be set in the ambient environment the test runner inherits (a real
// token unlocks the reply/mention UI even under SLASH_JIRA=off, since that
// only skips `acli`, not the token-configured check) — deliberately not
// asserted either way here. The reply composer/mention picker were verified
// by hand against the real Jira integration instead (see the task's own
// report).
test.describe('Plan page — Jira comments panel', () => {
  test('renders at the top of the questions index', async ({ page }) => {
    await page.goto('/plan/TEST-801')
    await appReady(page)

    const panel = page.getByTestId('plan-comments-panel')
    await expect(panel).toBeVisible()
    // Sits above the questions column's own question cards.
    await expect(page.getByTestId('plan-questions-column')).toContainText('Jira-opmerkingen')

    const group = page.getByTestId('plan-comment-group')
    await expect(group).toBeVisible()
    await expect(group).toContainText('TEST-801')
    await expect(group).toContainText('dit ticket')
    await expect(group).toContainText('geen opmerkingen')
  })

  test('the "Ververs" button re-reads the panel without throwing', async ({ page }) => {
    await page.goto('/plan/TEST-802')
    await appReady(page)

    const refresh = page.getByTestId('plan-comments-refresh')
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(page.getByTestId('plan-comment-group')).toContainText('TEST-802')
  })
})
