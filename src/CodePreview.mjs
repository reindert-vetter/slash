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
import { renderMarkdown } from './markdown.mjs'
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

// `titleText` is either a plain string ('Huidig (PR)'/'Voorgesteld (chat)')
// or a small html template carrying the fence's own "Codeblok N" label plus
// a language badge (`fenceTitle` below, mirroring the SAME header
// markdown.mjs's `extractCodeFences` renders inline in the chat bubble
// above) — rendered through a `${() => titleText}` FUNCTION binding rather
// than a bare `${titleText}` interpolation specifically because the shape
// can differ between calls sharing this one template (a suggestion fence's
// "Voorgesteld (chat)" pane can lose its `oldCode` comparison and fall back
// to the plain-fence title on a later recompute): see "A statically
// interpolated template↔string slot leaks the template function as text" in
// arrowjs-pitfalls.md — the function-binding form is the allowed escape
// hatch, a bare interpolation is not.
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
        class="flex items-center px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border-b border-slate-200 dark:border-zinc-700"
      >
        ${() => titleText}
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
//
// A dedicated button is BACK for the collapsed state specifically (reviewer
// report, screenshot: "onder de chat en comment blok komen dezelfde teksten
// opnieuw in blokken maar dan groter, die zijn ingeklapt als er nieuwe
// thread dingen zijn gekomen, dus die moeten duidelijk zijn dat het
// ingeklapt is" — a card whose own answer is no longer the LATEST one
// collapses to just its one-line, truncated `context` text with nothing
// else — cursor-pointer and a hover-only title tooltip were not enough of a
// cue that there is more hidden here). `code-preview-expand-btn`, rendered
// only while `!expanded()`, right below the (possibly truncated) context
// line: a labelled word ("Blok ingeklapt — klik om uit te klappen") plus a
// ▾ glyph, per the colourblind rule — never colour alone. It is a SIBLING
// of the `code-preview-toggle` header block, not nested inside it — its own
// `@click` calls `onToggle(it.key)` directly, with the same
// `stopPropagation`-first ordering as the header's handler above as a
// defensive habit (this file's established pattern), even though this
// button's own click never actually reaches the header. No symmetrical
// "collapse" button once expanded — the header's own
// click-to-toggle (still present) already covers that direction, and the
// reviewer's request was specifically about discoverability of the
// COLLAPSED state, not about removing the header affordance again.
//
// previewCard renders ONE card in the stack below the chat: an ordinary
// fence's "Huidig (PR)"/"Voorgesteld (chat)" pair (same shell — border/ring,
// active marker, click-to-toggle header, collapse/expand). `active`/
// `expanded` are getters, same reasoning as before: walking/toggling must not
// re-key (and thereby re-Prism-highlight) the rest of the stack.
//
// MEASURED CRASH (PR 13535, 2026-08-28, found via debug mode's console.error
// hook — see .claude/docs/debug-mode.md): this card is `.key(it.key)`'d, and
// per arrowjs-pitfalls.md's "keyed node reused without re-running its
// bindings", a reused chunk's inner `${() => ...}` bindings stay wired to
// whichever closure was passed the FIRST time this key was ever mounted —
// they are never re-created on a later render. `codePreviewColumn` used to
// pass `expanded` as `() => isExpanded(i)`, a closure over a captured array
// INDEX; RelatedPanel.mjs's `isExpanded` then re-derived the item via
// `cp.items[i]`. Once `cp.items` shrank or reordered (a fence
// arriving/leaving while a Claude turn streams) — the reused card's frozen
// `i` could point past the new, shorter array: `cp.items[i]` came back
// `undefined`, and `isPreviewExpanded(undefined)` threw on `it.key`. LOCAL
// PATCH 4/5 in vendor/arrow.js caught it (console.error, never rethrown —
// see the "arrow.js's own CAUGHT throws" section in debug-mode.md), but the
// binding never recovers: since the closure is frozen, EVERY subsequent
// reactive trigger re-threw the same error, forever, for that one card — 832
// error lines over ~7 minutes in the reported session, reading as "the
// browser is frozen" even though the rest of the reactive graph kept
// working. Fixed by passing the already-available `it` (this map
// iteration's own array element, guaranteed non-undefined) into `isExpanded`
// instead of re-deriving via a captured index — see `codePreviewColumn`
// below.
// `isActive` stays index-based on purpose: cs.previewPos is a POSITION, not
// an item identity, and comparing a stale `i` can never throw.
//
// Aside for whoever finds this via a similarly-shaped freeze report: the
// bug report that led here gave a URL selecting a `test_class` row
// (`?sel=testclass:...&tcol=1`) — but that column is unrelated to this
// crash. The reviewer very likely had a Claude-chat/PR-comment panel open
// alongside the test-methods column (this card lives in
// CodePreviewPanel/comment-claude-row), and THAT is where the repeatedly
// re-thrown error actually was. Don't assume a similar report is a
// test-class-grouping bug just because the URL mentions one — check
// data/debug-log.jsonl's `error` lines first; they name the real file/line.
// fenceTitle(it) — the single-pane ("Codeblok") title, mirroring the exact
// header markdown.mjs's `extractCodeFences` renders inline in the chat
// bubble above this same fence: the running "Codeblok N"/"Suggestie N" label
// (`it.label`, `data-fence-label`) plus an uppercase language word (`it.lang`,
// `data-fence-lang`, empty for a suggestion fence). Reviewer report
// (screenshot): the preview card below said only the bare word "Codeblok",
// no number, no language, unlike the fence's own header a few lines above
// it. Falls back to the plain translated word when a fence carries no label
// at all (older/defensive case — `data-fence-label` is otherwise always
// present, see markdown.mjs).
function fenceTitle(it) {
  if (!it.label) return t('Codeblok')
  if (!it.lang) return it.label
  return html`<span class="flex items-center">${it.label}<span class="ml-2 uppercase tracking-wide">${it.lang}</span></span>`
}

function previewCard(it, active, expanded, onToggle) {
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
            it.classLabel
              ? html`<span
                  class="truncate text-[11px] font-medium text-slate-500 dark:text-zinc-500"
                  data-testid="code-preview-title"
                >
                  ${it.classLabel}
                </span>`
              : ''}
        </div>
        ${() =>
          it.context
            ? html`<span
                class="${() =>
                  'markdown-body [&_p]:inline text-xs leading-relaxed text-slate-700 dark:text-zinc-300 ' +
                  (expanded() ? '' : 'truncate')}"
                data-testid="code-preview-context"
                .innerHTML="${() => renderMarkdown(it.context)}"
              ></span>`
            : ''}
      </div>
      ${() =>
        expanded()
          ? ''
          : html`<button
              type="button"
              data-testid="code-preview-expand-btn"
              class="self-start inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
              @click="${(e) => {
                // stopPropagation FIRST, before the toggle mutates the
                // reactive state this button's own ancestor re-renders off —
                // see the nested-@click ordering rule in arrowjs-pitfalls.md.
                if (e && e.stopPropagation) e.stopPropagation()
                onToggle(it.key)
              }}"
            >
              ${t('Blok ingeklapt — klik om uit te klappen')}
              <span aria-hidden="true">▾</span>
            </button>`}
      <div class="flex flex-col gap-2" data-testid="code-preview-body">
        ${() =>
          expanded()
            ? [
                it.oldCode != null ? pane(t('Huidig (PR)'), it.oldCode, it.lang).key('old') : '',
                pane(it.oldCode != null ? t('Voorgesteld (chat)') : fenceTitle(it), it.code, it.lang).key('new'),
                // trailing — the chat text after this fence (only set on the
                // LAST fence of its message, see markdown.mjs's
                // `data-fence-trailing`) — reviewer request: "laat de laatste
                // tekst ook zien", so nothing typed after the code is lost.
                it.trailing
                  ? html`<span
                      class="markdown-body [&_p]:inline text-xs leading-relaxed text-slate-700 dark:text-zinc-300"
                      data-testid="code-preview-trailing"
                      .innerHTML="${() => renderMarkdown(it.trailing)}"
                    ></span>`.key('trailing')
                  : '',
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
// claude-chat-panel.md). It stays index-based on purpose: cs.previewPos IS a
// position, not an item identity, and a stale captured `i` merely compares
// wrong — it can never dereference anything.
//
// `isExpanded(it)`/`onToggle` back the collapse state above
// (RelatedPanel.mjs's `isPreviewExpanded`/`toggleCodePreviewExpanded`) and
// are DELIBERATELY item-based, not index-based — see the "measured crash"
// paragraph right below `previewCard`'s own `.key(it.key)` line for why.
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
// groupDivider — the ONLY visual separator between two cards that came from
// the SAME chat message (`it.groupWithPrev`, RelatedPanel.mjs's
// recomputeCodePreviews): a dashed horizontal rule, no surrounding gap, so
// such cards read as "stuck together" — reviewer request: "de blokken die
// uit dezelfde message komen, moeten … gescheiden worden met een
// horizontale stippellijn, voor de rest mogen die aan elkaar plakken". A
// dashed LINE (shape), never colour alone, per the colourblind rule.
function groupDivider(key) {
  return html`<div
    class="border-t border-dashed border-slate-300 dark:border-zinc-600"
    data-testid="code-preview-group-divider"
  ></div>`.key(key)
}

export function codePreviewColumn(
  getItems,
  isActive = () => false,
  isExpanded = () => true,
  onToggle = () => {},
  getWidthCls = () => 'w-full',
) {
  return html`
    <div class="${() => 'flex shrink-0 flex-col ' + getWidthCls()}" data-testid="code-preview-column">
      ${() =>
        getItems().flatMap((it, i) => {
          const card = previewCard(
            it,
            () => isActive(i),
            // `it`, not `i` — see the "measured crash" note above `previewCard`'s
            // .key(it.key) line: a keyed card's inner bindings freeze on the
            // closure captured at first mount (arrowjs-pitfalls.md's "keyed node
            // reused without re-running its bindings"), so re-deriving via a
            // captured INDEX into a list that can since have shrunk/reordered
            // (`cp.items[i]`) reads past the end and throws. `it`
            // is the guaranteed-valid object from THIS map iteration — it can
            // never be undefined, only (rarely) stale in value, which is the
            // same accepted trade-off every other keyed-reuse case already has.
            () => isExpanded(it),
            onToggle,
          )
          // Spacing between cards, per pair: two cards from the SAME message
          // (`groupWithPrev`) get a dashed divider and no gap at all (see
          // groupDivider above); everything else (including the very first
          // card) keeps the ordinary vertical gap the column used to apply
          // uniformly via `gap-3` — replaced here with an explicit `mt-3` per
          // card so it can be conditionally skipped for a grouped pair.
          const cardWithMargin = i === 0 ? card : html`<div class="${it.groupWithPrev ? '' : 'mt-3'}">${card}</div>`.key(it.key + ':wrap')
          return it.groupWithPrev ? [groupDivider(it.key + ':sep'), cardWithMargin] : [cardWithMargin]
        })}
    </div>
  `
}
