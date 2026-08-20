import { test, expect } from './_fixtures.mjs'

// The sky "Aanpassingen sinds jouw review" blocks under "Doel" in the PR-info
// column (stop 1): what landed on the PR after the reviewer's own last review.
// The first block's line repeats the PR overview's own "Bijgewerkt … geleden ·
// nieuw sinds jouw review" line verbatim, off the SAME moment (see stage 3/4 of
// pr_status in .claude/docs/workflows-trackers.md). Mocks GET /api/pr, like
// pr-description-expand.spec.mjs — the backend chain has its own Go tests
// (TestSinceReviewFacts, TestSinceReviewRoundTrip); what needs proving here is
// the render contract, including the "show nothing at all" case, the split into
// separately navigable blocks and the Enter-to-read-it-all toggle.
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

test('the story block shows the overview line and the AI explanation, the facts get their own blocks', async ({ page }) => {
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

// The whole point of the split: every part is reachable with ↓, so nothing stays
// stuck below the scrolling card's bottom edge, and a capped block opens up to
// its full text on Enter (reviewer: "je mag het afkappen, maar als ik enter
// druk op z'n blok dan wil ik de volledige omschrijving lezen").
test('each part is its own block: two lists become two blocks, walked with the arrow keys', async ({ page }) => {
  await mockPr(page, {
    ghUpdatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    newSinceKind: 'review',
    sinceSummary: 'De laatste wijziging voegt lege periodes toe aan de query.',
    sinceFacts:
      '**2 nieuwe commits** sinds jouw laatste review:\n\n- Add the empty periods (bob)\n- Fix rounding (alice)\n' +
      '\n**3 bestanden** geraakt:\n\n- `app/A.php`\n- `app/B.php`\n- `app/C.php`\n',
  })

  // Block 1 = the story only: the overview line + the explanation, no facts.
  const story = page.getByTestId('pr-info-since-review')
  await expect(story.getByTestId('pr-info-since-summary')).toContainText('lege periodes')
  await expect(story.getByTestId('pr-info-since-facts')).toHaveCount(0)
  await expect(story).toContainText('Aanpassingen sinds jouw review')

  // Blocks 2 and 3 = one per fact list, each with its own heading.
  const factBlocks = page.getByTestId('pr-info-since-block')
  await expect(factBlocks).toHaveCount(2)
  await expect(factBlocks.nth(0)).toContainText('2 nieuwe commits sinds jouw laatste review')
  await expect(factBlocks.nth(0).locator('li').first()).toContainText('Add the empty periods')
  await expect(factBlocks.nth(1)).toContainText('3 bestanden geraakt')

  // ↓ walks story → commits → files, one block at a time.
  await page.keyboard.press('ArrowDown')
  await expect(story).toHaveAttribute('data-since-focused', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(factBlocks.nth(0)).toHaveAttribute('data-since-focused', 'true')
  await expect(story).toHaveAttribute('data-since-focused', 'false')
  await page.keyboard.press('ArrowDown')
  await expect(factBlocks.nth(1)).toHaveAttribute('data-since-focused', 'true')

  // ↑ walks back up and releases the cursor to the description card itself.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(story).toHaveAttribute('data-since-focused', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(story).toHaveAttribute('data-since-focused', 'false')
})

test('a long block is capped with a fade and Enter opens it up in full', async ({ page }) => {
  const long = 'Deze commit herschrijft de aggregatie in de query. '.repeat(6)
  await mockPr(page, {
    ghUpdatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    newSinceKind: 'review',
    sinceSummary: long,
    sinceFacts: '**1 nieuwe commit** sinds jouw laatste review:\n\n- Rewrite aggregation\n',
  })

  const story = page.getByTestId('pr-info-since-review')
  await expect(story).toHaveAttribute('data-since-collapsed', 'true')
  await expect(story.getByTestId('pr-info-since-toggle')).toContainText('meer…')

  await page.keyboard.press('ArrowDown') // land the cursor on the story block
  await expect(story).toHaveAttribute('data-since-focused', 'true')
  await page.keyboard.press('Enter')
  await expect(story).toHaveAttribute('data-since-collapsed', 'false')
  await expect(story.getByTestId('pr-info-since-toggle')).toContainText('Inklappen')
  // Enter really read the block instead of opening the PR-wide menu.
  await expect(page.getByTestId('command-menu')).toHaveCount(0)

  await page.keyboard.press('Enter')
  await expect(story).toHaveAttribute('data-since-collapsed', 'true')

  // The short fact block has nothing to open, so it carries no affordance.
  const facts = page.getByTestId('pr-info-since-block')
  await expect(facts).toHaveAttribute('data-since-collapsed', 'false')
  await expect(facts.getByTestId('pr-info-since-toggle')).toHaveCount(0)
})
