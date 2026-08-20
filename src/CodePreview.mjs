// CodePreview.mjs — the standalone code-preview column shown next to the
// comment/Claude-chat row whenever it contains a fenced code block (see
// markdown.mjs's extractCodeFences and RelatedPanel.mjs's
// recomputeCodePreviews/CodePreviewPanel, which owns the reactive `cp` state
// this file only renders). Pure template, no reactive() state of its own and
// no import of RelatedPanel.mjs — the same split ClaudeChat.mjs/
// translationDiff.mjs already have with their owning module, so there is no
// circular import.
//
// D1 (see .claude/docs/claude-chat-panel.md, "A full-size code-preview
// column"): this is deliberately NOT a real line-diff. There is no
// clientside diff algorithm in this codebase — the existing diff rendering
// (Block.mjs's codeDiff/unifiedCodeDiff) works only on `rows` the backend
// already shaped from the PR's own git hunks, not on two arbitrary strings.
// Building/vendoring a diff algorithm for this one feature was judged out of
// proportion; instead the two sides render as independently Prism-highlighted
// panes, stacked "Huidig" above "Voorgesteld" below — literally what was
// asked ("onder elkaar, oude boven, nieuwe onder"), without colour-coded
// line-level comparison. A follow-up can add real diffing later.
//
// D2/D3 reversed (reviewer request, see claude-chat-panel.md): the column is
// no longer opened by clicking (the "Bekijk volledig ↗" button that used to do
// that has since been removed entirely) and no longer closable — it is ALWAYS on, showing every code fence currently visible in
// the comment/Claude columns (a `suggestion` fence included, see
// markdown.mjs), stacked in ONE column instead of one column per fence
// (chosen over N columns growing <main>'s horizontal scroll — see the
// reviewer's own "gestapeld in één kolom" answer).
//
// D3 reversed AGAIN (a later reviewer request, "Always on, stacked BELOW
// (reversing D3 again)" in claude-chat-panel.md): this used to be a sibling
// column to the RIGHT of comment-claude-row with its own fixed w-[42rem].
// It now renders as a row BELOW comment-claude-row (home.mjs), so
// `codePreviewColumn`'s root takes the FULL width of that row (`w-full`)
// instead of a narrow fixed column — home.mjs no longer wraps it in a
// `flex items-start` row with comment-claude-row, so nothing constrains its
// width but its own content.
import { html } from './vendor/arrow.js'
import { highlightForLang } from './Block.mjs'

function pane(titleText, code, lang) {
  return html`
    <div class="rounded border border-slate-200 dark:border-zinc-700 overflow-hidden">
      <div
        class="px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border-b border-slate-200 dark:border-zinc-700"
      >
        ${titleText}
      </div>
      <pre
        class="code m-0 max-h-[40vh] overflow-auto p-2 text-xs leading-relaxed"
      ><code class="language-php" .innerHTML="${() => highlightForLang(code, lang)}"></code></pre>
    </div>
  `
}

// previewCard renders ONE fence's preview ("Huidig (PR)"/"Voorgesteld (chat)"
// pair, or a single "Codeblok" pane when there is no current-code comparison
// — D4 in claude-chat-panel.md; since that rule was sharpened, only a
// ```suggestion fence ever gets the pair, an ordinary fence always shows the
// single pane). `it` is a plain (non-reactive) snapshot
// object — RelatedPanel.mjs replaces `cp.items` wholesale on every
// recompute, never mutates an item in place, so nothing here needs its own
// `${() => ...}` binding on `it`'s fields themselves; only the Prism
// highlighting (via `pane`) is wrapped reactively, mirroring the previous
// single-item version.
//
// `active` is the ONE exception to that plain-snapshot rule: it is a getter
// (`() => cs.previewPos === i + 1`, see RelatedPanel.mjs's own preview cursor)
// wired into whole-value `class`/`data-active` bindings, so walking the cards
// with ↓/↑ only re-applies those attribute slots instead of re-keying (and
// thereby re-Prism-highlighting) the whole card on every step. The cursor is
// deliberately NOT part of `.key(it.key)` for exactly that reason. Same
// border/ring pair as every other selected card in this file
// (`related-item`), plus a leading ▸ glyph on the title so the state is
// carried by a SHAPE, not only by colour (colourblind rule).
function previewCard(it, active) {
  return html`
    <div
      class="${() =>
        'flex flex-col gap-2 rounded-xl border bg-white dark:bg-zinc-900 p-3 ' +
        (active()
          ? 'border-indigo-300 dark:border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5')}"
      data-testid="code-preview-card"
      data-active="${() => (active() ? 'true' : 'false')}"
    >
      <span class="truncate text-[11px] font-medium text-slate-500 dark:text-zinc-500" data-testid="code-preview-title">
        ${() => (active() ? '▸ ' : '')}${it.title}
      </span>
      <div class="flex flex-col gap-2" data-testid="code-preview-body">
        ${() => (it.oldCode != null ? pane('Huidig (PR)', it.oldCode, it.lang) : '')}
        ${() => pane(it.oldCode != null ? 'Voorgesteld (chat)' : 'Codeblok', it.code, it.lang)}
      </div>
    </div>
  `.key(it.key)
}

// codePreviewColumn(getItems) — `getItems` reads `cp.items`, a plain array
// RelatedPanel.mjs's recomputeCodePreviews reassigns wholesale (never
// mutated in place). Called from inside a `${() => ...}` binding here (not
// read directly) so a later recompute (new fence appearing, a fence's
// content changing while a Claude turn streams, navigating to a different
// block) always repaints, never freezing on the first-computed set (the
// static chunk-reuse pitfall in arrowjs-pitfalls.md).
//
// `isActive(i)` answers "does the keyboard cursor sit on the i-th card"
// (RelatedPanel.mjs's cs.previewPos, reached with ↓ from the bottom of the
// Claude chat — see "↓ walks the chat's own code blocks" in
// claude-chat-panel.md). Defaulted so a future caller that has no cursor of
// its own can keep passing one argument.
export function codePreviewColumn(getItems, isActive = () => false) {
  return html`
    <div class="flex w-full shrink-0 flex-col gap-3" data-testid="code-preview-column">
      ${() => getItems().map((it, i) => previewCard(it, () => isActive(i)))}
    </div>
  `
}
