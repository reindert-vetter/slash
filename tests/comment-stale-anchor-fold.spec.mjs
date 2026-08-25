import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer reports: standing on a diff line/group that has nothing to do with
// a comment must show NOTHING next to the diff — not a leftover card from a
// comment anchored elsewhere in the same block. The concrete trigger was a
// comment whose exact row the re-anchor pass could no longer re-find
// (anchorState 'unpinned', "verouderd — regel gewijzigd" — see reanchor.go).
//
// Fix (part 1): such a comment is now ALWAYS folded behind the SAME
// "N hierboven" hint (hiddenAboveCount/moreAboveHint) a real comment above the
// cursor already gets, reachable only through that hint (or an explicit ↑
// once inside the panel) — never shown at rest. → also skips it as a default
// landing, the same way it already skips an already-resolved comment. The one
// place it still renders normally (field-reduced: avatar/name/label/title
// only, never the body/meta line) is compactConversation, when it happens to
// sit BELOW a real, non-stale comment on the SAME unit — it never reorders
// ahead of one. The expanded thread (once reached via the hint) is untouched.
//
// Fix (part 2, later, comments-panel.md "Best-effort line matching for an
// unpinned comment"): commentUnder's original "unknown anchor → always shown
// within this whole block" leniency turned out too broad on a real PR — it
// surfaced the hint under EVERY unit of the block, including ones that have
// nothing to do with the comment. It was narrowed to a best-effort match of
// the comment's own recorded source `line` against the SELECTED unit's real
// line range (lineMatchesUnit) — so the comment is now only "in scope" (and
// thus only foldable/reachable) on the unit whose line range it actually
// falls in, not on every unit of the block.
//
// PR 970601 (materializeStaleAnchorWorktrees, tests/_setup.mjs): one method
// with three separate single-line change groups, $a/$b/$c. One 'unpinned'
// comment is pre-seeded (staleanchor-comments.json — anchorState is
// unreachable from the UI, so it must be seeded, same reasoning as the
// orphan fixture) with no real row (rowStart/rowEnd -1) but a recorded `line`
// that lands on $a's own line — so it is only ever "in scope" there, never
// on $b/$c. The spec places one ordinary, REAL comment on $a's own group
// (the SAME unit as the stale one) through the composer.
test.describe('PR Review Tree — a stale (unpinned) comment stays folded behind the ▲ hierboven hint', () => {
  test('folded at rest on its own unit, visible (reduced) below a real one there, absent on unrelated units', async ({
    page,
  }) => {
    test.setTimeout(60000) // a full reload + several navigation steps, comfortably over the 30s default
    await page.goto('/pr/970601')
    await page.locator('[data-idx="0"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff, lands on group $a

    // --- Group $a: only the stale comment is "in scope" here — folded away. ---
    const inlineComments = page.getByTestId('inline-comments')
    await expect(inlineComments.getByTestId('comment-item')).toHaveCount(0)
    const hint = page.getByTestId('comment-more-above')
    await expect(hint).toContainText('1 hierboven')
    // The embedded Claude column follows the same fold — nothing to anchor a
    // conversation on while the only comment in scope is folded away.
    await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)

    // → must not land straight on the folded stale comment either.
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('related-code')).toBeVisible() // skipped to Underlying code (none here → the empty-state card)
    await page.keyboard.press('ArrowLeft') // back to the diff, still on group $a

    // --- Groups $b and $c: unrelated to the stale comment's own line — the
    // best-effort line match must leave it out of scope entirely there, not
    // just folded: no hint, no card, nothing to fold in the first place. This
    // is the part that changed — before, the same "1 hierboven" as on $a
    // showed here too. ---
    await page.keyboard.press('ArrowDown') // $a -> $b
    await expect(inlineComments.getByTestId('comment-item')).toHaveCount(0)
    await expect(hint).toHaveCount(0)
    await page.keyboard.press('ArrowDown') // $b -> $c
    await expect(inlineComments.getByTestId('comment-item')).toHaveCount(0)
    await expect(hint).toHaveCount(0)
    await page.keyboard.press('ArrowUp') // $c -> $b
    await page.keyboard.press('ArrowUp') // $b -> $a, back where the stale comment lives

    // --- Group $a: place a REAL comment on the SAME unit through the ordinary composer. ---
    await page.keyboard.press('Enter') // block command palette
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()
    await composer.fill('een echte, actuele comment op deze regel')
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
      ),
      page.keyboard.press('Enter'), // posts directly
    ])
    const runId = (await createRes.json()).runId
    expect(runId).toBeTruthy()

    try {
      // Reload so both comments are present from the first render (avoids
      // racing the 5s poll, same reasoning as comment-call-gran-scope.spec.mjs).
      await page.goto('/pr/970601')
      await page.locator('[data-idx="0"]').click()
      await leaveSearchBox(page)
      await page.keyboard.press('ArrowRight') // list -> diff, group $a again

      // Both comments are "in scope" (the real one matches the row, the
      // stale one best-effort-matches its own recorded line, which is $a's)
      // — nothing is folded because the real comment (older) sorts before
      // the stale one, so there is no LEADING stale run.
      const items = inlineComments.getByTestId('comment-item')
      await expect(items).toHaveCount(2)
      await expect(page.getByTestId('comment-more-above')).toHaveCount(0)

      const realCard = items.filter({ hasText: 'een echte, actuele comment op deze regel' })
      await expect(realCard).toHaveAttribute('data-stale-anchor', 'false')
      await expect(realCard).toContainText('reacties') // the ordinary meta line

      // Reduced to avatar + name + label + title: no body/meta line at rest —
      // its own body text ("Dit verwijst naar...") must NOT be findable this
      // way, so the stale card is picked by its stale marker instead.
      const staleCard = items.filter({ has: page.getByTestId('comment-stale-anchor') })
      await expect(staleCard).toHaveCount(1)
      await expect(staleCard).toHaveAttribute('data-stale-anchor', 'true')
      await expect(staleCard.getByTestId('comment-stale-anchor')).toContainText('verouderd — regel gewijzigd')
      await expect(staleCard.getByTestId('comment-meta')).toHaveCount(0)
      // The stale comment's own body/stored snippet must not leak into the
      // reduced card at all.
      await expect(staleCard).not.toContainText('Dit verwijst naar')
      await expect(staleCard).not.toContainText('$b = 0;')

      // --- Group $b: still fully out of scope — a real comment existing
      // elsewhere in the block (on $a) must not pull the stale one into scope
      // here too. ---
      await page.keyboard.press('ArrowDown') // group $a -> $b
      await expect(inlineComments.getByTestId('comment-item')).toHaveCount(0)
      await expect(page.getByTestId('comment-more-above')).toHaveCount(0)
      await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)

      // --- Back on group $a: clicking the reduced stale card still expands
      // it to the ordinary, UNREDUCED thread — the fold only reduces its
      // AT-REST appearance, never what it shows once actually opened. ---
      await page.keyboard.press('ArrowUp') // $b -> $a
      await staleCard.click()
      const expandedCard = inlineComments.locator('[data-testid="comment-item"][data-expanded="true"]')
      await expect(expandedCard).toHaveCount(1)
      await expect(expandedCard).toContainText('Dit verwijst naar een regel die inmiddels is verschoven')
      await expect(expandedCard).toContainText('verouderd — regel gewijzigd')
    } finally {
      await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/delete', {
        data: { author: 'reviewer' },
      })
    }
  })
})
