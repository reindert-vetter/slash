import { test, expect } from './_fixtures.mjs'

// Change navigation: from the sidebar (list mode) → steps into the selected
// block's diff and selects the first changed line; ↑/↓ then walk the change
// groups; ← steps back out. Consecutive changed lines collapse into one group,
// but a run longer than 5 rows is split into successive groups. See home.mjs +
// Block.mjs (changeGroups / paneHTML active highlight).
test.describe('PR Review Tree — change navigation', () => {
  test('changeGroups collapses runs and splits every 5 rows', async ({ page }) => {
    await page.goto('/pr/12903')
    // Let the app's initial module load + lazy fetches settle; otherwise an
    // in-page evaluate() can race the load and hit "context destroyed".
    await page.waitForLoadState('networkidle')
    const groups = await page.evaluate(async () => {
      const { changeGroups } = await import('/src/Block.mjs')
      // Changed rows carry letter text so the MAX_GROUP split is allowed to fall
      // on them (the split only lands on a row with an actual letter — see
      // hasLetter in Block.mjs).
      const mk = (n, changed) =>
        Array.from({ length: n }, (_, i) =>
          changed
            ? { left: `old${i}`, right: `new${i}`, leftMark: 'del', rightMark: 'ins' }
            : { left: 'kept', right: 'kept', leftMark: null, rightMark: null },
        )
      // 8 changed rows, an unchanged gap, then 2 more changed rows.
      const rows = [...mk(8, true), ...mk(1, false), ...mk(2, true)]
      return changeGroups(rows)
    })
    // 8 changed → [0..4] + [5..7]; gap at 8 resets; 2 changed → [9..10].
    expect(groups).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 7 },
      { start: 9, end: 10 },
    ])
  })

  test('a long run of bracket-only rows is NOT split (needs a letter to break)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const groups = await page.evaluate(async () => {
      const { changeGroups } = await import('/src/Block.mjs')
      // 7 changed rows whose text is just braces — over MAX_GROUP, but none carries
      // a letter, so the split is suppressed and they stay one group. The two
      // sides must differ (`{` vs `}`), else it reads as a whitespace-only
      // re-alignment and wouldn't count as a change at all (wsOnly).
      const rows = Array.from({ length: 7 }, () => ({
        left: '{',
        right: '}',
        leftMark: 'del',
        rightMark: 'ins',
      }))
      return changeGroups(rows)
    })
    expect(groups).toEqual([{ start: 0, end: 6 }])
  })

  test('an active group is highlighted with an anchor on both panes', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::bar',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        approved: false,
        code: {
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: {
            start: 26,
            end: 29,
            text: "public function bar(): ?int {\n    $x = 'hi';\n    return $x;\n}",
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'nav-host'
      document.body.appendChild(host)
      // Highlight the first change group (the paired signature/return lines).
      Block(b, { activeGroup: () => ({ start: 0, end: 2 }) })(host)
    })

    const host = page.locator('#nav-host')
    // One anchor per pane (first row of the group), so two in total.
    await expect(host.locator('[data-change-active]')).toHaveCount(2)
    // Active rows get the brighter hex tints (rose-200/emerald-200 mixed 20%
    // toward white) — #fed7dc = active del, #b9f5d9 = active ins. See paneHTML.
    await expect(host.locator('div[class*="#fed7dc"]')).toHaveCount(2)
    await expect(host.locator('div[class*="#b9f5d9"]')).toHaveCount(3)
  })

  test('→ steps into the diff (panel expands, first change stays highlighted), ← steps back out', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first now, see
    // categoryRank in home.mjs) has no local diff to step through; select
    // block 1 (CreatePaymentAction::execute), the block with a reliable
    // change used by the rest of this file's cross-block-flow tests.
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)

    // Wait for the selected block's diff to load.
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()

    // In list mode the selected block already *previews* its first change (the
    // very group → steps onto), and the panel sits in its narrow list layout.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(panel).toHaveClass(/left-\[29rem\]/)

    // → steps in: mode flips to diff, the panel expands to full width, and the
    // first change is still highlighted.
    await page.keyboard.press('ArrowRight')
    await expect(panel).toHaveClass(/left-6/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // ← steps back out: the panel returns to the narrow list layout.
    await page.keyboard.press('ArrowLeft')
    await expect(panel).toHaveClass(/left-\[29rem\]/)
  })

  // Cross-block flow only continues within the SAME file. In the fixture,
  // block 0 (ContractController::index) sorts first as the sole CONTROLLER
  // (see categoryRank in home.mjs), then blocks 1 and 2 are both
  // CreatePaymentAction.php (linked by the connector) while block 3 is a
  // different file (ProcessCartAction.php). Walking ↓ off the end of block 1
  // should flow into block 2, but must stop at the file boundary before
  // block 3. Walking ↑ off the top of block 2 flows back into block 1 and stops.
  const selected = (page, i) => expect(page.locator(`[data-idx="${i}"]`))

  test('↓ flows into the next same-file block but stops at the file boundary', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await selected(page, 1).toHaveClass(/bg-indigo-50/)
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()

    // Step into block 1's diff, then walk down well past its changes. More presses
    // than either block can have groups, so we're guaranteed to reach the boundary.
    await page.keyboard.press('ArrowRight')
    for (let n = 0; n < 40; n++) await page.keyboard.press('ArrowDown')

    // Landed on block 2 (same file) and never crossed into block 3 (other file).
    await selected(page, 2).toHaveClass(/bg-indigo-50/)
    await selected(page, 3).not.toHaveClass(/bg-indigo-50/)
  })

  test('↑ flows back into the previous same-file block and stops at the top', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Block 2 (findOrCreateCustomer) carries no local diff of its own, so
    // entering the diff directly on it would silently no-op (enterDiff bails
    // when groupsFor(b) is empty). Step in via block 1 (execute, the reliable
    // diff) and flow all the way down into block 2 first (same mechanism as
    // the previous test), then reverse: flowing back up must land on block 1
    // and stop there — block 0 is a different file, so there's no earlier
    // same-file neighbour to flow into.
    await page.locator('[data-idx="1"]').click()
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()

    await page.keyboard.press('ArrowRight')
    for (let n = 0; n < 40; n++) await page.keyboard.press('ArrowDown')
    await selected(page, 2).toHaveClass(/bg-indigo-50/) // sanity: flowed into block 2

    for (let n = 0; n < 40; n++) await page.keyboard.press('ArrowUp')

    // Flowed back into block 1 and stopped there (no previous same-file block).
    await selected(page, 1).toHaveClass(/bg-indigo-50/)
  })

  // Comments are the task_code_comment workflow; seeding one is the only write
  // path (POST /api/workflows/task_code_comment). A "+ Comment op deze regel"
  // button leads the list; clicking a comment opens its thread. See RelatedPanel
  // (commentsSection). The comments/taken sidebar is a fixed overlay toggled
  // with Cmd+ArrowRight (see detail-layout.md), so it must be opened first. The server
  // runs with SLASH_GITHUB=off so seeding never touches a real repo.
  test('the new-comment button leads the list; clicking a comment opens its thread', async ({
    page,
    request,
  }) => {
    // Seed two comments on a PR of this test's own (the comments read-model is
    // shared across the parallel run, so seeding the default 12903 would collide
    // with the other comment specs). This test only exercises the comment panel,
    // not the diff, so it needs no ingested blocks. The first comment carries a
    // code snippet so we can assert the thread shows it (like the composer
    // preview) — a comment without code shows no hint.
    const pr = 970002
    const seeds = [
      {
        body: 'first review comment',
        code: '$upsellOrder->billingAddress()->save($order->billingAddress);',
        gran: 'line',
        label: 'AddUpsell::execute',
      },
      { body: 'second review comment' },
    ]
    for (const s of seeds) {
      const res = await request.post('/api/workflows/task_code_comment', {
        data: { pr, file: 'seed.php', line: 1, author: 'test', ...s },
      })
      expect(res.ok()).toBeTruthy()
    }

    await page.goto('/pr/' + pr)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('Meta+ArrowRight') // open the comments/taken sidebar
    const panel = page.getByTestId('comments-sidebar')
    const items = panel.getByTestId('comment-item')
    const active = /bg-indigo-50/

    // The new-comment button leads the list, and both seeded comments show.
    await expect(panel.getByTestId('new-comment')).toBeVisible()
    await expect(items).toHaveCount(2)

    // Clicking a comment selects it and its thread header follows; a comment
    // with a snippet shows the code hint in its thread (like the composer).
    await items.nth(0).click()
    await expect(items.nth(0)).toHaveClass(active)
    await expect(items.nth(1)).not.toHaveClass(active)
    const thread = panel.getByTestId('comment-thread')
    await expect(thread).toContainText('first review comment')
    await expect(thread.getByTestId('comment-target')).toBeVisible()
    await expect(thread.getByTestId('comment-target')).toContainText('billingAddress')

    // The second comment has no snippet, so its thread shows no code hint.
    await items.nth(1).click()
    await expect(thread.getByTestId('comment-target')).toHaveCount(0)
  })

  // The Onderliggende-code card (RelatedPanel's default export) renders all
  // children as one flat vertical list, inline next to the diff, unaffected by
  // the comments/taken sidebar. ↓/↑ walk the list (↓ clamps on the last child,
  // ↑ from the first exits back to the diff); ← returns to the diff from any
  // child. Mount RelatedPanel directly with mock children + drive the exported
  // nav functions so the test is independent of the fixture's child count.
  // See RelatedPanel (enterRelated / handleRelatedKey / relatedCard).
  test('↓/↑ walk the underlying-code list, ↑ from first exits', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const state = reactive({ pr: 12903, blocks: [], allBlocks: [], selected: 0 })
      const host = document.createElement('div')
      host.id = 'related-host'
      document.body.appendChild(host)
      mod.default(state, () => null, { startCallSearch: () => {} })(host)
      // Three children so we can prove ↓ advances and then clamps on the last.
      const kids = [0, 1, 2].map((i) => ({
        id: 'c' + i,
        label: 'Foo::m' + i,
        file: 'app/Foo.php',
        line: 10 + i,
        kind: 'method_call',
        code: 'public function m' + i + '() {}',
      }))
      mod.setRelated(kids, [])
      window.__rp = mod
    })

    const host = page.locator('#related-host')
    const items = host.getByTestId('related-item')
    const activeAt = (i) => expect(items.nth(i)).toHaveAttribute('data-active', 'true')
    const inactiveAt = (i) => expect(items.nth(i)).toHaveAttribute('data-active', 'false')
    const key = (k) => page.evaluate((k) => window.__rp.handleRelatedKey(k), k)

    await expect(items).toHaveCount(3)
    // No more →/↓ hint element — children render as a flat vertical list.
    await expect(host.getByTestId('related-hint')).toHaveCount(0)

    // Enter from the diff → first child selected.
    await page.evaluate(() => window.__rp.enterRelated())
    await activeAt(0)
    await inactiveAt(1)

    // ↓ walks down the list to the next child, and clamps on the last one.
    await key('ArrowDown')
    await activeAt(1)
    await key('ArrowDown')
    await activeAt(2)
    await key('ArrowDown') // clamp: stays on the last child
    await activeAt(2)

    // ↑ walks back up the list.
    await key('ArrowUp')
    await activeAt(1)
    await key('ArrowUp')
    await activeAt(0)

    // ↑ from the first child exits the card back to the diff: no child selected.
    await key('ArrowUp')
    await inactiveAt(0)

    // ← also exits back to the diff from any child, same as ↑ from the first.
    await page.evaluate(() => window.__rp.enterRelated())
    await key('ArrowDown') // 2nd child
    await activeAt(1)
    await key('ArrowLeft')
    await inactiveAt(1)
  })

  // Selection granularity: f refines group → line → call, d coarsens back. See
  // home.mjs (setGran/GRANS/unitsFor) + Block.mjs (changeLines/changeCalls).
  test('changeLines and changeCalls split a group into lines then call segments', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const out = await page.evaluate(async () => {
      const { changeGroups, changeLines, changeCalls } = await import('/src/Block.mjs')
      // A modified row (its new line is a two-call chain), a one-sided added row,
      // and a pure deletion (old removed, no replacement).
      const rows = [
        { left: '$order->name();', right: '$order->customer()->name();', leftMark: 'del', rightMark: 'ins' },
        { left: null, right: '$extra = 1;', leftMark: null, rightMark: 'ins' },
        { left: '$gone->bye();', right: null, leftMark: 'del', rightMark: null },
      ]
      const calls = changeCalls(rows)
      return {
        groups: changeGroups(rows),
        lines: changeLines(rows),
        // A call unit is a single-row range carrying char() + underline sets.
        calls: calls.map((e) => ({
          row: e.start,
          char: !!e.char,
          left: [...e.left].length,
          right: [...e.right].length,
        })),
      }
    })
    // One group spanning all three rows; lines cover only the new-code rows.
    expect(out.groups).toEqual([{ start: 0, end: 2 }])
    expect(out.lines).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ])
    // Row 0 splits into its whole-line call segments (`$order`, `->customer()`,
    // `->name();`) — every segment, not just the changed one; the `;` rides along
    // with its call. Row 1 is one segment ending in `;`. Row 2 (pure deletion) is
    // a single empty-new unit.
    const byRow = (r) => out.calls.filter((c) => c.row === r)
    expect(byRow(0).length).toBe(3)
    expect(byRow(1).length).toBe(1)
    expect(byRow(2).length).toBe(1)
    // Every new-code segment marks new (right) chars; the deletion marks only old.
    for (const c of byRow(0)) expect(c.right).toBeGreaterThan(0)
    expect(byRow(2)[0]).toMatchObject({ char: true, right: 0 })
    expect(byRow(2)[0].left).toBeGreaterThan(0)
  })

  // A blank line that's purely part of the diff (e.g. inside a wholly added
  // function) is diff noise, not reviewable content — see rowHasContent in
  // Block.mjs. It must not inflate changedRows()/the approve total, and must
  // not be its own landable unit on the finer granularities (changeLines /
  // changeCalls) — that's what made it feel like "there's an approvable spot
  // here but I can't see anything". It still rides along inside whichever
  // changeGroups() run it falls in, so the group's highlighted range doesn't
  // jump around it.
  test('a blank added/removed row is diff noise: not counted, not its own line/call unit', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const out = await page.evaluate(async () => {
      const { changeGroups, changeLines, changeCalls, changedRows } = await import(
        '/src/Block.mjs'
      )
      // Row 0: real added line. Row 1: a blank added line (e.g. spacing inside
      // a wholly added function). Row 2: real added line again — same run.
      const rows = [
        { left: null, right: '$a = 1;', leftMark: null, rightMark: 'ins' },
        { left: null, right: '', leftMark: null, rightMark: 'ins' },
        { left: null, right: 'return $a;', leftMark: null, rightMark: 'ins' },
      ]
      return {
        groups: changeGroups(rows),
        lines: changeLines(rows),
        calls: changeCalls(rows).map((u) => u.start),
        changed: changedRows(rows),
      }
    })
    // The blank row still rides along inside the one group run — no break.
    expect(out.groups).toEqual([{ start: 0, end: 2 }])
    // But it's never its own line unit, and never counted toward the total.
    expect(out.lines).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ])
    expect(out.calls).not.toContain(1)
    expect(out.changed).toEqual([0, 2])
  })

  // Same blank-row exclusion for a pure deletion (old side blank, no
  // replacement) — the display side there is the old (left) text.
  test('a blank pure-deletion row is diff noise too', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const out = await page.evaluate(async () => {
      const { changeLines, changeCalls, changedRows } = await import('/src/Block.mjs')
      const rows = [
        { left: '$a = 1;', right: null, leftMark: 'del', rightMark: null },
        { left: '', right: null, leftMark: 'del', rightMark: null },
        { left: 'return $a;', right: null, leftMark: 'del', rightMark: null },
      ]
      return {
        lines: changeLines(rows), // pure deletions are never line-granular anyway
        calls: changeCalls(rows).map((u) => u.start),
        changed: changedRows(rows),
      }
    })
    expect(out.lines).toEqual([])
    expect(out.calls).not.toContain(1)
    expect(out.changed).toEqual([0, 2])
  })

  // A `??` (and its siblings `&&`/`||`/comparisons) joins two independent call
  // chains, so segmentCalls must break there — otherwise the operator gets
  // swallowed into one caller's segment and the two callers can't be separated.
  test('changeCalls splits a line at `??` so the two callers are separate segments', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const segs = await page.evaluate(async () => {
      const { changeCalls } = await import('/src/Block.mjs')
      const rows = [
        {
          left: '$contract->address->company ?? $contract->address->full_name,',
          right: '$contract->billingAddress->company ?? $contract->billingAddress->full_name,',
          leftMark: 'del',
          rightMark: 'ins',
        },
      ]
      // Return the trimmed text each unit underlines on the new (right) side.
      return changeCalls(rows).map((u) =>
        rows[0].right
          .split('')
          .filter((_, i) => u.right.has(i))
          .join('')
          .trim(),
      )
    })
    // `$contract` / `->billingAddress` / `->company` / `?? $contract` / … — the
    // `??` starts a fresh segment (`?? $contract`), splitting the two callers.
    expect(segs).toContain('?? $contract')
    // The first caller's tail ends at `??`, never spanning across it.
    expect(segs.some((s) => s.includes('??') && s !== '?? $contract')).toBe(false)
    expect(segs).toContain('->company')
  })

  // A call is split into the caller name and each of its arguments, and a string
  // argument (with a `.` inside, PHP concatenation) is never cut — segmentCalls
  // treats strings as opaque and splits only at the outermost `(` / argument `,`.
  test('changeCalls splits a call into caller name + each argument, keeping strings whole', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const segs = await page.evaluate(async () => {
      const { changeCalls } = await import('/src/Block.mjs')
      const rows = [
        {
          left: "$couple->where('type', $mapping[$type]);",
          right: "$couple->orWhere('contracts.type', $mapping[$type]);",
          leftMark: 'del',
          rightMark: 'ins',
        },
      ]
      // The trimmed text each unit underlines on the new (right) side.
      return changeCalls(rows).map((u) =>
        rows[0].right
          .split('')
          .filter((_, i) => u.right.has(i))
          .join('')
          .trim(),
      )
    })
    // Caller name, then each parameter on its own — the `.` inside the string
    // argument stays whole (regression guard).
    expect(segs).toEqual([
      '$couple',
      '->orWhere(',
      "'contracts.type',",
      '$mapping[$type]);',
    ])
    expect(segs).toContain("'contracts.type',")
  })

  test('a call-granularity unit underlines only its segment (indigo), not the rest', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/Block.mjs')
      const Block = mod.default
      const b = reactive({
        category: 'RESOURCE',
        label: 'Foo::toArray',
        status: 'modified',
        file: 'app/Foo.php',
        line: 13,
        approved: false,
        code: {
          // One modified line whose new side is a call chain; changeCalls splits it
          // into segments `'city' => $this`, `->resource`, `->city,`.
          old: { start: 1, end: 1, text: "'city' => $address->city," },
          new: { start: 1, end: 1, text: "'city' => $this->resource->city," },
        },
      })
      const host = document.createElement('div')
      host.id = 'char-host'
      document.body.appendChild(host)
      // Select the `->resource` segment (index 1). paneHTML underlines its chars.
      const seg = mod.changeCalls(mod.blockRows(b))[1]
      Block(b, { activeGroup: () => seg })(host)
    })

    const host = page.locator('#char-host')
    const ul = 'span[class*="decoration-[#6366f1]"]'
    // The active segment is underlined on the new pane…
    await expect(host.locator(ul).first()).toBeVisible()
    await expect(host.locator(`${ul}`, { hasText: 'resource' })).not.toHaveCount(0)
    // …but the neighbouring `city` segment is never underlined.
    await expect(host.locator(`${ul}`, { hasText: 'city' })).toHaveCount(0)
  })

  test('f on a single-line group jumps straight to call; d coarsens back', async ({
    page,
  }) => {
    // Use block 1 (CreatePaymentAction::execute, proven to load in the other
    // nav tests — block 0 is now ContractController::index, the CONTROLLER
    // sorted first, which carries no local diff). Its first change group
    // spans a single row, so refining it with f has no meaningful 'line' step
    // (line == the whole group) and jumps straight to 'call'. See home.mjs
    // (setGran).
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Active rows (any granularity) carry the inset indigo left bar; count them
    // across both panes as a granularity-agnostic "how many rows are selected".
    const activeRows = panel.locator('div[class*="inset_3px_0_0"]')
    const underline = panel.locator('span[class*="decoration-[#6366f1]"]')

    // Step in at the default (group) granularity — a single row here.
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page).not.toHaveURL(/gran=/) // group is the default → omitted
    await expect(activeRows.first()).toBeVisible()
    const groupCount = await activeRows.count()
    expect(groupCount).toBe(2) // a single-row group: one row × two panes

    // f → call directly (skipping line): gran=call, still one row, and now the
    // segment's chars carry the indigo underline (same colour as the inset bar).
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)
    await expect(activeRows).toHaveCount(2)
    await expect(underline.first()).toBeVisible()

    // d walks back down the levels one step at a time: call → line (no underline).
    await page.keyboard.press('d')
    await expect(page).toHaveURL(/gran=line/)
    await expect(underline).toHaveCount(0)

    // d → group: gran param drops back to the default and the group count returns.
    await page.keyboard.press('d')
    await expect(page).not.toHaveURL(/gran=/)
    await expect(activeRows).toHaveCount(groupCount)
  })

  // Regression guard: a plain change-step within the same block must only move
  // the active-group highlight, not rebuild the card. canStep() (which drives the
  // grey step-chevron) reads state.change/mode/focusLevel; calling it directly
  // inside the DetailPanel block-column's outer array-building closure (rather
  // than in its own nested reactive slot) used to make THAT closure depend on
  // state.change, forcing a fresh Block() call (fresh activeGroup/hintsEnabled/
  // etc. closures) — and therefore a fresh attribute patch across the WHOLE card
  // (article class, category/status badges, description, approve checkbox) — on
  // every single step, a visible flicker for what should be just the highlight
  // moving. See stepChevronSlot in home.mjs / the flicker note in
  // detail-layout.md. Block 1's (CreatePaymentAction::execute) first change
  // group is a single row with several call segments (see the previous test),
  // so refining to 'call' and stepping to the next segment stays within the
  // same block while state.change advances — exactly the scenario that used
  // to flicker.
  test('a change-step within the same block only patches the highlight, not the whole card', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // single-row group → jumps straight to 'call'
    await expect(page).toHaveURL(/gran=call/)
    await expect(page).not.toHaveURL(/chg=/) // first call segment → index 0, omitted

    // Watch every attribute mutation on the block column for the next step. The
    // active-row highlight itself is a .innerHTML replace inside <code> (not an
    // attribute), so a clean highlight-only update records zero attribute
    // mutations here.
    await page.evaluate(() => {
      window.__mutations = 0
      const target = document.querySelector('[data-testid="block-column"]')
      window.__obs = new MutationObserver((records) => {
        window.__mutations += records.length
      })
      window.__obs.observe(target, { attributes: true, subtree: true })
    })

    await page.keyboard.press('f') // next call segment, same block
    await expect(page).toHaveURL(/chg=1/)
    await page.waitForTimeout(200)

    const mutations = await page.evaluate(() => window.__mutations)
    expect(mutations).toBe(0)

    // The highlight itself DID move.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(panel.locator('span[class*="decoration-[#6366f1]"]').first()).toBeVisible()
  })

  // On the finest 'call' level f no longer zooms in — it steps to the *next* call
  // (fKey → nextChange, the same flow as ↓). s always zooms straight back out
  // (sKey → setGran(-1)), never walking the calls. See home.mjs.
  test('on the call level f steps to the next call and s zooms back out', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index) carries no local diff now that
    // CONTROLLER sorts first — select block 1 (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()

    // Step in and zoom to a single call segment (single-row group → straight to call).
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)
    await expect(page).not.toHaveURL(/chg=/) // first call → index 0, omitted

    // On 'call', f advances to the next call segment instead of zooming further.
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)
    await expect(page).toHaveURL(/chg=1/)

    // s zooms straight back out to line, dropping to the coarser level.
    await page.keyboard.press('s')
    await expect(page).toHaveURL(/gran=line/)
  })

  // The footer shows the selected change as an inline diff, but only when the
  // active unit spans a single row. Refining with f down to a line (or call
  // segment) always yields a single-row unit, so the footer always surfaces it, and
  // on a 'call' unit it mirrors the pane's indigo segment underline. See Footer.mjs
  // (activeUnit via unitsFor, line() with the underline set).
  test('the footer surfaces the selected change and underlines the active call segment', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index) carries no local diff now that
    // CONTROLLER sorts first — select block 1 (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    const footer = page.getByTestId('footer')
    const footerDiff = footer.getByTestId('code-diff')

    // Step into the diff of block 1 (single-row first group) and refine:
    // f jumps straight to call, still one row, so the footer shows the +/- diff and
    // the active segment carries the same indigo underline as the pane.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)
    await expect(footerDiff.locator('div.block')).not.toHaveCount(0)
    await expect(footer.locator('span[class*="decoration-[#6366f1]"]').first()).toBeVisible()

    // Coarsen to line: still one row, footer keeps showing, underline gone.
    await page.keyboard.press('d')
    await expect(page).toHaveURL(/gran=line/)
    await expect(footerDiff.locator('div.block')).not.toHaveCount(0)
    await expect(footer.locator('span[class*="decoration-[#6366f1]"]')).toHaveCount(0)
  })

  // The footer bar's own visibility is state.footerVisible
  // (!!(footerUnit || footerExplain), see Footer.mjs/home.mjs), not simply
  // state.mode==='diff' — a multi-row 'group' unit with no if-statement hides
  // the bar entirely (see footer-explanation.spec.mjs). This block's first
  // group happens to contain an if, so footerExplain keeps the bar visible
  // here even though the group is multi-row and shows no inline diff content;
  // it still hides in list mode (no diff open at all → footerUnitInfo is
  // null).
  test('the footer bar is hidden in list mode and visible for any diff granularity', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    const footer = page.getByTestId('footer')

    // List mode: no diff open, footer hidden.
    await expect(footer).toBeHidden()

    // Step into the diff (starts on 'group'): footer visible even if the
    // group spans multiple rows.
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/sel=/)
    await expect(footer).toBeVisible()

    // ← back to the list: hidden again.
    await page.keyboard.press('ArrowLeft')
    await expect(footer).toBeHidden()
  })
})
