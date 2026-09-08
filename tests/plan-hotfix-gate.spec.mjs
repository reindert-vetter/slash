import { test, expect, appReady } from './_fixtures.mjs'

// Regression for a reviewer-reported bug: "er zijn nu 2 dingen geselecteerd,
// vreemd" — while the hotfix/base-branch gate stands (needsHotfix), the
// Jira-opmerkingen block AND one of the branch-choice rows both showed a
// selection ring at once.
//
// Root cause: hotfixCard() used to map ALL of navRows() through hotfixRow(),
// instead of filtering to `kind === 'hotfix'` the way scopeCard() already
// filters to `kind === 'scope'`. navRows() always puts the Jira-comments row
// (COMMENTS_ROW_ID) first, even while the hotfix gate stands, so that row
// rendered a SECOND time as a phantom hotfix option — hotfixRow falls back to
// its "Vanaf een andere branch…" label for an unset `target` — and because
// its id was literally COMMENTS_ROW_ID (the real default cursor), it also lit
// up with the same ring as the real Jira-opmerkingen block.
//
// This mocks both GET /api/plan (a doc parked on the hotfix gate) and
// GET /api/jira/comments (a non-empty comment list) directly at the HTTP
// layer — the same seam plan-comments.spec.mjs already uses — rather than
// driving the real plan_workflow.go gate, which needs a "bug" issue type and
// a live Claude generation to reach this state.
test.describe('Plan page — hotfix gate does not duplicate the comments row', () => {
  test('only the comments block, never a branch row, shows the block-level ring', async ({ page }) => {
    await page.route('**/api/jira/comments*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          groups: [
            {
              key: 'TEST-905',
              title: 'Hotfix-gate test ticket',
              relation: 'self',
              comments: [{ id: 'c1', author: 'Alice', created: '2026-01-01T10:00:00Z', body: 'Een opmerking' }],
            },
          ],
          canPost: false,
          canMention: false,
        },
      }),
    )
    await page.route('**/api/plan?key=*', (route) =>
      route.fulfill({
        json: {
          ok: true,
          doc: {
            key: 'TEST-905',
            title: 'Hotfix-gate test ticket',
            description: '',
            url: '',
            questions: [],
            tasks: [],
            answers: [],
            error: '',
            chat: [],
            needsHotfix: true,
            defaultBranch: 'develop',
            hotfixBranch: 'master',
          },
          runs: [],
          generating: false,
        },
      }),
    )

    await page.goto('/plan/TEST-905')
    await appReady(page)

    // The hotfix card shows exactly its three real choices — never a fourth,
    // phantom row for the comments block.
    const hotfixOptions = page.getByTestId('plan-hotfix-option')
    await expect(hotfixOptions).toHaveCount(3)
    await expect(page.getByTestId('plan-hotfix')).not.toContainText('Jira-opmerkingen')

    // The default cursor lands on the comments block (rows[0] of navRows()),
    // and it alone carries the "blok geselecteerd" ring.
    await expect(page.getByTestId('plan-comments-state')).toHaveText('◆ blok geselecteerd')
    await expect(page.getByTestId('plan-comments-panel')).toHaveAttribute('data-cursor', 'true')

    // None of the three real hotfix rows is ALSO marked as the cursor.
    for (let i = 0; i < 3; i++) {
      await expect(hotfixOptions.nth(i)).toHaveAttribute('data-cursor', 'false')
    }
  })
})
