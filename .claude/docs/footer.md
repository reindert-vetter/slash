# Footer: inline preview of the selected unit + AI description

Below the panels sits a fixed footer (`src/Footer.mjs`, `data-testid=footer`)
that shows an inline diff of whatever navigation unit currently has the
keyboard, plus a short AI explanation for an `if`.

## Visibility

The footer is **not** visible just because a diff is open — only once there is
actually something to show: `state.footerVisible`, derived in `home.mjs`'s
`updateFooter()` as `!!(state.footerUnit || state.footerExplain)`. Since every
navigable `group`/`line`/`call` unit yields at least one row, that is in
practice almost every diff-mode selection; the bar really only disappears in
list mode or with no focused block/navigable unit (`hidden` instead of `flex` on
the stable `<footer>` root — the class string stays one whole-value
`class="${() => …}"` binding, see `.claude/rules/arrowjs-pitfalls.md`).
`footerUnitInfo` (`home.mjs`) returns `null` outside `state.mode==='diff'`, so
`footerVisible` is always `false` in list mode.

## A separate, always-visible progress bar (`src/ProgressBar.mjs`)

A very thin (`PROGRESS_BAR_PX`, 3px), full-width strip sits at the TRUE
`bottom-0` of the screen (`data-testid=review-progress-bar`, fill
`data-testid=review-progress-fill`), showing PR-wide review progress: how many
of the approvable changed lines are already approved vs. the total. It reuses
`state.approvalTotal` (`{done, total}`) verbatim — the exact same combined-
approval rollup that already feeds `BlockList.mjs`'s "X/Y approved · N left to
review" heading (see "Combined approval per tree" in
`.claude/docs/approval.md`) — no new computation, just a different view on an
existing number.

**Deliberately NOT gated by `state.footerVisible`** and not part of this
component at all: this footer only shows once there's a navigation unit to
preview (hidden in list mode / with no selection, see "Visibility" above),
whereas the progress bar is a PR-wide indicator that must stay visible
everywhere the reviewer is, including list mode. It is mounted directly in
`home.mjs`, right after `Footer(state)(app)`, always.

**No text label, by deliberate choice** — only the bar. Colourblind-safe
without one (the reviewer is colourblind, see the palette rule in
`.claude/rules/conventions.md`): the ratio is carried by the **fill length**
itself (position, not colour), and the empty track (`bg-slate-200`/
`dark:bg-zinc-800`) vs. the filled portion (`bg-indigo-600`/
`dark:bg-indigo-400`) differ clearly in **lightness**, not just hue — so even a
very low, thin sliver of fill still visibly reads as "something is filled"
without relying on colour discrimination. Hidden entirely at `total === 0`
(nothing to review yet), mirroring `footerVisible`'s "nothing to show yet"
pattern. Purely informational: not clickable, no tooltip/breakdown.

**Stacking:** `PROGRESS_BAR_PX` is exported from `ProgressBar.mjs` so both
`Footer.mjs` (whose own fixed root sits at `bottom-[PROGRESS_BAR_PX]px`, not
`bottom-0`, so the two bars never overlap) and `home.mjs`'s `<main>`
bottom-reservation (adds `PROGRESS_BAR_PX` on top of `footerBoxPx(state)`
whenever the footer is visible) read the exact same figure — the same
single-source-of-truth pattern `footerBoxPx` itself already uses.
`footerReservePxSnapshot` (read by `previewTooTallForActive`, see the "Height"
section above) also folds in `PROGRESS_BAR_PX` unconditionally, since the bar
always consumes its own sliver of the bottom regardless of `footerVisible`.
When the footer is hidden, `<main>` keeps its existing `bottom-6` (24px)
gutter unchanged — the 3px bar comfortably fits inside that already-existing
space, so no separate reservation was needed there. Test:
`tests/review-progress-bar.spec.mjs`.

The theme toggle is **not** in the footer — see "Theme" in
`.claude/rules/conventions.md`.

## Height (`footerBoxPx`) and the space reserved for it

The bar's height is **content-driven** (`footerBoxPx`, exported from
`Footer.mjs`), not the old fixed 90/140px tier. It derives a px figure purely
from already-known counts — never a DOM measurement, so it can't race the same
render (the technique `Block.mjs`'s `widthCls`/`fitWidthCls` and
`RelatedPanel.mjs`'s `relatedColumnWidthCls` already use for width): a small
chrome allowance + one `FOOTER_DIFF_LINE_PX` per rendered `-`/`+` row in
`state.footerUnit`, plus — while an AI description shows — a fixed
`FOOTER_EXPLAIN_LINES_PX` reserve for its `line-clamp-2` ceiling; clamped
between `FOOTER_MIN_PX` (56) and `FOOTER_MAX_PX` (140).

**Accepted imprecision:** a visible description always reserves the full 2-line
cap even when the text needs one line — knowing which would require a DOM
text-wrap read.

`footerBoxPx(state)` is the **single source of truth** for that height:
`DetailPanel`/`<main>` (`home.mjs`) imports the exact same function for its own
bottom reservation — `bottom-6` while `!state.footerVisible`, otherwise
`` bottom-[${footerBoxPx(state)}px] `` — so the real box and the reserved space
can never drift apart. The pr-index (`BlockList.mjs`) and the PR-info column
(`PrInfoPanel`) reserve **nothing** (`bottom-6`): both are only visible in list
mode, where the footer never shows, so their old fixed `bottom-[90px]` was dead
space.

**`<main>`'s own `overflow-y` already resolves to `auto`** even though its class
list only sets `overflow-x-auto` — one non-`visible` axis forces the other to
compute as `auto` too (the same CSS rule as the TRANSLATION card's scroll
container, see `.claude/docs/diff-render.md`). So a block column taller than
`<main>`'s box already scrolls/clips cleanly within it, and nothing ever renders
*behind* the footer (`z-20`, above `<main>`'s `z-10`). A too-tall active diff is
therefore a **space-allocation** question, never a clipping bug — see "The
look-ahead preview collapses…" in `.claude/docs/diff-card.md`. Tests:
`tests/footer-height-fits-content.spec.mjs`,
`tests/footer-explanation.spec.mjs`.

## Inline diff of the active unit

The footer shows a Prism-highlighted `- old` / `+ new` diff of **every**
navigable unit — `group` included, not just a 1-line `line`/`call`. A multi-line
group shows one del/ins line pair per aligned row it spans (up to `MAX_GROUP`,
5 — `Block.mjs`), stacked inside the scrollable `footer-diff` column
(`no-scrollbar overflow-auto`). The bar grows with the row count up to
`FOOTER_MAX_PX`; only past that ceiling does a long group scroll internally.

It follows the **focused column and its cursor** — the top-level block
(`state.gran`/`state.change`) at `focusLevel 0`, or a drilled column's own
`state.drillCursor[focusLevel-1]` (see "Column navigation" in
`.claude/docs/drilling.md`) — via the same `unitsFor(rows, gran)` as
navigation, reading out rows `[unit.start, unit.end]` one by one.

- Long lines (> `WIDE_AT`, 110 characters, across **all** rows of the unit)
  release the `max-w` so the footer uses full width.
- If specifically the new/right (`ins`) line of a row exceeds `WIDE_AT`, that
  line also wraps fully (`whitespace-pre-wrap break-words`) so the whole new
  code is visible without an invisible (`no-scrollbar`) horizontal scroll; the
  old/left (`del`) line never wraps along.
- At `'call'` level the footer underlines the **active segment** in the same
  indigo as the panes, via the exported `markChars` + `UNDERLINE_CLS`
  (`Block.mjs`). At `'group'`/`'line'` the units carry no set → no underline.

The `-`/`+` gutter convention here is what the `a` toggle's `'unified'` stand
mirrors — see `.claude/docs/keyboard-navigation.md`.

## The footer never reads `blockRows`/`b.code` itself

`home.mjs` has its own decoupled footer `watch` (the
`setRelated`/`setCommentScope` pattern — inline deps incl. `state.drillCursor`
and `focusedBlock().code`) that pushes two flat snapshots:

- **`state.footerUnit`** — the aligned rows + underline arrays of the active
  unit (one row for `line`/`call`, several for a multi-line `group`). `null` for
  no unit, explicitly **never an empty array**, so both the `!!(...)` check in
  `updateFooter` and the single↔array-slot rule in `Footer.mjs` stay correct
  (see `.claude/rules/arrowjs-pitfalls.md`).
- **`state.footerExplain`** — the AI description (below).

The same `updateFooter()` then sets the derived `state.footerVisible`. This way
the footer never becomes a co-subscriber on the focused block's code (the "stuck
on loading" race) and follows a drilled cursor for free.

## AI description for an if statement (`explain_code`)

If the text of the focused **`group`- or `line`** unit (never `call`, diff mode
only) contains an `if`/`elseif`/`else if` (`reIfStatement` in `home.mjs` — a
bare regex on the line text; false positives in strings/comments deliberately
accepted), the footer shows a short AI explanation above the inline diff
(`data-testid=footer-description`) of what the condition checks and when the
branch runs.

It comes from the `explanations` read model (`GET /api/explanations?pr=N`),
generated by the **`explain_code`** workflow (see
`.claude/docs/workflows-analysis.md`). Generation starts **automatically** with
a debounce (`EXPLAIN_DEBOUNCE_MS`, 600ms — so arrowing through triggers
nothing) via `POST /api/workflows/explain_code`, client-side deduped
(`explainRequested`) and server-side idempotent (a deterministic Run ID per
unit+code-hash). While the run is in progress the line shows "Generating AI
description…" (pulsing); a `failed` row (offline, `SLASH_CLAUDE=off`) hides the
line again.

A row matches on `blockId|unitKey` (unitKey = `group-<start>-<end>`/
`line-<row>`, the same codeRef shape as `commentPath`) **plus** a code-hash
check (`fnv1a` over `EXPLAIN_PROMPT_VERSION + '|' + code + context`): a stale
row from before a new commit — or from before a prompt change that bumped
`EXPLAIN_PROMPT_VERSION` — is ignored and regenerated. A seeded row with an
empty hash always matches (test fixtures).

The prompt caps the answer at ~40 words / ~275 characters, measured against
`line-clamp-2` at the footer's real width, so it fits the two-line clamp without
being cut off. While the description shows, the footer's own height grows
accordingly (`footerBoxPx` above) and `<main>` reserves that same height, so
nothing shifts behind the footer. Test: `tests/footer-explanation.spec.mjs`
(incl. the drilled-column case).
