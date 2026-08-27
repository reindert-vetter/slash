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
// It now renders as a row BELOW comment-claude-row (home.mjs) — home.mjs no
// longer wraps it in a `flex items-start` row with comment-claude-row.
//
// A plain `w-full` here (100% of the unconstrained, shrink-to-fit
// `comments-and-related` ancestor) turned out not to bound this column at
// all: an oversized child (a long unwrapped context line, see previewCard's
// own doc comment in this file) could still push that ancestor — and thus
// this "full width" column — wider than comment-claude-row itself, spilling
// the card out past it (reviewer report, screenshot). `codePreviewColumn`'s
// root now takes RelatedPanel.mjs's `commentClaudeRowWidthCls(state)` — the
// row's own real, bounded width — as its width class instead.
import { html } from './vendor/arrow.js'
import { highlightForLang, scrollHint } from './Block.mjs'
import { updateScrollHints } from './scrollFade.mjs'
import { t } from './i18n.mjs'

// splitCodeByClasses(code) — best-effort split of a snippet into per-class
// segments, so a code-preview pane can show WHICH class a piece of code
// belongs to right above it (reviewer request, on top of the card-title
// class name(s): "ook boven elke stukje code (als dat kan)"). Deliberately
// conservative: returns `null` (no segments, render as one plain pane exactly
// as before) unless it can attribute the WHOLE snippet unambiguously —
// "don't guess" per the reviewer's own instruction. Returns an array of
// `{ label, code }` covering the full snippet in order when it succeeds;
// `label` is `null` for a leading/trailing chunk that isn't inside any class
// (e.g. a `use` preamble).
//
// What this does NOT attempt, on purpose (falls back to `null`, i.e. no
// per-segment labels, rather than a wrong one):
// - A class with no matching closing `}` in the snippet (a truncated/partial
//   body) — bails for the WHOLE snippet, never a partial split.
// - A `class` token found INSIDE a previous class's own `{ … }` region (a
//   nested/anonymous class, or a trait/interface between two classes) is
//   folded into that surrounding segment, not given its own label — the
//   brace-depth scan below only looks for top-level declarations.
// - PHP heredoc/nowdoc (`<<<EOT … EOT`) is not recognised, so a `{`/`}`
//   inside one can throw off the depth count; the likely failure mode is an
//   unbalanced count at end-of-snippet, which correctly bails to `null`
//   rather than mis-segmenting.
// - String literals are skipped char-by-char (single/double quotes, with
//   `\`-escapes), so a `{`/`}` typed inside a string doesn't affect the count.
function splitCodeByClasses(code) {
  if (!code) return null
  const declRe = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/g
  const decls = []
  let m
  while ((m = declRe.exec(code))) {
    decls.push({ name: m[1], declStart: m.index, braceStart: declRe.lastIndex - 1 })
  }
  if (decls.length < 2) return null // one (or zero) class: the title already names it, nothing to add here
  const segments = []
  let cursor = 0
  for (const { name, declStart, braceStart } of decls) {
    if (declStart < cursor) return null // this decl sits inside the previous segment we already claimed — ambiguous, bail entirely
    let depth = 0
    let j = braceStart
    let inStr = null
    for (; j < code.length; j++) {
      const ch = code[j]
      if (inStr) {
        if (ch === '\\') {
          j++
          continue
        }
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'") {
        inStr = ch
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) return null // no matching close brace found — truncated/partial snippet, don't guess
    if (declStart > cursor) segments.push({ label: null, code: code.slice(cursor, declStart) })
    segments.push({ label: name, code: code.slice(declStart, j + 1) })
    cursor = j + 1
  }
  if (cursor < code.length) segments.push({ label: null, code: code.slice(cursor) })
  return segments
}

// `whitespace-pre-wrap break-words` (same fix, same reason, as
// markdown.mjs's own inline fence <pre> — see its doc comment): without it a
// long line (a TS type annotation, JSDoc, …) just kept scrolling out of the
// `overflow-auto` box, and with the native scrollbar hidden (`no-scrollbar`)
// there was no visible cue that anything was cut off. `overflow-auto` stays
// (for a snippet many lines/segments tall — see `pane`'s own `max-h-[40vh]`
// cap above), it just no longer needs to also carry the horizontal case now
// that a line wraps instead of running off the right edge.
function highlightedPre(code, lang) {
  return html`<pre
    class="no-scrollbar code m-0 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words p-2 text-xs leading-relaxed"
    data-scroll-body
    @scroll="${(e) => updateScrollHints(e.target)}"
  ><code class="language-php" .innerHTML="${() => highlightForLang(code, lang)}"></code></pre>`
}

// segmentBlock — one class-labelled (or label-less) chunk of a multi-class
// snippet. A STABLE `<div class="contents">` root (never itself the whole
// toggling body) with the label as a nested `${() => ...}` function binding —
// both per the "Never key a template whose entire body is one toggling
// expression" / "A statically interpolated template↔string slot leaks the
// template function as text" pitfalls in arrowjs-pitfalls.md: this template
// SHAPE is reused across every segment of every pane, in some instances with
// a label and in some without, so a bare `cond ? html\`…\` : ''` here (no
// `()=>`) risks exactly the chunk-reuse corruption those entries describe.
function segmentBlock(seg, lang) {
  return html`<div class="contents">
    ${() =>
      seg.label
        ? html`<div
            class="px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 border-b border-indigo-100 dark:border-indigo-500/20"
            data-testid="code-preview-class-label"
          >
            class ${seg.label}
          </div>`
        : ''}
    ${highlightedPre(seg.code, lang)}
  </div>`
}

function pane(titleText, code, lang) {
  // The scrollbar is hidden (`no-scrollbar`, reviewer request) and replaced
  // by the same green up/down `scrollHint` chevron pair Block.mjs's diff
  // panes use — `data-scroll-body` + `updateScrollHints` (src/scrollFade.mjs)
  // discover the cap instead of a visible native scrollbar. The outer `<div>`
  // (not the `<pre>` itself) is the `relative` host the two hints anchor to,
  // same wrapper/scroller split as everywhere else this pattern is used.
  //
  // A snippet spanning 2+ classes gets a small sub-header naming each class
  // directly above its own segment, stacked inside this SAME bordered pane
  // (no extra card) — see splitCodeByClasses' own doc comment for exactly
  // when this does/doesn't apply. Each `data-scroll-body` still scrolls (and
  // gets scroll hints) independently, same as a single-segment pane.
  //
  // The body slot is ALWAYS a keyed array (one entry when there are no
  // segments, N when there are) — never a single element in one case and an
  // array in another, per the "single↔array slot freezes" pitfall in
  // arrowjs-pitfalls.md: this same `pane()` call site renders both shapes
  // across different fences.
  const segments = splitCodeByClasses(code)
  const body = segments
    ? segments.map((seg, i) => segmentBlock(seg, lang).key('seg-' + i))
    : [highlightedPre(code, lang).key('single')]
  return html`
    <div class="relative rounded border border-slate-200 dark:border-zinc-700 overflow-hidden">
      <div
        class="px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border-b border-slate-200 dark:border-zinc-700"
      >
        ${titleText}
      </div>
      ${body}
      ${scrollHint('up')}
      ${scrollHint('down')}
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
//
// `expanded` is the same kind of getter, backed by RelatedPanel.mjs's
// `cp.expandedOverride` (default: only the last answer's own cards start
// expanded, see its own doc comment there) — reviewer request, "blokken die
// niet bij de laatste antwoord horen, ingeklapt … maar uitklappen door er
// Enter op te drukken". `onToggle(key)` is `toggleCodePreviewExpanded`
// itself, called both by `Enter` (home.mjs, on the active card) and by a
// click on the card's own header row (title/context) below — reviewer
// follow-up ("uitklap ding... kan helemaal weg"): the small ▾/▸ chevron
// button is gone, but the click-to-toggle affordance itself had to survive,
// because a fence embedded in a plain PR-comment thread (cs.focus ===
// 'comment') has NO keyboard route to this card at all — cs.previewPos only
// ever moves while cs.focus === 'claude' (see handleRelatedKey in
// RelatedPanel.mjs), so for that case a click is the ONLY way to reach the
// other state, not just a convenience alongside Enter. Same
// mouse-navigation.md rule as before ("a click runs the same function a key
// runs"), just on a bigger, glyph-less target instead of a dedicated button.
// pendingEditLink — one row inside the pending-edits card's expanded body: a
// clickable link when the touched file matched a block in the currently
// loaded tree (it.blockId set), a plain, non-clickable line otherwise
// (reviewer's own answer: "wel tonen, als platte tekst zonder
// navigatiedoel"). `active` mirrors previewCard's own getter shape — a
// nested cursor (RelatedPanel.mjs's cs.editLinkSel), not part of `.key()` for
// the same reason active/expanded aren't: walking it must not re-render the
// whole list.
function pendingEditLink(link, i, active, onJump) {
  if (!link.blockId) {
    return html`<div
      class="truncate rounded px-2 py-1 text-xs text-slate-400 dark:text-zinc-500"
      data-testid="pending-edit-link"
    >
      ${link.label}
    </div>`.key('edit-' + i)
  }
  return html`
    <button
      type="button"
      class="${() =>
        'flex items-center gap-1 truncate rounded px-2 py-1 text-left text-xs ' +
        (active()
          ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800')}"
      data-testid="pending-edit-link"
      data-active="${() => (active() ? 'true' : 'false')}"
      @click="${(e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        onJump(link.blockId)
      }}"
    >
      <span class="shrink-0 text-indigo-500 dark:text-indigo-400">${() => (active() ? '▸' : '')}</span>
      ${link.label}
    </button>
  `.key('edit-' + i)
}

// pendingEditLinks — the pending-edits card's body while expanded: one
// pendingEditLink per touched file/block, `linkSel` (1-based, 0 = none) the
// nested keyboard cursor (RelatedPanel.mjs's cs.editLinkSel — see
// "↓ walks the chat's own code blocks, PLUS a pending-edits card" in
// claude-chat-panel.md).
function pendingEditLinks(links, linkSel, onJump) {
  return links.map((l, i) => pendingEditLink(l, i, () => linkSel() === i + 1, onJump))
}

// previewCard renders ONE card in the stack below the chat: either an
// ordinary fence's "Huidig (PR)"/"Voorgesteld (chat)" pair (it.kind is unset)
// or the pending-edits summary card (it.kind === 'edits', see
// RelatedPanel.mjs's pendingEditsItem) — same shell (border/ring, active
// marker, click-to-toggle header, collapse/expand), different body. `active`/
// `expanded` are getters, same reasoning as before: walking/toggling must not
// re-key (and thereby re-Prism-highlight) the rest of the stack. `linkSel`/
// `onJump` only matter for the edits-kind card — an ordinary fence card
// ignores them (its default no-ops).
function previewCard(it, active, expanded, onToggle, linkSel = () => 0, onJump = () => {}) {
  return html`
    <div
      class="${() =>
        'flex flex-col gap-2 rounded-xl border bg-white dark:bg-zinc-900 p-3 ' +
        (active()
          ? 'border-indigo-300 dark:border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5')}"
      data-testid="code-preview-card"
      data-kind="${it.kind || 'fence'}"
      data-active="${() => (active() ? 'true' : 'false')}"
      data-expanded="${() => (expanded() ? 'true' : 'false')}"
    >
      <div
        class="flex flex-col gap-1 cursor-pointer"
        data-testid="code-preview-toggle"
        title="${() => t(expanded() ? 'Inklappen' : 'Uitklappen (Enter)')}"
        @click="${(e) => {
          // stopPropagation FIRST, before the toggle mutates the reactive
          // state this very button's own ancestor re-renders off — see the
          // nested-@click ordering rule in arrowjs-pitfalls.md.
          if (e && e.stopPropagation) e.stopPropagation()
          onToggle(it.key)
        }}"
      >
        <div class="flex items-center gap-1">
          <span
            class="shrink-0 text-[11px] font-semibold text-indigo-500 dark:text-indigo-400"
            data-testid="code-preview-active-marker"
          >
            ${() => (active() ? '▸' : '')}
          </span>
          ${() =>
            it.kind === 'edits'
              ? html`<span
                  class="truncate text-[11px] font-medium text-slate-500 dark:text-zinc-500"
                  data-testid="code-preview-title"
                >
                  ✎ ${t('Aanpassingen van Claude')} · ${it.links.length}
                </span>`
              : it.classLabel
                ? html`<span
                    class="truncate text-[11px] font-medium text-slate-500 dark:text-zinc-500"
                    data-testid="code-preview-title"
                  >
                    ${it.classLabel}
                  </span>`
                : ''}
        </div>
        ${() =>
          it.kind !== 'edits' && it.context
            ? html`<span
                class="${() =>
                  'text-xs leading-relaxed text-slate-700 dark:text-zinc-300 ' + (expanded() ? '' : 'truncate')}"
                data-testid="code-preview-context"
              >
                ${t('over')}: ${it.context}
              </span>`
            : ''}
      </div>
      <div class="flex flex-col gap-2" data-testid="code-preview-body">
        ${() =>
          expanded()
            ? it.kind === 'edits'
              ? pendingEditLinks(it.links, linkSel, onJump)
              : [
                  it.oldCode != null ? pane(t('Huidig (PR)'), it.oldCode, it.lang).key('old') : '',
                  pane(t(it.oldCode != null ? 'Voorgesteld (chat)' : 'Codeblok'), it.code, it.lang).key('new'),
                ].filter(Boolean)
            : []}
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
// claude-chat-panel.md). `isExpanded(i)`/`onToggle` back the collapse state
// above (RelatedPanel.mjs's `isPreviewExpanded`/`toggleCodePreviewExpanded`).
// All defaulted so a future caller with no cursor/collapse state of its own
// can keep passing fewer arguments.
//
// `getWidthCls` bounds the column's own width — RelatedPanel.mjs's
// `commentClaudeRowWidthCls(state)` by default caller, so this column can
// never render wider than comment-claude-row above it (a bare `w-full` is
// 100% of an UNCONSTRAINED shrink-to-fit ancestor, which does nothing to cap
// an oversized child's own preferred width — see that function's doc
// comment). Defaults to the previous literal `w-full` so a caller with
// nothing better still gets today's behaviour. Read inside the same `${() =>
// ...}` slot as the class it lives in (whole-value rule, arrowjs-pitfalls.md)
// so a focus/narrow-breakpoint change re-applies just this class.
export function codePreviewColumn(
  getItems,
  isActive = () => false,
  isExpanded = () => true,
  onToggle = () => {},
  getWidthCls = () => 'w-full',
  getLinkSel = () => 0,
  onJumpToBlock = () => {},
) {
  return html`
    <div class="${() => 'flex shrink-0 flex-col gap-3 ' + getWidthCls()}" data-testid="code-preview-column">
      ${() =>
        getItems().map((it, i) =>
          previewCard(
            it,
            () => isActive(i),
            () => isExpanded(i),
            onToggle,
            () => getLinkSel(i),
            onJumpToBlock,
          ),
        )}
    </div>
  `
}
