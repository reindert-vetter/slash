import { test, expect, evaluateSettled, appReady, leaveSearchBox } from './_fixtures.mjs'

// Inline, IDE-style editing of a diff block's new/right side (Block.mjs's
// inlineEditToggleButton/inlineEditorSlot, home.mjs's saveInlineEdit). See
// .claude/docs/inline-edit.md: "Opslaan" never commits/writes anything
// directly — it hands the edited text to a brand-new Claude chat
// (startClaudeChat) as invisible first-turn context and SENDS it right away,
// so most of this file asserts the hand-off purely via a spy on the
// onSaveInlineEdit callback (eligibility, the toggle, the overlay editor, the
// draft, the precise staleness detection — unrelated to the actual
// startClaudeChat/claude_chat mechanics, which are covered end to end by
// tests/claude-chat-panel.spec.mjs). The one exception is the real-app test
// at the bottom of this file, which covers the auto-send regression itself
// (no reviewer typing, no second Enter).
test.describe('Inline code editing (Block.mjs)', () => {
  test('edit toggle only shows for an eligible, top-level block and lets the reviewer type + save', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        id: 'inline-edit-test:Foo::bar',
        pr: 12903,
        category: 'ACTION',
        label: 'Foo::bar',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        endLine: 29,
        name: 'bar',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: { start: 26, end: 29, text: 'public function bar(): ?int {\n    return 2;\n}' },
        },
      })
      const host = document.createElement('div')
      host.id = 'inline-edit-host'
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
      document.body.appendChild(host)
      window.__inlineEditSaves = []
      Block(b, {
        allowInlineEdit: true,
        diffActive: () => true,
        onSaveInlineEdit: (blk, text, originalSource) => {
          window.__inlineEditSaves.push({ text, originalSource })
        },
      })(host)
    })

    const host = page.locator('#inline-edit-host')
    const toggle = host.locator('[data-testid="block-inline-edit-toggle"]')
    await expect(toggle).toBeVisible()
    // Not in edit mode yet: the ordinary diff still renders.
    await expect(host.locator('[data-testid="inline-edit-wrapper"]')).toHaveCount(0)

    await toggle.click()
    await expect(host.locator('[data-testid="inline-edit-wrapper"]')).toHaveCount(1)
    const textarea = host.locator('[data-testid="inline-edit-textarea"]')
    await expect(textarea).toHaveValue(/return 2;/)

    // The highlighted overlay underneath mirrors the same text (Prism
    // tokenised, so assert on the visible text rather than the raw HTML).
    await expect(host.locator('[data-testid="inline-edit-highlight"]')).toContainText('return 2;')

    await textarea.fill('public function bar(): ?int {\n    return 3;\n}')
    await expect(host.locator('[data-testid="inline-edit-highlight"]')).toContainText('return 3;')

    await host.locator('[data-testid="inline-edit-save"]').click()

    // Editor closes again (back to the ordinary diff), and the save handler
    // received exactly the typed text plus the ORIGINAL (pre-edit) source —
    // never the write path itself; see the file header.
    await expect(host.locator('[data-testid="inline-edit-wrapper"]')).toHaveCount(0)
    const saves = await page.evaluate(() => window.__inlineEditSaves)
    expect(saves).toHaveLength(1)
    expect(saves[0].text).toContain('return 3;')
    expect(saves[0].originalSource).toContain('return 2;')
  })

  // Reviewer request: "esc moet edit sluiten zonder op te slaan (mag het wel
  // onthouden als dat nu het geval is), cmd + enter moet het opslaan" —
  // handled locally by the textarea's own @keydown (Block.mjs's
  // onTextareaKeyDown), not through home.mjs's global onKeydown (see
  // .claude/docs/inline-edit.md).
  test('Escape closes the editor without saving (draft kept), Cmd+Enter saves', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        id: 'inline-edit-test:Foo::keys',
        pr: 12903,
        category: 'ACTION',
        label: 'Foo::keys',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        endLine: 29,
        name: 'keys',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 26, end: 28, text: 'public function keys(): int {\n    return 1;\n}' },
          new: { start: 26, end: 29, text: 'public function keys(): int {\n    return 2;\n}' },
        },
      })
      const host = document.createElement('div')
      host.id = 'inline-edit-keys-host'
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
      document.body.appendChild(host)
      window.__inlineEditKeysSaves = []
      Block(b, {
        allowInlineEdit: true,
        diffActive: () => true,
        onSaveInlineEdit: (blk, text, originalSource) => {
          window.__inlineEditKeysSaves.push({ text, originalSource })
        },
      })(host)
    })

    const host = page.locator('#inline-edit-keys-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    const textarea = host.locator('[data-testid="inline-edit-textarea"]')
    await expect(textarea).toBeVisible()

    await textarea.fill('public function keys(): int {\n    return 42;\n}')
    await textarea.press('Escape')
    // Closed, nothing saved.
    await expect(host.locator('[data-testid="inline-edit-wrapper"]')).toHaveCount(0)
    expect(await page.evaluate(() => window.__inlineEditKeysSaves)).toHaveLength(0)

    // Reopening shows the SAME (draft) text — Escape never clears it, same
    // as "Annuleren".
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    await expect(host.locator('[data-testid="inline-edit-textarea"]')).toHaveValue(/return 42;/)

    // Cmd+Enter saves the current textarea value.
    await host.locator('[data-testid="inline-edit-textarea"]').press('Meta+Enter')
    await expect(host.locator('[data-testid="inline-edit-wrapper"]')).toHaveCount(0)
    const saves = await page.evaluate(() => window.__inlineEditKeysSaves)
    expect(saves).toHaveLength(1)
    expect(saves[0].text).toContain('return 42;')
  })

  test('a removed block never shows the edit toggle', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        id: 'inline-edit-test:Foo::removed',
        pr: 12903,
        category: 'ACTION',
        label: 'Foo::removed',
        status: 'removed',
        file: 'app/Foo.php',
        line: 40,
        endLine: 42,
        name: 'removed',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 40, end: 42, text: 'public function removed(): void {\n    // gone\n}' },
          new: null,
        },
      })
      const host = document.createElement('div')
      host.id = 'inline-edit-removed-host'
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
      document.body.appendChild(host)
      Block(b, { allowInlineEdit: true, diffActive: () => true })(host)
    })

    await expect(
      page.locator('#inline-edit-removed-host [data-testid="block-inline-edit-toggle"]'),
    ).toHaveCount(0)
  })

  test('draft survives across a remount and is cleared once saved', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // Mirrors home.mjs's real saveInlineEdit closely enough for this test's
      // purpose: it must clear the draft on save, exactly like the real one
      // does (via clearInlineEditDraft) — the actual startClaudeChat hand-off
      // itself is out of scope here, see the file header.
      const { clearInlineEditDraft } = await import('/src/inlineEdit.mjs')
      window.__mountInlineEditBlock = () => {
        const b = reactive({
          id: 'inline-edit-test:Foo::draft',
          pr: 12903,
          category: 'ACTION',
          label: 'Foo::draft',
          status: 'modified',
          file: 'app/Foo.php',
          line: 26,
          endLine: 29,
          name: 'draft',
          class: 'Foo',
          approved: false,
          code: {
            old: { start: 26, end: 28, text: 'public function draft(): int {\n    return 1;\n}' },
            new: { start: 26, end: 29, text: 'public function draft(): int {\n    return 2;\n}' },
          },
        })
        const host = document.createElement('div')
        host.id = 'inline-edit-draft-host'
        host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
        document.body.appendChild(host)
        window.__inlineEditDraftSaves = window.__inlineEditDraftSaves || []
        Block(b, {
          allowInlineEdit: true,
          diffActive: () => true,
          onSaveInlineEdit: (blk, text) => {
            window.__inlineEditDraftSaves.push(text)
            clearInlineEditDraft(blk)
          },
        })(host)
      }
      window.__mountInlineEditBlock()
    })

    let host = page.locator('#inline-edit-draft-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    await host.locator('[data-testid="inline-edit-textarea"]').fill('public function draft(): int {\n    return 99;\n}')
    // "Annuleren" closes the editor WITHOUT clearing the draft — only a
    // successful save does that (see clearInlineEditDraft's call site).
    await host.locator('[data-testid="inline-edit-cancel"]').click()
    await expect(host.locator('[data-testid="inline-edit-wrapper"]')).toHaveCount(0)

    // Simulate leaving and coming back: unmount, then mount a FRESH card for
    // the same block id/pr — the draft must still be there (reviewer
    // request: "je komt terug bij het blok en je tekst staat er nog").
    await page.evaluate(() => {
      document.getElementById('inline-edit-draft-host').remove()
      window.__mountInlineEditBlock()
    })
    host = page.locator('#inline-edit-draft-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    await expect(host.locator('[data-testid="inline-edit-textarea"]')).toHaveValue(/return 99;/)

    // Saving clears the draft — reopening once more starts from the
    // (still-original, since nothing landed) current source again.
    await host.locator('[data-testid="inline-edit-save"]').click()
    await page.evaluate(() => {
      document.getElementById('inline-edit-draft-host').remove()
      window.__mountInlineEditBlock()
    })
    host = page.locator('#inline-edit-draft-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    await expect(host.locator('[data-testid="inline-edit-textarea"]')).toHaveValue(/return 2;/)
  })
})

// Reviewer report: "ik zie niks in het menu als ik op geselecteerde code
// klik" — Enter and a right-click both open the SAME COMMANDS list
// (.claude/docs/command-palette.md, "The right-click context menu": one
// shared implementation, not two), so a real block-palette entry is
// exercised here via Enter — the right-click path reuses the identical
// list/openMenu('block', ...) call, unchanged by this feature, and is
// already covered by the existing right-click suite.
test.describe('Inline code editing — the block palette entry (home.mjs COMMANDS)', () => {
  test('"Bewerk deze code" only appears once the block owns the diff keyboard, and opens the same editor as the header button', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await leaveSearchBox(page)

    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md. CreatePaymentAction::execute reliably has one
    // changed row and is an ordinary `modified` PHP block.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)

    // Still list mode (no → yet): the header button isn't shown either
    // (both gate on the same diffActive()/state.mode==='diff' condition), so
    // the menu item must not appear — same rule, same result, not a special
    // case for the menu.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(page.getByTestId('command-row').filter({ hasText: 'Bewerk deze code' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // → steps into the diff — now both entry points agree it's eligible.
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('block-inline-edit-toggle')).toBeVisible()

    await page.keyboard.press('Enter')
    const editItem = page.getByTestId('command-row').filter({ hasText: 'Bewerk deze code' })
    await expect(editItem).toBeVisible()
    await editItem.click()

    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(page.getByTestId('inline-edit-wrapper')).toBeVisible()
    await expect(page.getByTestId('inline-edit-textarea')).toBeVisible()
  })
})

// Reviewer request: "als ik e druk op een code blokje die ik kan editen, dan
// wil ik het gelijk editen" — the `e` key (home.mjs's eKey/
// inlineEditEligibleNow) is a third entry point into the SAME openInlineEdit,
// gated identically to the header button/"Bewerk deze code" command.
test.describe('Inline code editing — the `e` key (home.mjs onKeydown)', () => {
  test('`e` opens the editor once the block owns the diff keyboard, and is a no-op before that', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await leaveSearchBox(page)

    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)

    // Still list mode: `e` does nothing (not eligible yet, same gate as the
    // header button/command).
    await page.keyboard.press('e')
    await expect(page.getByTestId('inline-edit-wrapper')).toHaveCount(0)

    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('block-inline-edit-toggle')).toBeVisible()

    await page.keyboard.press('e')
    await expect(page.getByTestId('inline-edit-wrapper')).toBeVisible()
    await expect(page.getByTestId('inline-edit-textarea')).toBeFocused()

    // While already editing, `e` is an ordinary character typed into the
    // textarea (DOM focus already sits there) — never toggles anything.
    await page.keyboard.press('e')
    await expect(page.getByTestId('inline-edit-wrapper')).toBeVisible()
  })
})

// Reviewer request: "'bewerk deze code' dat moet gelijk de cursor zetten in
// het midden van wat is geselecteerd" — opening the editor must focus the
// textarea AND place the caret in the middle of whatever navigation unit was
// active in the diff, not always at offset 0. See inlineEdit.mjs's
// computeInlineEditCaretOffset/scheduleInlineEditCaret and .claude/docs/
// inline-edit.md.
test.describe('Inline code editing — caret placed in the middle of the active selection', () => {
  test('computeInlineEditCaretOffset returns the middle of the given row range', async ({ page }) => {
    // A pure-function unit test (no DOM/diff dependency) for the row→offset
    // arithmetic itself — the row shape mirrors blockRows()'s own aligned
    // rows (one line per row via r.right ?? r.left).
    await page.goto('/pr/12903')
    const offsets = await page.evaluate(async () => {
      const { computeInlineEditCaretOffset } = await import('/src/inlineEdit.mjs')
      const rows = [{ right: 'aaaa' }, { right: 'bb' }, { right: 'cccccc' }]
      return {
        // row 1 ("bb") spans absolute offsets 5..7 — its own middle is 6.
        singleRow: computeInlineEditCaretOffset(rows, 1, 1),
        // rows 0..1 ("aaaa\nbb") span 0..7 — the middle of the WHOLE range.
        multiRow: computeInlineEditCaretOffset(rows, 0, 1),
        // no selection at all.
        none: computeInlineEditCaretOffset(rows, -1, -1),
      }
    })
    expect(offsets.singleRow).toBe(6)
    expect(offsets.multiRow).toBe(4)
    expect(offsets.none).toBe(null)
  })

  test('opening the editor for a specific selected unit focuses the textarea with the caret inside it, and shows ONLY that unit', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        id: 'inline-edit-test:Foo::caret',
        pr: 12903,
        category: 'ACTION',
        label: 'Foo::caret',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        endLine: 30,
        name: 'caret',
        class: 'Foo',
        approved: false,
        code: {
          old: {
            start: 26,
            end: 29,
            text: 'public function caret(): int {\n    return 1;\n}',
          },
          new: {
            start: 26,
            end: 30,
            // 4 lines — the active unit below points at rows 1..2 only
            // ("    // changed" + "    return 2;"), neither the whole
            // block's own start nor its end.
            text: 'public function caret(): ?int {\n    // changed\n    return 2;\n}',
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'inline-edit-caret-host'
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
      document.body.appendChild(host)
      Block(b, {
        allowInlineEdit: true,
        diffActive: () => true,
        // Simulates the reviewer's selection sitting on rows 1..2 ("    //
        // changed" / "    return 2;") when "Bewerk deze code" is invoked —
        // the SAME {start,end} shape activeGroup()/topLevelActiveUnit()
        // return.
        activeGroup: () => ({ start: 1, end: 2 }),
      })(host)
    })

    const host = page.locator('#inline-edit-caret-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    const textarea = host.locator('[data-testid="inline-edit-textarea"]')
    await expect(textarea).toBeVisible()
    await expect(textarea).toBeFocused()

    // Only the selected unit's own two rows are shown/editable — not the
    // whole 4-line block (reviewer follow-up: "is het handiger als je
    // alleen kan bewerken wat is geselecteerd?", a deliberate narrowing of
    // v1's "whole block" scope — see .claude/docs/inline-edit.md).
    await expect(textarea).toHaveValue('    // changed\n    return 2;')

    const value = await textarea.inputValue()
    const pos = await textarea.evaluate((el) => el.selectionStart)
    // The caret must land strictly inside the (now whole) editable text —
    // never at its very start and never at its very end.
    expect(pos).toBeGreaterThan(0)
    expect(pos).toBeLessThan(value.length)
  })
})

// Reviewer report: "als ik iets edit en ik druk cmd + enter, dan zie ik mijn
// aanpassing niet in de chat. ik wil dat de chat die aanpassing overneemt en
// direct doorvoerd" — Cmd+Enter used to only open an EMPTY Claude composer
// (nothing sent until the reviewer typed a follow-up and pressed Enter
// themselves). This is the one test in this file that goes past
// `onSaveInlineEdit` into the real `home.mjs`/`RelatedPanel.mjs` hand-off, to
// cover the actual regression: no reviewer typing, no second Enter, the
// proposed change is sent straight away. See .claude/docs/inline-edit.md
// ("'Opslaan': builds a commentTarget-shaped object...") and
// .claude/docs/claude-chat-panel.md ("Third caller of the 'open, then
// auto-send' pattern").
test.describe('Inline code editing — Cmd+Enter auto-sends the change, no manual follow-up needed', () => {
  test('saving opens a brand-new Claude chat and sends the fixed instruction sentence by itself', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await leaveSearchBox(page)

    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff

    await page.keyboard.press('e') // open the inline editor (see the `e`-key describe block above)
    const textarea = page.getByTestId('inline-edit-textarea')
    await expect(textarea).toBeFocused()
    const original = await textarea.inputValue()
    await textarea.fill('// edited by the reviewer\n' + original)

    let runId = null
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
      ),
      textarea.press('Meta+Enter'),
    ])
    runId = (await createRes.json()).runId
    expect(runId).toBeTruthy()

    try {
      // The editor is gone, and the reviewer's own bubble is the fixed
      // instruction sentence — never something they had to type or send
      // themselves.
      await expect(page.getByTestId('inline-edit-wrapper')).toHaveCount(0)
      await expect(page.getByTestId('claude-message-body').first()).toContainText(
        'Voer de hierboven voorgestelde aanpassing door.',
      )
      await expect(page.getByTestId('claude-chat-compose')).toHaveValue('')
    } finally {
      await page.request.post('/api/workflows/' + runId + '/signals/delete', {
        data: { author: 'reviewer' },
      })
    }
  })
})

// Reviewer follow-up: "is het handiger als je alleen kan bewerken wat is
// geselecteerd?" — narrows v1's "whole block, not a sub-range" scope (see
// .claude/docs/inline-edit.md) to just the currently selected navigation
// unit. Opslaan must still leave the REST of the block untouched: it merges
// the reviewer's edited fragment back into the full new-side source before
// handing it to Claude as `proposedCode` (home.mjs's saveInlineEdit).
test.describe('Inline code editing — only the selected unit is editable', () => {
  test('blockNewSourceRangeText/mergeInlineEditRangeIntoSource: extract a sub-range, then merge an edit back in leaving the rest untouched', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    const result = await page.evaluate(async () => {
      const { blockNewSourceRangeText, mergeInlineEditRangeIntoSource } = await import('/src/inlineEdit.mjs')
      const rows = [{ right: 'aaaa' }, { right: 'bb' }, { right: 'cccccc' }, { right: 'dd' }]
      return {
        // rows 1..2 only ("bb", "cccccc") — not the whole 4-row block.
        rangeText: blockNewSourceRangeText(rows, 1, 2),
        // No selection at all (-1/-1) falls back to the WHOLE block, same
        // as v1's original behaviour — still needed for list mode / a
        // direct-mount caller that never computed a unit.
        wholeBlockFallback: blockNewSourceRangeText(rows, -1, -1),
        // Replacing rows 1..2 with new text: row 0 ("aaaa") and row 3
        // ("dd") must survive completely unchanged, only the middle is the
        // reviewer's edit.
        merged: mergeInlineEditRangeIntoSource(rows, 1, 2, 'EDITED'),
        // No selection: the merge has no "rest of the block" to preserve,
        // so it returns the typed text as-is.
        mergedNoSelection: mergeInlineEditRangeIntoSource(rows, -1, -1, 'EDITED'),
      }
    })
    expect(result.rangeText).toBe('bb\ncccccc')
    expect(result.wholeBlockFallback).toBe('aaaa\nbb\ncccccc\ndd')
    expect(result.merged).toBe('aaaa\nEDITED\ndd')
    expect(result.mergedNoSelection).toBe('EDITED')
  })

  // A real end-to-end pass through Block.mjs's own onSaveInlineEdit hand-off:
  // the reviewer only ever sees/types the SELECTED unit's own two rows, but
  // the callback also receives that unit's own rowStart/rowEnd so the caller
  // (home.mjs's saveInlineEdit) can merge it back into the full source.
  test('"Opslaan" only hands over the selected unit\'s own text, plus its row range', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        id: 'inline-edit-test:Foo::scope',
        pr: 12903,
        category: 'ACTION',
        label: 'Foo::scope',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        endLine: 30,
        name: 'scope',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 26, end: 29, text: 'public function scope(): int {\n    return 1;\n}' },
          new: {
            start: 26,
            end: 30,
            text: 'public function scope(): ?int {\n    // changed\n    return 2;\n}',
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'inline-edit-scope-host'
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
      document.body.appendChild(host)
      window.__inlineEditScopeSaves = []
      Block(b, {
        allowInlineEdit: true,
        diffActive: () => true,
        // Only row 2 ("    return 2;") is selected.
        activeGroup: () => ({ start: 2, end: 2 }),
        onSaveInlineEdit: (blk, text, originalSource, rowStart, rowEnd) => {
          window.__inlineEditScopeSaves.push({ text, originalSource, rowStart, rowEnd })
        },
      })(host)
    })

    const host = page.locator('#inline-edit-scope-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    const textarea = host.locator('[data-testid="inline-edit-textarea"]')
    await expect(textarea).toHaveValue('    return 2;')
    await textarea.fill('    return 3;')
    await host.locator('[data-testid="inline-edit-save"]').click()

    const saves = await page.evaluate(() => window.__inlineEditScopeSaves)
    expect(saves).toHaveLength(1)
    expect(saves[0].text).toBe('    return 3;')
    expect(saves[0].originalSource).toBe('    return 2;')
    expect(saves[0].rowStart).toBe(2)
    expect(saves[0].rowEnd).toBe(2)
  })
})

// Reviewer report (with a screenshot): "als ik stukje code bewerk, kan ik er
// niet in scrollen" — an underestimated initial textarea height (Block.mjs's
// crude "assume 16px per line" guess) left the <textarea> itself internally
// scrollable (a plain <textarea>'s own default overflow), which silently
// captured the mouse-wheel scroll instead of it bubbling to the intended
// overflow-auto ancestor — while the highlighted <pre> underneath (which
// tracks the ancestor, not the textarea) never moved at all. Fixed by
// scheduleInlineEditGrow (inlineEdit.mjs), which corrects the textarea's own
// height to its real ta.scrollHeight right after mount. Still relevant after
// narrowing the editor's scope to just the selected unit (above), since a
// 'group'/'call' unit can still legitimately span many lines.
test.describe('Inline code editing — a long selected unit is scrollable', () => {
  test('the textarea has no internal overflow of its own, and the surrounding container actually scrolls', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const lines = []
      for (let i = 0; i < 300; i++) lines.push('    $line' + i + ' = ' + i + ';')
      const newText = 'public function big(): int {\n' + lines.join('\n') + '\n}'
      const b = reactive({
        id: 'inline-edit-test:Foo::big',
        pr: 12903,
        category: 'ACTION',
        label: 'Foo::big',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        endLine: 26 + lines.length + 1,
        name: 'big',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 26, end: 27, text: 'public function big(): int {\n}' },
          new: { start: 26, end: 26 + lines.length + 1, text: newText },
        },
      })
      const host = document.createElement('div')
      host.id = 'inline-edit-scroll-host'
      // A bounded host (unlike the other direct-mount tests' unbounded
      // fixed overlay) so the card's own overflow-auto container actually
      // has to scroll rather than just growing with the page — matching
      // the real app's column, which is bounded by the footer.
      host.style.cssText =
        'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto;display:flex;flex-direction:column;height:600px'
      document.body.appendChild(host)
      Block(b, {
        allowInlineEdit: true,
        diffActive: () => true,
        // A big SELECTED UNIT (a 'group' spanning the whole block) — the
        // case that must still be scrollable even though the editor now
        // scopes to just the selected unit.
        activeGroup: () => ({ start: 0, end: lines.length + 1 }),
      })(host)
    })

    const host = page.locator('#inline-edit-scroll-host')
    await host.locator('[data-testid="block-inline-edit-toggle"]').click()
    const textarea = host.locator('[data-testid="inline-edit-textarea"]')
    await expect(textarea).toBeVisible()
    // Wait for scheduleInlineEditGrow's requestAnimationFrame to run.
    await expect
      .poll(async () => textarea.evaluate((el) => parseFloat(el.style.height) >= el.scrollHeight))
      .toBe(true)

    const box = await textarea.boundingBox()
    await page.mouse.move(box.x + 50, box.y + 50)
    await page.mouse.wheel(0, 2000)
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const wrapper = document.querySelector('#inline-edit-scroll-host [data-testid="inline-edit-wrapper"]')
          const scrollDiv = wrapper.querySelector(':scope > div')
          return scrollDiv.scrollTop
        }),
      )
      .toBeGreaterThan(0)
  })
})
