import { test, expect } from './_fixtures.mjs'

// The review-submit follow-ups: opened by afterApproveAction (home.mjs) right
// after a palette approve action leaves NOTHING ahead to navigate to
// (findNextUnapproved()===null) — the complement of the postApprove
// follow-up covered in postapprove-menu.spec.mjs (which covers the "there IS
// something ahead" case). Two variants, both driven by state.approvalTotal
// (the PR-wide combined-approval count):
//   - fully approved (REVIEW_APPROVE_COMMANDS, menu mode 'reviewApprove'):
//     "Sluit menu" (pinned first) / "Keur de HELE PR goed" (the default, 2nd
//     item).
//   - not yet fully approved (REVIEW_CHOICE_COMMANDS, menu mode
//     'reviewChoice'): "Sluit menu" (pinned first) / "Keur de HELE PR goed"
//     (default, 2nd item) / "Wijs de PR af" —
//     the not-fully-approved half of this is also covered by
//     postapprove-menu.spec.mjs's own "nothing left ahead" test; this file
//     focuses on what actually gets POSTed to /api/workflows/submit_review.
//
// Approving the whole PR is a deliberate TWO-STEP choice: "Keur de HELE PR
// goed" no longer submits directly — it has `children` (the ordinary submenu
// mechanism, like "Open GitHub") that opens a one-item confirm step
// ("Sluit menu" / "Goedkeuren en ga naar overzicht" / "Goedkeuren en
// sluiten"); only one of those two actually calls submit_review — they post
// the identical review and differ only in where the reviewer lands afterwards.
// Both confirm items and (after typing a reason)
// "Wijs de PR af" call the real submit_review endpoint — SLASH_GITHUB=off
// (forced by the test harness, see _fixtures.mjs) means the backend's
// github.Fake accepts it without touching the network, so no mocking is
// needed; we only intercept the request here to assert exactly what was sent.
//
// Same PR 12903 fixture as postapprove-menu.spec.mjs: only block 1
// (CreatePaymentAction::execute, index 1) and block 6 (Order::address, index
// 6) carry a real diff (one single-line group each) — every other block has
// zero changed rows, so approving both of those two blocks is exactly "alles
// goedgekeurd" for this fixture.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const BLOCK6_ID = '12903:app/Models/Order.php:Order::address'

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

// clearBlockApproval resets one block's durable approval through the
// sanctioned write path (the approve workflow's `set` signal — an empty set
// removes the row) — same helper as selected-reveal-hidden.spec.mjs's
// clearBlock1Approval. This file's whole premise (state.approvalTotal exactly
// tracks blocks 1 and 6) breaks if either carries a leftover approval from an
// earlier test on the same worker DB (postapprove-menu.spec.mjs,
// sidebar-skip-approved.spec.mjs and selected-reveal-hidden.spec.mjs also
// durably approve block 1 on this same PR), so every test here clears both,
// BEFORE navigating, making it idempotent regardless of run order.
async function clearBlockApproval(page, blockId) {
  const start = await page.request.post('/api/workflows/approve', { data: { pr: 12903 } })
  const { runId } = await start.json()
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId, rows: [], calls: [] },
  })
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/approvals?pr=12903')
      const rows = await res.json()
      return Array.isArray(rows) && rows.every((r) => r.blockId !== blockId)
    })
    .toBe(true)
}

// approveViaPalette approves the current unit through the command palette
// (Enter → filter "keur" → click the (first, "approve") row) — the only path
// that runs afterApproveAction (the top checkbox stays a direct toggle, see
// its own doc comment in home.mjs).
async function approveViaPalette(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-input').fill('keur')
  await page.getByTestId('command-row').first().click()
}

// mockClipboard stubs navigator.clipboard the same way tests/overview.spec.mjs's
// "Kopieer GitHub URL" test does — buildReviewClipboardText/copyReviewSummary
// (home.mjs) write the post-submit summary here.
async function mockClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied = t
          return Promise.resolve()
        },
        readText: () => Promise.resolve(window.__copied),
      },
    })
  })
}

test.describe('PR Review Tree — review-submit follow-up (Keur de HELE PR goed / Wijs de PR af)', () => {
  test('PR fully approved: "Keur de HELE PR goed" opens a confirm step before it POSTs event APPROVE', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await mockClipboard(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    // Approve block 1's only group — this still leaves block 6 open, so it
    // opens the existing postApprove "Ga door" follow-up (unchanged
    // behaviour, see postapprove-menu.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)

    // Approve block 6's only group too — now NOTHING is left ahead AND the
    // whole PR (both real-diff blocks) is fully approved.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')
    // Colorblind rule: shape + text carry the meaning, the emerald tint is
    // decoration only — the icon must be present regardless.
    await expect(rows.nth(1).getByTestId('command-icon-approve-pr')).toBeVisible()

    // Choosing it must NOT submit yet — it opens the confirm submenu instead,
    // which offers the same review twice, differing only in where you land
    // afterwards: "ga naar overzicht" (the default, 2nd item) and "sluiten".
    await rows.filter({ hasText: 'Keur de HELE PR goed' }).click()
    await expect(menu).toBeVisible()
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Goedkeuren en ga naar overzicht')
    await expect(rows.nth(2)).toContainText('Goedkeuren en sluiten')
    await expect(rows.nth(1).getByTestId('command-icon-approve-pr')).toBeVisible()
    await expect(rows.nth(2).getByTestId('command-icon-approve-pr')).toBeVisible()

    const [request] = await Promise.all([
      page.waitForRequest('**/api/workflows/submit_review'),
      rows.filter({ hasText: 'Goedkeuren en sluiten' }).click(),
    ])
    expect(request.method()).toBe('POST')
    expect(request.postDataJSON()).toEqual({ pr: 12903, event: 'APPROVE', body: '' })
    const response = await request.response()
    expect(response.status()).toBe(200)
    await expect(menu).not.toBeVisible()

    // With no own unresolved comments on this PR, the clipboard summary is
    // the bare link + a checkmark, no comment count.
    const copied = await page.evaluate(() => window.__copied)
    expect(copied).toContain('/pull/12903')
    expect(copied.trim().endsWith('✅')).toBe(true)
  })

  test('PR not fully approved: "Wijs de PR af" requires a typed reason before it submits', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await mockClipboard(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    // Approve block 6 only — block 1 stays open, so the PR isn't fully done.
    await page.locator('[data-idx="6"]').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')
    await expect(rows.nth(2)).toContainText('Wijs de PR af')
    // Colorblind rule: approve and reject are told apart by icon SHAPE
    // (check-in-circle vs. X-in-circle), the emerald/rose tint is decoration
    // only — both icons must be present regardless.
    await expect(rows.nth(1).getByTestId('command-icon-approve-pr')).toBeVisible()
    await expect(rows.nth(2).getByTestId('command-icon-reject-pr')).toBeVisible()
    await rows.filter({ hasText: 'Wijs de PR af' }).click()

    // The rejection-reason step: an empty textarea offers no command at all
    // (Enter must be a no-op, not a silent close-without-submitting — a
    // bodyless REQUEST_CHANGES is rejected by GitHub/the backend).
    await expect(menu).toBeVisible()
    const input = page.getByTestId('command-input')
    await expect(input).toHaveAttribute('placeholder', /Typ de reden voor afwijzing/)
    await expect(page.getByTestId('command-row')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible() // still open — nothing was submitted

    // Typing a reason reveals exactly one command; running it submits
    // REQUEST_CHANGES with that reason as the body.
    await input.fill('Graag nog een test toevoegen voor de foutafhandeling.')
    await expect(page.getByTestId('command-row')).toHaveCount(1)
    await expect(page.getByTestId('command-row').first()).toContainText('Wijs de PR af met deze reden')

    const [request] = await Promise.all([
      page.waitForRequest('**/api/workflows/submit_review'),
      page.getByTestId('command-row').first().click(),
    ])
    expect(request.method()).toBe('POST')
    expect(request.postDataJSON()).toEqual({
      pr: 12903,
      event: 'REQUEST_CHANGES',
      body: 'Graag nog een test toevoegen voor de foutafhandeling.',
    })
    const response = await request.response()
    expect(response.status()).toBe(200)
    await expect(menu).not.toBeVisible()

    // No emoji for a rejection — the link, the fixed "met nog een paar
    // aanpassingen" phrase, and the typed reason verbatim.
    const copied = await page.evaluate(() => window.__copied)
    expect(copied).toContain('/pull/12903')
    expect(copied).toContain(
      ' met nog een paar aanpassingen: Graag nog een test toevoegen voor de foutafhandeling.',
    )
    expect(copied).not.toMatch(/[✅❌]/)
  })

  // The second confirm item posts the identical review and then leaves for the
  // PR overview via overviewExitUrlAfterApprove (home.mjs) — deliberately NOT
  // overviewExitUrl/its `?pr=`/`?sel=` round-trip (there's nothing left to
  // return to once the whole PR is approved). Instead the just-approved PR
  // must already be filtered out of every section by the time the page
  // renders (approvedPr/normalizeSections, overview.mjs), with the new TOP
  // row of the list selected (trySelectTopAfterApprove) — never a flash of
  // the approved row followed by it disappearing. The navigation must happen
  // only AFTER the submit resolved.
  test('"Goedkeuren en ga naar overzicht" submits, then lands on /pr-overview with that PR already gone and the top row selected', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await mockClipboard(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const rows = page.getByTestId('command-row')
    await expect(menu).toBeVisible()
    await rows.filter({ hasText: 'Keur de HELE PR goed' }).click()

    const [request] = await Promise.all([
      page.waitForRequest('**/api/workflows/submit_review'),
      rows.filter({ hasText: 'Goedkeuren en ga naar overzicht' }).click(),
    ])
    expect(request.postDataJSON()).toEqual({ pr: 12903, event: 'APPROVE', body: '' })

    await page.waitForURL(/\/pr-overview\?/)
    const url = new URL(page.url())
    expect(url.pathname).toBe('/pr-overview')
    expect(url.searchParams.get('approved')).toBe('12903')
    expect(url.searchParams.get('pr')).toBeNull()
    expect(url.searchParams.get('sel')).toBeNull()

    // The fixture's "Needs your review" section is [12888, 12903, 12904] —
    // 12903 (just approved) must be gone, and the new top row (12888) must
    // carry the keyboard-selection ring, not merely "still first in the DOM".
    const navRows = page.locator('[data-nav-row]')
    await expect(navRows.first()).toHaveAttribute('data-pr', '12888')
    await expect(page.locator('[data-pr="12903"]')).toHaveCount(0)
    await expect(navRows.first()).toHaveClass(/ring-indigo-500\/50/)
  })

  // buildReviewClipboardText (home.mjs) counts the reviewer's OWN comments
  // that are not (yet) resolved, across the whole PR — not scoped to any one
  // block. Seeded here via the sanctioned task_code_comment write path;
  // _cleanApprovals (_fixtures.mjs) deletes every comment on the shared
  // anchor PR 12903 before each test, so this never leaks into a neighbour.
  test('Approving the whole PR with own unresolved comments open counts them in the clipboard summary', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    const seedComment = async (line, body) => {
      const start = await page.request.post('/api/workflows/task_code_comment', {
        data: { pr: 12903, file: 'app/Actions/CreatePaymentAction.php', line, author: 'reviewer', body },
      })
      expect((await start.json()).runId).toBeTruthy()
    }
    await seedComment(26, 'own comment one')
    await seedComment(27, 'own comment two')
    // A "just praise" comment is NOT an open point, so it must not be counted
    // (isPraiseComment, home.mjs). Deliberately a LONGER body around the word:
    // the rule is a raw substring match with no word boundaries, so this one is
    // skipped as well — see the two documented choices at isPraiseComment.
    await seedComment(28, 'Nice, maar deze query geeft N+1')

    await mockClipboard(page)
    // The word list is configurable (GET /api/praisewords → praise-words.json,
    // see praisewords.go); ensurePraiseWords fetches it once at startup. Waiting
    // for that response proves the wiring — without it the page would silently
    // fall back to DEFAULT_PRAISE_WORDS and this test would still pass.
    const praiseWords = page.waitForResponse('**/api/praisewords')
    await page.goto('/pr/12903')
    expect((await praiseWords).ok()).toBe(true)
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()

    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await rows.filter({ hasText: 'Keur de HELE PR goed' }).click()
    await expect(menu).toBeVisible()

    const [request] = await Promise.all([
      page.waitForRequest('**/api/workflows/submit_review'),
      rows.filter({ hasText: 'Goedkeuren en sluiten' }).click(),
    ])
    const response = await request.response()
    expect(response.status()).toBe(200)
    await expect(menu).not.toBeVisible()

    const copied = await page.evaluate(() => window.__copied)
    expect(copied).toContain('/pull/12903')
    expect(copied.trim().endsWith('✅ met 2 comments')).toBe(true)
  })

  // "PR keuren" (PR_COMMANDS → the "GitHub" submenu) is a manual entry point
  // into this exact same REVIEW_CHOICE_COMMANDS array — reachable at any time
  // via `/`, not only right after approving the last reachable unit (the
  // automatic postApprove/reviewChoice path covered by the tests above and by
  // postapprove-menu.spec.mjs). No second implementation: it's the identical
  // `children` array, so this only checks the new entry point + item order,
  // not the submit mechanics again.
  test('`/` → GitHub → "PR keuren" opens the same approve/reject choice, reachable at any time', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    // `/` opens the menu of the CURRENT stop (contextMenuMode, home.mjs), so
    // the PR-wide menu lives one step left of the index: stop 1, the PR
    // description column. See command-palette.md.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'GitHub' }).click()

    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Open op GitHub')
    await expect(rows.nth(2)).toContainText('PR keuren')
    await expect(rows.nth(3)).toContainText('Algemene comment plaatsen')
    await expect(rows.nth(2).getByTestId('command-icon-approve-pr')).toBeVisible()

    await rows.filter({ hasText: 'PR keuren' }).click()
    await expect(menu).toBeVisible()
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')
    await expect(rows.nth(2)).toContainText('Wijs de PR af')
    await expect(rows.nth(1).getByTestId('command-icon-approve-pr')).toBeVisible()
    await expect(rows.nth(2).getByTestId('command-icon-reject-pr')).toBeVisible()

    // Esc from this nested submenu resets straight to the PR-menu root, not
    // one level back to "GitHub" — the documented "Esc always goes to root"
    // behaviour (see command-palette.md), which is what makes this extra
    // nesting level free. No exact toHaveCount on this root list — PR_COMMANDS
    // (home.mjs) keeps growing (e.g. "Tests laten draaien"), so assert the
    // known first row instead of the total count.
    await page.keyboard.press('Escape')
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('GitHub')

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })
})
