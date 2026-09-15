import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// Inline, IDE-style editing of a diff block's new/right side (Block.mjs's
// inlineEditToggleButton/inlineEditorSlot, home.mjs's saveInlineEdit). See
// CLAUDE.md's inline-edit design notes: "Opslaan" never commits/writes
// anything directly — it hands the edited text to a brand-new Claude chat
// (startClaudeChat) as invisible first-turn context, so this is asserted
// purely via a spy on the onSaveInlineEdit callback (the actual
// startClaudeChat/claude_chat wiring is already covered by
// tests/claude-chat-panel.spec.mjs and is unrelated to this feature's own
// logic: eligibility, the toggle, the overlay editor, the draft, and the
// precise staleness detection).
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
