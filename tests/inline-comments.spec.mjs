import { test, expect } from './_fixtures.mjs'

// Block-scoped comments (task_code_comment workflow) render as their own
// inline blocks, directly above the Onderliggende-code card — not a browsable,
// unscoped index. They are scoped to the selected block (and, in the diff, to
// the unit under the selection: call ⊂ line ⊂ group ⊂ block — see
// RelatedPanel's visibleComments/commentUnder/commentRowSet + the
// state→cs.scope watch in home.mjs). A diff row that carries a comment shows
// a 💬 marker (Block.mjs's paneHTML). Per conversation, exactly one card:
// several threads on the same unit each get their own, compact card, and only
// the one currently focused/selected expands to its full thread. See
// detail-layout.md ("Inline comment blocks").
test.describe('PR Review Tree — inline comment blocks', () => {
  async function ready(page) {
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  }
  // selectedCard is the selected block's card (the first card in the column).
  function selectedCard(page) {
    return page.getByTestId('block-column').locator('article').first()
  }
  async function ident(page) {
    const card = selectedCard(page)
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
    return { label, file: fileLine.split(':')[0], fileLine }
  }
  // waitBlock waits until the selected card is the block `label` (used after a
  // deep link restores ?sel=, which may select a non-first row).
  async function waitBlock(page, label) {
    await expect(selectedCard(page).locator('h2').first()).toHaveText(label)
  }

  test('a comment shows only as an inline block on its own block, with a 💬 on its row', async ({ page }) => {
    // Discover a block other than the first (so this spec never pollutes the first
    // block other 12903 specs select by default) and remember its file:line ref
    // (?sel= carries the block's `file:line`, not its index — see CLAUDE.md).
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)
    for (let i = 0; i < 12; i++) {
      if ((await ident(page)).label !== first.label) break
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(120)
    }
    const mine = await ident(page)
    expect(mine.label).not.toBe(first.label)

    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: mine.file,
        line: 1,
        author: 'reviewer',
        body: 'commentaar op mijn blok',
        label: mine.label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(res.ok()).toBeTruthy()

    const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: 'commentaar op mijn blok' })

    // Deep-link to the default (first) block — the comment is on another
    // block, so it never shows as an inline block there.
    await page.goto('/pr/12903')
    await waitBlock(page, first.label)
    await expect(item).toHaveCount(0)

    // Deep-link with its own block selected — the comment shows as an inline
    // card, and its diff row carries a 💬 marker.
    await page.goto('/pr/12903?sel=' + encodeURIComponent(mine.fileLine))
    await waitBlock(page, mine.label)
    await expect(item).toHaveCount(1)
    await expect(page.getByTestId('block-column').locator('[data-comment]').first()).toBeVisible()
  })

  test('the comment-claude-row card is hidden while there is nothing to show, and reappears once a comment exists', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    // Nothing hangs on this block yet (no comment, no composer open, no
    // Claude chat, no busy/replySent footer) — the bordered
    // comment-claude-row card must be hidden (see
    // .claude/docs/comments-panel.md).
    const row = page.getByTestId('comment-claude-row')
    await expect(row).toBeHidden()

    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: first.file,
        line: 1,
        author: 'reviewer',
        body: 'brengt de kaart terug',
        label: first.label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(res.ok()).toBeTruthy()

    // Once the block carries a visible comment the card is back.
    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)
    await expect(row).toBeVisible()
  })

  test('a fresh composer with no earlier comments/Claude chat still gets a visible, non-zero-height row', async ({
    page,
  }) => {
    // Regression for the `overflow-hidden` + `justify-end` interaction on
    // comment-claude-row (see detail-layout.md): a brand-new composer opened
    // on a block with no earlier comments and no Claude conversation used to
    // collapse the whole comment-claude-row to just the composeTargetHint
    // bar's height, silently clipping the composer/Claude column away above
    // it — "commenting on a line only shows a bare bar at the top". The
    // actual browser collapse only reproduces at a specific real
    // Onderliggende-code-driven column width (relatedGrowthChars() > some
    // threshold, see RelatedPanel.mjs's relatedWidthCls) — not reliably
    // triggerable through this suite's synthetic fixtures despite trying
    // several blocks/widths/viewports — so this asserts the actual CSS
    // property whose removal fixed it, directly, in addition to the ordinary
    // visibility check below.
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    // rel.foc=new restores straight onto the fresh "new comment" composer
    // (see CLAUDE.md's URL-state section, `RelatedPanel`'s `ns: 'rel'`).
    await page.goto(
      '/pr/12903?sel=' + encodeURIComponent(first.fileLine) + '&mode=diff&rel.foc=new',
    )
    await waitBlock(page, first.label)

    const row = page.getByTestId('comment-claude-row')
    await expect(row).toBeVisible()
    const composer = page.getByTestId('comment-composer')
    await expect(composer).toBeVisible()

    const rowBox = await row.boundingBox()
    const composerBox = await composer.boundingBox()
    expect(rowBox.height).toBeGreaterThan(20)
    expect(composerBox.height).toBeGreaterThan(20)
    // The composer must sit fully inside its row, not clipped above a
    // collapsed 0px ancestor (the tell-tale symptom: a negative y offset
    // relative to the row).
    expect(composerBox.y).toBeGreaterThanOrEqual(rowBox.y)

    // Pin the actual fix: an `overflow-hidden` ancestor combined with
    // `justify-end` on the inline-comments column (bottom-aligning it with
    // the taller Claude column) is what collapsed every intermediate
    // flex-col ancestor's auto-height to 0 in Chromium. comment-claude-row
    // must never carry it again.
    const rowClass = await row.getAttribute('class')
    expect(rowClass).not.toMatch(/\boverflow-hidden\b/)
  })

  test('resolving a comment removes its 💬 marker', async ({ page }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    const created = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: first.file,
        line: 1,
        author: 'reviewer',
        body: 'resolve me',
        label: first.label,
        gran: 'group',
        rowStart: 0,
        rowEnd: 0,
      },
    })
    expect(created.ok()).toBeTruthy()
    const { runId } = await created.json()
    expect(runId).toBeTruthy()

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    const marker = page.getByTestId('block-column').locator('[data-comment]').first()
    await expect(marker).toBeVisible()

    const resolved = await page.request.post(`/api/workflows/${runId}/signals/reply`, {
      data: { author: 'reviewer', body: 'klaar', done: true },
    })
    expect(resolved.ok()).toBeTruthy()

    // syncComments polls cs.list; the marker disappears reactively once it refetches.
    await expect(marker).toBeHidden({ timeout: 15000 })
  })

  test('multiple conversations on the same unit each get their own card; only the focused one expands', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    // Two separate conversations, same block, same (whole-block) anchor.
    const bodies = ['eerste conversatie', 'tweede conversatie']
    for (const body of bodies) {
      const res = await page.request.post('/api/workflows/task_code_comment', {
        data: { pr: 12903, file: first.file, line: 1, author: 'reviewer', body, label: first.label, rowStart: -1, rowEnd: -1 },
      })
      expect(res.ok()).toBeTruthy()
    }

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    const items = page.getByTestId('inline-comments').getByTestId('comment-item')
    await expect(items).toHaveCount(2)
    // Neither is focused yet — both render compact.
    await expect(items.nth(0)).toHaveAttribute('data-expanded', 'false')
    await expect(items.nth(1)).toHaveAttribute('data-expanded', 'false')

    // Clicking the second expands only that one; the first stays compact.
    await items.nth(1).click()
    await expect(items.nth(0)).toHaveAttribute('data-expanded', 'false')
    await expect(items.nth(1)).toHaveAttribute('data-expanded', 'true')
    await expect(items.nth(1).getByTestId('comment-thread')).toContainText('tweede conversatie')

    // Clicking the first expands it instead and collapses the second again.
    await items.nth(0).click()
    await expect(items.nth(0)).toHaveAttribute('data-expanded', 'true')
    await expect(items.nth(1)).toHaveAttribute('data-expanded', 'false')
    await expect(items.nth(0).getByTestId('comment-thread')).toContainText('eerste conversatie')
  })

  test('the expanded thread is capped at max-h-[38vh] and scrolls internally, newest message visible by default, faded once scrolled', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    const created = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file: first.file, line: 1, author: 'reviewer', body: 'lange conversatie', label: first.label, rowStart: -1, rowEnd: -1 },
    })
    expect(created.ok()).toBeTruthy()
    const { runId } = await created.json()
    expect(runId).toBeTruthy()

    // Enough replies to overflow the max-h-[38vh] cap.
    for (let i = 0; i < 15; i++) {
      const res = await page.request.post(`/api/workflows/${runId}/signals/reply`, {
        data: { author: 'bogsat', body: 'reactie nummer ' + i, done: false },
      })
      expect(res.ok()).toBeTruthy()
    }

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: 'lange conversatie' })
    await item.click()
    await expect(item).toHaveAttribute('data-expanded', 'true')

    const thread = item.getByTestId('comment-thread')
    const lastBubble = thread.getByTestId('reaction-bubble').last()
    await expect(lastBubble).toContainText('reactie nummer 14')

    // The thread is capped (see "A capped, fading thread" in
    // .claude/docs/comments-panel.md) — a 16-message conversation genuinely
    // overflows max-h-[38vh] and scrolls internally instead of growing the
    // whole comment-claude-row (and, via <main>'s align-items:stretch, the
    // sibling block-diff column) without bound.
    const overflow = await thread.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(overflow).toBeGreaterThan(0)

    // The newest message is still visible without any manual scroll — toComment()
    // scrolls the thread to the bottom at the rest position (threadPos === 0),
    // mirroring the Claude column's own scrollClaudeThreadToBottom.
    await expect(lastBubble).toBeInViewport()

    // The top fade only appears once something is actually scrolled out of view
    // above — it must not be a permanent, misleading cue.
    await expect(thread).toHaveClass(/scroll-fade-top/)
    await thread.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(thread).not.toHaveClass(/scroll-fade-top/)
  })

  // compactConversation's preview used to hard-truncate at 1 line — fine for a
  // short human reply, but it cut off a multi-sentence AI-controle finding
  // (code_warning, source 'ai') after just a few words. It now clamps at 3
  // lines instead (line-clamp-3), so a typical finding is readable without a
  // click. See compactConversation's own doc comment in RelatedPanel.mjs.
  test('an unfocused AI-controle finding clamps at 3 lines, not 1', async ({ page }) => {
    await page.goto('/pr/12903')
    await ready(page)
    const first = await ident(page)

    const longBody =
      'De hardening vervangt wel de interpolatie in de run-bodies, maar laat het grootste resterende injectiepad staan: ' +
      'de volledige workflow-diff wordt met een vast delimiter naar de omgeving geschreven, waardoor een diff-regel die ' +
      'toevallig dezelfde tekst bevat de heredoc vroegtijdig kan afsluiten en willekeurige variabelen kan overschrijven.'
    const created = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: first.file,
        line: 1,
        author: 'AI check',
        body: longBody,
        source: 'ai',
        local: true,
        label: first.label,
        rowStart: -1,
        rowEnd: -1,
      },
    })
    expect(created.ok()).toBeTruthy()

    await page.goto('/pr/12903?sel=' + encodeURIComponent(first.fileLine))
    await waitBlock(page, first.label)

    // Not focused (nothing was clicked) — stays compact.
    const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: 'De hardening vervangt' })
    await expect(item).toHaveAttribute('data-expanded', 'false')
    const preview = item.locator('span.line-clamp-3').first()
    await expect(preview).toHaveClass(/line-clamp-3/)
    await expect(preview).not.toHaveClass(/\btruncate\b/)
    // line-clamp-3 (a webkit line-clamp) reports itself via the CSS box, not
    // a class assertion alone — assert the actual computed style too, so a
    // future accidental revert to `truncate` (1 line, no line-clamp) is
    // caught even if some other class still happened to contain the string
    // "line-clamp-3" as a substring.
    const clamp = await preview.evaluate((el) => getComputedStyle(el).webkitLineClamp)
    expect(clamp).toBe('3')
  })
})
