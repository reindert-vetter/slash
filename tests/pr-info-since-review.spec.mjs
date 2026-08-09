import { test, expect } from './_fixtures.mjs'

// The sky "Sinds jouw laatste review" block under "Doel" in the PR-info column
// (stop 1): what landed on the PR after the reviewer's own last review. Its
// first line repeats the PR overview's own "Bijgewerkt … geleden · nieuw sinds
// jouw review" line verbatim, off the SAME moment (see stage 3/4 of pr_status
// in .claude/docs/workflows-trackers.md). Mocks GET /api/pr, like
// pr-description-expand.spec.mjs — the backend chain has its own Go tests
// (TestSinceReviewFacts, TestSinceReviewRoundTrip); what needs proving here is
// the render contract, including the "show nothing at all" case.
const BASE = {
  ok: true,
  pr: 12903,
  title: 'Rework checkout flow',
  url: 'https://github.com/x/y/pull/12903',
  body: 'Korte omschrijving.',
  summary: 'Deze PR herziet de checkout.',
  reviewDecision: 'APPROVED',
  reviewers: [],
  checksTotal: 1,
  checksPassed: 1,
}

async function mockPr(page, extra) {
  await page.route('**/api/pr?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...BASE, ...extra }),
    }),
  )
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await page.keyboard.press('ArrowLeft') // stop 1: the PR-info column
  await expect(page.getByTestId('pr-info-summary')).toBeVisible()
}

test('the block shows the overview line first, then the AI explanation and the facts', async ({ page }) => {
  const hourAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  await mockPr(page, {
    ghUpdatedAt: hourAgo,
    newSinceKind: 'review',
    newSinceAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    sinceSummary: 'De afronding van bedragen is verplaatst naar de order zelf.',
    sinceFacts: '**2 nieuwe commits** sinds jouw laatste review:\n\n- Fix rounding (alice)\n- Tweak totals\n',
  })

  const block = page.getByTestId('pr-info-since-review')
  await expect(block).toBeVisible()

  // Line 1 — the overview's own wording, with its relative "Bijgewerkt" time.
  const line = page.getByTestId('pr-info-since-line')
  await expect(line).toContainText('nieuw sinds jouw review')
  await expect(line).toContainText('Bijgewerkt')
  await expect(line).toContainText('geleden')

  // The AI explanation sits above the deterministic list, both rendered as
  // Markdown (the facts arrive as a Markdown list from the backend).
  await expect(page.getByTestId('pr-info-since-summary')).toContainText('afronding van bedragen')
  const facts = page.getByTestId('pr-info-since-facts')
  await expect(facts.locator('li').first()).toContainText('Fix rounding')

  // It really sits directly under "Doel", which is what was asked for.
  const summaryBox = page.getByTestId('pr-info-summary')
  const a = await summaryBox.boundingBox()
  const b = await block.boundingBox()
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1)
})

test('the facts stand alone when the AI explanation is missing', async ({ page }) => {
  await mockPr(page, {
    ghUpdatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    newSinceKind: 'comment',
    sinceSummary: '',
    sinceFacts: '**1 nieuwe commit** sinds jouw laatste review:\n\n- Fix rounding\n',
  })

  await expect(page.getByTestId('pr-info-since-review')).toBeVisible()
  await expect(page.getByTestId('pr-info-since-summary')).toHaveCount(0)
  await expect(page.getByTestId('pr-info-since-facts')).toContainText('Fix rounding')
  // The other half of the same "kind" word, so the block never claims a review
  // that never happened.
  await expect(page.getByTestId('pr-info-since-line')).toContainText('nieuw sinds jouw comment')
})

test('nothing is shown when nothing changed since (or you never reviewed)', async ({ page }) => {
  await mockPr(page, { newSinceKind: '', sinceFacts: '', sinceSummary: '' })
  await expect(page.getByTestId('pr-info-since-review')).toHaveCount(0)
})
