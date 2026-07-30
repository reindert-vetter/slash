// Block — the detail card for a single block, shown to the right of the list.
// A component: takes one block object (from state.blocks) plus display options
// and returns an arrow.js template. It mirrors the sidebar row but with the full
// header, file:line and the approve toggle. Code goes underneath later.

import { html, reactive } from './vendor/arrow.js'
import { categoryClass } from './BlockList.mjs'
import { translationBlockView, translationChangeUnits } from './translationDiff.mjs'
import { avatarHtmlString } from './avatar.mjs'
import Prism from './vendor/prism.js'

// highlight turns raw PHP source into Prism-tokenised HTML (keywords, strings,
// variables, …). Prism.highlight escapes the text itself, so the result is safe
// to feed to .innerHTML. Blocks are usually bare function bodies without a
// `<?php` tag, which the php grammar still tokenises fine. If the grammar is
// somehow missing we fall back to an escaped plain string — never raw innerHTML.
export function highlight(code) {
  const grammar = Prism.languages.php
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, 'php')
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// The word shown top-right of the header, per change status.
const STATUS_WORD = {
  added: 'text-emerald-600 dark:text-emerald-400',
  modified: 'text-amber-600 dark:text-amber-400',
  removed: 'text-rose-600 dark:text-rose-400',
}

function statusColor(status) {
  return STATUS_WORD[status] || 'text-slate-500 dark:text-zinc-500'
}

// removedLabel returns the prominent Dutch label for deleted code: a block
// whose whole file was deleted by the PR (b.fileDeleted, the reliable
// backend signal — git's `+++ /dev/null`) reads "Verwijderd bestand"; a loose
// removed block in a file that still exists reads "Verwijderd". Null for
// every other block — the caller falls back to the plain status word.
export function removedLabel(b) {
  if (b.fileDeleted) return 'Verwijderd bestand'
  if (b.status === 'removed') return 'Verwijderd'
  return null
}

// blockLabel returns the full display label for a block (or a plain label
// string): `class::method`, falling back to just the bare name when the block
// has no class ("class::method everywhere"). Shared by the drill-hint chips
// (RelatedPanel.mjs) and the collapsed column rails (home.mjs'
// collapsedColumnHTML) so no render spot shortens a label to only the method
// name anymore.
export function blockLabel(x) {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (x.class && x.name) return x.class + '::' + x.name
  return x.label || x.name || ''
}

// Shared rose emphasis for the removed-file/removed markers (card badge and
// diff banner) — deliberately louder than the plain status word.
const REMOVED_BADGE_CLS =
  'shrink-0 rounded px-1.5 py-0.5 text-xs font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300'

// singleSide returns which pane to show when a block is one-sided: an added block
// has no old source (show only 'right'/new), a removed block has no new source
// (show only 'left'/old). Modified blocks keep both panes (null). This lets the
// card drop the empty pane and render narrower. Driven by status so the width is
// stable even before b.code loads. Exported so home.mjs can check whether the
// ACTIVE/selected block is one-sided, to make a look-ahead preview card match
// its shape (see the "preview never wider/richer than active" note below and
// detail-layout.md).
export function singleSide(b) {
  if (b.status === 'added') return 'right'
  if (b.status === 'removed') return 'left'
  return null
}

// fitOnly returns which single pane the `a` toggle's THIRD ('fit') stand
// shows: on explicit reviewer request, 'fit' never shows the old/removed
// code of a genuinely two-sided (modified) block anymore — it always
// collapses to just the new/right pane, exactly like an already one-sided
// ADDED block. A one-sided REMOVED block is the deliberate exception:
// singleSide(b) wins first, so it keeps showing its old/left pane in 'fit'
// too — that's the only code it has, hiding it would leave nothing to
// review. Used by both codeDiff (which pane(s) render) and fitWidthCls
// (which side's text drives the width) so the two stay in lockstep.
function fitOnly(b) {
  return singleSide(b) || 'right'
}

// narrowed reports whether the `a` toggle should shrink this card to its 60%
// width. The reviewer wants EVERY visible card — modified, added, removed, a
// preview/look-ahead card, or any drilled column — to shrink in lockstep
// while `a`'s unified stand is on, regardless of singleSide(b): a
// genuinely one-sided block was already narrow on its own, and the unified
// stand's single "old above new" column (see unifiedCodeDiff below) is
// exactly as narrow. Shared by every card via the same viewMode option, so
// this one flag keeps them all in sync. Deliberately excludes 'fit' (see
// widthCls below) — that third `a` stand gets its own, content-based width
// instead of this fixed 60%.
function narrowed(viewMode) {
  return viewMode() === 'unified'
}

// isPhpFile — the discriminator between 'fit''s two different behaviors
// (see fitWidthCls/boundedWrapWidthCls below): a plain `.php` extension
// check on b.file. PHP code gets the uncapped, max-line-based 'fit' width
// (a long PHP statement is typically one unbreakable logical line, so it
// must stay fully visible, unwrapped); everything else (markdown, JSON,
// config, …) gets a bounded width with wrapping instead — prose/config text
// reads perfectly fine wrapped, and letting one long line balloon the card
// (reported: a 336-character markdown bullet grew the card to ~6800px) is
// exactly what "don't be wider than necessary" rules out.
function isPhpFile(b) {
  return !!(b.file && b.file.toLowerCase().endsWith('.php'))
}

// isSvgFile — a plain `.svg` extension check on b.file, mirrors isPhpFile.
// Used only to route the card's whole render (see the b.category/isSvgFile
// dispatch in Block() below) to svgSlot instead of codeDiff — it does NOT
// change widthCls: an .svg file is by construction never a PHP file, so it
// already gets the existing non-PHP width treatment (boundedWrapWidthCls in
// the 'fit' stand) for free, same as markdown/JSON.
function isSvgFile(b) {
  return !!(b.file && b.file.toLowerCase().endsWith('.svg'))
}

// nonCommentLineLengths — the shared scan behind codeGrowthChars and
// codeMaxLineChars below: the character lengths of every non-blank,
// non-comment line in `code` (a leading PHPDoc block, `//`/`#` line
// comments skipped — free-form prose must never drive a width, only real
// PHP code lines may), sorted ascending. Deterministic, regex/state-machine
// based (no parser, matching the rest of this codebase's PHP-adjacent
// heuristics, e.g. phpscan.go's PHPDoc detection) and — load-bearing — no
// live DOM measurement: it only counts characters in the raw source string,
// so it can run inside a reactive binding without racing any render/layout
// pass.
function nonCommentLineLengths(code) {
  if (!code) return []
  let inBlockComment = false
  const lens = []
  for (const raw of code.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.endsWith('*/')) inBlockComment = false
      continue
    }
    if (trimmed === '') continue
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlockComment = true
      continue
    }
    lens.push(line.length)
  }
  lens.sort((a, b) => a - b)
  return lens
}

// codeGrowthChars — a REPRESENTATIVE non-comment line length in `code`, not
// the single longest line.
//
// A single outlier line (one exceptionally long call, e.g. a
// `Cache::remember(...)` one-liner buried in an otherwise normal-width
// method) must not alone dictate a width — that stretched a card to its
// ceiling for one wrapping-worthy line while the rest of the method was
// perfectly narrow. The plain median turned out too aggressive the other
// way: a method's brace-only lines (`{`/`}`) drag the middle value down to
// almost nothing even for a genuinely wide method (with as few as 3-4 real
// content lines, the median lands on one of those single-char lines). The
// 75th percentile (nearest-rank) is the middle ground: it still reflects the
// wider half of a method's real content lines without being hostage to its
// single longest line.
//
// Shared by RelatedPanel.mjs's relatedColumnWidthCls (the Onderliggende-code
// column width, which keeps this non-ballooning percentile behavior) — NOT
// used any more by this file's own fitWidthCls (the `a`-toggle's 'fit'
// stand), see codeMaxLineChars below for why 'fit' deliberately wants a
// different, stronger guarantee.
export function codeGrowthChars(code) {
  const lens = nonCommentLineLengths(code)
  if (lens.length === 0) return 0
  const idx = Math.min(lens.length - 1, Math.max(0, Math.ceil(0.75 * lens.length) - 1))
  return lens[idx]
}

// codeMaxLineChars — the TRUE longest non-comment line in `code` (not a
// percentile). Used only by fitWidthCls's 'fit' stand: unlike the
// non-ballooning default width elsewhere (codeGrowthChars, still used by
// relatedColumnWidthCls and by every other card width in this file), the
// reviewer explicitly wants 'fit' to guarantee that the single widest real
// code line is never cut off/hidden behind an invisible horizontal scroll —
// see fitWidthCls's own doc comment for the full reasoning and the
// deliberate scope (only 'fit'; 'split'/'unified' keep their existing, fixed
// widths and can still clip a very long line).
function codeMaxLineChars(code) {
  const lens = nonCommentLineLengths(code)
  return lens.length ? lens[lens.length - 1] : 0
}

// widthCls picks the card's width class for the current `a` stand: for
// 'fit', a PHP file gets the uncapped, content-based width (fitWidthCls);
// any other file gets a bounded width instead (boundedWrapWidthCls) — see
// isPhpFile above for why. Every other stand keeps the existing binary
// choice (narrow 60% vs. full split width), unchanged for every file type.
//
// Below the `narrow` breakpoint (< 1400px, see the tailwind.config comment
// in index.html) BOTH tiers shrink further — the reviewer explicitly asked
// for the diff column itself to narrow too, not just the comments/
// Onderliggende-code column next to it (see "Narrow viewport (< 1400px)" in
// detail-layout.md for the full width budget this was measured against):
// 70rem/82rem -> 42rem (the same number the "narrow 60%" tier already used
// above 1400px) and 42rem/49.2rem -> 28rem, keeping roughly the same ~60%
// ratio between the two tiers so a same-file `a` toggle (unified vs. split)
// still visibly differs at this viewport too — see the ratio assertion in
// diffview.spec.mjs ("`a` cycles the live diff card through split ->
// unified -> fit -> split"). Deliberately scoped to THIS function — `fit`'s
// own uncapped, content-based width (fitWidthCls/boundedWrapWidthCls) stays
// untouched: it's an opt-in stand that already routinely exceeds every
// fixed width here by design, so it was never going to reliably fit at
// 1378px regardless, and narrowing its floor too would only add risk to the
// many `fit`-specific assertions in diffview.spec.mjs for no product
// benefit.
function widthCls(b, viewMode) {
  if (viewMode() === 'fit') return isPhpFile(b) ? fitWidthCls(b) : boundedWrapWidthCls()
  return narrowed(viewMode) || singleSide(b)
    ? 'w-[42rem] narrow:w-[28rem] 2xl:w-[49.2rem] '
    : 'w-[70rem] narrow:w-[42rem] 2xl:w-[82rem] '
}

// boundedWrapWidthCls — the 'fit' width for a NON-PHP file (see isPhpFile):
// the same narrow 60% width a one-sided added/removed block already uses in
// every other stand — deliberately NOT content-based. 'fit' only ever shows
// ONE pane now (fitOnly, above — old is never shown next to new anymore, not
// even for a genuinely two-sided modified block), so there's no second,
// full-split-width branch to account for any more. Long lines are made to
// fit THIS width by wrapping instead (the `wrap` flag on codePane/paneHTML),
// so nothing needs to balloon the card past what's actually necessary — the
// direct fix for "the 3rd stand must not be wider than needed" for non-code
// (markdown/prose/config) text, where a long line reads perfectly fine
// wrapped, unlike a PHP statement.
function boundedWrapWidthCls() {
  return 'w-[42rem] 2xl:w-[49.2rem] '
}

// fitWidthCls — the card width for the `a` toggle's third ('fit') stand, for
// a PHP FILE ONLY (widthCls routes any other file to boundedWrapWidthCls
// instead, see isPhpFile above): make the card as wide as its own code
// actually needs, instead of the fixed 60% ('unified') or full ('split')
// width. Floored at the existing 60% width (so 'fit' never goes narrower
// than 'unified'), but — on explicit reviewer request — deliberately UNCAPPED
// upward: unlike every other width in this file (and unlike codeGrowthChars,
// the 75th-percentile non-ballooning technique RelatedPanel.mjs's
// relatedColumnWidthCls still uses), 'fit' must guarantee that the single
// widest real PHP code line of the block is fully visible, without wrapping
// and without an invisible horizontal scroll — cutting off part of a long
// line defeats the entire point of a stand whose stated purpose is "width
// follows the code". Uses codeMaxLineChars (the TRUE longest non-comment
// line, not a percentile) for exactly that reason — a percentile-based width
// plus a ceiling is precisely what let a genuinely long line get silently
// clipped before this change (reported: a `modified` block's 168-character
// `throw new RuntimeException(...)` line was cut off mid-word in 'fit',
// identically to 'split' — see the CSS `max()` below, which drops the
// previous `clamp(...)` ceiling entirely). Purely a character-count
// calculation on the already-loaded source text, no live DOM measurement
// (`scrollWidth`/`getBoundingClientRect`), per the existing approach and the
// arrow.js pitfalls in conventions.md.
//
// This uncapped guarantee turned out to backfire for a NON-PHP file: a
// markdown bullet/prose line reads perfectly fine wrapped (unlike a PHP
// statement, which loses nothing by staying on one physical line but reads
// terribly split mid-expression), so an isolated long prose line ballooned
// the whole card (reported: 336 characters → ~6800px). Hence the PHP-only
// scope: a non-PHP file gets boundedWrapWidthCls + wrapping instead.
//
// Deliberately scoped to 'fit' + PHP ONLY — 'split' and 'unified' keep their
// existing, fixed widths and can still clip a very long line exactly as
// before, for every file type; this was an explicit, discussed choice (not a
// guess), see keyboard-navigation.md ("`a` — cycling the diff view").
//
// 'fit' never shows the old pane of a genuinely two-sided (modified) block
// anymore (fitOnly, above — a deliberate change from the earlier "both
// panes, doubled width" formula: the reviewer explicitly asked for 'fit' to
// hide old code, mirroring how an already one-sided added block only ever
// showed its one pane) — so this is now ALWAYS a single-pane calculation,
// based on whichever side fitOnly(b) actually renders: the new/right text
// for an added or modified block, the old/left text for a removed block
// (the one deliberate exception — a removed block has no new side to prefer,
// so its old pane stays visible in every stand, 'fit' included).
function fitWidthCls(b) {
  const c = b.code
  const oldText = c && !c.error && c.old ? c.old.text : ''
  const newText = c && !c.error && c.new ? c.new.text : ''
  const only = fitOnly(b)
  const chars = codeMaxLineChars(only === 'left' ? oldText : newText)
  return (
    `w-[max(42rem,calc(${chars}ch_+_2rem))] ` +
    `2xl:w-[max(49.2rem,calc(${chars}ch_+_2rem))] `
  )
}

// VIEW_MODE_META describes the three `a`-cycle stands (state.diffViewMode,
// see DIFF_VIEW_CYCLE in home.mjs) for the compact status indicator in the
// block-card header: a tooltip label and a small inline SVG glyph per
// stand — our own static markup (no icon lib, per the vendoring rule).
// Fixed, unchanging order/length, so viewModeIndicator's .map() over it is
// safe without the keyed-node caveats that apply to a truly dynamic list
// (see conventions.md) — this array never grows/shrinks/reorders.
const VIEW_MODE_META = [
  {
    mode: 'split',
    label: 'Split-weergave (oud + nieuw naast elkaar)',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="6" height="12" rx="1"/><rect x="9" y="2" width="6" height="12" rx="1"/></svg>',
  },
  {
    mode: 'unified',
    label: 'Unified diff (oud boven nieuw, 60% breed)',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="14" height="5" rx="1" stroke-dasharray="1.4 1.4" opacity="0.5"/><rect x="1" y="9" width="14" height="5" rx="1" fill="currentColor" stroke="none"/></svg>',
  },
  {
    mode: 'fit',
    label: 'Alleen nieuwe code, breedte volgt de code',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="2" width="10" height="12" rx="1"/><path d="M1 8h1.6M14.4 8H16" stroke-linecap="round"/></svg>',
  },
]

// viewModeIndicator — the compact status indicator for the `a`-cycle: three
// small icon buttons (split/unified/fit), the active stand highlighted with an
// indigo ring. A click jumps straight to that stand (setViewMode); `a`
// keeps cycling as before (home.mjs). Only rendered by Block() while
// diffActive() is true — i.e. only on the card that currently owns the
// diff keyboard (see the caller below), never on a preview/collapsed card.
// Each button's class is its own whole-value `${() => ...}` function
// binding (see the arrow.js class-binding rule in conventions.md) so only
// the highlight re-evaluates on a viewMode change, not the surrounding
// card header.
function viewModeIndicator(viewModeFn, setViewMode) {
  return html`
    <span class="flex items-center gap-0.5" data-testid="diffview-indicator">
      ${VIEW_MODE_META.map(
        (m) => html`
          <button
            type="button"
            title="${m.label}"
            data-testid="${'diffview-' + m.mode}"
            class="${() =>
              'flex h-4 w-4 items-center justify-center rounded transition ' +
              (viewModeFn() === m.mode
                ? 'bg-indigo-100 text-indigo-600 ring-1 ring-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-300 dark:ring-indigo-500/40'
                : 'text-slate-400 hover:text-slate-600 dark:text-zinc-600 dark:hover:text-zinc-400')}"
            @click="${() => setViewMode(m.mode)}"
          >
            <span class="h-3 w-3" .innerHTML="${() => m.svg}"></span>
          </button>
        `.key(m.mode),
      )}
    </span>
  `
}

/**
 * @param {object} b - one block from state.blocks (reactive).
 * @param {object} [opts] - { preview: boolean } dims the look-ahead card.
 * @returns arrow.js template — call with a mount target to render.
 */
export default function Block(b, opts = {}) {
  // viewMode — a function returning the global diff-view preference: 'split'
  // (default, both panes side by side, full width), 'unified' (a genuinely
  // two-sided block collapses to ONE column, old (-) directly above new (+)
  // — see unifiedCodeDiff below — fixed 60% width), or 'fit' (only the
  // new/right pane, old is never shown — see fitOnly above — the card width
  // follows that pane's own code instead of a fixed width — see
  // widthCls/fitWidthCls above). Cycled everywhere with `a` (home.mjs). A
  // function so codeDiff's own reactive slot picks up the change, mirroring
  // activeGroup/hintsEnabled above.
  const viewModeFn = opts.viewMode || (() => 'split')
  // setViewMode — called with a stand ('split'/'unified'/'fit') when the reviewer
  // clicks one of the three icons in viewModeIndicator below; home.mjs jumps
  // state.diffViewMode straight to it (setDiffViewMode). Defaults to a no-op
  // so a caller that doesn't pass one (e.g. the drill-preview/look-ahead
  // cards, which never show the indicator anyway since diffActive is always
  // false there) doesn't need to wire it up.
  const setViewMode = opts.setViewMode || (() => {})
  const preview = !!opts.preview
  // activeGroup is a function returning the currently-navigated change group
  // ({ start, end } row indices) for this block, or null. It's a function (not a
  // value) so the pane's .innerHTML binding re-runs when the navigation state it
  // reads changes — see home.mjs. Preview cards never highlight.
  const activeGroup = opts.activeGroup || (() => null)
  // hintsEnabled is a function returning whether the out-of-view change hints may
  // show for this card. They only make sense for the block the reviewer is
  // actually stepping through: the selected card, in diff mode. Preview cards and
  // list mode pass a falsey predicate, so their hints stay hidden. Reactive (a
  // function) so flipping mode re-evaluates without re-rendering the diff.
  const hintsEnabled = opts.hintsEnabled || (() => false)
  // diffActive is a function returning whether the reviewer is currently stepping
  // through this block's code diff (the selected card, in diff mode). When true the
  // card border turns light blue — the same indigo as a selected row in the comment
  // index — as an at-a-glance cue that the keyboard now drives the diff.
  const diffActive = opts.diffActive || (() => false)
  // approvedRows is a function returning the Set of approved row indices for this
  // block, so the panes re-tint (an emerald left bar) as the reviewer approves
  // units. A function (not a value) so the .innerHTML binding re-runs when
  // b.approvedRows changes. Defaults to nothing approved.
  const approvedFn = opts.approvedRows || (() => new Set())
  // onApprove is called with the block after the top checkbox toggles its
  // approved rows, so the caller (home.mjs) can persist the new state durably.
  // Defaults to a no-op; Block itself stays decoupled from the write path.
  const onApprove = opts.onApprove || (() => {})
  // commentedRows is a function returning the Set of rows that carry a comment,
  // so the panes mark them with a 💬 (presence only). A function so the binding
  // re-runs as comments load/change. Defaults to no comments.
  const commentedFn = opts.commentedRows || (() => new Set())
  // approvedCalls is a function returning the Set of approved call-segment keys
  // (finer than approvedRows — see callKey), so a row with more than one call
  // segment can show its per-segment progress before the whole row is signed
  // off. Defaults to nothing approved.
  const approvedCallsFn = opts.approvedCalls || (() => new Set())
  // lineSummaryFn is a function returning a Map<rowIndex, { approve, commentActivity }>
  // — the "onderliggende code" rollup per diff line (home.mjs's
  // lineChildSummaries): an avatar+N comment-activity indicator plus a
  // done/total approve fraction, rendered at the right edge of the line the
  // underlying code (a resolved method call, relation child, or covers
  // target) is anchored to — see rowCellHTML's lineSummaryBadge. A function
  // so the pane's .innerHTML binding re-runs as approvals/comments change,
  // mirroring approvedFn/commentedFn above. Defaults to nothing to show.
  const lineSummaryFn = opts.lineSummaries || (() => new Map())
  // langSiblingsFn is a function returning, for a TRANSLATION block, the
  // OTHER locale files of the same lang file (home.mjs's
  // state.langSiblings[b.id], via ensureLangSiblings/GET /api/langsiblings)
  // — read from translationSlot's own nested reactive slot below (never
  // resolved here), so a fetch landing after the first render re-runs only
  // that slot, not this whole Block() call. Defaults to none (every
  // non-TRANSLATION block, and a TRANSLATION block before its siblings have
  // loaded/without a lang-root sibling directory).
  const langSiblingsFn = opts.langSiblings || (() => [])
  return html`
    <article
      class="${() =>
        'flex min-h-0 max-w-full flex-col overflow-hidden rounded-xl border bg-white dark:bg-zinc-900 transition ' +
        // A one-sided (added/removed) block only ever shows a single pane, so it
        // renders at the narrow (60%) width by default — the same width the `a`
        // toggle gives every card. A two-sided (modified) block keeps the full
        // two-pane width, and the `a` toggle (viewMode==='unified', see
        // `narrowed`) then shrinks EVERY visible card — modified included — to
        // that same narrow width in lockstep. `a`'s third stand ('fit') gets its
        // own, content-based width instead — see widthCls.
        widthCls(b, viewModeFn) +
        (preview
          ? 'max-h-72 border-slate-300 dark:border-zinc-700 opacity-50'
          : diffActive()
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5')}"
    >
      <div class="flex items-center gap-3 border-b border-slate-100 dark:border-zinc-800/60 px-4 py-2.5">
        <span
          class="${() =>
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
            categoryClass(b.category)}"
          >${() => b.category}</span
        >
        <h2 class="flex-1 truncate font-mono text-sm font-semibold text-slate-800 dark:text-zinc-200">
          ${() => b.label}
        </h2>
        <span
          data-testid="block-status-badge"
          class="${() =>
            // One stable span whose whole class/text flip together (whole-value
            // function bindings, see conventions.md): a prominent rose badge for
            // deleted code (fileDeleted / removed), else the plain status word.
            removedLabel(b) ? REMOVED_BADGE_CLS : 'shrink-0 text-xs font-medium ' + statusColor(b.status)}"
          >${() => removedLabel(b) || b.status}</span
        >
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <span class="flex flex-col gap-0.5 font-mono text-xs">
          ${() =>
            // Renamed file: show the OLD path above the NEW one. The nested
            // toggling slot lives inside this stable flex-col root (never a
            // bare keyed toggling expression) — see the "kale toggelende
            // expressie" pitfall in .claude/rules/conventions.md.
            b.oldFile && b.oldFile !== b.file
              ? html`<span
                  data-testid="block-old-path"
                  class="text-slate-400 line-through dark:text-zinc-600"
                  >${b.oldFile}</span
                >`
              : ''}
          <span class="font-mono text-slate-500 dark:text-zinc-500"
            >${() => b.file + ':' + b.line}</span
          >
        </span>
        <span class="flex-1"></span>
        ${() =>
          // Only the card that currently owns the diff keyboard (diffActive,
          // e.g. the selected top-level block or the focused drilled column
          // — never a preview/look-ahead card) shows the split/new/fit
          // status indicator; see viewModeIndicator above and the "a —
          // cycling the diff view" section in keyboard-navigation.md.
          diffActive() ? viewModeIndicator(viewModeFn, setViewMode) : ''}
        ${() =>
          b.tests === false
            ? html`<span
                class="rounded bg-rose-50 dark:bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400"
                >⚑ geen tests</span
              >`
            : ''}
        ${() =>
          b.author
            ? html`<span
                class="rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:text-zinc-400"
                >${b.author}</span
              >`
            : ''}
        ${() =>
          // An 'unchanged' block (a synthetic drilled call-frame pointing at
          // a file the PR doesn't touch, see "Drilling" in
          // detail-layout.md) has zero changed rows — nothing to approve —
          // so the checkbox is hidden entirely instead of showing a
          // permanently empty, meaningless "approve" toggle. Plain nested
          // slot, same shape as the b.tests/b.author ternaries above (not a
          // keyed list item, so the "bare toggling expression" pitfall in
          // conventions.md doesn't apply here).
          b.status === 'unchanged'
            ? ''
            : html`<label
                class="flex cursor-pointer items-center gap-1 text-xs text-slate-600 dark:text-zinc-400"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 rounded border-slate-300 dark:border-zinc-700"
                  checked="${() => blockApproved(b)}"
                  .indeterminate="${() => blockPartlyApproved(b)}"
                  @change="${() => {
                    toggleBlockApproval(b)
                    onApprove(b)
                  }}"
                />
                ${() => approveSummary(b)}
              </label>`}
      </div>

      <p class="border-t border-slate-100 dark:border-zinc-800/60 px-4 py-3 text-sm leading-relaxed">
        <span class="${() => (b.description ? 'text-slate-600 dark:text-zinc-400' : 'italic text-slate-400 dark:text-zinc-500')}"
          >${() => b.description || 'nog geen omschrijving'}</span
        >
      </p>

      ${() =>
        b.category === 'TRANSLATION'
          ? translationSlot(b, activeGroup, approvedFn, langSiblingsFn, hintsEnabled, commentedFn, lineSummaryFn)
          : isSvgFile(b)
          ? svgSlot(b)
          : codeDiff(b, activeGroup, hintsEnabled, approvedFn, commentedFn, approvedCallsFn, viewModeFn, lineSummaryFn)}
    </article>
  `
}

// translationRowUnitsCache memoizes translationRowUnits() per block, keyed on
// b.code's own reference identity — same rationale/precedent as
// blockRowsCache above (b.code is always wholesale-reassigned, never mutated
// in place, so a reference match is an exact, correct invalidation check).
// translationRowUnits is read on every render of a TRANSLATION card (see
// translationSlot) and every keyboard step in home.mjs's navigation
// (unitsOf/commentTarget/approveTargetRows), so it's worth memoizing exactly
// like blockRows itself.
const translationRowUnitsCache = new WeakMap()

// translationRowUnits maps each changed/added/removed KEY of a TRANSLATION
// block (translationChangeUnits, translationDiff.mjs — carries a 1-based
// oldLine/newLine per key) onto the aligned-diff ROW index blockRows(b)
// already computes for that same block — so per-key navigation, approve and
// comment-anchoring can all reuse the EXISTING row-indexed infrastructure
// (b.approvedRows, unitLineRange, ...) instead of a parallel system. Returns
// units in the same order translationBlockView renders them (changed, added,
// removed), each `{ key, kind, oldVal?, newVal?, val?, row }` — `row` is the
// blockRows index a 'changed'/'added' key's NEW line maps to, or a 'removed'
// key's OLD line; entries whose line can't be mapped onto any row (should not
// happen for the common one-key-per-line case this targets — see
// blocks-and-ingest.md "Translation blocks" — but kept as a defensive
// boundary for a multi-line/nested value whose exact row is ambiguous) are
// dropped: such a key would show in the raw key overview but isn't
// individually navigable/approvable/commentable, only the whole-block
// checkbox still covers it (via changedRows(blockRows(b)), unaffected).
export function translationRowUnits(b) {
  const c = b && b.code
  if (!c || c.error) return []
  const cached = translationRowUnitsCache.get(b)
  if (cached && cached.code === c) return cached.units
  const oldText = (c.old && c.old.text) || ''
  const newText = (c.new && c.new.text) || ''
  const rows = blockRows(b)
  // newLineToRow[j] / oldLineToRow[j] — the blockRows index of the (j+1)-th
  // line (0-based j) of the new resp. old text, in source order. blockRows
  // aligns old/new line-by-line (see alignRows) without reordering, so a
  // simple running counter per side is enough — no separate line-number
  // bookkeeping needed there.
  const newLineToRow = []
  const oldLineToRow = []
  rows.forEach((r, i) => {
    if (r.right != null) newLineToRow.push(i)
    if (r.left != null) oldLineToRow.push(i)
  })
  const changeUnits = translationChangeUnits(oldText, newText)
  const units = []
  for (const u of changeUnits) {
    const row =
      u.newLine != null
        ? newLineToRow[u.newLine - 1]
        : u.oldLine != null
        ? oldLineToRow[u.oldLine - 1]
        : undefined
    if (row === undefined) continue
    units.push({ ...u, row })
  }
  translationRowUnitsCache.set(b, { code: c, units })
  return units
}

// translationSlot renders a TRANSLATION block as a clean changes-only key
// overview instead of a raw code diff (see translationDiff.mjs). It reads the
// same lazily-loaded b.code as codeDiff (undefined = not yet requested, null =
// loading, { old, new } or { error }), so the DetailPanel's codeVersion-keyed
// rebuild reruns this the moment the code arrives — same as codeDiff.
//
// `activeGroup`/`approvedFn` are the SAME reactive opts Block() already
// builds for codeDiff (see above) — home.mjs's unitsOf/groupsFor being
// TRANSLATION-aware (see home.mjs's translationNavUnits) makes activeGroup()
// return the `{start,end,idx}` shape of the currently navigated KEY for a
// TRANSLATION block: `idx` is that unit's own index (read directly below,
// NOT re-derived from `start`/the row — two DIFFERENT keys can share the
// same aligned row, e.g. a removed key directly followed by an added one,
// exactly like an ordinary code block's del+ins pairing — so the row alone
// isn't a reliable way back to "which key", see translationNavUnits).
// approvedFn is the existing Set of approved blockRows row indices — a
// key's row is simply one more member of that same Set (see home.mjs's
// approveTargetRows), so a per-key approve toggle needs no separate storage
// either. `langSiblingsFn` (Block()'s own opt, see above) is called directly
// here, once per Block() call — that's fine dependency-wise (this whole
// function is already invoked from within Block()'s own nested `${() =>
// ...}` slot, so reading state here doesn't leak a dependency into anything
// broader — see the "outer closure vs. nested reactive slot" distinction in
// conventions.md). NOTE: that alone is NOT enough to get the sibling columns
// on screen once the async GET /api/langsiblings fetch resolves — home.mjs's
// own card-level `.key(...)` must ALSO fold in the fetched sibling count
// (see `langSibKeyPart` there), otherwise arrow.js reuses the already-mounted
// card node and never re-applies this function's freshly-returned (but
// merely statically interpolated) template — the same keyed-node-reuse
// pitfall the rest of that key already guards against for b.code/foc/unfoc.
// `hintsEnabled` (Block()'s own opt, see above — only true for the card that
// currently owns the diff keyboard) gates the green out-of-view scroll hints
// below, exactly like codeDiff's own `data-hints` — see the wrapper doc
// comment further down. `commentedFn`/`lineSummaryFn` are the SAME opts
// Block() already threads into codeDiff (see above) — a TRANSLATION block's
// per-key rows can carry an open comment (💬) and an "onderliggende code"
// avatar+N/approve badge exactly like an ordinary code row; both were
// missing entirely on this render path until now (reported: a comment on a
// TRANSLATION key showed no indicator at all, unlike a comment on ordinary
// PHP code). Passed down to translationBlockView as small callbacks
// (`commentMarkerFor`/`lineSummaryFor`, mirroring the existing `onScroll`
// callback) rather than the raw Sets/Map themselves, so translationDiff.mjs
// stays decoupled from Block.mjs's own markup functions (commentMarkerHtml/
// translationLineSummaryHtml) — no circular import, same reasoning as
// `onScroll` above.
function translationSlot(
  b,
  activeGroup,
  approvedFn,
  langSiblingsFn,
  hintsEnabled = () => false,
  commentedFn = () => new Set(),
  lineSummaryFn = () => new Map(),
) {
  const c = b.code
  if (c === undefined || c === null) {
    return html`<p class="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500">code laden…</p>`
  }
  if (c.error) {
    return html`<p class="px-4 py-3 text-sm text-rose-500 dark:text-rose-400">${c.error}</p>`
  }
  const units = translationRowUnits(b)
  const activeIndex = () => {
    const g = activeGroup()
    return g && g.idx != null ? g.idx : null
  }
  const siblings = langSiblingsFn ? langSiblingsFn() : []
  // A lang file with many changed keys scrolls out of view exactly like a
  // tall code diff — so this wraps translationBlockView's own scrolling
  // `[data-scrollsync]`/`[data-changed]` div (see its doc comment in
  // translationDiff.mjs) in the SAME shell codeDiff's single-pane branches
  // use (`data-testid="code-diff"` + `data-hints`, the two green scrollHint
  // chevrons) instead of a parallel scroll/hint mechanism: home.mjs's
  // existing `scrollChangeIntoView` (on every ↑/↓) and `updateHints`/
  // `refreshHints` (on scroll/resize) then work for a TRANSLATION card for
  // free. See .claude/rules/blocks-and-ingest.md ("Translation blocks") and
  // .claude/rules/keyboard-navigation.md (the green in-card scroll chevron).
  return html`
    <div
      class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      ${translationBlockView(units, {
        activeIndex,
        approvedRowSet: approvedFn,
        siblings,
        onScroll: (e) => {
          const container = e.target.closest('[data-testid="code-diff"]')
          if (container) updateHints(container)
        },
        commentMarkerFor: (row) => (row != null && commentedFn().has(row) ? commentMarkerHtml() : ''),
        lineSummaryFor: (row) => (row != null ? translationLineSummaryHtml(lineSummaryFn().get(row)) : ''),
      })}
      ${scrollHint('up')}
      ${scrollHint('down')}
    </div>
  `
}

// svgDataUri turns raw SVG source text into a `data:image/svg+xml;base64,...`
// URI for a plain <img> — this is the ONLY way this file ever hands SVG
// content to the DOM. Never render PR-supplied SVG source via .innerHTML (or
// any other route that ends up as an inline <svg> element): the content
// comes from the PR itself, so it's untrusted — an inline <svg> in the page
// can carry a <script>, an `onload=`/`onerror=` handler, or a
// <foreignObject> embedding arbitrary HTML, all of which WOULD execute. A
// browser treats an <img>-rendered SVG purely as an image: per spec, script
// execution (and event handlers) are disabled in that "image context", so a
// hostile SVG can't do anything here beyond rendering (or failing to
// render) its shapes. `unescape(encodeURIComponent(...))` is the standard
// trick to let `btoa` (Latin1-only) encode arbitrary UTF-8 text. Returns ''
// for empty text or anything that doesn't even look like an SVG document (no
// `<svg` tag) — a defensive guard so a garbled/wrong-extension file never
// produces a data URI at all; svgSlot then shows "geen preview" instead.
function svgDataUri(text) {
  if (!text || !/<svg[\s>]/i.test(text)) return ''
  try {
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)))
  } catch {
    return ''
  }
}

// svgPreviewPane renders one labelled image slot (old or new) of the SVG
// preview — a plain <img>, never an inline <svg> (see svgDataUri above).
// `uri` empty (missing side, or content that didn't look like SVG) shows a
// muted "geen preview" placeholder instead of a broken <img>.
function svgPreviewPane(labelText, uri) {
  return html`
    <div class="flex min-w-0 flex-1 flex-col gap-1.5" data-testid="${'svg-pane-' + labelText}">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500"
        >${labelText}</span
      >
      <div
        class="flex min-h-[6rem] items-center justify-center rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/40 p-3"
      >
        ${() =>
          uri
            ? html`<img src="${uri}" alt="${labelText + ' svg'}" class="max-h-64 max-w-full" />`
            : html`<span class="text-xs italic text-slate-400 dark:text-zinc-500">geen preview</span>`}
      </div>
    </div>
  `
}

// svgSlot renders a changed .svg block as RENDERED old/new preview images
// instead of a raw text diff — it REPLACES codeDiff entirely for an .svg
// file (see the b.category/isSvgFile dispatch in Block() above), the same
// "replace, don't add alongside" precedent as translationSlot right above.
// Both images always render side by side; a one-sided (added/removed) block
// shows only the side it actually has (singleSide(b), the same pane choice
// codeDiff itself uses). Deliberately UNAFFECTED by the `a`
// split/unified/fit toggle: unlike the text diff, this preview has no
// text-WIDTH concern for 'fit' to solve (that stand exists to control how
// much code TEXT is shown/how wide a line is) — there's nothing here that
// needs to change across the three stands, so viewMode is not even read.
// The card's own width (widthCls) is untouched too: an .svg file is not a
// PHP file, so it already gets the existing non-PHP width treatment
// (boundedWrapWidthCls) in every stand, exactly like markdown/JSON — two
// small preview images simply share whatever width that already gives.
//
// No raw-text fallback: there is deliberately no toggle back to the plain
// text diff for a changed .svg file. The raw SVG source stays reachable via
// GET /api/code (not surfaced in this UI) and "Open on GitHub", but adding a
// dedicated in-app toggle would need new ephemeral state (and, per the
// convention in urlState.mjs, its own URL field to survive a refresh) for a
// narrow case — out of scope for this change; flagged here rather than
// silently built or silently dropped.
function svgSlot(b) {
  const c = b.code
  if (c === undefined || c === null) {
    return html`<p class="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500">code laden…</p>`
  }
  if (c.error) {
    return html`<p class="px-4 py-3 text-sm text-rose-500 dark:text-rose-400">${c.error}</p>`
  }
  const only = singleSide(b)
  const oldUri = only === 'right' ? '' : svgDataUri(c.old && c.old.text)
  const newUri = only === 'left' ? '' : svgDataUri(c.new && c.new.text)
  return html`
    <div
      class="flex flex-wrap gap-4 border-t border-slate-100 dark:border-zinc-800/60 px-4 py-4"
      data-testid="svg-diff"
    >
      ${() => (only === 'right' ? '' : svgPreviewPane('oud', oldUri))}
      ${() => (only === 'left' ? '' : svgPreviewPane('nieuw', newUri))}
    </div>
  `
}

// codeDiff renders the old/new source side by side under the block info. Old on
// the left, new on the right. The two sides are line-aligned by an LCS diff
// (alignRows, below) so unchanged lines sit on the same row, a removed line
// leaves a blank filler on the right, and an added line leaves a blank filler on
// the left. Changed lines are tinted red (old) / green (new). This is a pure
// text diff — no AI. `b.code` is filled lazily by home.mjs: undefined (not
// requested), null (loading), { old, new } or { error }.
//
// viewMode() is read directly here (not in a nested slot) so this call's own
// enclosing `${() => codeDiff(...)}` slot in Block() picks up state.diffViewMode
// as a dependency, same as its existing b.code dependency — flipping `a`
// re-renders just this per-card slot (split ↔ unified single column), not the
// outer per-column closures in home.mjs. See keyboard-navigation.md.
function codeDiff(
  b,
  activeGroup,
  hintsEnabled = () => false,
  approvedFn = () => new Set(),
  commentedFn = () => new Set(),
  approvedCallsFn = () => new Set(),
  viewMode = () => 'split',
  lineSummaryFn = () => new Map(),
) {
  const c = b.code
  if (c === undefined) return ''
  if (c === null) {
    return html`<div
      class="border-t border-slate-100 dark:border-zinc-800/60 px-4 py-3 text-xs italic text-slate-400 dark:text-zinc-500"
      data-testid="code-diff"
    >
      loading code…
    </div>`
  }
  if (c.error) {
    return html`<div
      class="border-t border-slate-100 dark:border-zinc-800/60 px-4 py-3 text-xs text-rose-500 dark:text-rose-400"
      data-testid="code-diff"
    >
      ${c.error}
    </div>`
  }
  const rows = blockRows(b)
  const only = singleSide(b)
  // Unlike the removed old-'new' stand, the unified stand no longer hides a
  // two-sided (modified) block's old pane — it restructures the block into
  // ONE column instead (unifiedCodeDiff below, old (-) directly above new
  // (+)), see the branch further down. A block that's already one-sided
  // (added/removed) has nothing to restructure — `only` (from singleSide)
  // still wins here, unaffected by viewMode.
  //
  // 'fit', however, DOES force a single pane here — on explicit reviewer
  // request, the third stand never shows old code next to new anymore, even
  // for a genuinely two-sided (modified) block (fitOnly, above): it always
  // collapses to just the new/right pane, exactly like an already one-sided
  // added block. `only ||` keeps the removed-block exception intact (a
  // removed block has no new side to fall back to, so its old/left pane
  // stays visible in every stand, 'fit' included).
  const effectiveOnly = only || (viewMode() === 'fit' ? 'right' : null)
  // A non-PHP file in 'fit' wraps its lines within a bounded width instead of
  // growing the card to fit the longest line (widthCls/boundedWrapWidthCls
  // pick the matching width; this flag makes the row rendering itself wrap
  // instead of overflowing on a single `whitespace-pre` line) — see
  // isPhpFile/fitWidthCls's own doc comment for the full reasoning. Since
  // 'fit' now always forces a single pane above, this only ever reaches the
  // single-pane codePane branches below (effectiveOnly === 'right'/'left')
  // — there is no two-pane wrapping path left to reach.
  const wrap = viewMode() === 'fit' && !isPhpFile(b)
  // A one-sided block (added/removed) renders at the card's full width in
  // every stand — the `a` toggle's narrower 60% width (`narrowed`, see above)
  // still applies to the card itself, just without a second pane to hide;
  // there's no divider, no empty counterpart. A one-sided block never needs
  // the paired-row structure below (there's only one column to wrap), so it
  // just reuses codePane/paneHTML with the `wrap` flag threaded through.
  if (effectiveOnly === 'right') {
    return html`
      <div
        class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60"
        data-testid="code-diff"
        data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
      >
        ${codePane('new', c.new, rows, 'right', 'border-emerald-100 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', activeGroup, 'w-full', approvedFn, commentedFn, approvedCallsFn, wrap, lineSummaryFn)}
        ${scrollHint('up')}
        ${scrollHint('down')}
      </div>
    `
  }
  if (effectiveOnly === 'left') {
    // A left-only pane is exclusively the removed case, so this branch carries
    // the prominent "deleted" banner. The outer div keeps data-testid=code-diff
    // + data-hints (syncScroll's closest() and the hint styling hang off it);
    // the pane + scroll hints move into a nested relative flex-row so the
    // absolutely-positioned hints overlay only the code, not the banner.
    return html`
      <div
        class="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-slate-100 dark:border-zinc-800/60"
        data-testid="code-diff"
        data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
      >
        <div
          data-testid="removed-banner"
          class="shrink-0 border-b border-rose-200 dark:border-rose-500/30 bg-rose-100 dark:bg-rose-500/20 px-4 py-1.5 text-xs font-bold text-rose-700 dark:text-rose-300"
        >
          ${() =>
            b.fileDeleted
              ? 'Verwijderd bestand — deze code bestaat niet meer'
              : 'Verwijderd — deze code bestaat niet meer'}
        </div>
        <div class="relative flex min-h-0 flex-1 overflow-hidden">
          ${codePane('old', c.old, rows, 'left', 'border-rose-100 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400', activeGroup, 'w-full', approvedFn, commentedFn, approvedCallsFn, wrap, lineSummaryFn)}
          ${scrollHint('up')}
          ${scrollHint('down')}
        </div>
      </div>
    `
  }
  // Two-sided (old + new both shown) + the unified stand: one "old above
  // new" column instead of the side-by-side default below — see
  // unifiedCodeDiff's own doc comment. This is also the only remaining
  // two-pane branch left in this function: 'fit' always forces
  // effectiveOnly above, so it never reaches this point at all.
  if (viewMode() === 'unified') {
    return unifiedCodeDiff(rows, hintsEnabled, activeGroup, approvedFn, commentedFn, approvedCallsFn, lineSummaryFn)
  }
  return html`
    <div
      class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      ${codePane('old', c.old, rows, 'left', 'border-rose-100 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400', activeGroup, 'w-1/2', approvedFn, commentedFn, approvedCallsFn, false, lineSummaryFn)}
      <div class="w-px shrink-0 bg-slate-100 dark:bg-zinc-800"></div>
      ${codePane('new', c.new, rows, 'right', 'border-emerald-100 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', activeGroup, 'w-1/2', approvedFn, commentedFn, approvedCallsFn, false, lineSummaryFn)}
      ${scrollHint('up')}
      ${scrollHint('down')}
    </div>
  `
}

// scrollHint is the little floating bar at the top/bottom edge of the diff body
// that tells the reviewer there are still changed lines out of view in that
// direction (so scrolling reveals more). It starts hidden (opacity 0) and is
// switched on/off — and positioned right below the pane headers / above the
// bottom edge — imperatively by updateHints on every scroll and refresh. It's
// pointer-events-none so it never eats a scroll or click.
function scrollHint(dir) {
  const down = dir === 'down'
  // A chevron pointing the way you can scroll. Static SVG string, fed through the
  // .innerHTML binding (arrow.js sets the property instead of escaping) — the
  // markup is our own, so it's safe.
  const chevron = down
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M6 9l6 6 6-6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M18 15l-6-6-6 6"/></svg>'
  return html`
    <div
      data-hint="${dir}"
      style="opacity:0"
      class="${'pointer-events-none absolute inset-x-0 z-10 flex h-7 items-center justify-center transition-opacity duration-150 ' +
      (down
        ? 'bottom-0 bg-gradient-to-t'
        : 'top-0 bg-gradient-to-b') +
      ' from-white/95 via-white/70 to-transparent dark:from-zinc-900/95 dark:via-zinc-900/70 dark:to-transparent'}"
    >
      <span
        class="flex h-4 w-6 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-1 ring-black/5"
        .innerHTML="${() => chevron}"
      ></span>
    </div>
  `
}

// updateHints toggles and positions the up/down scroll hints of one diff. A row
// is "out of view" when its box sits fully above the visible top or below the
// visible bottom of the (equal to both panes) left scroll body; if any changed
// row is out of view in a direction, that hint shows. The hints are anchored to
// the scroll body's edges (top sits below the pane headers) so they float over
// the code, not over the OLD/NEW header row.
export function updateHints(container) {
  const pane = container.querySelector('[data-scrollsync]')
  const up = container.querySelector('[data-hint="up"]')
  const down = container.querySelector('[data-hint="down"]')
  if (!pane || !up || !down) return
  // Only the selected block in diff mode opts in (data-hints="on"); everything
  // else — preview cards, list mode — keeps both hints hidden.
  if (container.getAttribute('data-hints') !== 'on') {
    up.style.opacity = '0'
    down.style.opacity = '0'
    return
  }
  const vRect = pane.getBoundingClientRect()
  let above = false
  let below = false
  for (const el of pane.querySelectorAll('[data-changed]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom <= vRect.top + 0.5) above = true
    else if (r.top >= vRect.bottom - 0.5) below = true
    if (above && below) break
  }
  // This green in-block chevron only ever means "there are more changed lines
  // out of view in this direction — scroll to reveal them". Stepping to the
  // next / previous block is a separate, grey chevron rendered *outside* the
  // card by home.mjs (stepChevron), so it never lights up here.
  const cRect = container.getBoundingClientRect()
  up.style.top = vRect.top - cRect.top + 'px'
  down.style.bottom = cRect.bottom - vRect.bottom + 'px'
  up.style.opacity = above ? '1' : '0'
  down.style.opacity = below ? '1' : '0'
}

// syncScroll keeps the old (left) and new (right) panes in lockstep on both axes:
// scrolling one — sideways or up/down — scrolls the other to the same position.
// Each pane scrolls on its own (they can hold lines of different length), so
// without this they drift apart. The rows are line-aligned and equal-height, so
// scrollTop maps 1:1. The `!==` guards stop the mirrored write from bouncing
// back — once both panes share a value the loop is a no-op. This also carries
// home.mjs's scrollIntoView (which scrolls only the left pane) over to the right.
function syncScroll(e) {
  const src = e.target
  const container = src.closest('[data-testid="code-diff"]')
  if (!container) return
  for (const p of container.querySelectorAll('[data-scrollsync]')) {
    if (p === src) continue
    if (p.scrollLeft !== src.scrollLeft) p.scrollLeft = src.scrollLeft
    if (p.scrollTop !== src.scrollTop) p.scrollTop = src.scrollTop
  }
  // Scrolling may have moved changed lines in or out of view — re-evaluate the
  // up/down hints. Covers both manual scroll and home.mjs's programmatic
  // scrollTop (which fires a scroll event too).
  updateHints(container)
}

// codePane is one half of the diff: a fixed-width, horizontally scrolling column
// with a tinted header. `data` is a codeSide ({ start, end, text }) used only for
// the L-range in the header. The body is the shared aligned `rows`, projected to
// this side (`left` = old, `right` = new). Both panes render the same number of
// rows at the same line-height, so they line up vertically without any JS.
// `wrap` (only ever true for a non-PHP file in 'fit', see isPhpFile/codeDiff)
// switches every row from `whitespace-pre` to `whitespace-pre-wrap
// break-words` — safe here because this is the SINGLE-pane path: there's no
// second pane whose row height needs to stay in lockstep. 'fit' forces a
// single pane for every block (fitOnly/effectiveOnly in codeDiff), so this
// function is now the ONLY render path 'fit' ever reaches; the unified
// stand still never reaches it (see unifiedCodeDiff instead), since that
// stand restructures a genuinely two-sided block into its own single
// "old above new" column.
function codePane(
  side,
  data,
  rows,
  sideKey,
  headerCls,
  activeGroup,
  widthCls = 'w-1/2',
  approvedFn = () => new Set(),
  commentedFn = () => new Set(),
  approvedCallsFn = () => new Set(),
  wrap = false,
  lineSummaryFn = () => new Map(),
) {
  return html`
    <div class="${'flex min-w-0 min-h-0 flex-col ' + widthCls}" data-pane="${side}">
      <div class="no-scrollbar min-h-0 flex-1 overflow-auto" data-scrollsync @scroll="${syncScroll}">
        <code
          class="language-php m-0 block py-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
          @click="${(e) => onPaneClick(rows, e)}"
          .innerHTML="${() =>
            paneHTML(rows, sideKey, activeGroup(), approvedFn(), commentedFn(), approvedCallsFn(), wrap, lineSummaryFn())}"
        ></code>
      </div>
    </div>
  `
}

// commentMarkerHtml renders the 💬 span that marks a row/key carrying an open
// comment (presence only — the count doesn't matter). Shared by rowCellHTML
// (an ordinary code row, appended after the line's own text) and
// translationSlot (a TRANSLATION per-key row has no single code line to
// append to, so it renders the same marker inline in its key header instead
// — see translationBlockView's commentMarkerFor opt) — one source of markup
// so the two never drift apart.
function commentMarkerHtml() {
  return '<span class="select-none opacity-60" data-comment="1" title="Er zit een comment op deze regel">💬</span>'
}

// rowCellHTML builds the <div> for ONE (row, side) — the shared building
// block behind paneHTML (below, the single-pane renderer every stand uses
// except the unified stand's own restructured column) and unifiedHTML (the
// unified stand's single "old above new" column, further below). `wrap`
// switches `whitespace-pre` → `whitespace-pre-wrap break-words`; every
// other computation (active tint, checkmark, comment marker, call
// underline) is identical between both render paths, so extracting this
// avoids duplicating that logic.
//
// `opts.gutter` (only ever true from unifiedHTML) prepends a leading
// "- "/"+ "/"  " marker — mirrors Footer.mjs's own inline-diff gutter — and
// moves the approve checkmark from its usual absolute overlay into an
// inline slot right after that marker (the overlay would otherwise sit on
// top of the gutter text).
//
// `opts.emitMeta` (defaults to true; only ever false from unifiedHTML, for
// the purely decorative OLD half of a paired change) suppresses
// data-row/data-changed/the change-active anchor/the checkmark/the comment
// marker — so a paired row's two stacked lines never both carry the same
// `data-row="i"`, which would make a callArrows/updateHints query for that
// index ambiguous. Exactly one line per row keeps carrying metadata: the
// same canonical side approveHere/commentedHere below already single out
// (the new/right side, or the old/left side when there's no right at all).
function rowCellHTML(r, i, sideKey, group, approved, commented, wrap, opts = {}, lineSummaries = null) {
  const { gutter = false, emitMeta = true } = opts
  const text = sideKey === 'left' ? r.left : r.right
  const mark = sideKey === 'left' ? r.leftMark : r.rightMark
  const ws = wsOnly(r)
  // A row-level flag (a real change on either side) so a single pane's rows
  // carry the full set of changes — updateHints scans just one pane. Del
  // rows are marked on the left, ins rows via their filler row, so both are
  // covered. Whitespace-only re-alignments don't count (see rowChanged/wsOnly).
  const changed = rowChanged(r)
  const active = changed && group && i >= group.start && i <= group.end
  // At call granularity the active unit is a single row plus the char indices
  // of the one call segment being navigated; underline those (per side) so the
  // exact segment within the line is marked. null at group/line granularity.
  const underline =
    active && group.char ? (sideKey === 'left' ? group.left : group.right) : null
  // A fully-approved changed row gets a small checkmark in the left gutter —
  // see approveHere below for which side draws it. The active (indigo)
  // highlight takes precedence visually while the cursor is on the row.
  const isApproved = changed && approved.has(i)
  // Backgrounds are ~20% lighter than the raw Tailwind rose/emerald shades
  // (mixed 20% toward white) so the tint reads as an accent, not a fill.
  let cls = 'relative block px-3 ' + (wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')
  if (active) {
    // Brighter tint + an inset left bar (box-shadow, so it adds no width and
    // the bars of adjacent active rows merge into one continuous accent).
    cls += ' shadow-[inset_3px_0_0_#6366f1]'
    if (mark === 'del') cls += ' bg-[#fed7dc] dark:bg-rose-500/25' // rose-200 +20% white
    else if (mark === 'ins') cls += ' bg-[#b9f5d9] dark:bg-emerald-500/25' // emerald-200 +20% white
    else cls += ' bg-indigo-50 dark:bg-indigo-500/15'
  } else {
    if (ws) {
      // Whitespace-only re-alignment: no full-line tint (it isn't a real
      // change). Only the shifted whitespace itself is coloured, in the body.
    } else if (mark === 'del') cls += ' bg-[#ffe9eb] dark:bg-rose-500/10' // rose-100 +20% white
    else if (mark === 'ins') cls += ' bg-[#dafbea] dark:bg-emerald-500/10' // emerald-100 +20% white
    else if (text === null) cls += ' bg-slate-50 dark:bg-zinc-800/60' // filler for the missing side
  }
  // A row modified on both sides (a del paired with an ins) gets an intra-line
  // char diff so the reviewer sees *what* changed — the inserted/removed
  // characters are marked, not just the whole line. One-sided rows (a pure
  // add or remove) have nothing to diff against, so they highlight plainly.
  const paired = r.left != null && r.right != null && !!r.leftMark && !!r.rightMark
  let body
  if (text === null) body = '&nbsp;'
  else if (paired) body = highlightChanges(r, sideKey, ws, underline)
  else if (underline && underline.size)
    // A one-sided change (pure add / remove): its whole line is the single
    // edit, so underline it end to end.
    body = markChars(highlight(text), (pi) => (underline.has(pi) ? UNDERLINE_CLS : ''))
  else body = highlight(text)
  // A 💬 marks a row that carries a comment — presence only (the count
  // doesn't matter). Shown once per row: on the new (right) pane for a normal
  // row, on the old (left) pane only for a pure deletion (no right side), so a
  // modified row doesn't get the marker twice. Appended after the code so it
  // trails the line and scrolls with it. commentMarkerHtml() below is shared
  // with translationSlot's per-key rows (a TRANSLATION block has no ordinary
  // code line to append this to, so it renders the same marker inline in its
  // key header instead — see translationSlot/translationBlockView).
  const commentedHere =
    emitMeta && text !== null && commented.has(i) && (sideKey === 'right' || r.right == null)
  const marker = commentedHere ? ' ' + commentMarkerHtml() : ''
  // Anchor the first row of the active group so home.mjs can scroll it to
  // the vertical centre of the diff viewport. Suppressed on the decorative
  // OLD half of a unified pair (emitMeta false) — see the doc comment above.
  const anchor = emitMeta && active && i === group.start ? ' data-change-active="1"' : ''
  // Anchor the LAST row of the active group too, so home.mjs's command
  // palette can float below the bottom of a multi-row selection (a `group`
  // unit, or an extended Shift+up/down range — see rangeUnit) instead of
  // overlapping it by anchoring on the first row like scrollChangeIntoView
  // does. Same guard as the first-row anchor above; for a single-row unit
  // (start === end) both attributes land on the same row, so nothing changes
  // there. See "menuAnchor" in home.mjs and keyboard-navigation.md.
  const anchorEnd = emitMeta && active && i === group.end ? ' data-change-active-end="1"' : ''
  const flag = emitMeta && changed ? ' data-changed="1"' : ''
  // approveHere mirrors commentedHere: the approve mark for a row belongs on
  // the new (right) pane normally, and on the old (left) pane only for a pure
  // deletion (no right side) — so a modified row never gets it twice.
  const approveHere = emitMeta && (sideKey === 'right' || r.right == null)
  // lineSummaryHtml: the "onderliggende code" per-line badge (avatar+N
  // comment activity, plus a done/total approve fraction) — see
  // lineSummaryBadge below and home.mjs's lineChildSummaries, which builds
  // the lineSummaries Map keyed by the SAME row index rowCellHTML is
  // rendering here (already resolved onto a change-group's first row where
  // applicable). Same canonical side as commentedHere/approveHere — a
  // modified row never gets it twice.
  const lineSummaryHtml = approveHere && lineSummaries ? lineSummaryBadge(lineSummaries.get(i)) : ''
  // gutterHtml (unified stand only, opts.gutter): the leading "- "/"+ "/"  "
  // marker plus an inline, fixed-width checkmark slot — see the doc comment
  // above for why the checkmark can't stay an absolute overlay here.
  const gutterHtml = gutter ? gutterSpan(mark, isApproved && approveHere) : ''
  // No leading space here: the span is absolutely positioned so it should
  // take no flow width, but a plain leading space character would still be
  // a real char in this white-space:pre row and shift the whole line one
  // monospace column to the right on an approved row. Only used outside the
  // unified stand — there the checkmark rides along inside gutterHtml instead.
  const check =
    !gutter && isApproved && approveHere
      ? '<span class="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] font-bold leading-none text-emerald-600 dark:text-emerald-400" title="Goedgekeurd">✓</span>'
      : ''
  // data-row carries the aligned-row index: the DOM child index can't be used
  // to find a row (the partial-call circle rows below insert extra divs), and
  // only the active group's first row has an anchor otherwise. Used by the
  // call-arrow overlay (src/callArrows.mjs) to anchor an arrow on the exact
  // call-site row. Suppressed when emitMeta is false, see above.
  const dataRow = emitMeta ? ` data-row="${i}"` : ''
  return `<div class="${cls}"${anchor}${anchorEnd}${flag}${dataRow}>${check}${gutterHtml}${body}${marker}${lineSummaryHtml}</div>`
}

// lineSummaryParts builds the shared INNER content (avatar+"+N"
// comment-activity indicator + a done/total approve fraction) and title for
// the "onderliggende code" per-line indicator — factored out of
// lineSummaryBadge so translationLineSummaryHtml below (a TRANSLATION
// per-key row, which has no single code line to absolutely-position an
// overlay on top of) can reuse the exact same content/count logic with a
// different, inline wrapper instead of duplicating it. `commentActivity` on
// `summary` counts EVERY open comment thread in scope — including one placed
// directly on this row/key itself, not only underlying-code children — see
// home.mjs's lineChildSummaries. Returns null when there's nothing to show.
function lineSummaryParts(summary) {
  if (!summary) return null
  const { approve, commentActivity } = summary
  const hasApprove = approve && approve.total > 0
  if (!hasApprove && !commentActivity) return null
  const parts = []
  if (commentActivity) {
    parts.push(
      avatarHtmlString(commentActivity.last.name, commentActivity.last.avatarUrl, 'h-3 w-3') +
        (commentActivity.count > 1
          ? `<span class="text-[9px] font-semibold text-slate-500 dark:text-zinc-500">+${commentActivity.count - 1}</span>`
          : ''),
    )
  }
  if (hasApprove) {
    const done = approve.done === approve.total
    parts.push(
      `<span class="text-[9px] font-semibold tabular-nums ${
        done ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-zinc-500'
      }">${done ? '✓ ' : ''}${approve.done}/${approve.total}</span>`,
    )
  }
  const title =
    'Onderliggende code' +
    (hasApprove ? ' — ' + approve.done + '/' + approve.total + ' regels goedgekeurd' : '') +
    (commentActivity
      ? ' — ' + commentActivity.count + (commentActivity.count === 1 ? ' open reactie' : ' open reacties')
      : '')
  return { html: parts.join(''), title }
}

// lineSummaryBadge renders the small "onderliggende code" pill for one diff
// row, absolutely positioned at the right edge of the row (mirrors the
// left-edge checkmark overlay above) on a small pill background so it stays
// legible over code. A leading "✓ " (never color alone — see the colorblind
// rule in CLAUDE.md) marks a fully approved fraction; the numbers themselves
// already carry the meaning either way. `summary` is one entry of
// home.mjs's lineChildSummaries Map, or undefined/null when this row has
// nothing to show.
function lineSummaryBadge(summary) {
  const p = lineSummaryParts(summary)
  if (!p) return ''
  return ` <span class="select-none absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded bg-white/90 dark:bg-zinc-900/90 px-1 py-0.5 ring-1 ring-slate-200 dark:ring-zinc-700 shadow-sm" data-testid="line-underlying-summary" title="${p.title}">${p.html}</span>`
}

// translationLineSummaryHtml is lineSummaryBadge's sibling for a TRANSLATION
// per-key row (translationSlot's lineSummaryFor callback, passed into
// translationBlockView): same content (lineSummaryParts), but rendered
// INLINE in the key header instead of absolutely positioned — a per-key row
// has no single code line whose right edge it could float over.
function translationLineSummaryHtml(summary) {
  const p = lineSummaryParts(summary)
  if (!p) return ''
  return `<span class="select-none inline-flex items-center gap-1 rounded bg-slate-100 dark:bg-zinc-800 px-1 py-0.5" data-testid="line-underlying-summary" title="${p.title}">${p.html}</span>`
}

// gutterSpan renders the leading "- "/"+ "/"  " marker for the unified
// stand (Block()'s `a`-cycle 2nd stand) — mirrors Footer.mjs's own
// inline-diff gutter (`line()`) so the two "old above new" renderings share
// one visual language. `approvedMark` reserves a second, fixed-width slot
// right after the gutter for the checkmark: the usual absolute-positioned
// checkmark (see rowCellHTML) would sit on top of this leading text, so
// here it renders inline instead, always at the same width (a checkmark or
// a blank), so the code body itself never shifts a column depending on
// approve state.
function gutterSpan(mark, approvedMark) {
  const ch = mark === 'del' ? '-' : mark === 'ins' ? '+' : ' '
  const color =
    mark === 'del'
      ? 'text-rose-500 dark:text-rose-400'
      : mark === 'ins'
      ? 'text-emerald-500'
      : 'text-slate-300 dark:text-zinc-700'
  const check = approvedMark
    ? '<span class="text-emerald-600 dark:text-emerald-400" title="Goedgekeurd">✓</span>'
    : ' '
  return (
    `<span class="select-none ${color}">${ch} </span>` +
    `<span class="select-none inline-block w-3">${check}</span>`
  )
}

// ── Context collapsing for huge blocks ──────────────────────────────────────
// A whole-file fallback block (a multi-thousand-line locale JSON, see
// blocks-and-ingest.md) renders thousands of UNCHANGED context rows around a
// handful of changed lines. That full render (Prism over every line ×2 panes,
// one giant innerHTML string, ~2× rows DOM nodes + layout) repeats on every
// navigation step that re-keys the card (preview↔selected role flips, every
// codeVersion bump — see conventions.md's key-encoding pitfall), which is
// what made sidebar ↑/↓ take 250-850ms per step around such a block
// (measured on PR 13166's 9179-line nl.json/en.json). Blocks above
// COLLAPSE_MIN_ROWS therefore collapse long runs of unchanged rows into one
// clickable "⋯ N ongewijzigde regels" spacer row; everything at or below the
// threshold renders exactly as before (an ordinary PHP method is unaffected).
//
// The plan is a pure function of (rows, commented set, expanded runs) —
// deliberately NOT of the active group/cursor, so an ↑/↓ step never changes
// WHICH rows exist in the DOM (no scroll jumps, no churn), and both panes
// (fed the same inputs) always collapse identically, keeping the split view's
// row-for-row alignment. Changed rows (plus COLLAPSE_CONTEXT rows around
// them) and commented rows are always kept — every row that can carry an
// active highlight/anchor (`data-change-active`), an approve ✓, a 💬 marker,
// a line-summary badge, a call arrow (`data-row` of a call site — always a
// changed line) or the updateHints `data-changed` flag is by construction a
// kept row, so navigation/approve/comments/scrollChangeIntoView/updateHints/
// callArrows keep working on unchanged aligned-row indices. A comment's
// row range CAN cover unchanged rows (a Shift-range spanning a gap), hence
// the explicit `commented` keep.
//
// Expanding: a click on a spacer (event delegation on the pane's <code>, the
// spacer itself lives in an .innerHTML string so it can't carry an arrow.js
// binding) records the run in `expandedRunsByRows` — a plain, non-reactive
// WeakMap keyed on the memoized `rows` array identity (stable per b.code,
// see blockRowsCache; a code reload resets the expansions, ephemeral like
// state.testsExpanded) — and bumps the reactive `collapseUi.v`, which every
// big-block pane's innerHTML binding reads via collapsePlan, so exactly those
// panes re-render with the run expanded. A small block's collapsePlan
// early-returns BEFORE that read, so its binding never subscribes to it (its
// dependency set is stable across runs — rows.length doesn't change within
// one b.code — so the watch-getter crystallisation pitfall doesn't apply).
const COLLAPSE_MIN_ROWS = 300
const COLLAPSE_CONTEXT = 3
const COLLAPSE_MIN_RUN = 10
const collapseUi = reactive({ v: 0 })
const expandedRunsByRows = new WeakMap()

function expandCollapsedRun(rows, runKey) {
  let set = expandedRunsByRows.get(rows)
  if (!set) {
    set = new Set()
    expandedRunsByRows.set(rows, set)
  }
  set.add(runKey)
  collapseUi.v++
}

// onPaneClick is the delegated click handler on each pane's <code> — the only
// interactive thing inside the innerHTML-rendered rows is a collapsed-run
// spacer, so anything else falls through untouched.
function onPaneClick(rows, e) {
  const el = e.target && e.target.closest && e.target.closest('[data-collapsed-run]')
  if (!el) return
  e.stopPropagation()
  expandCollapsedRun(rows, el.getAttribute('data-collapsed-run'))
}

// collapsePlan returns null (render every row — the small-block fast path,
// byte-identical behaviour to before this feature) or a list of segments
// `{skip, start, end}` covering rows exactly once, in order: skip:false →
// render those rows as usual, skip:true → render one collapsedRunHTML spacer
// in their place. Hidden candidates shorter than COLLAPSE_MIN_RUN render
// normally (a "⋯ 3 regels" spacer saves nothing and only adds a click).
function collapsePlan(rows, commented) {
  if (rows.length <= COLLAPSE_MIN_ROWS) return null
  void collapseUi.v // reactive read: expanding a run re-renders this pane
  const expanded = expandedRunsByRows.get(rows)
  const keep = new Uint8Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    if (!rowChanged(rows[i])) continue
    const s = Math.max(0, i - COLLAPSE_CONTEXT)
    const e = Math.min(rows.length - 1, i + COLLAPSE_CONTEXT)
    for (let j = s; j <= e; j++) keep[j] = 1
  }
  if (commented) for (const i of commented) if (i >= 0 && i < keep.length) keep[i] = 1
  if (expanded)
    for (const k of expanded) {
      const d = k.indexOf('-')
      const s = Math.max(0, +k.slice(0, d) || 0)
      const e = Math.min(rows.length - 1, +k.slice(d + 1) || 0)
      for (let j = s; j <= e; j++) keep[j] = 1
    }
  const segs = []
  let collapsedAny = false
  let i = 0
  while (i < rows.length) {
    let j = i
    while (j + 1 < rows.length && keep[j + 1] === keep[i]) j++
    if (!keep[i] && j - i + 1 >= COLLAPSE_MIN_RUN) {
      segs.push({ skip: true, start: i, end: j })
      collapsedAny = true
    } else {
      segs.push({ skip: false, start: i, end: j })
    }
    i = j + 1
  }
  return collapsedAny ? segs : null
}

// collapsedRunHTML renders the spacer for one hidden run of unchanged rows.
// The word + count carry the meaning (never colour alone — colorblind rule);
// the ⋯ glyph and muted tint are decoration on top. Clicking expands the run
// in place (see onPaneClick above).
function collapsedRunHTML(start, end) {
  const n = end - start + 1
  return (
    `<div class="block cursor-pointer select-none whitespace-pre border-y border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 text-center text-[10px] leading-relaxed text-slate-400 dark:text-zinc-500 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-300"` +
    ` data-collapsed-run="${start}-${end}" data-testid="collapsed-run" title="Klik om deze regels te tonen">` +
    `⋯ ${n} ongewijzigde regels</div>`
  )
}

// paneHTML builds the innerHTML string of one pane's <code>: one <div> per
// aligned row (via rowCellHTML), plus the call-approval segment-dots row
// where applicable. Present lines are Prism-highlighted (which escapes the
// text); blank/filler lines get a non-breaking space so the row keeps its
// height. The only unescaped bits are our own static class strings, so the
// result is safe to hand to the .innerHTML binding. A huge block renders
// through collapsePlan (see above): long unchanged runs become one clickable
// spacer row instead — identical in both panes, so they stay aligned.
function paneHTML(
  rows,
  sideKey,
  group,
  approved = new Set(),
  commented = new Set(),
  approvedCalls = new Set(),
  wrap = false,
  lineSummaries = null,
) {
  const parts = []
  const pushRow = (i) => {
    const r = rows[i]
    parts.push(rowCellHTML(r, i, sideKey, group, approved, commented, wrap, {}, lineSummaries))

    // Partial call approval: once at least one — but not all — of this row's
    // call segments is approved, an open circle marks every segment still
    // waiting, positioned under it via a second monospace row. Both panes
    // evaluate the exact same (row, approval-state) inputs, so they insert this
    // extra row at the same index on both sides and stay line-for-line aligned:
    // only the side that actually shows the segments draws the dots, the other
    // gets a blank filler row of equal height.
    const partial = partialCallApproval(rows, i, approved, approvedCalls)
    if (partial) {
      const text = sideKey === 'left' ? r.left : r.right
      const approveHere = sideKey === 'right' || r.right == null
      parts.push(
        approveHere ? circleRowHTML(text, partial.segs, partial.approvedStarts) : BLANK_MARK_ROW,
      )
    }
  }
  const plan = collapsePlan(rows, commented)
  if (!plan) {
    for (let i = 0; i < rows.length; i++) pushRow(i)
  } else {
    for (const seg of plan) {
      if (seg.skip) parts.push(collapsedRunHTML(seg.start, seg.end))
      else for (let i = seg.start; i <= seg.end; i++) pushRow(i)
    }
  }
  return parts.join('')
}

// unifiedRowHTML renders one aligned row for the unified stand (`a`'s 2nd
// stand, a genuinely two-sided/modified block): the OLD (-) line directly
// above the NEW (+) line, in ONE column — mirroring Footer.mjs's own
// "- old / + new" inline-diff convention — instead of 'split''s side-by-side
// panes. A context row (no leftMark/rightMark) or a one-sided row (a pure
// add/remove) still renders as a single line; only a PAIRED row (both
// leftMark:'del' and rightMark:'ins' — a real replacement OR a
// whitespace-only re-alignment, see wsOnly) renders both lines. See
// rowCellHTML's own doc comment for why exactly one of the two lines (the
// canonical, metadata-carrying one) ever gets `data-row`/etc.
function unifiedRowHTML(r, i, group, approved, commented, lineSummaries = null) {
  const paired = r.left != null && r.right != null && !!r.leftMark && !!r.rightMark
  if (paired) {
    return (
      rowCellHTML(r, i, 'left', group, approved, commented, false, { gutter: true, emitMeta: false }, lineSummaries) +
      rowCellHTML(r, i, 'right', group, approved, commented, false, { gutter: true, emitMeta: true }, lineSummaries)
    )
  }
  if (r.right != null) {
    return rowCellHTML(r, i, 'right', group, approved, commented, false, { gutter: true, emitMeta: true }, lineSummaries)
  }
  if (r.left != null) {
    return rowCellHTML(r, i, 'left', group, approved, commented, false, { gutter: true, emitMeta: true }, lineSummaries)
  }
  return ''
}

// unifiedCallText picks the same "current" text a call-segment progress row
// (circleRowHTML) needs to align its dots against — the new/right text when
// there is one, otherwise the old/left text (a pure deletion) — mirroring
// paneHTML's own approveHere-driven side choice.
function unifiedCallText(r) {
  return r.right != null ? r.right : r.left
}

// unifiedHTML builds the innerHTML string of the unified stand's single
// column: one (or, for a paired change, two) unifiedRowHTML lines per
// aligned row, plus the call-approval segment-dots row where applicable —
// simpler than paneHTML's two-pane version above, since there's only one
// column to keep aligned (no blank filler row needed for "the other pane
// didn't draw it").
function unifiedHTML(
  rows,
  group,
  approved = new Set(),
  commented = new Set(),
  approvedCalls = new Set(),
  lineSummaries = null,
) {
  const parts = []
  const pushRow = (i) => {
    parts.push(unifiedRowHTML(rows[i], i, group, approved, commented, lineSummaries))
    const partial = partialCallApproval(rows, i, approved, approvedCalls)
    if (partial) parts.push(circleRowHTML(unifiedCallText(rows[i]), partial.segs, partial.approvedStarts))
  }
  const plan = collapsePlan(rows, commented)
  if (!plan) {
    for (let i = 0; i < rows.length; i++) pushRow(i)
  } else {
    for (const seg of plan) {
      if (seg.skip) parts.push(collapsedRunHTML(seg.start, seg.end))
      else for (let i = seg.start; i <= seg.end; i++) pushRow(i)
    }
  }
  return parts.join('')
}

// unifiedCodeDiff renders the two-sided ('modified') diff for the `a`-cycle
// unified stand: a SINGLE scrolling column instead of two side-by-side
// panes — see unifiedRowHTML/unifiedHTML above for the per-row "old above
// new" shape. Carries `data-pane="new"` (the same meaning that attribute
// already carries on the ordinary new/right codePane — the side the call
// site actually lives on) so the call-arrow overlay
// (callArrows.mjs's `[data-pane="new"]` query) still finds it.
function unifiedCodeDiff(rows, hintsEnabled, activeGroup, approvedFn, commentedFn, approvedCallsFn, lineSummaryFn = () => new Map()) {
  return html`
    <div
      class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      <div class="no-scrollbar min-h-0 flex-1 overflow-auto" data-pane="new" data-scrollsync @scroll="${syncScroll}">
        <code
          class="language-php m-0 block py-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
          @click="${(e) => onPaneClick(rows, e)}"
          .innerHTML="${() =>
            unifiedHTML(rows, activeGroup(), approvedFn(), commentedFn(), approvedCallsFn(), lineSummaryFn())}"
        ></code>
      </div>
      ${scrollHint('up')}
      ${scrollHint('down')}
    </div>
  `
}

// BLANK_MARK_ROW is the filler used on the pane that doesn't draw the
// call-approval circles, so both panes keep the same row count and stay
// vertically aligned (see paneHTML). Not used by unifiedHTML above (one
// column, no second pane to keep aligned with).
const BLANK_MARK_ROW = '<div class="block whitespace-pre px-3 leading-none">&nbsp;</div>'

// partialCallApproval decides whether row `i` should show the per-segment
// open-circle indicator: it has more than one call segment (rowCallSegments),
// isn't already fully approved (that gets the plain checkmark instead), and at
// least one — but not all — of its segments is approved. Returns null when
// nothing is approved yet (nothing to show) or everything is (checkmark
// covers it), matching the "niks → niks, deels → bolletjes, alles → vinkje"
// rule.
function partialCallApproval(rows, i, approved, approvedCalls) {
  if (!rowChanged(rows[i])) return null
  if (approved.has(i)) return null
  const segs = rowCallSegments(rows, i)
  if (segs.length <= 1) return null
  const prefix = i + ':'
  const approvedStarts = new Set(
    [...approvedCalls]
      .filter((k) => k.startsWith(prefix))
      .map((k) => Number(k.slice(prefix.length))),
  )
  const done = segs.filter((s) => approvedStarts.has(s.start)).length
  if (done === 0 || done >= segs.length) return null
  return { segs, approvedStarts }
}

// circleRowHTML renders the per-segment progress row: one dot under every call
// segment, positioned at its (whitespace-trimmed) start column via literal
// leading spaces — works without any JS measurement because the row shares the
// exact same monospace font/size as the code line above it, so columns line up
// 1:1. An already-approved segment gets a solid green dot, a still-waiting one
// a hollow (open) one — so the row reads at a glance as a progress strip.
function circleRowHTML(text, segs, approvedStarts) {
  let out = ''
  let col = 0
  for (const s of segs) {
    let start = s.start
    while (start < s.end && /\s/.test(text[start])) start++
    if (start < col) continue
    out += ' '.repeat(start - col)
    out += approvedStarts.has(s.start)
      ? '<span class="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" title="Goedgekeurd"></span>'
      : '<span class="inline-block h-1.5 w-1.5 rounded-full border border-emerald-500 align-middle" title="Nog niet goedgekeurd"></span>'
    col = start + 1
  }
  return `<div class="block whitespace-pre px-3 leading-none">${out || '&nbsp;'}</div>`
}

// wsOnly reports whether a row differs on both sides purely in whitespace
// (indentation / alignment): same tokens, just re-spaced. Re-indenting a whole
// block makes diffLines pair every line as del/ins even though nothing really
// changed — these rows are noise, so we skip them for navigation and don't tint
// the whole line, only the shifted whitespace.
function wsOnly(r) {
  return (
    r.leftMark === 'del' &&
    r.rightMark === 'ins' &&
    r.left != null &&
    r.right != null &&
    r.left.replace(/\s+/g, '') === r.right.replace(/\s+/g, '')
  )
}

// rowChanged reports whether a row counts as a change for navigation and hints:
// it carries a del/ins mark and isn't a whitespace-only re-alignment.
function rowChanged(r) {
  return !!(r.leftMark || r.rightMark) && !wsOnly(r)
}

// UNDERLINE_CLS is the thin underline that marks the *active* call segment when
// the reviewer has drilled navigation down to the finest level (gran === 'call').
// Its colour is the same indigo (#6366f1) as the inset left bar of an active row,
// so "the selected segment within the line" reads as the finest step of the same
// accent.
export const UNDERLINE_CLS = 'underline decoration-2 decoration-[#6366f1] underline-offset-2'

// highlightChanges renders one side of a modified row: Prism-highlighted like any
// line. A real content change no longer gets its own char-level background here
// — the line-level row background (rose/emerald pane tint) already shows what
// changed. The one exception is a whitespace-only re-alignment (`ws`): the row
// itself stays untinted (see paneHTML), so the shifted whitespace still needs
// its own soft marker to be visible at all — see `wsOnly` in blocks-and-ingest.md.
// `underline` is an optional Set of char indices (the active call-segment) that
// gets the indigo underline regardless of `ws`.
function highlightChanges(r, sideKey, ws, underline) {
  const text = sideKey === 'left' ? r.left : r.right
  const markCls = ws ? (sideKey === 'left' ? 'bg-rose-200 dark:bg-rose-500/30' : 'bg-emerald-200 dark:bg-emerald-500/30') : ''
  const { leftMarked, rightMarked } = ws ? charDiffSides(r.left, r.right) : {}
  const marked = ws ? (sideKey === 'left' ? leftMarked : rightMarked) : null
  return markChars(highlight(text), (pi) => {
    const parts = []
    if (marked && marked.has(pi)) parts.push(markCls)
    if (underline && underline.has(pi)) parts.push(UNDERLINE_CLS)
    return parts.join(' ')
  })
}

// charDiffSides diffs the two sides at *token* granularity and returns, per side,
// the set of character indices belonging to a token present on only that side.
// A token is a whole `[A-Za-z0-9]` run (an identifier / number) or a single other
// character, so a word is matched as a unit. Only used for whitespace-only rows
// (see `highlightChanges`) — there, every token matches except the whitespace
// tokens, so this ends up marking exactly the re-spaced whitespace.
function charDiffSides(left, right) {
  const a = tokenize(left || '')
  const b = tokenize(right || '')
  const ops = diffChars(
    a.map((t) => t.text),
    b.map((t) => t.text),
  )
  const leftMarked = new Set()
  const rightMarked = new Set()
  const markToken = (set, tok) => {
    for (let k = 0; k < tok.text.length; k++) set.add(tok.start + k)
  }
  let ai = 0
  let bi = 0
  for (const op of ops) {
    if (op === 'eq') {
      ai++
      bi++
    } else if (op === 'del') {
      markToken(leftMarked, a[ai++])
    } else {
      markToken(rightMarked, b[bi++])
    }
  }
  return { leftMarked, rightMarked }
}

// tokenize splits a line into { text, start } tokens: each maximal `[A-Za-z0-9]`
// run is one token (so identifiers/numbers match whole), and every other
// character (operators, punctuation, each whitespace char) is its own token.
function tokenize(s) {
  const toks = []
  const re = /[A-Za-z0-9]+|[^A-Za-z0-9]/g
  let m
  while ((m = re.exec(s)) !== null) {
    toks.push({ text: m[0], start: m.index })
  }
  return toks
}

// diffChars is diffLines over an arbitrary sequence (characters or tokens): a
// classic LCS returning 'eq'/'del'/'ins' ops turning `a` into `b`, comparing
// elements with `===`. Lines are short, so the O(n·m) table is cheap.
function diffChars(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('eq')
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push('del')
      i++
    } else {
      ops.push('ins')
      j++
    }
  }
  while (i < n) {
    ops.push('del')
    i++
  }
  while (j < m) {
    ops.push('ins')
    j++
  }
  return ops
}

// markChars wraps the characters of a Prism-highlighted HTML string in marker
// spans, where `classOf(plaintextIndex)` returns the class string for that source
// char (`''` for none). It walks the HTML tracking the plaintext offset — copying
// tags verbatim (they don't advance the offset) and counting each entity
// (`&amp;` etc.) as one source char — so char-offset-based classifiers (e.g. the
// active call-segment underline, or the whitespace-only tint) line up with the
// escaped output. Consecutive chars that map to the *same* class string share
// one span, and a span is always closed before a tag, so a marker never
// straddles a Prism token boundary (it nests inside or sits between tokens) and
// the markup stays well-formed.
export function markChars(html, classOf) {
  let out = ''
  let pi = 0 // plaintext index into the original line
  let i = 0
  let open = '' // the class string of the currently-open span ('' = none)
  const ensure = (cls) => {
    if (cls === open) return
    if (open) out += '</span>'
    open = ''
    if (cls) {
      out += `<span class="${cls}">`
      open = cls
    }
  }
  while (i < html.length) {
    const ch = html[i]
    if (ch === '<') {
      // A tag — copy it whole, and never let a marker span straddle it.
      ensure('')
      const end = html.indexOf('>', i)
      const to = end === -1 ? html.length : end + 1
      out += html.slice(i, to)
      i = to
      continue
    }
    if (ch === '&') {
      // An HTML entity stands for a single source char.
      const end = html.indexOf(';', i)
      const to = end === -1 ? i + 1 : end + 1
      ensure(classOf(pi))
      out += html.slice(i, to)
      pi++
      i = to
      continue
    }
    ensure(classOf(pi))
    out += ch
    pi++
    i++
  }
  ensure('')
  return out
}

// dedent4 strips one level of leading indent from the diff: only when every
// non-blank line of BOTH sides starts with 4 spaces does it drop those 4 spaces
// everywhere. Blocks are usually one method deep inside a class, so this removes
// the dead indent and lets the code sit flush in the panes. The all-or-nothing
// check keeps old/new stripped by the same amount, so alignRows still lines up.
// Blank lines are left as-is. Returns [old, new].
function dedent4(oldText, newText) {
  const lines = (oldText + '\n' + newText).split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0 || !lines.every((l) => l.startsWith('    '))) {
    return [oldText, newText]
  }
  const strip = (t) =>
    t
      .split('\n')
      .map((l) => (l.startsWith('    ') ? l.slice(4) : l))
      .join('\n')
  return [strip(oldText), strip(newText)]
}

// blockRowsCache memoizes blockRows() per block, keyed on b.code's own
// reference identity (not b itself, since b.code is what actually determines
// the result — dedent4/alignRows are pure functions of its text). Kept as a
// module-level WeakMap OUTSIDE reactive state (like home.mjs's
// codeRequested Set) so reading/writing it never creates or notifies an
// arrow.js dependency. b.code is always wholesale-reassigned when new code
// arrives (ensureCode does `b.code = await res.json()`, never an in-place
// mutation — see home.mjs), so comparing the stored reference against the
// current one is a correct, exact invalidation check: a cache hit is only
// possible while b.code is still the exact object it was computed against.
//
// This matters because blockRows is called from 20+ sites (every diff render,
// every navigation-unit computation, and — critically — home.mjs's
// approvalSummaries watch, which recomputes subtreeApproveCount for EVERY
// top-level block on every state.codeVersion bump, i.e. on every block's code
// arriving anywhere, including as a look-ahead preview during plain sidebar
// navigation). Without memoization, a single large non-PHP block (e.g. a
// whole-file-fallback block for a multi-thousand-line JSON/locale file — see
// blocks-and-ingest.md) turns its O(n·m) LCS diff (alignRows/diffLines) into a
// tax paid again on every subsequent, unrelated navigation step for the rest
// of the session, which is what made the sidebar "loopt vast" after passing
// such a block (measured: sidebar ArrowDown steps went from ~50ms to a
// sustained 400-4900ms, with one 6-15s spike, after a 9000-line block's code
// arrived — see blocks-and-ingest.md).
const blockRowsCache = new WeakMap()

// blockRows produces the aligned diff rows for a loaded block (b.code === {old,new}).
// Returns [] when the code isn't loaded or errored. Shared by codeDiff (rendering)
// and home.mjs (change navigation) so both agree on the exact same row list.
export function blockRows(b) {
  const c = b && b.code
  if (!c || c.error) return []
  const cached = blockRowsCache.get(b)
  if (cached && cached.code === c) return cached.rows
  const [oldText, newText] = dedent4(
    (c.old && c.old.text) || '',
    (c.new && c.new.text) || '',
  )
  const rows = alignRows(oldText, newText)
  blockRowsCache.set(b, { code: c, rows })
  return rows
}

// unitsFor maps a granularity ('group' | 'line' | 'call') to its navigation-unit
// list for the given rows: whole change runs (changeGroups), individual changed
// lines (changeLines), or single call-chain segments within a line (changeCalls).
// Shared by home.mjs (diff navigation) and Footer.mjs (the one-line preview) so
// both agree on what the currently-selected unit is.
export function unitsFor(rows, gran) {
  if (gran === 'line') return changeLines(rows)
  if (gran === 'call') return changeCalls(rows)
  return changeGroups(rows)
}

// ── Approval ───────────────────────────────────────────────────────────────
// Approval is tracked per *changed row*: `b.approvedRows` is an array of row
// indices (into blockRows) the reviewer has signed off. Every granularity's
// approval reduces to these rows — approving a group marks all its rows, a line
// or call marks the one row it sits on — so "is the whole block approved?" is
// simply "are all changed rows approved?". The array is always reassigned (never
// mutated in place) so arrow.js re-renders the checkbox and the pane bars.

// displayText returns a row's *display* side text — the new (right) side for
// an `ins` row (including a paired modification, whose display side is always
// the new one), the old (left) side for a del-only row with no replacement.
// Shared by rowHasContent and isBracketOnlyRow below.
function displayText(r) {
  return r.rightMark === 'ins' ? r.right : r.left
}

// rowHasContent reports whether a changed row actually carries visible text on
// its display side. A row can be `rowChanged` (it carries a del/ins mark) yet
// be a blank/whitespace-only line that's purely part of the diff — e.g. a
// blank line inside a wholly *added* function (status: 'added', so the entire
// body is emitted as one-sided `ins` rows including its blank lines) or a
// blank *removed* line. That's diff noise, not reviewable content: nothing to
// read or judge. Used to additionally filter changedRows/changeLines/changeCalls
// (see below) so such a row never counts toward the approve total and is never
// its own landable line/call unit ("ik kan het selecteren zonder dat ik het zie").
// Deliberately NOT applied to changeGroups/rowChanged themselves: a blank row
// still rides along inside whichever group run it falls in (same as a
// bracket-only row, see hasLetter) so a group's highlighted range never jumps
// around it — only its own count/selectability is suppressed.
//
// Go port: blockstats.go's rowHasContent — keep both in lockstep.
function rowHasContent(r) {
  const text = displayText(r)
  return !!(text && text.trim() !== '')
}

// isBracketOnlyRow reports whether a changed row's display text is nothing
// but closing/structural punctuation — ')', '}', ';', ',', ']', '{' — after
// trim (combinations count too, e.g. a lone `});` line closing a callback, or
// a stray `},`/`{` on its own line). Such a line needs no separate review of
// its own: see sweepBracketOnlyForward (home.mjs), which auto-approves it
// once the reviewer approves the line/group right before it. This does NOT
// change what counts toward changedRows/the approve total (a bracket-only
// row already counts, same as before) — it only affects which specific rows
// end up in b.approvedRows when an approve action runs, so no Go port is
// needed here (see blocks-and-ingest.md).
export function isBracketOnlyRow(r) {
  if (!rowChanged(r)) return false
  const text = displayText(r)
  if (!text) return false
  const t = text.trim()
  return t !== '' && /^[)};,\]{]+$/.test(t)
}

// changedRows returns the indices of every navigable (changed, non-ws-only,
// non-blank) row — the full set a reviewer must approve for the block to
// count as approved.
export function changedRows(rows) {
  const out = []
  for (let i = 0; i < rows.length; i++)
    if (rowChanged(rows[i]) && rowHasContent(rows[i])) out.push(i)
  return out
}

// sweepBracketOnlyForward extends a set of just-approved row indices with the
// run of directly FOLLOWING (forward only — never backward, a deliberate
// scope choice) changed rows whose content is nothing but closing punctuation
// (isBracketOnlyRow): approving a line/group also approves the `});`/`},`/
// etc. line(s) right after it, so the reviewer never has to approve those
// separately. One-way: only meant to be applied on the ADD path of an
// approve toggle (see toggleApprove in home.mjs) — retracting an approval
// never un-approves an already-swept neighbor, so there is no shared-row
// edge case (a bracket-only row sitting between two independently-approved
// lines) to resolve. `target` must be non-empty; returns it unchanged
// otherwise.
export function sweepBracketOnlyForward(rows, target) {
  if (!target.length) return target
  const set = new Set(target)
  const hi = Math.max(...target)
  for (let j = hi + 1; j < rows.length && isBracketOnlyRow(rows[j]); j++) set.add(j)
  return [...set].sort((a, b) => a - b)
}

// diffStat tallies added vs removed lines over aligned rows, git-diff-stat style:
// an inserted line counts +1, a removed line -1, and a paired modification counts
// as both (+1/-1). Whitespace-only re-alignments are skipped (same as rowChanged).
export function diffStat(rows) {
  let add = 0
  let del = 0
  for (const r of rows) {
    if (wsOnly(r)) continue
    if (r.rightMark === 'ins') add++
    if (r.leftMark === 'del') del++
  }
  return { add, del }
}

// approvedRowSet reads a block's approved-row indices as a Set (empty when none).
export function approvedRowSet(b) {
  return new Set(Array.isArray(b && b.approvedRows) ? b.approvedRows : [])
}

// approvedCallSet reads a block's approved call-segment keys as a Set (empty
// when none). A key is `${row}:${segStart}` (see callKey/rowCallSegments) —
// finer than approvedRows, used only while a row's segments aren't *all*
// approved yet (once they are, the row graduates into approvedRows instead —
// see toggleCallApprove in home.mjs — so the two sets never overlap for a row).
export function approvedCallSet(b) {
  return new Set(Array.isArray(b && b.approvedCalls) ? b.approvedCalls : [])
}

// callKey builds the approvedCalls key for one call segment: its row plus the
// segment's untrimmed start char offset, stable because rowCallSegments always
// splits the same source text the same way.
export function callKey(row, segStart) {
  return row + ':' + segStart
}

// callUnitApproved reports whether one call-granularity unit (as produced by
// changeCalls) currently counts as approved: its whole row is approved (a
// coarser group/line approval, or a call approval that graduated once every
// segment of the row was approved), or its own segment key is in approvedCalls.
export function callUnitApproved(b, unit) {
  if (!unit) return false
  if (approvedRowSet(b).has(unit.start)) return true
  return approvedCallSet(b).has(callKey(unit.start, unit.segStart))
}

// blockApproved — the derived top-level state: a block is approved once it has at
// least one change and *every* changed row is approved.
export function blockApproved(b) {
  const all = changedRows(blockRows(b))
  if (!all.length) return false
  const set = approvedRowSet(b)
  return all.every((i) => set.has(i))
}

// blockPartlyApproved — some but not all changed rows approved (the checkbox's
// indeterminate state).
export function blockPartlyApproved(b) {
  const all = changedRows(blockRows(b))
  const set = approvedRowSet(b)
  const done = all.filter((i) => set.has(i)).length
  return done > 0 && done < all.length
}

// toggleBlockApproval flips the whole block from the top checkbox: approve every
// changed row, or (if already fully approved) clear them all.
function toggleBlockApproval(b) {
  b.approvedRows = blockApproved(b) ? [] : changedRows(blockRows(b))
}

// approveSummary is the checkbox label: plain "approve" for a block with no
// navigable changes, else "approve <done>/<total>" so approval progress is legible.
function approveSummary(b) {
  const all = changedRows(blockRows(b))
  if (!all.length) return 'approve'
  const set = approvedRowSet(b)
  const done = all.filter((i) => set.has(i)).length
  return `approve ${done}/${all.length}`
}

// changeGroups collapses runs of consecutive changed rows (del/ins) into
// navigation targets: one group per run, but a run longer than MAX_GROUP rows is
// split into successive groups of that size. Each group is { start, end }
// (inclusive row indices into `rows`). Unchanged rows break a run.
//
// The MAX_GROUP split only happens on a row that carries an actual letter (A-z):
// a changed row whose text is just braces/punctuation (e.g. `}` or `{`) is
// pulled into the current group instead of starting a fresh one, so a group
// never ends right before — or begins on — a bare bracket line.
const MAX_GROUP = 5
export function changeGroups(rows) {
  const groups = []
  let run = null
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const changed = rowChanged(r)
    if (!changed) {
      run = null
      continue
    }
    if (!run || (run.end - run.start + 1 >= MAX_GROUP && hasLetter(r))) {
      run = { start: i, end: i }
      groups.push(run)
    } else {
      run.end = i
    }
  }
  return groups
}

// changeLines is the line-granularity navigation list: one unit per changed row
// that carries visible content, each a single-row range { start: i, end: i }.
// Same shape as a changeGroups entry so the two are interchangeable for range
// highlighting. Added and modified rows are landable via their new (right) side;
// a pure deletion (a removed line with no replacement, rightMark !== 'ins') is
// ALSO landable — it counts toward changedRows/the approve total (it's a real
// change), so it must be individually approvable at line granularity too, not
// only at group/call level. That mirrors changeCalls, which already lands on a
// removed line. Its approve ✓ then renders on the old (left) pane (approveHere
// in paneHTML). Only a blank/whitespace-only row (see rowHasContent) stays
// skipped on both sides — diff noise with nothing to read or judge.
export function changeLines(rows) {
  const units = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (rowChanged(r) && rowHasContent(r)) units.push({ start: i, end: i })
  }
  return units
}

// changeCalls is the call-granularity navigation list: one unit per call-chain
// segment of a changed row. Unlike the coarser levels this cuts a line by its
// *structure* (the calls it makes), not by what the diff changed — so later each
// segment can be tied to the function it calls (an edge in the call-graph). A
// line is split on `->`, `;`, the binary separators `??`/`&&`/`||`/comparisons,
// and a call's `(`/argument `,` boundaries (segmentCalls), and — unlike changeLines —
// the WHOLE new line is walked: every non-empty segment is landable, changed or
// not. Each unit is a single-row range { start: i, end: i } tagged `char: true`
// with `left`/`right` Sets of the char indices to underline on each side.
//
// Only new code (the right pane) is segmented: a row that adds new text
// (rightMark === 'ins') is split into its call segments. A removed line with no
// replacement still gets one unit — an empty new segment (nothing right) with the
// whole old line underlined — so you can land on it as a blank row marking what's
// gone.
export function changeCalls(rows) {
  const units = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!rowChanged(r)) continue
    // A blank row (see rowHasContent) is diff noise: skip it entirely, on
    // both branches below — it never becomes its own call-segment unit.
    if (!rowHasContent(r)) continue
    if (r.rightMark === 'ins' && r.right != null) {
      for (const s of rowCallSegments(rows, i))
        units.push({
          start: i,
          end: i,
          char: true,
          left: new Set(),
          right: rangeSet(r.right, s.start, s.end),
          segStart: s.start,
        })
    } else {
      // A removed line with no replacement: land on it as an empty new segment,
      // underlining the whole removed line on the old side so you see what's gone.
      units.push({
        start: i,
        end: i,
        char: true,
        left: fullSet(r.left || ''),
        right: new Set(),
        segStart: 0,
      })
    }
  }
  return units
}

// rowCallSegments lists the call-chain segments of one row's *display* text —
// the new (right) text for a normal/added row, the old (left) text for a pure
// deletion with no replacement — mirroring changeCalls' own split. A segment's
// (untrimmed) start offset is used as its stable per-row approval key (see
// callKey). A row with nothing to split (a blank added line, or no real call
// structure) still yields exactly one segment spanning the whole text, so a
// row always has at least one segment — the fully-approved/none-approved cases
// stay binary and only rows with 2+ segments can be partly approved.
export function rowCallSegments(rows, i) {
  const r = rows[i]
  if (r.rightMark === 'ins' && r.right != null) {
    const segs = segmentCalls(r.right).filter(
      (s) => r.right.slice(s.start, s.end).trim() !== '',
    )
    return segs.length ? segs : [{ start: 0, end: r.right.length }]
  }
  return [{ start: 0, end: (r.left || '').length }]
}

// CALL_SEPARATORS are binary operators that join two *independent* operands —
// each side is its own call chain — so they break a segment and lead the next one
// (like `->`). `$a->x ?? $b->y` must split at `??` so `$a->x` and `$b->y` are
// separate segments (each later tied to its own call-graph edge), otherwise `??`
// gets swallowed into one caller's segment. Besides `??` (null-coalesce) this
// covers the logical `&&`/`||` and the comparisons — all glue two callers.
// Matched longest-first so `===` beats `==` and `!==` beats `!=`.
//
// Deliberately NOT separators (would over-split real chains): `=>` (array
// key=>value stays one segment — see the toArray test), `.` (PHP string
// concatenation, not a call boundary), `::` (static call, part of a chain), the
// ternary `?`/`:` (collide with the `?->` nullsafe operator and `::`), a bare
// `<`/`>` (collide with `->` and `=>`), and arithmetic (rarely a caller boundary,
// and `-`/`/` collide with `->`/`//`).
const CALL_SEPARATORS = ['===', '!==', '??', '&&', '||', '==', '!=', '<=', '>=']

// segmentCalls splits a line into call-chain segments so each caller — and each
// of its arguments — is separately landable. A new segment begins at each `->`
// or a CALL_SEPARATORS operator (the operator starts the call it introduces);
// `;` closes the current one (a statement boundary, kept at the end of its call).
// Two more boundaries separate a call from its arguments: at the *outermost*
// call's opening `(` (when it has real arguments) the caller name ends and the
// first argument starts fresh, and each top-level `,` inside that `(` ends one
// argument. So `$order->customer()->name();` (empty `()`, no args) stays
// `$order` / `->customer()` / `->name();`, while
// `$couple->orWhere('contracts.type', $mapping[$type]);` becomes
// `$couple` / `->orWhere(` / `'contracts.type',` / `$mapping[$type]);`.
// Strings are opaque — no boundary (`->`/`,`/`??`, and PHP's `.` concatenation)
// is ever detected inside a quoted literal, so `'contracts.type'` stays whole.
// Argument splitting is *outermost only*: a nested call or array argument keeps
// its own commas (`foo(bar($a, $b), $c)` → `foo(` / `bar($a, $b),` / `$c)`).
// The segments tile the whole line with no gaps. Returns [{ start, end }]
// half-open char ranges.
function segmentCalls(text) {
  const segs = []
  let start = 0
  const push = (end) => {
    if (end > start) segs.push({ start, end })
    start = end
  }
  // skipString returns the index just past the closing quote of the string that
  // starts at i (text[i] is `'` or `"`), honouring backslash escapes.
  const skipString = (i) => {
    const q = text[i]
    i += 1
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === q) return i + 1
      i += 1
    }
    return i
  }
  const stack = [] // open brackets we're inside: '(', '[' or '{'
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'") {
      i = skipString(i) // strings are opaque — no boundary lives inside one
    } else if (c === '-' && text[i + 1] === '>') {
      push(i) // end current here; `->` starts the next segment
      i += 2
    } else if (c === '(' || c === '[' || c === '{') {
      // Separate the caller name from its arguments only at the outermost call
      // (nothing open yet) that actually has arguments: peek past whitespace, an
      // empty `()` stays with the caller so `->customer()` is one segment.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const outermost = stack.length === 0
      stack.push(c)
      i += 1
      if (c === '(' && outermost && text[j] !== ')') push(i)
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.length) stack.pop()
      i += 1 // a closer rides along with the segment it ends
    } else if (c === ',' && stack.length === 1 && stack[0] === '(') {
      i += 1
      push(i) // an outermost-call argument boundary; the `,` trails its argument
    } else if (c === ';') {
      i += 1
      push(i) // include `;` in the current segment, then start fresh after it
    } else {
      const op = CALL_SEPARATORS.find((o) => text.startsWith(o, i))
      if (op) {
        push(i) // end current before the operator; it leads the next segment
        i += op.length
      } else {
        i += 1
      }
    }
  }
  push(text.length)
  return segs
}

// rangeSet returns the set of char indices in the half-open range [start, end),
// with leading and trailing whitespace trimmed off so the underline hugs the
// segment's text and never runs across the empty indent before it (or a trailing
// gap). `text` is the full line the range indexes into. Interior whitespace stays
// underlined so a segment reads as one continuous mark.
function rangeSet(text, start, end) {
  let s = start
  let e = end
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  const set = new Set()
  for (let k = s; k < e; k++) set.add(k)
  return set
}

// fullSet returns the set of every non-outer-whitespace char index of a string
// (leading/trailing whitespace trimmed, like rangeSet over the whole line).
function fullSet(s) {
  return rangeSet(s, 0, s.length)
}

// hasLetter reports whether either side of a row contains an ASCII letter (A-z).
// Bracket/punctuation-only rows return false, so they never act as a split
// boundary in changeGroups.
function hasLetter(r) {
  return /[a-z]/i.test(r.left || '') || /[a-z]/i.test(r.right || '')
}

// alignRows turns the old and new source into a list of aligned rows. Each row is
// { left, right, leftMark, rightMark }: `left`/`right` are the line text (or null
// when that side has no line on this row), and the marks ('del'/'ins'/null) drive
// the tint. Unchanged lines pair up; a run of removals is paired line-by-line
// with the following run of additions (so a modified line lines up with its
// replacement), and any overflow becomes one-sided rows.
function alignRows(oldText, newText) {
  const a = oldText ? oldText.split('\n') : []
  const b = newText ? newText.split('\n') : []
  const ops = diffLines(a, b)

  const rows = []
  let dels = []
  let inss = []
  const flush = () => {
    const n = Math.max(dels.length, inss.length)
    for (let i = 0; i < n; i++) {
      const left = i < dels.length ? dels[i] : null
      const right = i < inss.length ? inss[i] : null
      rows.push({
        left,
        right,
        leftMark: left !== null ? 'del' : null,
        rightMark: right !== null ? 'ins' : null,
      })
    }
    dels = []
    inss = []
  }
  for (const op of ops) {
    if (op.op === 'eq') {
      flush()
      if (op.left === op.right) {
        rows.push({ left: op.left, right: op.right, leftMark: null, rightMark: null })
      } else {
        // Equal but for whitespace: a pure re-indent. Emit it as a paired del/ins
        // row so wsOnly catches it downstream — only the shifted whitespace gets
        // the soft tint, the (unchanged) words are never marked. flush() ran first,
        // so this stays 1:1 aligned and never drifts into the positional pairing.
        rows.push({ left: op.left, right: op.right, leftMark: 'del', rightMark: 'ins' })
      }
    } else if (op.op === 'del') {
      dels.push(op.left)
    } else {
      inss.push(op.right)
    }
  }
  flush()
  return rows
}

// diffLines is a classic LCS line diff: it returns a sequence of ops that turn
// `a` into `b` — { op: 'eq', left, right } for a shared line, { op: 'del', left }
// for a line only in `a`, { op: 'ins', right } for a line only in `b`. Blocks are
// function-sized, so the O(n·m) table is cheap — EXCEPT for a whole-file
// fallback block (a multi-thousand-line locale JSON, see blocks-and-ingest.md):
// there the untrimmed table is tens of millions of cells (measured: 0.8–2.2s
// per file on a 9179-line locale JSON with 7 changed lines). The common
// prefix/suffix trim below cuts the DP down to just the changed middle, which
// makes that first-contact spike ~free for the typical "huge file, tiny diff"
// case, while leaving the op sequence a valid LCS alignment either way. Lines
// are matched whitespace-insensitively (via `key`, à la `git diff -w`): a line
// that only got re-indented still pairs with its counterpart and comes back as
// an `eq` op whose `left`/`right` differ only in whitespace, so alignRows can
// show it as a soft re-alignment instead of drifting into the positional
// del/ins pairing — which is also why the trim compares `key(...)`, not the
// raw lines: a re-indented prefix line must keep trimming (it was an `eq` op
// in the untrimmed DP too).
function diffLines(a, b) {
  const key = (s) => s.replace(/\s+/g, '')
  const n0 = a.length
  const m0 = b.length
  // Common prefix/suffix (whitespace-insensitive, same equality as the DP).
  let pre = 0
  while (pre < n0 && pre < m0 && key(a[pre]) === key(b[pre])) pre++
  let suf = 0
  while (suf < n0 - pre && suf < m0 - pre && key(a[n0 - 1 - suf]) === key(b[m0 - 1 - suf])) suf++
  const ops = []
  for (let p = 0; p < pre; p++) ops.push({ op: 'eq', left: a[p], right: b[p] })
  // O(n·m) LCS on the trimmed middle only.
  const n = n0 - pre - suf
  const m = m0 - pre - suf
  const ka = []
  const kb = []
  for (let p = 0; p < n; p++) ka.push(key(a[pre + p]))
  for (let p = 0; p < m; p++) kb.push(key(b[pre + p]))
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      ops.push({ op: 'eq', left: a[pre + i], right: b[pre + j] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del', left: a[pre + i] })
      i++
    } else {
      ops.push({ op: 'ins', right: b[pre + j] })
      j++
    }
  }
  while (i < n) ops.push({ op: 'del', left: a[pre + i++] })
  while (j < m) ops.push({ op: 'ins', right: b[pre + j++] })
  for (let p = suf; p > 0; p--) ops.push({ op: 'eq', left: a[n0 - p], right: b[m0 - p] })
  return ops
}
