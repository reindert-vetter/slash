import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// openPrInfo walks left until the PR-info column (stop 1) is on screen — the
// number of ← steps depends on where the cursor currently is (list vs diff).
async function openPrInfo(page) {
  for (let i = 0; i < 4; i++) {
    if (await page.getByTestId('pr-info-column').isVisible().catch(() => false)) return
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(150)
  }
  await expect(page.getByTestId('pr-info-column')).toBeVisible()
}

// "Live AI assistent uit" silences every automatic Claude call the review
// tree makes on its own — not just the code_warning risk check but also the
// footer's AI description (explain_code): "als dat uit staat, ook geen live
// descriptions toevoegen aan geselecteerde dingen". Uses PR 97, whose
// explanations are pre-seeded (tests/fixtures/explanations.json), so this
// asserts the DISPLAY is suppressed as well, not merely the request — the
// switch should read as "the assistant is quiet", not "quiet from now on".
//
// Restores the toggle before it ends: a worker's DB outlives the test (see
// .claude/docs/testing-playwright.md).
test('with the Live AI assistent off, no footer description is shown or requested', async ({ page }) => {
  await page.goto('/pr/97')
  await expect(page.getByTestId('block-row').first()).toContainText('ExplainAction::execute')
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight')

  const description = page.getByTestId('footer').getByTestId('footer-description')
  await expect(description).toBeVisible()

  // Turn the switch off from the PR-info column (stop 1, same ← as
  // tests/theme.spec.mjs / auto-warn-toggle.spec.mjs).
  const explainRequests = []
  page.on('request', (req) => {
    if (req.url().includes('/api/workflows/explain_code')) explainRequests.push(req.url())
  })
  await openPrInfo(page)
  const toggle = page.getByTestId('auto-warn-toggle')
  await expect(toggle).toHaveText(/Live AI assistent aan/)
  await toggle.click()
  await expect(toggle).toHaveText(/Live AI assistent uit/)

  try {
    // The seeded description is gone at once, without navigating anywhere.
    await expect(description).toBeHidden()

    // And stepping through units starts no explain_code run either.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(1200) // past EXPLAIN_DEBOUNCE_MS
    expect(explainRequests).toEqual([])
    await expect(description).toBeHidden()

    // Back on: the seeded description returns. Reload first, so this lands on
    // the same first change group the baseline above used rather than
    // wherever the f/↓ steps left the cursor.
    await openPrInfo(page)
    await page.getByTestId('auto-warn-toggle').click()
    await expect(page.getByTestId('auto-warn-toggle')).toHaveText(/Live AI assistent aan/)
    await page.goto('/pr/97')
    await expect(page.getByTestId('block-row').first()).toContainText('ExplainAction::execute')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect(description).toBeVisible()
  } finally {
    // Make sure the switch is back on even if an assertion above failed.
    await page.request.post('/api/workflows/auto_warn', { failOnStatusCode: false })
  }
})
