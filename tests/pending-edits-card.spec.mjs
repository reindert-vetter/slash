import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The "pending-edits card": a summary card, prepended above the chat's own
// code-preview cards (CodePreview.mjs's previewCard, kind 'edits'), linking to
// every block touched by the LATEST, not-yet-pushed chat-driven edit (the same
// file set the "⇧ ongepusht" pill already reads — state.pendingPush.files, see
// pendingPushFiles() in home.mjs). Reviewer request: "als je iets hebt
// aangepast doordat de chat dat doet met claude, laat een blok eronder zien
// met linkjes naar de plekken wat is aangepast … eerst als 1 blok, als ik
// enter druk, moet ik door de linkjes heen kunnen naar boven en naar beneden."
// See "A pending-edits card" in .claude/docs/claude-chat-panel.md.
//
// GET /api/pending-push is mocked, same shape as pending-push-todo.spec.mjs —
// the real one reads git refs, which a test worktree fixture has none of.
// PR 12903 is the shared, read-only anchor fixture (tests/fixtures/blocks.json)
// — reading it (never writing outside the sanctioned comment path, which
// _cleanApprovals resets) is explicitly allowed, see testing-playwright.md.

function mockPendingPush(page, files) {
  return page.route('**/api/pending-push?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pending: {
          '12903': {
            pr: 12903,
            headRef: 'feature/x',
            sha: 'abc1234',
            ahead: 1,
            files,
            state: 'ready',
            pushRunId: 'chatmerge-12903',
          },
        },
      }),
    }),
  )
}

test.describe('Pending-edits card (a chat-driven, not-yet-pushed edit)', () => {
  test('shows one collapsed card linking to every touched block; a file with no matching block stays plain text', async ({
    page,
  }) => {
    await mockPendingPush(page, [
      'app/Actions/CreatePaymentAction.php', // two blocks in the fixture: execute, findOrCreateCustomer
      'app/Enums/AddressType.php', // one block: fromString
      'no/such/File.php', // no block at all
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const card = page.getByTestId('code-preview-card')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-kind', 'edits')
    // Collapsed by default ("eerst als 1 blok") — the summary line still
    // names the count, but no individual link renders yet.
    await expect(card).toHaveAttribute('data-expanded', 'false')
    await expect(card.getByTestId('code-preview-title')).toContainText('Aanpassingen van Claude')
    await expect(card.getByTestId('code-preview-title')).toContainText('4')
    await expect(page.getByTestId('pending-edit-link')).toHaveCount(0)

    await card.getByTestId('code-preview-toggle').click()
    await expect(card).toHaveAttribute('data-expanded', 'true')

    const links = page.getByTestId('pending-edit-link')
    await expect(links).toHaveCount(4)
    await expect(links.nth(0)).toContainText('CreatePaymentAction::execute')
    await expect(links.nth(1)).toContainText('CreatePaymentAction::findOrCreateCustomer')
    await expect(links.nth(2)).toContainText('AddressType::fromString')
    await expect(links.nth(3)).toContainText('no/such/File.php')
    // The unmatched file is plain, non-clickable text (reviewer's own answer:
    // "wel tonen, als platte tekst zonder navigatiedoel") — every matched
    // block is a real <button>.
    expect(await links.nth(0).evaluate((el) => el.tagName)).toBe('BUTTON')
    expect(await links.nth(3).evaluate((el) => el.tagName)).toBe('DIV')

    await links.nth(1).click()
    await expect(page.locator('[data-idx]').filter({ hasText: 'CreatePaymentAction::findOrCreateCustomer' })).toHaveClass(
      /bg-indigo-50/,
    )
  })

  test('↓/↑ from the Claude composer walk the card, then its own links, before falling through to a fence card', async ({
    page,
  }) => {
    await mockPendingPush(page, ['app/Actions/CreatePaymentAction.php']) // execute + findOrCreateCustomer: 2 links
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // By label, not raw index — CreatePaymentAction::execute reliably carries
    // a real changed row (see blocks-and-ingest.md's sort-order note, reused
    // from claude-chat-panel.spec.mjs).
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    const detailCard = page.getByTestId('block-column').locator('article').first()
    await expect(detailCard).toBeVisible()
    const label = (await detailCard.locator('h2').first().innerText()).trim()
    const file = (await detailCard.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'kan dit anders?', label, rowStart: -1, rowEnd: -1 },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        return list.some((x) => x.runId === runId)
      })
      .toBe(true)

    await page.goto('/pr/12903') // reload: the comment is present from the start
    await leaveSearchBox(page)
    await page.locator('[data-idx]').filter({ hasText: label }).first().click()
    await page.keyboard.press('ArrowRight') // list -> diff
    await page.keyboard.press('ArrowRight') // diff -> the comment conversation
    await page.keyboard.press('ArrowRight') // comment -> claude
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

    const card = page.getByTestId('code-preview-card')
    await expect(card).toHaveCount(1) // no fence in this comment's body — only the pending-edits card
    await expect(card).toHaveAttribute('data-kind', 'edits')

    // ↓ from the composer's rest position lands on the pending-edits card,
    // collapsed.
    await page.keyboard.press('ArrowDown')
    await expect(card).toHaveAttribute('data-active', 'true')
    await expect(card).toHaveAttribute('data-expanded', 'false')
    await expect(page.getByTestId('claude-chat-compose')).not.toBeFocused()

    // Enter expands it (the ordinary code-preview toggle — no link is
    // highlighted yet, so selectHighlightedEditLink is a no-op).
    await page.keyboard.press('Enter')
    await expect(card).toHaveAttribute('data-expanded', 'true')
    await expect(card).toHaveAttribute('data-active', 'true') // still the SAME card, not advanced

    const links = page.getByTestId('pending-edit-link')
    await expect(links).toHaveCount(2)

    // ↓ now walks the card's OWN links first (reviewer request), staying on
    // this one card the whole time.
    await page.keyboard.press('ArrowDown')
    await expect(links.nth(0)).toHaveAttribute('data-active', 'true')
    await expect(links.nth(1)).toHaveAttribute('data-active', 'false')
    await expect(card).toHaveAttribute('data-active', 'true')

    await page.keyboard.press('ArrowDown')
    await expect(links.nth(1)).toHaveAttribute('data-active', 'true')
    await expect(links.nth(0)).toHaveAttribute('data-active', 'false')

    // ↑ walks them back up (still on the SAME card), then leaves the card
    // for the composer again.
    await page.keyboard.press('ArrowUp')
    await expect(links.nth(0)).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('ArrowUp') // back to the card itself, no link highlighted
    await expect(links.nth(0)).toHaveAttribute('data-active', 'false')
    await expect(card).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('claude-chat-compose')).not.toBeFocused()
    await page.keyboard.press('ArrowUp') // now leaves the card entirely
    await expect(card).toHaveAttribute('data-active', 'false')
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

    // Down again, onto the second link, then Enter jumps straight to it.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(links.nth(1)).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Enter')
    await expect(
      page.locator('[data-idx]').filter({ hasText: 'CreatePaymentAction::findOrCreateCustomer' }),
    ).toHaveClass(/bg-indigo-50/)
  })
})
