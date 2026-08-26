// Block — the detail card for a single block, shown to the right of the list.
// A component: takes one block object (from state.blocks) plus display options
// and returns an arrow.js template. It mirrors the sidebar row but with the full
// header, file:line and the approve toggle. Code goes underneath later.

import { html, reactive } from './vendor/arrow.js'
import { categoryClass } from './BlockList.mjs'
import { translationBlockView, translationChangeUnits } from './translationDiff.mjs'
import { avatarHtmlString } from './avatar.mjs'
import { renderMarkdown } from './markdown.mjs'
import { splitBlockPath, paletteClass } from './blockPath.mjs'
import { parseAutoWidthPx, resizeHandle } from './columnWidth.mjs'
import { ShortcutHintBar } from './shortcutHints.mjs'
import Prism from './vendor/prism.js'

// highlight turns raw PHP source into Prism-tokenised HTML (keywords, strings,
// variables, …). Prism.highlight escapes the text itself, so the result is safe
// to feed to .innerHTML. Blocks are usually bare function bodies without a
// `<?php` tag, which the php grammar still tokenises fine. If the grammar is
// somehow missing we fall back to an escaped plain string — never raw innerHTML.
export function highlight(code) {
  return highlightForLang(code, 'php')
}

// A fenced code block in a comment/reply body (markdown.mjs) announces its own
// language after the opening ``` — this maps that free-form word onto one of
// the grammars actually vendored in prism.js (see its own header for the full
// list) plus a few common aliases (the word a reviewer types isn't always the
// exact Prism grammar name). `vue` deliberately has no grammar of its own —
// Prism itself ships none — and falls back to `markup`: a .vue single-file
// component's outer `<template>`/`<script>`/`<style>` tags still get tagged,
// even though the TS/JS inside `<script>` isn't tokenised on its own terms.
// A language that isn't vendored at all (e.g. `yaml` used to be, until it was
// vendored on request — a reviewer pasting an OpenAPI fragment under a comment
// got a colourless block; `toml`/`ruby`/… still are) falls through to the same
// plain-escaped-text path as a missing grammar — still labelled with the
// reviewer's own word in the badge (see markdown.mjs), just without colours.
// `yml` needs no alias here: the vendored yaml component registers
// `Prism.languages.yml` itself.
const LANGUAGE_ALIASES = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
}

// highlightForLang resolves `lang` (the word after ``` , case-insensitive,
// blank defaults to `php` — the pre-existing behaviour for an unannounced
// fence) to a vendored Prism grammar and highlights `code` with it. Falls back
// to escaped plain text, never raw innerHTML, exactly like `highlight` above.
export function highlightForLang(code, lang) {
  const key = String(lang || 'php').toLowerCase().trim()
  const grammarName = LANGUAGE_ALIASES[key] || key
  const grammar = Prism.languages[grammarName]
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, grammarName)
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

// movedLabel returns the Dutch word for a block the PR RENAMED or MOVED — the
// same body reappearing under a different symbol and/or in a different
// file/class (blockmove.go stamps b.oldName/b.oldClass/b.oldLine/b.oldFile on
// the merged block). "Hernoemd" when the name itself changed, "Verplaatst" for
// a pure move under the same name. Null for every other block, INCLUDING a
// bare git-detected FILE rename (no b.oldName) — that one keeps reading as the
// plain status word, exactly as before. The word carries the meaning; the badge
// colour is decoration (the reviewer is colourblind, see conventions.md).
export function movedLabel(b) {
  if (!b || !b.oldName) return null
  return b.oldName !== b.name ? 'Hernoemd' : 'Verplaatst'
}

// blockOldLabel is the pre-move `Class::method` of a renamed/moved block — the
// `- oud` line stacked above the card's own title. Null when nothing about the
// symbol changed (a pure cross-file move, or a plain block).
export function blockOldLabel(b) {
  if (!b || !b.oldName) return null
  const label = b.oldClass ? b.oldClass + '::' + b.oldName : b.oldName
  return label === (b.label || '') ? null : label
}

// blockOldPathLine is the pre-move `path:line` of a renamed/moved block — the
// `- oud` line stacked above the card's own path. Covers both sources of a
// move: a git-detected FILE rename (b.oldFile, which may be the only thing set)
// and blockmove.go's method-level move (b.oldLine, and b.oldFile when it landed
// in another file). Null when there is nothing different to show.
export function blockOldPathLine(b) {
  if (!b) return null
  const path = b.oldFile && b.oldFile !== b.file ? b.oldFile : b.file
  if (path === b.file && !b.oldLine) return null
  return b.oldLine ? path + ':' + b.oldLine : path
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

// Same shape for a renamed/moved block (movedLabel) — the WORD says what
// happened, this is only its badge.
const MOVED_BADGE_CLS =
  'shrink-0 rounded px-1.5 py-0.5 text-xs font-bold bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300'

// singleSide returns which pane to show when a block is one-sided: an added block
// has no old source (show only 'right'/new), a removed block has no new source
// (show only 'left'/old), an unchanged block has identical old/new source so
// showing both would just duplicate the same text (show only 'right'/current).
// A modified block genuinely has two different sides to compare (null). This
// lets the card drop the empty/redundant pane and render narrower. Driven by
// status so the width is stable even before b.code loads. Exported so
// home.mjs can check whether the ACTIVE/selected block is one-sided, to make
// a look-ahead preview card match its shape (see the "preview never
// wider/richer than active" note below and detail-layout.md).
//
// Deliberately an allowlist of the ONE status that genuinely needs both
// panes ('modified') rather than a denylist of the ones that don't: a future
// status defaults to single-pane here unless it's explicitly known to carry
// two genuinely different sides, so a status this file hasn't been taught
// about yet can't silently fall through to the wide two-pane tier again (see
// the 'unchanged' bug this replaced, diff-card.md).
export function singleSide(b) {
  if (b.status === 'modified') return null
  if (b.status === 'removed') return 'left'
  return 'right'
}

// fitOnly returns which single pane the `a` toggle's THIRD ('fit') stand
// shows: on explicit reviewer request, 'fit' never shows the old/removed
// code of a genuinely two-sided (modified) block anymore — it always
// collapses to just the new/right pane, exactly like an already one-sided
// ADDED block. A one-sided REMOVED block is the deliberate exception:
// singleSide(b) wins first, so it keeps showing its old/left pane in 'fit'
// too — that's the only code it has, hiding it would leave nothing to
// review. Used by both codeDiff (which pane(s) render) and contentWidthCls
// (which side's text drives the width) so the two stay in lockstep.
function fitOnly(b) {
  return singleSide(b) || 'right'
}

// sideText — the raw source text for one side ('left'/'right'), guarded
// against missing/errored code. Used directly by contentWidthCls's
// 'split'/'unified' branch (which needs BOTH sides' own whole-block
// fallback text, not just the canonical one) and by fitOnlyText below.
function sideText(b, side) {
  const c = b.code
  const oldText = c && !c.error && c.old ? c.old.text : ''
  const newText = c && !c.error && c.new ? c.new.text : ''
  return side === 'left' ? oldText : newText
}

// fitOnlyText — the exact text contentWidthCls/fitCapCharsFor measure in
// 'fit' (and for a one-sided block, in every stand): whichever side
// fitOnly(b) renders, guarded against missing/errored code. Extracted so
// both call sites (a card's own width and another card's cap on it, see
// fitCapCharsFor below) can never drift apart.
function fitOnlyText(b) {
  return sideText(b, fitOnly(b))
}


// isPhpFile — the discriminator between 'fit''s two different behaviors
// (see contentWidthCls/boundedWrapWidthCls below): a plain `.php` extension
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

// isYamlFile — a plain `.yml`/`.yaml` extension check on b.file, mirrors
// isPhpFile/isSvgFile. Used only to gate the collapsed-run breadcrumb below
// (see YAML_KEY_RE) — everything else about a yaml block's rendering is
// already covered by the existing non-PHP width/wrap treatment.
function isYamlFile(b) {
  return !!(b.file && /\.ya?ml$/i.test(b.file))
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
// percentile). Used only by contentWidthCls: unlike the
// non-ballooning default width elsewhere (codeGrowthChars, still used by
// relatedColumnWidthCls and by every other card width in this file), the
// reviewer explicitly wants 'fit' to guarantee that the single widest real
// code line is never cut off/hidden behind an invisible horizontal scroll —
// see contentWidthCls's own doc comment for the full reasoning and the
// deliberate scope (only 'fit'; 'split'/'unified' keep their existing, fixed
// widths and can still clip a very long line).
function codeMaxLineChars(code) {
  const lens = nonCommentLineLengths(code)
  return lens.length ? lens[lens.length - 1] : 0
}

// NO_CHANGE_MAX_WIDTH_CHARS — a cap applied ONLY to the whole-block
// codeMaxLineChars fallback that windowOrFallbackChars/fitCapCharsFor use
// when a BLOCK HAS ZERO CHANGED ROWS AT ALL (not merely "no unit was
// passed" — a block with real changed rows but no active unit, e.g. list
// mode/a fresh mount, keeps the existing uncapped fallback below;
// blockHasChangedRow is what actually decides). Reviewer-reported bug:
// drilling into unchanged context code (e.g. a class header shown only
// because a property nearby changed) sized the card off that context's own
// true longest line, uncapped — one 185-char property-doc line stretched
// the card (and every column after it) far past the screen. A real diff
// line keeps its deliberate "floor but no ceiling" guarantee
// (selectionWindowLineChars/contentWidthCls's own doc comments,
// diff-card.md) — that only applies once the block has at least one
// changed row somewhere. This cap exists purely for the
// zero-changed-rows-in-the-whole-block fallback path: the code pane already
// has its own `overflow-auto`, so capping here just trades an oversized
// card for an internal horizontal scrollbar, exactly like any other
// over-width pane. Reviewer-chosen value: 100 (comfortably above the
// MIN_CONTENT_WIDTH_CHARS floor of 80).
const NO_CHANGE_MAX_WIDTH_CHARS = 100

// blockHasChangedRow — whether `b` carries even a single changed row
// ANYWHERE (not scoped to `unit`/a side) — see NO_CHANGE_MAX_WIDTH_CHARS's
// own doc comment above for why this, not "no unit was passed", is the
// actual gate for the fallback cap.
function blockHasChangedRow(b) {
  return changedRows(blockRows(b)).length > 0
}

// codeMaxLineChars fallback, capped at NO_CHANGE_MAX_WIDTH_CHARS ONLY when
// `b` has no changed row at all; otherwise the existing uncapped "floor but
// no ceiling" guarantee applies unchanged (a block with real changes but no
// active unit, e.g. list mode).
function fallbackCodeMaxLineChars(b, code) {
  const chars = codeMaxLineChars(code)
  return blockHasChangedRow(b) ? chars : Math.min(NO_CHANGE_MAX_WIDTH_CHARS, chars)
}

// WINDOW_EDGE_ROWS — how far INSIDE a unit's own boundary still counts as
// "near enough to the edge you're looking at" once that unit grows past
// SELECTION_UNIT_MAX_SCAN_ROWS (below). Reviewer decision (2026-08-18): the
// earlier neighbor extension OUTSIDE the unit (looking up to this many
// CHANGED rows past the selection's own boundary) is removed — a unit's
// width is now measured purely from its own rows, capped at
// SELECTION_UNIT_MAX_SCAN_ROWS; nothing beyond the unit's own start/end ever
// counts any more.
const WINDOW_EDGE_ROWS = 2

// SELECTION_UNIT_MAX_SCAN_ROWS — a unit (a change group, a call/line range,
// or a Shift+arrow range — same shape `activeGroup` carries) at or under
// this many rows is scanned in full; a unit LARGER than this only has its
// edges (the first/last WINDOW_EDGE_ROWS rows) measured. Reviewer decision
// (2026-08-18, explicit "met een maximum van 5 lines"): capped at 5 —
// replaces the earlier 20-row threshold that only kicked in for a
// wholly-added/removed block's single whole-function group. Now that the
// neighbor extension OUTSIDE the unit is gone (see WINDOW_EDGE_ROWS above),
// this cap is the only thing bounding how much of a large gran=group/call
// range gets measured — a long unrelated line deep in the middle of a large
// group must not drive the whole card's width, only what's within reach of
// either edge of the selection.
const SELECTION_UNIT_MAX_SCAN_ROWS = 5

// selectionWindowLineChars — like codeMaxLineChars, but restricted to a small
// WINDOW of rows around the reviewer's current selection: the unit's own
// rows (a change group, a single line, a call segment, or a Shift+arrow
// range — same shape `activeGroup` already carries, see Block()'s own doc
// comment), capped at SELECTION_UNIT_MAX_SCAN_ROWS. Reviewer request: every
// stand's width should follow what's actually in view around the cursor, not
// the block's own true longest line elsewhere (which could sit far outside
// the visible window) — see "de 2 omliggende aangepaste rijen" in
// diff-card.md.
//
// `side` — which pane's text to measure ('left'/'right'), defaulting to
// whichever single side `fitOnly(b)` renders (the original, single-side
// contract every existing call kept until the split/unified fix below).
// contentWidthCls calls this for the canonical side of a two-sided
// (modified) block in 'unified'/'fit' (see windowCharsForMode's own doc
// comment) — 'split' no longer measures the non-canonical side at all, see
// windowCharsForMode below.
//
// Superseded, on reviewer decision (2026-08-18, "kijk niet naar omliggende
// rijen, maar alleen naar de huidige geselecteerde regel/groep/call, met een
// maximum van 5 lines"): this used to also extend up to WINDOW_EDGE_ROWS
// CHANGED rows PAST the unit's own boundary on the canonical side. That
// neighbor extension is removed — only the unit's own rows ever count now,
// and a unit larger than SELECTION_UNIT_MAX_SCAN_ROWS only has its edges (the
// first/last WINDOW_EDGE_ROWS rows) measured, same restriction a huge
// wholly-added/removed block's single 'group' unit already got before this
// change, just at a much smaller threshold (5, not 20) and now applied
// uniformly to gran=group/call/Shift-range alike, not just that one edge
// case.
//
// Returns `null` ONLY when there's no `unit` at all, or the block has no
// changed row whatsoever — genuinely nothing to position a window around.
// The caller then falls back to the whole-block codeMaxLineChars via
// fallbackCodeMaxLineChars, which additionally CAPS that fallback at
// NO_CHANGE_MAX_WIDTH_CHARS but ONLY when the block has zero changed rows
// anywhere (blockHasChangedRow, see NO_CHANGE_MAX_WIDTH_CHARS's own doc
// comment) — a block with real changes but simply no `unit` here (a
// preview/collapsed card, list mode) keeps the existing uncapped fallback,
// since there IS a real diff line somewhere to guarantee visibility for;
// only a drilled-in block whose changed row sits entirely elsewhere (e.g. a
// pure-context class header) gets capped, so an exceptionally long
// UNCHANGED context line can't balloon the card.
//
// Returns `0` — deliberately NOT null — when a `unit` DOES exist but nothing
// within the (possibly edge-restricted) window carries measurable text on
// the rendered side (e.g. the cursor sits deep inside a multi-row old-side-
// only deletion run at 'line' granularity). `0` reads as "cap at nothing" to
// both callers (contentWidthCls's `Math.max(MIN_CONTENT_WIDTH_CHARS, …)`
// floor, fitCapCharsFor's own documented 0-means-floor contract) and
// collapses the card to the plain MIN_CONTENT_WIDTH_CHARS floor — reviewer
// decision: a cursor position with nothing nearby to measure must NOT fall
// back to the block's true global longest line (that reintroduced the exact
// width-spike bug this window was built to fix, just spread across every row
// of a same-side deletion run instead of a single one).
function selectionWindowLineChars(b, unit, side = fitOnly(b) === 'left' ? 'left' : 'right') {
  if (!unit) return null
  const rows = blockRows(b)
  if (!rows.length) return null
  const changed = changedRows(rows)
  if (!changed.length) return null
  const start = Math.max(0, unit.start)
  const end = Math.min(rows.length - 1, unit.end)
  // See SELECTION_UNIT_MAX_SCAN_ROWS above: only a unit far bigger than any
  // ordinary change run gets its own interior edge-restricted.
  const restrictInterior = end - start + 1 > SELECTION_UNIT_MAX_SCAN_ROWS

  // measurableLen — the row's length on the rendered side, or null when the
  // row carries nothing worth measuring (blank). Deliberately does NOT skip
  // a `//`/`#`/`*`/`/*` line the way nonCommentLineLengths (the whole-block
  // fallback scan) does: a changed comment row inside the reviewer's own
  // selection window is real diff content being looked at right now, not
  // unrelated prose elsewhere in the block — excluding it here made an
  // active unit consisting only of a long changed comment line report `0`
  // measurable chars, which floored the card to MIN_CONTENT_WIDTH_CHARS and
  // clipped both that comment line and any other, unrelated, wider line
  // still visible in the pane. See "A changed comment line inside the
  // selection window counts too" in diff-card.md.
  const measurableLen = (i) => {
    const raw = rows[i][side]
    if (raw == null) return null
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') return null
    return line.length
  }

  let max = 0
  let any = false
  for (const i of changed) {
    if (i < start || i > end) continue
    // Deep interior of an oversized unit (see restrictInterior above) —
    // more than WINDOW_EDGE_ROWS away from BOTH of the unit's own
    // boundaries — is treated as out of view.
    if (restrictInterior && i - start > WINDOW_EDGE_ROWS && end - i > WINDOW_EDGE_ROWS) continue
    const len = measurableLen(i)
    if (len == null) continue
    any = true
    if (len > max) max = len
  }
  // A unit exists but nothing in it is measurable — return 0, not null, so
  // the caller floors to MIN_CONTENT_WIDTH_CHARS instead of falling back to
  // the block's true global longest line (see this function's own doc
  // comment above).
  return any ? max : 0
}

// fitCapCharsFor — the effective content-driven-width cap another card
// should never exceed, expressed in the SAME chars unit widthCls builds its
// own width from: for a PHP file, its own codeMaxLineChars (mirrors
// contentWidthCls exactly, via the shared fitOnlyText helper); for a non-PHP
// file there is no chars-based width at all (boundedWrapWidthCls is a fixed
// floor), so this returns 0 — capping a preview's contentWidthCls at 0 chars
// collapses it to that same fixed floor via the `max(...)` in
// contentWidthCls below, which is exactly the width a non-PHP active card
// renders at.
//
// Used by home.mjs's look-ahead preview call sites (never by a card's own,
// unconstrained width) to fix the gap in "the preview must never be wider
// than the active card" (see diff-card.md): the existing activeSingleSided
// override only narrows a preview by forcing 'unified', which by itself no
// longer changes the width formula (every stand is content-driven now) —
// this cap is what actually keeps a preview from rendering wider than the
// active card next to it when both are two-sided (modified) PHP files with
// a different own longest line.
//
// unit — optional, the SAME {start,end} row range the active card's own
// activeGroup opt is currently highlighting (home.mjs passes
// topLevelActiveUnit(...)/focusedActiveUnit()): since the width now narrows
// to just the selection's own window (see selectionWindowLineChars above),
// the cap must track that same, usually smaller, number. Absent, or present
// but the block has no changed row at all, falls back to the whole-block
// codeMaxLineChars (fallbackCodeMaxLineChars — capped at
// NO_CHANGE_MAX_WIDTH_CHARS only if the block has zero changed rows
// anywhere, see that function's own doc comment; otherwise uncapped as
// before); present with a changed row but nothing measurable nearby returns
// 0 (selectionWindowLineChars's own 0-vs-null contract),
// which caps a preview at the plain floor rather than the block's true
// global longest line.
//
// Deliberately stays single-side/canonical (fitOnlyText's own side) even
// now that a genuinely two-sided (modified) block's OWN width
// (contentWidthCls below) combines both sides for 'split'/'unified' — a
// smaller cap only ever narrows a preview further, never widens it past the
// active card, so this simpler, single-side cap still satisfies the one
// guarantee it exists for ("never wider than the active card") without
// needing to know the active card's current stand at all.
export function fitCapCharsFor(b, unit) {
  if (!isPhpFile(b)) return 0
  const windowChars = selectionWindowLineChars(b, unit)
  return windowChars != null ? windowChars : fallbackCodeMaxLineChars(b, fitOnlyText(b))
}

// widthCls picks the card's width class: a PHP file gets the content-driven
// width (contentWidthCls, below), in EVERY stand ('split'/'unified'/'fit'
// alike) — any other file gets the fixed, bounded width instead
// (boundedWrapWidthCls) — see isPhpFile above for why.
//
// The three stands used to differ here (a fixed 60%-width 'unified' tier, a
// fixed full-width 'split' tier, only 'fit' content-driven) — on explicit
// reviewer request that distinction is gone: every stand now sizes a PHP
// card off what's actually around the cursor (selectionWindowLineChars),
// floored at MIN_CONTENT_WIDTH_CHARS (80) characters, uncapped upward. The
// card genuinely grows/shrinks as the reviewer navigates — see
// contentWidthCls's own doc comment.
//
// `viewMode` DOES still affect the width, just not by picking a fixed tier
// per stand any more: a genuinely two-sided (modified) block's 'split'/
// 'unified' stands each need to know how many panes are actually rendered
// side by side vs. stacked, to size the card so NEITHER visible pane clips
// (see contentWidthCls's own doc comment) — reported: a selected old-side-
// only line ran off the edge of a 'unified' card, and both panes of a
// 'split' card truncated their own already-fitting content because the
// total card width was sized for one pane, then halved into two.
//
// `narrowFixed` — a function; when it returns true, short-circuits ALL of
// the above and returns the flat `NARROW_FIXED_WIDTH_CLS` instead, checked
// FIRST (before isPhpFile) so it applies to any file type. Only ever true
// for the top-level look-ahead preview (see Block()'s own `narrowFixedFn`
// doc comment) — reviewer decision: that preview's width no longer follows
// its own content at all.
function widthCls(b, viewMode, capFitChars, activeGroup, narrowFixed) {
  if (narrowFixed && narrowFixed()) return NARROW_FIXED_WIDTH_CLS
  return isPhpFile(b) ? contentWidthCls(b, capFitChars, activeGroup, viewMode) : boundedWrapWidthCls()
}

// boundedWrapWidthCls — the width for a NON-PHP file (see isPhpFile), in
// every stand: the same narrow 60%-equivalent width a one-sided added/
// removed block already used — deliberately NOT content-based. Long lines
// are made to fit THIS width by wrapping instead (the `wrap` flag on
// codePane/paneHTML in 'fit'; 'split'/'unified' already wrapped nothing
// before and still don't, unaffected by this change) — the direct fix for
// "the diff must not be wider than needed" for non-code (markdown/prose/
// config) text, where a long line reads perfectly fine wrapped, unlike a PHP
// statement.
function boundedWrapWidthCls() {
  return 'w-[42rem] 2xl:w-[49.2rem] '
}

// MIN_CONTENT_WIDTH_CHARS — the floor for contentWidthCls, in characters
// (not rem/px): a reviewer request to replace the old fixed 42rem/70rem-ish
// tiers with one flat, character-based minimum shared by every stand.
const MIN_CONTENT_WIDTH_CHARS = 80

// CODE_CHAR_PX — how wide ONE character of the code panes' own font really
// is, in CSS px. Every chars-count in this file used to be turned into a
// width with the CSS `ch` unit (`w-[calc(<chars>ch_+_2rem)]`), but `ch`
// resolves against the font of the element carrying the class — the card's
// own <article>, which inherits the page's PROPORTIONAL ui-sans-serif at
// 16px (measured: 10.08px per `ch`) — while the code itself renders in
// `font-mono text-[11px]` (measured: 6.62px per character, i.e. 34% less
// per card). Reported by the reviewer as a diff card that filled nearly the
// whole screen with ~730px of empty space to the right of its longest line:
// "dit mag ongeveer 25% kleiner. de rechterkant van de blok moet rechts
// aansluiten aan de laatste character."
//
// So the number of characters is measured exactly as before (nothing about
// selectionWindowLineChars/windowCharsForMode/the caps changed) — only this
// last step, chars → CSS width, now uses the CODE font's own advance width:
// the fixed `text-[11px]` font-size times 0.6023, the advance ratio of the
// monospace stack the panes use (measured 0.6020 for macOS ui-monospace/SF
// Mono; Menlo/DejaVu Sans Mono sit at 0.6023, Courier New at 0.60,
// Consolas at 0.55). Deliberately rounded UP rather than down: a narrower
// font than assumed only leaves a hair of unused slack, while a wider one
// would clip the longest line behind an invisible horizontal scroll — the
// exact bug the "floor but no ceiling" rule exists to prevent. Still a pure
// arithmetic constant, never a live DOM measurement (see this file's own
// module doc / diff-card.md).
const CODE_CHAR_PX = 11 * 0.6023

// CARD_CHROME_PX — everything in a content-driven card's width that is NOT
// code: the code rows' own horizontal padding (`px-3`, 2 × 12px) plus the
// card's 2 × 1px border — 26px — plus room for the absolutely-positioned
// per-row chip at the right edge of a diff row (lineSummaryBadge, the
// "onderliggende code" ✓ n/n pill). Without that reserve, sizing the card
// flush to the last character puts the chip straight on top of the longest
// line's tail. 4rem (reviewer-approved number) leaves ~38px, which fully
// clears the plain approve-fraction chip; a chip that also carries comment
// avatars (measured up to 62px) can still overlay the tail of the single
// longest line in view, which is the same designed-for overlay
// lineSummaryBadge's own translucent pill background has always handled
// (every row outside the measured window can already be longer than the
// card).
const CARD_CHROME_PX = 64

// contentWidthPx — the one chars → px conversion, shared by every
// content-driven width below so they can never drift apart. Exported (with
// its inverse, contentWidthChars) so a Playwright spec can keep expressing
// its expectations in CHARACTERS — what this file's whole width mechanism is
// actually about — instead of hardcoding pixel numbers that would silently
// rot the next time CODE_CHAR_PX/CARD_CHROME_PX moves (they used to read the
// chars-count straight out of the `w-[calc(<chars>ch_+_2rem)]` class, which
// no longer carries it). See tests/_fixtures.mjs's widthPx/widthCharsOf.
export function contentWidthPx(chars) {
  return Math.ceil(chars * CODE_CHAR_PX + CARD_CHROME_PX)
}

// contentWidthChars — contentWidthPx's inverse (exact, since contentWidthPx
// only rounds up by less than a whole character).
export function contentWidthChars(px) {
  return Math.round((px - CARD_CHROME_PX) / CODE_CHAR_PX)
}

// NARROW_FIXED_WIDTH_CLS — the top-level look-ahead preview's own fixed
// width (widthCls's `narrowFixed` short-circuit above): exactly
// MIN_CONTENT_WIDTH_CHARS plus the same chrome every content-driven card
// already uses, so it visually matches the floor width of an ordinary
// narrow card — just never grows past it, regardless of file type or
// content.
const NARROW_FIXED_WIDTH_CLS = `w-[${contentWidthPx(MIN_CONTENT_WIDTH_CHARS)}px] `

// SPLIT_LEFT_PANE_WIDTH_CLS — the non-canonical (old/left, for a modified
// block) pane's own width in the 'split' stand: `w-1/2` (the ORIGINAL,
// pre-existing mechanism — half the flex row, same as this pane always
// used) PLUS a static `max-w-[<80 code characters + 1rem>px]` cap (built
// once from MIN_CONTENT_WIDTH_CHARS × CODE_CHAR_PX, so it can never drift
// from the card's own width formula — it used to be a literal
// `max-w-[calc(80ch_+_1rem)]`, in the same wrong `ch` unit, see
// CODE_CHAR_PX). This reproduces
// windowCharsForMode's `Math.min(MIN_CONTENT_WIDTH_CHARS, canonicalChars) +
// canonicalChars` split-mode total EXACTLY, using only static CSS: whenever
// canonicalChars <= MIN_CONTENT_WIDTH_CHARS (the common case), that total is
// `2 * canonicalChars`, so `w-1/2` alone already equals `canonicalChars` —
// identical to the width this pane always got, unaffected by this whole
// change; the `max-w` cap never engages. Only once canonicalChars exceeds
// MIN_CONTENT_WIDTH_CHARS does 50% of the (now larger) total exceed the cap,
// which then clamps this pane at MIN_CONTENT_WIDTH_CHARS while the
// canonical/right pane (`flex-1`, absorbing whatever this pane doesn't
// claim) keeps growing with its own content — the reported bug this whole
// change exists to fix.
//
// Deliberately NOT `w-max` (CSS `width:max-content`, tried first): sizing
// this pane off its own RENDERED text needs an actual browser layout pass,
// which lagged behind the code's async load/highlight by roughly a second in
// testing — the pane visibly resized after the initial render, moving
// whatever sits in the canonical pane out from under a reviewer's cursor
// (tests/diff-row-mouse-select.spec.mjs's hover-then-click case) — this file
// is pure character-count arithmetic everywhere else specifically to avoid
// exactly that class of bug (see this file's own module doc / diff-card.md).
//
// Also deliberately NOT a `${() => ...}` reactive class on this pane (nor a
// CSS custom property threaded through the article's `style` attribute,
// also tried): either would make THIS element's own attribute mutate on a
// same-block navigation step, breaking the "only the card's own (ARTICLE)
// class mutates" guarantee (navigate.spec.mjs) — the CSS-variable/`style`
// attempt additionally collided with column-resize.spec.mjs, which asserts
// an unresized card's `style` attribute is exactly `''`. `w-1/2` + a static
// `max-w` needs neither: both are plain, unconditional, content-independent
// Tailwind utilities.
const SPLIT_LEFT_PANE_WIDTH_CLS = `w-1/2 max-w-[${Math.ceil(MIN_CONTENT_WIDTH_CHARS * CODE_CHAR_PX + 16)}px] shrink-0`

// contentWidthCls — the card width for a PHP file, for EVERY `a`-cycle stand
// ('split'/'unified'/'fit' alike — see widthCls above): make the card as
// wide as the code actually around the cursor needs, instead of a fixed
// tier. Floored at MIN_CONTENT_WIDTH_CHARS (80) characters, but — on
// explicit reviewer request — deliberately UNCAPPED upward: unlike
// codeGrowthChars (the 75th-percentile non-ballooning technique
// RelatedPanel.mjs's relatedColumnWidthCls still uses), this must guarantee
// that the widest real PHP code line actually in view is fully visible,
// without wrapping and without an invisible horizontal scroll. Purely a
// character-count calculation on the already-loaded source text, no live DOM
// measurement (`scrollWidth`/`getBoundingClientRect`), per the existing
// approach and the arrow.js pitfalls in conventions.md.
//
// This uncapped guarantee turned out to backfire for a NON-PHP file: a
// markdown bullet/prose line reads perfectly fine wrapped (unlike a PHP
// statement, which loses nothing by staying on one physical line but reads
// terribly split mid-expression), so an isolated long prose line ballooned
// the whole card (reported: 336 characters → ~6800px). Hence the PHP-only
// scope: a non-PHP file gets boundedWrapWidthCls + wrapping instead.
//
// A one-sided block (added/removed, singleSide(b) truthy), and ANY block in
// 'fit' (which always collapses to one pane — fitOnly, above), is measured
// off that single canonical side only, exactly as before. A genuinely
// two-sided (modified) block in 'unified' measures BOTH sides and combines
// them with `Math.max` (windowCharsForMode below) — it stacks old above new
// in ONE column, so it needs whichever side is wider. 'split' shows both
// side by side but, on reviewer decision (2026-08-18, "de linkerkant in de
// diff kan altijd op minimaal blijven"), no longer measures the
// non-canonical (old/left, for a modified block) pane's own content at all —
// that pane stays fixed at MIN_CONTENT_WIDTH_CHARS regardless of how long
// its lines are, and only the canonical (new/right) pane follows its own
// content; the card's own width is their SUM, not double the wider one (see
// codeDiff's split branch in Block.mjs, which gives the two panes their own
// matching widths instead of the earlier equal `w-1/2` halves). Previously
// both panes were forced to the same, equal width (`2 * Math.max(...)` of
// both sides) so neither pane's content clipped — this traded that symmetry
// away specifically for the non-canonical side, on the reviewer's own
// request that it's fine for it to just stay narrow.
//
// capFitChars — an optional `() => number|null` (only ever passed by home.mjs
// for a look-ahead PREVIEW card, see fitCapCharsFor's own doc comment above):
// when it returns a finite number, this card's own chars are clamped down to
// it BEFORE the MIN_CONTENT_WIDTH_CHARS floor applies, so a preview can never
// render wider than the active card it's stacked with even though both are
// genuinely two-sided PHP blocks with a different longest line. Absent for
// every non-preview card, and a no-op whenever the preview's own chars
// already happen to be the smaller number. Deliberately still a single,
// canonical-side number (fitCapCharsFor's own doc comment) even now that a
// two-sided block's own width can combine both sides — a smaller cap only
// ever narrows a preview further, never risks it exceeding the active card.
//
// activeGroup — an optional `() => {start,end}|null` (Block()'s own opt of
// the same name — the reviewer's currently selected/highlighted navigation
// unit). The chars-count is taken from the unit's OWN rows only
// (selectionWindowLineChars) — not the block's true longest line wherever it
// happens to sit, AND not the unit's own full span once that span balloons
// past SELECTION_UNIT_MAX_SCAN_ROWS (see that constant's own doc comment — a
// wholly-added/removed block's single 'group' unit can legitimately BE the
// entire function). Falls back to the whole-block
// codeMaxLineChars only when there's no active unit at all (a preview/
// collapsed card, list mode without changes, or a caller that doesn't pass
// this opt at all — every existing direct-mount test, see
// diffview.spec.mjs). A unit that IS present but whose window carries no
// measurable text at all floors to MIN_CONTENT_WIDTH_CHARS instead
// (selectionWindowLineChars returns 0, not null, for that case) —
// deliberately not the block's true global longest line, which would
// reintroduce the width-spike bug this window exists to prevent.
//
// viewMode — an optional `() => 'split'|'unified'|'fit'` (widthCls forwards
// its own same-named param, home.mjs's viewModeFn), defaulting to 'split'
// for the rare direct call/test that omits it (matching codeDiff's own
// default). See windowCharsForMode below for how it picks which side(s) to
// combine.
function contentWidthCls(b, capFitChars, activeGroup, viewMode) {
  const unit = activeGroup && activeGroup()
  const mode = (viewMode && viewMode()) || 'split'
  const chars = windowCharsForMode(b, unit, mode)
  const cap = capFitChars && capFitChars()
  const clamped = typeof cap === 'number' && isFinite(cap) ? Math.min(chars, cap) : chars
  const floored = Math.max(MIN_CONTENT_WIDTH_CHARS, clamped)
  return `w-[${contentWidthPx(floored)}px] `
}

// windowOrFallbackChars — selectionWindowLineChars for one side, with the
// null (no unit at all, or the block has no changed row) falling back to
// that SAME side's own whole-block codeMaxLineChars via
// fallbackCodeMaxLineChars — capped at NO_CHANGE_MAX_WIDTH_CHARS only when
// the block has zero changed rows anywhere, uncapped otherwise (see that
// function's own doc comment) — mirrors the existing single-side fallback,
// just made reusable per side instead of hardcoded to the canonical one.
function windowOrFallbackChars(b, unit, side) {
  const windowChars = selectionWindowLineChars(b, unit, side)
  return windowChars != null ? windowChars : fallbackCodeMaxLineChars(b, sideText(b, side))
}

// windowCharsForMode — combines however many sides `mode` actually renders
// on screen at once, mirroring codeDiff's own `effectiveOnly` gate exactly:
// a one-sided block (singleSide(b) truthy) or 'fit' (which always forces a
// single pane, see fitOnly) only ever measures that one canonical side. A
// genuinely two-sided (modified) block in 'unified' measures BOTH sides and
// takes `Math.max` (see contentWidthCls's own doc comment above). 'split'
// only measures the CANONICAL side, uncapped — same as it always
// (implicitly) was, since the old combined formula's `Math.max(canonical,
// other)` reduces to plain `canonicalChars` whenever the canonical side is
// the longer of the two (the common case) — and adds the non-canonical
// (old/left) pane's width, CAPPED at MIN_CONTENT_WIDTH_CHARS but otherwise
// matching canonicalChars too (`Math.min`, see SPLIT_LEFT_PANE_WIDTH_CLS's
// own doc comment): whenever canonicalChars is already at or under 80 (the
// common case), the total here is IDENTICAL to the old
// `2 * Math.max(canonical, other)` formula (both reduce to `2 *
// canonicalChars`), so an ordinary short two-sided block's split card keeps
// EXACTLY its previous width; only once canonicalChars exceeds 80 does the
// non-canonical pane stop growing with it (capped at 80) instead of
// ballooning to match — the reported bug this whole change exists to fix.
// Deliberately never reads the OTHER side's own content for this
// (contentWidthCls's own doc comment on the 'split' asymmetry) — a genuinely
// long OLD-side-only line can still be visually clipped within its own
// capped pane, an accepted trade-off per the reviewer's own request.
function windowCharsForMode(b, unit, mode) {
  const canonical = fitOnly(b)
  if (singleSide(b) || mode === 'fit') return windowOrFallbackChars(b, unit, canonical)
  const canonicalChars = windowOrFallbackChars(b, unit, canonical)
  if (mode === 'split') return Math.min(MIN_CONTENT_WIDTH_CHARS, canonicalChars) + canonicalChars
  const other = canonical === 'left' ? 'right' : 'left'
  const otherChars = windowOrFallbackChars(b, unit, other)
  return Math.max(canonicalChars, otherChars)
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

// blockCloseColumnButton — the mouse entry point that closes a drilled
// Underlying-code column and hands focus back to its parent column, the
// click equivalent of ← at state.focusLevel>0 (closeDrilledColumn,
// home.mjs). Only rendered on a drilled column's card, only while
// diffActive() — a drilled column only ever renders as a full card while
// it's the focused one (see "Unfocused columns collapse into a narrow
// rail" in drilling.md), so this is never shown twice either. Always
// visible, own icon (a chevron docked against a bar, "collapse this
// column back"). The top-level card's own way back (leaveDiffToList) no
// longer has a per-card button at all — see MainScrollLeftHint (home.mjs)
// and "A mouse way to reach content hidden to the left" in
// .claude/docs/detail-layout.md.
//
// Wrapped in a stable `<div class="contents">` root (mirroring
// stepChevronSlot in home.mjs) and its `@click` guards against a missing
// event: a reproducible bug (live PR, never in an isolated fixture — see
// "A narrow event-listener-only child toggled bare" in
// .claude/rules/arrowjs-pitfalls.md) fires this exact handler with
// `e===undefined` from arrow.js's own reactive-recompute flush, not from a
// real click — the caller (Block.mjs's own `${() => ... ?
// blockCloseColumnButton(...) : ''}` slot) toggles this bare, and the
// button's ONLY expression is this one `@click`. Both changes are a
// defensive/precedent-matching fix, not a proven root-cause fix — see that
// doc entry for exactly what is and isn't established.
function blockCloseColumnButton(onCloseColumn) {
  return html`<div class="contents">
    <button
      type="button"
      title="Sluit deze kolom"
      data-testid="block-close-column"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
      @click="${(e) => {
        if (!e) return
        e.stopPropagation()
        onCloseColumn()
      }}"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5" aria-hidden="true">
        <path d="M10 3v10M6 5l-3 3 3 3" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    </button>
  </div>`
}

// blockMenuButton — the mouse entry point into the block-scoped command
// palette (COMMANDS), the "Enter" equivalent per the click-runs-the-same-
// function rule in mouse-navigation.md. Distinct icon from the PR/comment/
// Claude menu buttons (a vertical kebab — "options for THIS item") so the
// four are visually told apart at a glance, per the colorblind rule's own
// "shape carries meaning" principle applied here to distinguish targets
// rather than states. Hover-revealed only (opacity via the static 'group'
// class on the card root above, plus focus-visible for keyboard/Tab
// reachability) — never a reactive toggle, so no state hangs off hover
// itself; the action stays reachable via Enter regardless of pointer
// position. Rendered next to the file:line label, never on a preview card
// (see the call site below) — a look-ahead card is never the one Enter
// would act on.
//
// Wrapped in a stable `<div class="contents">` root, and its `@click`
// guards against a missing event — same shape/reasoning as
// blockCloseColumnButton above (a single event-listener-only expression,
// toggled bare by its own caller): see "A narrow event-listener-only child
// toggled bare" in .claude/rules/arrowjs-pitfalls.md for what is and isn't
// established about why.
function blockMenuButton(onOpenMenu) {
  return html`<div class="contents">
    <button
      type="button"
      title="Menu voor dit blok"
      data-testid="block-open-menu"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
      @click="${(e) => {
        if (!e) return
        e.stopPropagation()
        onOpenMenu()
      }}"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true">
        <circle cx="8" cy="3" r="1.3"></circle>
        <circle cx="8" cy="8" r="1.3"></circle>
        <circle cx="8" cy="13" r="1.3"></circle>
      </svg>
    </button>
  </div>`
}

// descriptionHtml renders a block's PHPDoc description (b.description, see
// phpDocDescription in phpscan.go) as a safe HTML string for the card's
// description strip.
//
// It splits on the blank line FIRST and renders each paragraph separately,
// because snarkdown — deliberately minimal — turns a blank line into a single
// `<br />` and never emits a `<p>` of its own. A real `<p>` per paragraph
// picks up the `.markdown-body p { margin: .4em 0 }` rule that already exists
// in index.html, so a multi-paragraph docblock finally reads as prose instead
// of as one dense run. That is the whole point here: the description used to
// be a single plain-text slot, which (together with the multi-line-tag leak
// fixed in phpscan.go) made a long docblock an unreadable wall of text.
//
// Each paragraph still goes through renderMarkdown, so the escaping/XSS layer,
// the inline-code styling and the link sanitizing are unchanged.
// BLOCK_DESC_TRUNCATE_AT / blockDescCollapsible — is a block's description long
// enough to have something to open? A deterministic character count, exactly
// like descCollapsible's own DESC_TRUNCATE_AT for the PR description (home.mjs):
// the real question ("does it overflow the 2-line cap?") can only be answered by
// measuring the laid-out DOM, and both the "meer… (Enter)" hint here and the
// Enter branch in home.mjs must agree without a layout read. Exported because
// home.mjs's Enter/↑ handling needs the same answer.
const BLOCK_DESC_TRUNCATE_AT = 120

export function blockDescCollapsible(b) {
  return !!b && String(b.description || '').length > BLOCK_DESC_TRUNCATE_AT
}

function descriptionHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => '<p>' + renderMarkdown(p) + '</p>')
    .join('')
}

/**
 * @param {object} b - one block from state.blocks (reactive).
 * @param {object} [opts] - { preview: boolean } dims the look-ahead card;
 *   { collapsed: () => boolean } additionally shrinks it to just its header
 *   (see collapsedFn below) — only ever meaningful together with preview.
 * @returns arrow.js template — call with a mount target to render.
 */
export default function Block(b, opts = {}) {
  // viewMode — a function returning the global diff-view preference: 'split'
  // (default, both panes side by side, full width), 'unified' (a genuinely
  // two-sided block collapses to ONE column, old (-) directly above new (+)
  // — see unifiedCodeDiff below — fixed 60% width), or 'fit' (only the
  // new/right pane, old is never shown — see fitOnly above — the card width
  // follows that pane's own code instead of a fixed width — see
  // widthCls/contentWidthCls above). Cycled everywhere with `a` (home.mjs). A
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
  // colWidthStyleFn — the reactive inline `style="width:...px"` override for
  // this card (see columnWidth.mjs), read from the same nested slot as the
  // width class below. Defaults to '' (auto — the class-driven width wins).
  const colWidthStyleFn = opts.colWidthStyle || (() => '')
  // onResizeStart/onResizeReset — home.mjs already knows `state` and this
  // card's stable column key ('diff:' + b.id); Block.mjs stays decoupled from
  // `state` (per its existing opts convention) and only supplies the ONE
  // thing it alone knows: the current auto-width class string, so the drag's
  // snap-back-to-auto comparison (see columnWidth.mjs) uses the width this
  // exact card would have without an override.
  const onResizeStart = opts.onResizeStart || (() => {})
  const onResizeReset = opts.onResizeReset || (() => {})
  // onOpenMenu — opens the same block-scoped command palette (COMMANDS) that
  // Enter already opens on this card (home.mjs's openMenu(state.showDescription
  // ? 'pr' : 'block')), so a mouse-only reviewer can reach "Comment op deze
  // regel"/"Chat over deze regel"/"Open GitHub"/approve without the keyboard.
  // See blockMenuButton below. Defaults to a no-op so a caller that never
  // wires it up (e.g. a look-ahead/preview card, which never renders the
  // button at all — see !preview below) needs no change.
  const onOpenMenu = opts.onOpenMenu || (() => {})
  // onCloseColumn — the mouse-only way back out of a DRILLED column that ←
  // already provides via the keyboard (closeDrilledColumn, home.mjs) — see
  // blockCloseColumnButton above and its own call site in home.mjs. The
  // top-level card's own way back (leaveDiffToList) has no per-card button
  // any more, see MainScrollLeftHint (home.mjs). Defaults to null (not a
  // no-op) so the render slot below can tell "not wired up at all" apart
  // from "wired up" — same reasoning as onRowMouseDown/onApproveClick above.
  const onCloseColumn = opts.onCloseColumn || null
  const preview = !!opts.preview
  // collapsedFn is a function returning whether this card should shrink to just
  // its header + meta row (category/title/status, file:line + approve pill) —
  // no description, no diff body. Only ever passed for a look-ahead PREVIEW
  // card — home.mjs's two preview call sites (DetailPanel's pair.forEach,
  // drillPreviewColumns) both pass `() => true` unconditionally, so every
  // preview always collapses regardless of the active card's own height (see
  // "The look-ahead preview always collapses to just its header" in
  // .claude/docs/diff-card.md). Still a function (not a plain value), read
  // from this card's own nested `${() => ...}` slot below (mirrors
  // activeGroup/hintsEnabled) for parity with the rest of Block()'s reactive
  // opts. Defaults to never collapsing for every non-preview card.
  const collapsedFn = opts.collapsed || (() => false)
  // descFocused / descExpanded / onDescriptionClick — the description strip
  // below the meta row is its own keyboard stop above the block's first change
  // (↑ from unit 0, see "The block description is an extra ↑ stop" in
  // .claude/docs/keyboard-navigation.md). descFocused() says the cursor sits on
  // it (focus ring + the "meer…" affordance), descExpanded() whether it shows
  // its full text instead of the 2-line cap, and onDescriptionClick() is the
  // mouse twin of Enter there (same function for key and mouse, see
  // .claude/docs/mouse-navigation.md).
  //
  // Both predicates must depend ONLY on state that changes when the strip
  // itself changes (home.mjs passes state.descFocusId/state.descExpanded, both
  // keyed by block id) — never on state.selected/state.change. Otherwise every
  // ordinary ↑/↓/f step would re-set this strip's class attribute, which
  // tests/navigate.spec.mjs asserts never happens (a same-block step may only
  // mutate `class` on the <article> cards themselves).
  const descFocused = opts.descFocused || (() => false)
  const descExpanded = opts.descExpanded || (() => false)
  const onDescriptionClick = opts.onDescriptionClick || null
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
  // index — as an at-a-glance cue that the keyboard now drives the diff; it also
  // keeps the active-row cursor bar (rowCellHTML/translationRowCls) indigo instead
  // of dimming it to grey (see "Focus highlight per stop" in
  // keyboard-navigation.md). Defaults to focused (`() => true`, mirrors
  // translationBlockView's own `opts.focused` default) — every real call site in
  // home.mjs passes this explicitly (a preview card passes `() => false`), so the
  // default only matters for a test/harness that constructs Block() directly and
  // only cares about e.g. activeGroup, not about focus dimming.
  const diffActive = opts.diffActive || (() => true)
  // unpushed is a function returning whether this block's file is part of a
  // commit that landed on the PR's branch locally but isn't pushed to GitHub
  // yet (state.pendingPush.files, see loadPendingPush in home.mjs). A function
  // so its own nested slot re-runs when a push lands, without rebuilding the
  // card. Defaults to false, so a caller that doesn't know about it (the drill
  // preview) simply never shows the chip.
  const unpushed = opts.unpushed || (() => false)
  // editing is a function returning whether this block's file is currently
  // being touched by a not-yet-landed Claude edit (state.checkout.pendingFiles,
  // see loadCheckout in home.mjs / editingPill in BlockList.mjs for the
  // per-row twin of this same chip). Defaults to false, same reasoning as
  // unpushed above.
  const editing = opts.editing || (() => false)
  // refreshing is a function returning whether this block's file was just
  // landed by a Claude edit but the review tree hasn't re-ingested it yet
  // (state.checkout.refreshingFiles, see loadCheckout in home.mjs /
  // refreshingPill in BlockList.mjs for the per-row twin). Defaults to false,
  // same reasoning as unpushed/editing above.
  const refreshing = opts.refreshing || (() => false)
  // approvedRows is a function returning the Set of approved row indices for this
  // block, so the panes re-tint (an emerald left bar) as the reviewer approves
  // units. A function (not a value) so the .innerHTML binding re-runs when
  // b.approvedRows changes. Defaults to nothing approved.
  const approvedFn = opts.approvedRows || (() => new Set())
  // onApprove is called with the block after the top checkbox toggles its
  // approved rows, so the caller (home.mjs) can persist the new state durably.
  // Defaults to a no-op; Block itself stays decoupled from the write path.
  const onApprove = opts.onApprove || (() => {})
  // onRowMouseDown — the mouse equivalent of ↑/↓: called with the aligned-row
  // index (rowCellHTML's `data-row`) a mousedown landed on, via the delegated
  // onBlockMouseDown below. Defaults to null (not a no-op function) so
  // onBlockMouseDown can skip the closest() lookup entirely on a card that
  // never wired one up (the look-ahead preview at home.mjs's stepChevronSlot
  // call site, testClass preview cards, …). It only SEEDS the gesture — the
  // actual click-vs-selection resolution happens once, on `mouseup`, by
  // reading `window.getSelection()` (home.mjs's `beginMouseSelection`) — see
  // "Line selection: click and browser text selection" in
  // .claude/docs/diff-render.md.
  const onRowMouseDown = opts.onRowMouseDown || null
  // onRowContextMenu — the right-click counterpart of onRowMouseDown: called
  // with (row, segStart, clientX, clientY) via the delegated
  // onBlockContextMenu below, on the exact same [data-row]/[data-call-seg]
  // targets. Unlike a mousedown gesture a right-click never seeds a drag —
  // it's resolved SYNCHRONOUSLY, not deferred to mouseup — so home.mjs's
  // handleRowContextMenu can call resolveClickSelection directly and return
  // whether it actually landed on something. Defaults to null, same
  // reasoning as onRowMouseDown (a preview/testClass card never wires this).
  // See "The right-click context menu" in command-palette.md.
  const onRowContextMenu = opts.onRowContextMenu || null
  // onApproveClick — the mouse counterpart of Space (see home.mjs's
  // approveClickAt/mouseApprove): called with (row, 'call', segStart) when a
  // click lands on one of rowCellHTML's own call-segment dot/hover-ring
  // markers (see onBlockMouseDown). Defaults to null, same reasoning as
  // onRowMouseDown above: a card that never wires this up (a preview/
  // testClass card) simply never reaches the branch that reads it, since
  // rowCellHTML's own `rowApproveEnabled` (gated on `focused`) already keeps
  // the click targets themselves out of such a card's HTML.
  const onApproveClick = opts.onApproveClick || null
  // commentedRows is a function returning the Set of rows that carry a comment,
  // so the panes mark them with a 💬 (presence only). A function so the binding
  // re-runs as comments load/change. Defaults to no comments.
  const commentedFn = opts.commentedRows || (() => new Set())
  // commentRangeRows is a function returning the Set of rows spanned by the
  // comment the keyboard is currently IN (RelatedPanel's commentRangeRowSet —
  // empty whenever no comment owns the keyboard), drawn as a vertical bar
  // along the RIGHT edge of those rows so it's visible which lines the open
  // comment was made on. A function, for the same reason commentedFn is one.
  // Defaults to nothing, so a preview card (which never owns the keyboard)
  // simply never shows it.
  const commentRangeFn = opts.commentRangeRows || (() => new Set())
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
  // capFitChars — see fitCapCharsFor's own doc comment above. Only ever
  // passed for a look-ahead preview card (home.mjs); defaults to "no cap" so
  // every other card's 'fit' width stays exactly as uncapped as before.
  const capFitChars = opts.capFitChars || (() => null)
  // narrowFixed — a function returning whether this card gets a FIXED,
  // non-content-driven width (`NARROW_FIXED_WIDTH_CLS`, widthCls above),
  // bypassing contentWidthCls/boundedWrapWidthCls entirely regardless of
  // file type or content. Only ever passed `() => true` for the top-level
  // look-ahead preview (DetailPanel's `pair.forEach`, home.mjs) — reviewer
  // decision: that preview never needs to show its own longest line (it
  // always collapses to just its header anyway, see collapsedFn above), so
  // giving it a fixed width removes any reason for it to ever be wider than
  // the active card next to it, superseding the old capFitChars/
  // fitCapCharsFor mechanism for this ONE call site. Deliberately NOT used
  // by the drilled-column look-ahead preview (drillPreviewColumns), which
  // keeps its existing content-driven-but-capped width — see
  // .claude/docs/diff-card.md. Defaults to never fixed, for every other
  // card.
  const narrowFixedFn = opts.narrowFixed || (() => false)
  // shortcutHints — a function returning the contextual key-hint list for
  // THIS card right now (see shortcutHints.mjs) — only the caller (home.mjs)
  // knows whether this particular card instance is the one the keyboard is
  // actually on, so it decides when to pass a real list vs `() => []`.
  // Defaults to no hints for a caller that never wires it up (every preview/
  // drilled-preview card, which never owns the keyboard anyway).
  const shortcutHintsFn = opts.shortcutHints || (() => [])
  return html`
    <article
      class="${() =>
        // 'group' — purely for the hover-revealed blockMenuButton below (CSS
        // :hover, no reactive state attached, per the "hover carries no
        // state" rule in mouse-navigation.md); nothing else in this card
        // reacts to it.
        'group relative flex min-h-0 max-w-full flex-col overflow-hidden rounded-xl border bg-white dark:bg-zinc-900 transition ' +
        // A one-sided (added/removed) block only ever shows a single pane, so it
        // renders at the narrow (60%) width by default — the same width the `a`
        // toggle gives every card. A two-sided (modified) block keeps the full
        // two-pane width, and the `a` toggle (viewMode==='unified', see
        // `narrowed`) then shrinks EVERY visible card — modified included — to
        // that same narrow width in lockstep. `a`'s third stand ('fit') gets its
        // own, content-based width instead — see widthCls.
        widthCls(b, viewModeFn, capFitChars, activeGroup, narrowFixedFn) +
        (preview
          ? 'max-h-72 border-slate-300 dark:border-zinc-700 opacity-50'
          : // The real (non-preview) card also GROWS to fill whatever height
            // its column has left, up to the footer — but only once the diff
            // is big enough to plausibly want that room (the same
            // DIFF_FLOOR_MIN_ROWS gate diffFloorCls's own min-h-[45vh] floor
            // already uses below): a short block stays compact, matching the
            // existing "don't stretch a 3-line diff into empty space" rule.
            // Reviewer request (2026-08-20/21, screenshot of a drilled
            // SessionEnricher::utmValues card showing only ~3 lines of a
            // large function while its column had plenty of room below it):
            // "ik wil in de hoogte alles zien zolang de footer er niet
            // overheen gaat". The column itself (block-column / a drilled
            // column's own wrapper) already stretches to the full available
            // height bounded by the footer (AppColumns' own bottom offset,
            // see .claude/docs/detail-layout.md) — this card just never
            // asked for a SHARE of that height (`flex: 0 1 auto` by
            // default), so the leftover space sat empty below it instead of
            // in the diff. `min-h-[45vh]` on code-diff stays as the FLOOR;
            // this `flex-1` is the "no ceiling" half. See
            // .claude/docs/diff-card.md.
            (blockRows(b).length >= DIFF_FLOOR_MIN_ROWS ? 'flex-1 ' : '') +
            (diffActive()
              ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
              : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5'))}"
      style="${() => colWidthStyleFn()}"
      data-col-resize-root
      data-diff-col-key="${'diff:' + b.id}"
      @mousedown="${(e) => onBlockMouseDown(e, onRowMouseDown, onApproveClick)}"
      @contextmenu="${(e) => onBlockContextMenu(e, onRowContextMenu, opts.onOpenMenu)}"
      @mouseover="${(e) => {
        onCallSegHover(e, true)
        onRowPairHover(e, true)
      }}"
      @mouseout="${(e) => {
        onCallSegHover(e, false)
        onRowPairHover(e, false)
      }}"
    >
      ${() =>
        // Any non-preview/look-ahead card may be dragged wider/narrower —
        // NOT gated on diffActive() (unlike viewModeIndicator right below,
        // which is genuinely diff-session-only): resize must also work in
        // list mode (the block-index/sidebar still open, before stepping →
        // into a diff session) and while the keyboard has moved into this
        // card's own Underlying-code panel (relatedActive()) — both cases
        // `preview` already reports false for (see its own definition at
        // both Block() call sites in home.mjs), so `!preview` alone is the
        // right, and only, gate — consistent with how the Underlying-code/
        // Claude-chat/inline-comments handles show unconditionally (see
        // column-resize.md). Never shown on a card whose caller didn't wire
        // up resizing at all (onResizeStart stays a no-op then, so this
        // handle would drag nothing — e.g. testClass preview cards never
        // pass these opts). The snap-back baseline (parseAutoWidthPx) MUST
        // call widthCls with the exact same arguments as the card's own
        // class binding above — capFitChars/activeGroup included, not just
        // viewModeFn — so "the auto width" it compares the drag against is
        // exactly what's currently on screen; passing only `b`/`viewModeFn`
        // (no unit) falls back to the whole-block, un-windowed chars, which
        // used to differ from the window-scoped on-screen width only by a
        // few px for most real content but now can differ by a lot once
        // 'split'/'unified' combine both sides (see contentWidthCls) —
        // enough to break a same-position (+3px) drag's snap-back.
        !preview
          ? resizeHandle(
              (e) => onResizeStart(e, () => parseAutoWidthPx(widthCls(b, viewModeFn, capFitChars, activeGroup, narrowFixedFn))),
              () => onResizeReset(),
            )
          : ''}
      <div class="flex items-center gap-3 border-b border-slate-100 dark:border-zinc-800/60 px-4 py-2.5">
        <span
          class="${() =>
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
            categoryClass(b.category)}"
          >${() => b.category}</span
        >
        ${() => pathPills(b)}
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          ${() =>
            // Renamed/moved method: the OLD symbol above the new one, marked
            // `-` / `+` (same stacking as the path below). The nested toggling
            // slot lives inside this stable flex-col root — never a bare keyed
            // toggling expression, see the pitfall in
            // .claude/rules/arrowjs-pitfalls.md.
            blockOldLabel(b)
              ? html`<span
                  data-testid="block-old-label"
                  class="truncate font-mono text-xs font-medium text-rose-600 dark:text-rose-400"
                  >- ${blockOldLabel(b)}</span
                >`
              : ''}
          <h2 class="truncate font-mono text-sm font-semibold text-slate-800 dark:text-zinc-200">
            ${() => (blockOldLabel(b) ? '+ ' : '') + (b.label || '')}
          </h2>
        </span>
        <span
          data-testid="block-status-badge"
          class="${() =>
            // One stable span whose whole class/text flip together (whole-value
            // function bindings, see conventions.md): a prominent rose badge for
            // deleted code (fileDeleted / removed), else the plain status word.
            removedLabel(b)
              ? REMOVED_BADGE_CLS
              : movedLabel(b)
                ? MOVED_BADGE_CLS
                : 'shrink-0 text-xs font-medium ' + statusColor(b.status)}"
          >${() => removedLabel(b) || movedLabel(b) || b.status}</span
        >
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <span class="flex flex-col gap-0.5 font-mono text-xs">
          ${() =>
            // Renamed file OR renamed/moved method: show the OLD path:line
            // above the NEW one, marked `-` / `+` (not a strikethrough — the
            // two markers read the same way as the symbol stack above and as a
            // diff itself). The nested toggling slot lives inside this stable
            // flex-col root (never a bare keyed toggling expression) — see the
            // "kale toggelende expressie" pitfall in
            // .claude/rules/arrowjs-pitfalls.md.
            blockOldPathLine(b)
              ? html`<span
                  data-testid="block-old-path"
                  class="font-mono text-rose-600 dark:text-rose-400"
                  >- ${blockOldPathLine(b)}</span
                >`
              : ''}
          <span class="font-mono text-slate-500 dark:text-zinc-500"
            >${() => (blockOldPathLine(b) ? '+ ' : '') + b.file + ':' + b.line}</span
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
          // Mouse-only way back out of a DRILLED column — the click
          // equivalent of ←, same gate as viewModeIndicator right above,
          // never on a preview/look-ahead card. The top-level card's own way
          // back has no per-card button at all any more — see
          // MainScrollLeftHint (home.mjs).
          !preview && diffActive() && onCloseColumn ? blockCloseColumnButton(onCloseColumn) : ''}
        ${() =>
          // Mouse entry point into COMMANDS — never on a preview/look-ahead
          // card (Enter would never act on it either). See blockMenuButton's
          // own doc comment.
          preview ? '' : blockMenuButton(onOpenMenu)}
        ${() =>
          // Landed locally but not on GitHub yet: the code below IS what the
          // reviewer asked Claude for, it just isn't pushed. The word carries
          // the meaning, the ⇧ glyph reinforces it — never colour alone (the
          // reviewer is colour-blind). Cleared by the push (pending_push.go).
          unpushed()
            ? html`<span
                data-testid="block-unpushed"
                class="rounded bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                >⇧ ongepusht</span
              >`
            : ''}
        ${() =>
          // A not-yet-landed Claude edit is touching this file right now
          // (state.checkout.pendingFiles, chat_edit_pending.go) — a
          // deliberately different glyph/colour from unpushed() above, so
          // the two never read as the same status.
          editing()
            ? html`<span
                data-testid="block-editing"
                class="rounded bg-sky-50 dark:bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300"
                >✎ wordt aangepast</span
              >`
            : ''}
        ${() =>
          // Landed, but the ingest-refresh this landing triggered hasn't
          // swapped this file into the tree yet — the code shown below may
          // still be the pre-edit version (or the block may be about to
          // disappear entirely). home.mjs's `blocks.changed` handler clears
          // this automatically as soon as the refresh lands, see
          // refreshBlocksAfterOwnLanding.
          refreshing()
            ? html`<span
                data-testid="block-refreshing"
                class="rounded bg-violet-50 dark:bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300"
                >⟳ wordt bijgewerkt</span
              >`
            : ''}
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
          //
          // Same reasoning for a 'modified' block whose code HAS loaded but
          // turns out to have zero changed rows once aligned (e.g. a
          // whitespace/reformat-only diff, see approval.md's "A block with
          // zero changed rows has nothing to approve") — blockApproved
          // permanently returns false for it (it must, to not flash
          // "approved" while the code is still loading), so a visible
          // checkbox there would be a dead control forever. Gated on b.code
          // so the checkbox still shows (with a "loading" state) while the
          // diff hasn't loaded yet.
          b.status === 'unchanged' || (b.code && !b.code.error && changedRows(blockRows(b)).length === 0)
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

      ${() =>
        // Collapsed (see collapsedFn's own doc comment above): skip the
        // description AND the diff body entirely, leaving just the header +
        // meta rows above (category/title/status, file:line + approve pill) —
        // exactly the "only show the head" ask. A `${() => ...}` toggle
        // between a template and '' (never a bare/static ternary — see the
        // "leaks the template function as text" pitfall in conventions.md);
        // nested inside this already-stable <article> root, not itself the
        // sole content of a keyed list item, so the "bare toggling
        // expression" pitfall doesn't apply here either (same reasoning as
        // the b.tests/b.author/checkbox toggles above).
        //
        // No description yet (still being generated, or never will be) also
        // skips this whole strip — no placeholder text, the strip itself
        // doesn't render, on explicit request. There is no separate loading
        // flag for b.description, so this also hides the strip while an
        // AI description is still in flight; it appears the moment
        // b.description is populated, same as any other reactive field here.
        // Rendered as MARKDOWN, not as one plain-text run (descriptionHtml):
        // phpDocDescription (phpscan.go) preserves the docblock's paragraph
        // breaks, and a PHPDoc's prose routinely uses `backticks` around
        // identifiers and command names. Same renderMarkdown + `.markdown-body`
        // typography every comment body and chat bubble already goes through
        // (see conventions.md's "Markdown rendering"), so it also inherits the
        // XSS layer — which matters here too: the text is source-derived, and
        // this used to be an escaping-free plain-text slot.
        //
        // A <div> root, not the <p> this was: it now contains block-level
        // elements of its own.
        //
        // Capped at 2 visual lines (line-clamp-2, so also after wrapping; plus
        // [&>p]:my-0 while capped, because .markdown-body's own paragraph
        // margins ride along inside the clamp box and would otherwise make the
        // "2 lines" a good half line taller than two lines)
        // unless descExpanded() — a long docblock/AI description used to push
        // the diff itself off screen. The reviewer opens it from its own
        // keyboard stop (↑ from the block's first change, then Enter) or by
        // clicking the strip; the trailing ellipsis plus the "meer…" hint carry
        // the collapsed state, never colour alone.
        collapsedFn() || !b.description
          ? ''
          : html`<div
              class="${() =>
                'border-t border-slate-100 dark:border-zinc-800/60 px-4 py-3 ' +
                (onDescriptionClick ? 'cursor-pointer ' : '') +
                (descFocused() ? 'ring-2 ring-inset ring-indigo-400 dark:ring-indigo-500' : '')}"
              data-testid="block-description-strip"
              data-desc-focused="${() => (descFocused() ? 'true' : 'false')}"
              data-desc-collapsed="${() => (descExpanded() ? 'false' : 'true')}"
              @click="${() => onDescriptionClick && onDescriptionClick()}"
            >
              <div
                class="${() =>
                  'markdown-body text-sm leading-relaxed text-slate-600 dark:text-zinc-400 ' +
                  (descExpanded() ? '' : 'line-clamp-2 [&>p]:my-0')}"
                data-testid="block-description"
                .innerHTML="${() => descriptionHtml(b.description)}"
              ></div>
              ${() =>
                blockDescCollapsible(b)
                  ? html`<div
                      class="mt-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400"
                      data-testid="block-description-toggle"
                    >
                      ${() => (descExpanded() ? 'Inklappen' : 'meer… (Enter)')}
                    </div>`
                  : ''}
            </div>`}
      ${() =>
        collapsedFn()
          ? ''
          : b.category === 'TRANSLATION'
          ? translationSlot(b, activeGroup, approvedFn, langSiblingsFn, hintsEnabled, lineSummaryFn, diffActive)
          : isSvgFile(b)
          ? svgSlot(b)
          : codeDiff(b, activeGroup, hintsEnabled, approvedFn, commentedFn, approvedCallsFn, viewModeFn, lineSummaryFn, diffActive, commentRangeFn)}
      ${ShortcutHintBar(shortcutHintsFn)}
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
// comment further down. `lineSummaryFn` is the SAME opt Block() already
// threads into codeDiff (see above) — a TRANSLATION block's per-key rows can
// carry an "onderliggende code" avatar+N/approve badge exactly like an
// ordinary code row (this used to also render its own 💬 comment marker
// inline; removed together with rowCellHTML's, see commentedHere's doc
// comment there — the badge alone already marks presence). Passed down to
// translationBlockView as a small callback (`lineSummaryFor`, mirroring the
// existing `onScroll` callback) rather than the raw Map itself, so
// translationDiff.mjs stays decoupled from Block.mjs's own markup function
// (translationLineSummaryHtml) — no circular import, same reasoning as
// `onScroll` above.
function translationSlot(
  b,
  activeGroup,
  approvedFn,
  langSiblingsFn,
  hintsEnabled = () => false,
  lineSummaryFn = () => new Map(),
  diffActive = () => false,
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
  // free. See .claude/docs/blocks-and-ingest.md ("Translation blocks") and
  // .claude/docs/keyboard-navigation.md (the green in-card scroll chevron).
  return html`
    <div
      class="${'relative flex flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60 ' +
      diffFloorCls(units.length)}"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      ${translationBlockView(units, {
        activeIndex,
        focused: diffActive,
        approvedRowSet: approvedFn,
        siblings,
        onScroll: (e) => {
          const container = e.target.closest('[data-testid="code-diff"]')
          if (container) updateHints(container)
        },
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

// NO_ACTIVE_GROUP is the stub `activeGroup` the split stand's old/left pane
// gets — see "Only the new/right pane drives selection" below. A stable
// module-level function (never a fresh closure per render) so it never looks
// like a changing dependency of its own.
const NO_ACTIVE_GROUP = () => null

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
// lastDiffDebugKey — TEMP DEBUG, remove together with the instrumentation in
// codeDiff below. Plain module-level variable (never reactive state, same
// discipline as blockRowsCache/codeRequested), so re-checking it never
// triggers/depends on an arrow.js reactive notify.
let lastDiffDebugKey = null

function codeDiff(
  b,
  activeGroup,
  hintsEnabled = () => false,
  approvedFn = () => new Set(),
  commentedFn = () => new Set(),
  approvedCallsFn = () => new Set(),
  viewMode = () => 'split',
  lineSummaryFn = () => new Map(),
  diffActive = () => false,
  commentRangeFn = () => new Set(),
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
  // TEMP DEBUG instrumentation — remove after investigation. One summarized
  // line per block/render (not one per changed line — that flooded the
  // console and made the tab sluggish), and only logged again when the
  // block/view/char-counts actually differ from the last log, so repeated
  // re-renders of the same block/view are silent.
  {
    const vm = viewMode()
    const charsList = changedRows(rows).map((i) => rowAnchorText(rows[i]).length)
    const debugKey = `${b.file}:${b.line}|${vm}|${charsList.join(',')}`
    if (debugKey !== lastDiffDebugKey) {
      lastDiffDebugKey = debugKey
      console.log(`[diff-debug] block=${b.file}:${b.line} view=${vm} chars=[${charsList.join(',')}]`)
    }
  }
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
  // isPhpFile/contentWidthCls's own doc comment for the full reasoning. Since
  // 'fit' now always forces a single pane above, this only ever reaches the
  // single-pane codePane branches below (effectiveOnly === 'right'/'left')
  // — there is no two-pane wrapping path left to reach.
  const wrap = viewMode() === 'fit' && !isPhpFile(b)
  // Gates the collapsed-run breadcrumb (see yamlBreadcrumbsForSegs) — only a
  // yaml/yml whole-file fallback block gets the extra key-hierarchy line.
  const isYaml = isYamlFile(b)
  // A one-sided block (added/removed) renders at the card's full width in
  // every stand — the `a` toggle's narrower 60% width (`narrowed`, see above)
  // still applies to the card itself, just without a second pane to hide;
  // there's no divider, no empty counterpart. A one-sided block never needs
  // the paired-row structure below (there's only one column to wrap), so it
  // just reuses codePane/paneHTML with the `wrap` flag threaded through.
  if (effectiveOnly === 'right') {
    return html`
      <div
        class="${'relative flex flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60 ' +
        diffFloorCls(rows.length)}"
        data-testid="code-diff"
        data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
      >
        ${codePane('new', c.new, rows, 'right', 'border-emerald-100 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', activeGroup, 'w-full', approvedFn, commentedFn, approvedCallsFn, wrap, lineSummaryFn, diffActive, isYaml, commentRangeFn)}
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
        <div class="${'relative flex flex-1 overflow-hidden ' + diffFloorCls(rows.length)}">
          ${codePane('old', c.old, rows, 'left', 'border-rose-100 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400', activeGroup, 'w-full', approvedFn, commentedFn, approvedCallsFn, wrap, lineSummaryFn, diffActive, isYaml, commentRangeFn)}
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
    return unifiedCodeDiff(
      rows,
      hintsEnabled,
      activeGroup,
      approvedFn,
      commentedFn,
      approvedCallsFn,
      lineSummaryFn,
      diffActive,
      isYaml,
      commentRangeFn,
    )
  }
  // Side-by-side (the default 'split' stand). Only the RIGHTMOST pane gets
  // commentRangeFn — the old/left pane keeps the empty default, since the
  // comment-range bar marks the right edge of the diff as a whole, not of
  // each half (see rowCellHTML's commentRangeBar).
  //
  // Only the new/right pane drives selection here (see "Only the new/right
  // pane drives selection" in diff-render.md): the left pane gets a
  // permanently-null activeGroup (never highlights, never underlines) and
  // `emitMeta:false` (no data-row/checkmark/change-active anchor/line-summary
  // badge — the exact same suppression unifiedRowHTML already applies to its
  // own decorative OLD half). This is also what fixes the two-independent-
  // bindings race that used to let the old and new pane show the active bar
  // on two DIFFERENT rows at once: with the left pane's own `.innerHTML`
  // binding no longer reading `activeGroup()`/`state.change` at all, there is
  // only one binding left that can ever compute "active" — nothing left to
  // race against.
  //
  // The two panes are no longer both plain 'w-1/2' — on reviewer decision
  // (2026-08-18) the non-canonical (old/left) pane gets
  // SPLIT_LEFT_PANE_WIDTH_CLS ('w-1/2' capped at a static
  // MIN_CONTENT_WIDTH_CHARS-capped `max-w`, see its own doc comment for why this
  // reproduces the card's new total width formula using only static CSS),
  // and the canonical (new/right) pane gets `flex-1` — it simply fills
  // whatever space the capped left pane doesn't claim, which the card's own
  // outer width (windowCharsForMode's 'split' branch) already sized to fit.
  // Deliberately NOT computed here as a reactive `${() => ...}` ch-width on
  // either pane: reading activeGroup()/the current unit directly in
  // codeDiff's own top-level flow (rather than deferred inside codePane's
  // nested innerHTML binding, see the comment above) would make THIS ENTIRE
  // slot re-run on every same-block navigation step instead of only the
  // card's own width class — see "a change-step within the same block only
  // patches the highlight" in navigate.spec.mjs.
  return html`
    <div
      class="${'relative flex flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60 ' +
      diffFloorCls(rows.length)}"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      ${codePane('old', c.old, rows, 'left', 'border-rose-100 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400', NO_ACTIVE_GROUP, SPLIT_LEFT_PANE_WIDTH_CLS, approvedFn, commentedFn, approvedCallsFn, false, lineSummaryFn, diffActive, isYaml, undefined, false)}
      <div class="w-px shrink-0 bg-slate-100 dark:bg-zinc-800"></div>
      ${codePane('new', c.new, rows, 'right', 'border-emerald-100 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', activeGroup, 'flex-1 min-w-0', approvedFn, commentedFn, approvedCallsFn, false, lineSummaryFn, diffActive, isYaml, commentRangeFn)}
      ${scrollHint('up')}
      ${scrollHint('down')}
    </div>
  `
}

// diffFloorCls gives the code-diff body a VIEWPORT-RELATIVE minimum height
// (a vh unit, not a fixed px value) — but only once the block is genuinely
// long enough to plausibly want that much room. A long PHPDoc/AI description
// above the diff (Block()'s `block-description` strip — capped at 2 lines
// unless the reviewer opens it from its own keyboard stop, see
// .claude/docs/diff-card.md) used to squeeze an unrelated diff's own
// `flex-1` body down to a sliver, regardless of how much code it actually
// held; a bare fixed-px floor would fix that but also stretch a genuinely
// short diff (a one-line getter) into a mostly-empty box. So this floor only
// kicks in once `rowCount` would, on its own, roughly reach that same share
// of the viewport anyway: DIFF_FLOOR_ROW_PX mirrors Footer.mjs's own
// per-code-row estimate, so DIFF_FLOOR_MIN_ROWS is simply
// "how many rows it takes to reach DIFF_FLOOR_VH on a typical viewport" —
// deliberately a rough content-size gate, not a live window.innerHeight
// check: rowCount is a stable content fact (computed once per codeDiff()
// call), so this can stay a plain, non-reactive class string built inline
// where each wrapper's class is already assembled — no new reactive slot
// needed. The vh unit itself is pure CSS and needs no JS viewport tracking
// at all.
//
// This is a FLOOR only, not a ceiling: the card's own `<article>` (see its
// class binding above) ALSO gets `flex-1` under this exact same
// DIFF_FLOOR_MIN_ROWS gate, so a big-enough diff also grows to fill whatever
// height its column has left, up to the footer (`<main>`'s columns already
// stretch that far, see .claude/docs/detail-layout.md) — reviewer request,
// 2026-08-20/21, superseding the earlier "the rest of the page simply sits
// further down, accepted trade-off" framing that used to live here: the
// look-ahead preview/connector below the card sitting further down IS now
// the intended effect of the diff actually using that room, not an
// incidental side effect of a fixed floor. A diff under the row threshold
// stays exactly as compact as before — nothing here changes for it.
const DIFF_FLOOR_VH = 45
const DIFF_FLOOR_ROW_PX = 18
// 20 rows: on an 800px-tall viewport (a modest laptop, not an ultrawide),
// 20 * DIFF_FLOOR_ROW_PX (360px) already roughly equals DIFF_FLOOR_VH's own
// 45% (360px) — i.e. "big enough" means the diff's own natural height would
// already reach the floor unaided on an average screen.
const DIFF_FLOOR_MIN_ROWS = 20
function diffFloorCls(rowCount) {
  return rowCount >= DIFF_FLOOR_MIN_ROWS ? `min-h-[${DIFF_FLOOR_VH}vh]` : 'min-h-0'
}

// scrollHint is the little floating bar at the top/bottom edge of the diff body
// that tells the reviewer there are still changed lines out of view in that
// direction (so scrolling reveals more). It starts hidden (opacity 0) and is
// switched on/off — and positioned right below the pane headers / above the
// bottom edge — imperatively by updateHints on every scroll and refresh. It's
// pointer-events-none so it never eats a scroll or click.
export function scrollHint(dir) {
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
  // Prefer the new/right pane's scroller: it's the only one that still
  // carries `data-changed` in a split diff (the old/left pane is
  // display-only, see "Only the new/right pane drives selection" in
  // diff-render.md) — `[data-scrollsync]` alone would grab whichever pane
  // happens to come FIRST in document order, which is the old/left one in
  // 'split'. Falls back to the plain query for a whole-removed block (only
  // an old pane exists there at all) and every other stand, which all carry
  // `data-pane="new"` on their one and only pane already.
  const pane =
    container.querySelector('[data-pane="new"] [data-scrollsync]') ||
    container.querySelector('[data-scrollsync]')
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
  diffActive = () => false,
  isYaml = false,
  commentRangeFn = () => new Set(),
  // emitMeta: false ONLY for the split stand's old/left pane (see
  // codeDiff's "Only the new/right pane drives selection") — suppresses
  // data-row/the change-active anchor/the checkmark/the line-summary badge on
  // this pane's own rows, the same suppression unifiedRowHTML already applies
  // to its decorative OLD half. Every other call site keeps the default
  // (true): a single-pane render (added/removed/'fit', or the split stand's
  // own new/right pane) is always the canonical, metadata-carrying side.
  emitMeta = true,
) {
  return html`
    <div class="${'flex min-w-0 min-h-0 flex-col ' + widthCls}" data-pane="${side}">
      <div class="no-scrollbar min-h-0 flex-1 overflow-auto" data-scrollsync @scroll="${syncScroll}">
        <code
          class="language-php m-0 block py-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
          @click="${(e) => onPaneClick(rows, e)}"
          .innerHTML="${() => {
            disarmRowPairHover()
            return paneHTML(rows, sideKey, activeGroup(), approvedFn(), commentedFn(), approvedCallsFn(), wrap, diffActive(), lineSummaryFn(), isYaml, commentRangeFn(), emitMeta)
          }}"
        ></code>
      </div>
    </div>
  `
}

// commentRangeBar renders the vertical bar along the RIGHT edge of row `i`
// when that row falls inside the range of the comment the keyboard currently
// sits in (RelatedPanel's commentRangeRowSet, threaded down as `commentRange`
// — null/empty whenever no comment owns the keyboard, which is the common
// case). Adjacent rows' segments touch, so the range reads as one continuous
// line, exactly like the active unit's inset left bar; the first/last row of
// the range get a rounded cap so the extent is unmistakable.
//
// RIGHT edge on purpose: the left edge already carries the cursor bar of the
// active unit, so position alone tells the two apart — colour is never the
// discriminator here (the reviewer is colourblind, see CLAUDE.md).
//
// Absolutely positioned inside the row's own (relative) box, exactly like the
// approve checkmark on the left. That box is the pane's width, not the code's,
// so the bar scrolls along when a pane is scrolled horizontally — accepted,
// same as the checkmark; anchoring it to the viewport would need a measuring
// overlay (callArrows.mjs) for a purely decorative cue.
function commentRangeBar(i, commentRange) {
  if (!commentRange || !commentRange.has(i)) return ''
  const cap =
    (commentRange.has(i - 1) ? '' : ' rounded-t-sm') + (commentRange.has(i + 1) ? '' : ' rounded-b-sm')
  return (
    '<span class="pointer-events-none absolute right-0 top-0 bottom-0 w-[3px] select-none bg-indigo-400 dark:bg-indigo-400/80' +
    cap +
    '" data-testid="comment-range-bar" data-comment-range="' +
    i +
    '" title="De open comment gaat over deze regels"></span>'
  )
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
// data-row/data-changed/the change-active anchor/the checkmark/the line
// summary badge — so a paired row's two stacked lines never both carry the
// same `data-row="i"`, which would make a callArrows/updateHints query for
// that index ambiguous. Exactly one line per row keeps carrying metadata: the
// same canonical side approveHere below already singles out (the new/right
// side, or the old/left side when there's no right at all).
function rowCellHTML(r, i, sideKey, group, approved, commented, wrap, focused = true, opts = {}, lineSummaries = null, segDots = null) {
  const { gutter = false, emitMeta = true, commentRange = null } = opts
  const text = sideKey === 'left' ? r.left : r.right
  const mark = sideKey === 'left' ? r.leftMark : r.rightMark
  const ws = wsOnly(r)
  // A row-level flag (a real change on either side) so a single pane's rows
  // carry the full set of changes — updateHints scans just one pane. Del
  // rows are marked on the left, ins rows via their filler row, so both are
  // covered. Whitespace-only re-alignments don't count (see rowChanged/wsOnly).
  const changed = rowChanged(r)
  // A REFERENCE unit (group.ref — an unchanged line that only carries a
  // resolved call, see withReferenceUnits above) is landable too, so the
  // cursor bar has to show there as well; `changed` alone would leave the
  // reviewer standing on an invisible selection. Everything else follows from
  // the existing branches: with no del/ins mark the row keeps its ordinary
  // (untinted) background and only gains the inset cursor bar.
  const active = !!group && i >= group.start && i <= group.end && (changed || !!group.ref)
  // At call granularity the active unit is a single row plus the char indices
  // of the one call segment being navigated; underline those (per side) so the
  // exact segment within the line is marked. null at group/line granularity.
  const underline =
    active && group.char ? (sideKey === 'left' ? group.left : group.right) : null
  // A fully-approved changed row gets a small checkmark in the left gutter —
  // see approveHere below for which side draws it. The active (indigo)
  // highlight takes precedence visually while the cursor is on the row.
  const isApproved = changed && approved.has(i)
  // rowApproveEnabled gates the one remaining mouse-only approve affordance:
  // the call-segment hover ring (segHoverRingMarkers, below) — only for the
  // split/fit stands (opts.gutter is only ever true from unifiedRowHTML — the
  // unified stand's own inline "-"/"+" gutter checkmark stays exactly as
  // before, not a click target; a deliberate scope limit, same "not every
  // stand" precedent as SVG/TRANSLATION — see mouse-navigation.md), on the
  // canonical approve side (approveHere is computed once, further down, from
  // the same `sideKey`/`r.right` inputs — duplicated here only so this flag
  // is available before that point), and only on a card that currently owns
  // (or could take over) the keyboard (`focused`, the same gate the plain
  // hover-select affordance further below uses) — a look-ahead preview/
  // testClass card never shows the hover ring. The line/group gutter
  // toggles this flag used to also gate were removed (reviewer request: a
  // selection now shows the command palette directly instead, see
  // .claude/docs/command-palette.md's "A mouse selection shows the palette
  // passively" — only the plain, always-visible ✓ checkmark stays).
  const rowApproveEnabled = !gutter && focused && emitMeta && (sideKey === 'right' || r.right == null)
  // Backgrounds are ~20% lighter than the raw Tailwind rose/emerald shades
  // (mixed 20% toward white) so the tint reads as an accent, not a fill.
  let cls =
    'relative block px-3 ' +
    (wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre') +
    (rowApproveEnabled ? ' group/row' : '')
  if (active && focused) {
    // Brighter tint + an inset left bar (box-shadow, so it adds no width and
    // the bars of adjacent active rows merge into one continuous accent).
    // Only while the diff genuinely owns the keyboard (`focused`, mirrors
    // `diffActive()` — see keyboard-navigation.md "Focus highlight per
    // stop"): otherwise this same row falls into the dimmed branch below.
    cls += ' shadow-[inset_3px_0_0_#6366f1]'
    if (mark === 'del') cls += ' bg-[#fed7dc] dark:bg-rose-500/25' // rose-200 +20% white
    else if (mark === 'ins') cls += ' bg-[#b9f5d9] dark:bg-emerald-500/25' // emerald-200 +20% white
    else cls += ' bg-indigo-50 dark:bg-indigo-500/15'
  } else if (active) {
    // The cursor still sits on this row, but the diff doesn't currently own
    // the keyboard (it moved into a comment thread, Underlying code, the
    // embedded Claude chat, or back to the block index/search — see
    // "Focus highlight per stop" in keyboard-navigation.md). The bar turns
    // GREY *and* one pixel thinner than the focused indigo bar (2px vs 3px)
    // — colour and thickness change together, never colour alone (the
    // reviewer is colourblind, see CLAUDE.md). The del/ins background falls
    // back to its ordinary (non-active) tint; a mark-less row (the filler
    // side of a one-sided add/remove) gets the ordinary filler tint.
    cls += ' shadow-[inset_2px_0_0_#94a3b8] dark:shadow-[inset_2px_0_0_#71717a]'
    if (mark === 'del') cls += ' bg-[#ffe9eb] dark:bg-rose-500/10' // rose-100 +20% white
    else if (mark === 'ins') cls += ' bg-[#dafbea] dark:bg-emerald-500/10' // emerald-100 +20% white
    else if (text === null) cls += ' bg-slate-50 dark:bg-zinc-800/60' // filler for the missing side
  } else {
    // Hover affordance for line selection (click / a real text selection, see
    // home.mjs's beginMouseSelection/resolveClickSelection/
    // resolveRangeSelection): a grey left inset bar, same
    // colour family as the dimmed cursor bar above — never shown together
    // with a real cursor bar (this whole branch is only reached for a
    // non-active row), so there's no risk of one hiding the other. Only
    // while `focused` (this card already owns, or could take over, the
    // keyboard — mirrors diffActive()): a look-ahead preview/testClass card
    // never shows it or reacts to a click at all (opts.onRowMouseDown
    // defaults to null there). Shape+thickness would be
    // identical either way — this is a pure hover-only affordance, not a
    // second colour-only state (colorblind rule): nothing else on the row
    // changes. Written as `0px_0px` (equivalent CSS to `0_0`, box-shadow
    // treats a zero length the same with or without a unit) rather than
    // reusing the exact `inset_2px_0_0` token the dimmed cursor bar uses —
    // that literal substring is what tests/diff-active-row-dim.spec.mjs
    // greps the `class` attribute for, and a *possible* hover class would
    // otherwise always match it regardless of actual `:hover` state.
    //
    // Gated on `emitMeta` too (not just `focused`): the split stand's old/left
    // pane is never a click target (see "Only the new/right pane drives
    // selection" in diff-render.md), so it gets neither `cursor-pointer` nor
    // this native self-`:hover` — only the JS-driven `row-pair-hover` class
    // below, which the delegated onRowPairHover also lights up on its new/
    // right counterpart (and vice versa — reviewer request: "het moet hover
    // state krijgen als nieuw connected ook hoverd, en andersom").
    if (focused && emitMeta)
      cls += ' cursor-pointer hover:shadow-[inset_2px_0px_0px_#94a3b8] dark:hover:shadow-[inset_2px_0px_0px_#71717a]'
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
  // The call-approval dot markers (segDots, see segDotMarkers) ride along on
  // the same markChars pass as the underline: both are per-character classes on
  // this line, so they compose without a second render path — a segment can be
  // underlined (active) and carry its dot at the same time.
  // hoverSegMarks (defined further below, once callSegs is known) rides along
  // the same two functions — a segment's hover-only ring is exactly as much a
  // "dot" as a real DONE/TODO one, just gated on hover instead of always shown.
  const segDotCls = (pi) => (segDots && segDots.get(pi)) || (hoverSegMarks && hoverSegMarks.get(pi)) || ''
  const segDotAttr = (pi) =>
    (segDots && segDots.has(pi)) || (hoverSegMarks && hoverSegMarks.has(pi)) ? ` data-seg-dot="${pi}"` : ''
  // callSegs: every call-chain segment of this row's NEW/right text, wrapped
  // below in a hoverable+clickable span (CALL_HOVER_CLS/`data-call-seg`) so a
  // single click can resolve to 'call' granularity instead of 'line' — see
  // home.mjs's resolveClickSelection and "Line selection: click and browser
  // text selection" in .claude/docs/diff-render.md. Only while `focused` (same gate as the
  // plain-row hover bar above) and only the RIGHT side — the old/left pane
  // never gets a 'call' selection at all (reviewer confirmed "oude kant
  // alleen 'line'"), and only when this row's new text was actually
  // segmented (rightMark==='ins'): a removed line with no replacement has no
  // right text to hover/click on.
  const callSegs =
    focused && sideKey === 'right' && r.rightMark === 'ins' && r.right != null ? callSegmentsForRow(r) : null
  const callSegCls = (pi) => (callSegAt(callSegs, pi) ? CALL_HOVER_CLS : '')
  const callSegAttr = (pi) => {
    const seg = callSegAt(callSegs, pi)
    return seg ? ` data-call-seg="${seg.start}"` : ''
  }
  // hoverSegMarks: the mouse-only "approve this call segment" counterpart of
  // segDotMarkers' own DONE/TODO dots — same position (a ::after pseudo-
  // element under the segment's first non-space character, see
  // segHoverRingMarkers below) and the same "niks → niks, deels → bolletjes"
  // rule, EXCEPT this one only shows up on hover (rowApproveEnabled,
  // group/row): a row that's already partially approved shows its real dots
  // unconditionally (segDots), so this only ever fires for a row with real
  // call structure (more than one segment) that carries NO approval at all
  // yet — the "leeg rondje bij hover" rule applied per segment instead of per
  // line. Clickable via the same `[data-seg-dot]` delegation as a real dot
  // (see onBlockMouseDown), which already carries `data-call-seg` too.
  const hoverSegMarks =
    rowApproveEnabled && !isApproved && !(segDots && segDots.size) && callSegs && callSegs.length > 1
      ? segHoverRingMarkers(text, callSegs)
      : null
  // dotsForRender: segDots/hoverSegMarks are mutually exclusive (the latter
  // only ever computed when the former is empty — see its own doc comment
  // above), so a plain fallback picks whichever applies. highlightChanges
  // (the PAIRED-row render path, below) takes its own segDots argument
  // directly rather than reading segDotCls/segDotAttr's closures, so it needs
  // this merge explicitly — the one-sided branch further below already gets
  // it for free through those two closures.
  const dotsForRender = segDots && segDots.size ? segDots : hoverSegMarks
  let body
  if (text === null) body = '&nbsp;'
  else if (paired) body = highlightChanges(r, sideKey, ws, underline, dotsForRender, callSegs)
  else if ((underline && underline.size) || (segDots && segDots.size) || callSegs)
    // A one-sided change (pure add / remove): its whole line is the single
    // edit, so underline it end to end.
    body = markChars(
      highlight(text),
      (pi) =>
        [underline && underline.has(pi) ? UNDERLINE_CLS : '', segDotCls(pi), callSegCls(pi)]
          .filter(Boolean)
          .join(' '),
      (pi) => segDotAttr(pi) + callSegAttr(pi),
    )
  else body = highlight(text)
  // A commented row no longer gets its own 💬 marker in the code body — the
  // "onderliggende code" avatar+N badge (lineSummaryHtml below) already marks
  // presence on that same row (it counts a comment placed directly on the
  // block's own row too, not only underlying-code-child activity — see
  // lineChildSummaries in home.mjs), so the emoji was a second, redundant
  // presence indicator right next to it (reviewer request: "haal comment
  // balonnetjes weg, de avatar laat het al zien"). Don't reintroduce it. The
  // `commented` param stays threaded through unchanged — collapsePlan below
  // still needs it to keep a commented row visible in a trimmed huge block.
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
  // approveHere: the approve mark for a row belongs on the new (right) pane
  // normally, and on the old (left) pane only for a pure deletion (no right
  // side) — so a modified row never gets it twice.
  const approveHere = emitMeta && (sideKey === 'right' || r.right == null)
  // lineSummaryHtml: the "onderliggende code" per-line badge (avatar+N
  // comment activity, plus a done/total approve fraction) — see
  // lineSummaryBadge below and home.mjs's lineChildSummaries, which builds
  // the lineSummaries Map keyed by the SAME row index rowCellHTML is
  // rendering here (already resolved onto a change-group's first row where
  // applicable). Same canonical side as approveHere — a modified row never
  // gets it twice.
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
  // to find a row (a collapsed run renders one spacer for many rows), and only
  // the active group's first row has an anchor otherwise. Used by the
  // call-arrow overlay (src/callArrows.mjs) to anchor an arrow on the exact
  // call-site row. Suppressed when emitMeta is false, see above.
  const dataRow = emitMeta ? ` data-row="${i}"` : ''
  // data-row-pair carries the SAME aligned-row index as data-row, but
  // unconditionally (regardless of emitMeta/canonical side) — see
  // onRowPairHover above. Only the canonical (new/right) side is a click
  // target, but hovering EITHER side must light up both, so both need a
  // handle to find each other.
  const dataRowPair = ` data-row-pair="${i}"`
  return `<div class="${cls}"${anchor}${anchorEnd}${flag}${dataRow}${dataRowPair}>${check}${gutterHtml}${body}${lineSummaryHtml}${commentRangeBar(
    i,
    commentRange,
  )}</div>`
}

// pathPills renders the MODULE and LAYER a block lives in, next to the
// category pill on the card header. Both are optional and each is simply left
// out when absent — a plain-Laravel path (`config/…`) has neither, an
// old-style module path (`modules/Payments/Services/…`) has only a module, a
// new-style one (`modules/Checkouts/Internal/Services/…`) has both. `app`
// counts as a module name like any other (Reindert), so it gets a pill too.
//
// Together with the category pill this is the three-label set: module · layer ·
// type. Deliberately HERE and not in the sidebar row: the block index is for
// scanning and its row already carries cursor/category/label/removed/unpushed/
// comment-activity/approval/status; the card is where there is room for
// context. (Reindert picked this over "all three in the index".)
//
// The module pill's colour comes from the same rotating palette the category
// fallback uses, so one module always looks the same; the layer pill is
// deliberately a neutral outline — there are only three layer values and they
// are a structural detail, not a category. As always the WORD carries the
// meaning, colour is decoration (the colourblind rule).
//
// Returned as a keyed ARRAY, never a bare element or null, so the slot always
// emits the same kind and can't hit the single↔array freeze (see
// .claude/rules/arrowjs-pitfalls.md).
function pathPills(b) {
  const { module, layer } = splitBlockPath(b.file)
  const pills = []
  if (module) {
    pills.push(
      html`<span
        data-testid="block-module-pill"
        class="${'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ' + paletteClass(module)}"
        title="${'Module: ' + module}"
        >${module}</span
      >`.key('mod:' + module),
    )
  }
  if (layer) {
    pills.push(
      html`<span
        data-testid="block-layer-pill"
        class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 dark:text-zinc-300 ring-1 ring-inset ring-slate-300 dark:ring-zinc-600"
        title="${'Laag: ' + layer}"
        >${layer}</span
      >`.key('layer:' + layer),
    )
  }
  return pills
}

// noteIconHtmlString — the per-line indicator's glyph for a row whose only
// open comment threads are LOCAL ones (never posted to GitHub, see
// isLocalComment in RelatedPanel.mjs). Reindert: "als ik alleen een local
// comment heb op een regel, maak hier dan een note icoontje van ipv mijn
// avatar" — an avatar answers "who is waiting for you", which says nothing
// when the only thing on that line is your own private note, and seeing your
// own face on your own note is just noise.
//
// A plain HTML string, not an arrow.js template, because the whole pane it
// lands in is assigned via `.innerHTML` (same reason avatarHtmlString exists
// rather than avatarHTML — see the statically-interpolated-template pitfall in
// .claude/rules/arrowjs-pitfalls.md).
//
// The distinction is carried by SHAPE (a square note vs. the round avatar),
// not by colour — the colorblind rule — and the badge's `title` names it in
// words too ("eigen notitie(s)" vs "open reactie(s)").
function noteIconHtmlString(sizeCls) {
  return (
    `<svg data-testid="line-note-icon" class="${sizeCls} shrink-0 text-slate-500 dark:text-zinc-400" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 9h8"/><path d="M8 14h5"/></svg>'
  )
}

// aiWarningIconHtmlString mirrors BlockList.mjs's aiWarningIcon (the same
// warning-triangle glyph, see isLocalAiWarning there) as a plain HTML string,
// sized to sit inline with noteIconHtmlString/avatarHtmlString in the
// "onderliggende code" per-line badge (lineSummaryParts below). A not-yet-
// published AI risk finding used to fall through to the plain note icon there
// too (it also satisfies isLocalComment — never posted to GitHub yet), which
// read exactly like a private reviewer note and hid the fact that a machine
// flagged the line (reviewer request). Rendered SIDE BY SIDE with the note/
// avatar icon when both apply to the same line — explicit reviewer decision:
// never let one win over the other, since they mean different things. The
// SHAPE carries the meaning (colorblind rule); the amber tint is decoration.
function aiWarningIconHtmlString(sizeCls) {
  return (
    `<svg data-testid="line-ai-warning-icon" class="${sizeCls} shrink-0 text-amber-600 dark:text-amber-400" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  )
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
    // hasAiWarning (a not-yet-published AI risk finding, see
    // aiWarningIconHtmlString above) and otherCount > 0 (an ordinary open
    // comment/note besides it) are independent — both icons render when both
    // apply, never one instead of the other. `icons.length` is how many
    // threads are already visually represented (the AI triangle covers every
    // counted AI finding, the note/avatar icon covers every other counted
    // comment), so the "+N" suffix is the remainder beyond that, not a flat
    // count-1 — mirrors the single-icon case exactly when only one applies.
    const icons = []
    if (commentActivity.hasAiWarning) icons.push(aiWarningIconHtmlString('h-3 w-3'))
    if (commentActivity.otherCount > 0) {
      icons.push(
        commentActivity.local
          ? noteIconHtmlString('h-3 w-3')
          : avatarHtmlString(commentActivity.last.name, commentActivity.last.avatarUrl, 'h-3 w-3'),
      )
    }
    const remaining = commentActivity.count - icons.length
    parts.push(
      icons.join('') +
        (remaining > 0
          ? `<span class="text-[9px] font-semibold text-slate-500 dark:text-zinc-500">+${remaining}</span>`
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
  const activityWords = []
  if (commentActivity && commentActivity.hasAiWarning) {
    activityWords.push(
      commentActivity.aiCount + (commentActivity.aiCount === 1 ? ' AI-risicowaarschuwing' : ' AI-risicowaarschuwingen'),
    )
  }
  if (commentActivity && commentActivity.otherCount > 0) {
    activityWords.push(
      commentActivity.otherCount +
        (commentActivity.local
          ? commentActivity.otherCount === 1
            ? ' eigen notitie'
            : ' eigen notities'
          : commentActivity.otherCount === 1
            ? ' open reactie'
            : ' open reacties'),
    )
  }
  const title =
    'Onderliggende code' +
    (hasApprove ? ' — ' + approve.done + '/' + approve.total + ' regels goedgekeurd' : '') +
    (activityWords.length ? ' — ' + activityWords.join(' + ') : '')
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
//
// `right-3` (not `right-1.5`): CARD_CHROME_PX's ~38-52px chip reserve (see
// its own doc comment above) was tuned against the plain avatar+fraction
// case ("measured up to 62px"). The WIDEST real combo — an AI-warning
// triangle AND an avatar/note icon AND a "+N" remainder AND a done/total
// fraction, all at once — measured ~77-93px, which left only ~3-4px of
// clearance to the card's own right edge on a row near the block's longest
// line (reported: "het labeltje gaat net over de rechterkant heen" with a
// screenshot of exactly this 4-part combo). The absolute-positioned pill can
// never truly cross the card's border (its `right` offset is fixed relative
// to the row, which fills the card), but a few px of clearance reads as
// "touching/crossing" once antialiasing blurs the rounded corner next to it.
// Widening the offset trades a little more overlap onto the code text to its
// left — already-accepted behavior, see CARD_CHROME_PX's own comment — for
// comfortable, consistent clearance from the edge regardless of how many
// segments the pill ends up showing.
function lineSummaryBadge(summary) {
  const p = lineSummaryParts(summary)
  if (!p) return ''
  return ` <span class="select-none absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded bg-white/90 dark:bg-zinc-900/90 px-1 py-0.5 ring-1 ring-slate-200 dark:ring-zinc-700 shadow-sm" data-testid="line-underlying-summary" title="${p.title}">${p.html}</span>`
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

// onBlockMouseDown — a delegated handler on the whole card (<article>, see
// Block()'s own bindings) rather than threading another callback through
// codeDiff/codePane/unifiedCodeDiff/paneHTML's already long positional
// parameter lists: a row div lives inside whichever pane's <code> is
// currently rendered (one in 'fit'/one-sided, two in 'split', one in
// 'unified'), and `data-row` (rowCellHTML, only on the canonical
// metadata-carrying line of a row) already uniquely identifies it regardless
// of which pane/side the click landed on.
//
// Reviewer request: "ik wil dat ik alles kan selecteren als normaal [...] ik
// wil de browser selectie manier gebruiken" — this handler therefore no
// longer resolves a selection itself, and no longer calls `preventDefault()`
// on an ordinary click: the browser's own text selection is left to run (drag,
// native double/triple-click word/line select, a native Shift+click extending
// an existing selection — all of them). It only SEEDS which row/call-segment/
// card the gesture *started* on — `cb` is home.mjs's `beginMouseSelection`,
// null on a card that never wired one up (a preview/testClass card), so this
// is a plain no-op there. The actual resolution (a plain click vs. a real,
// possibly multi-row selection) happens once, on the next `mouseup`, by
// reading `window.getSelection()` — see "Line selection: click and browser
// text selection" in .claude/docs/diff-render.md.
//
// It passes the `data-call-seg` of whichever call-segment span (see
// rowCellHTML's own `callSegs`) the mousedown landed inside, or `null` when it
// didn't — home.mjs's top-level resolveClickSelection uses this to select
// that exact 'call' segment instead of the whole 'line' on a plain click
// (reviewer: "als ik op code druk... call, als ik naast characters klik...
// line"). A drilled column's own beginMouseSelection closure simply never
// passes this through, which is what keeps a drilled column's click
// 'line'-only.
//
// It also passes `e.shiftKey` — a Shift+click is ALWAYS resolved via app
// state (home.mjs's resolveShiftClickSelection), never via the browser's own
// native selection-extend behaviour: this app's diff panes reassign their
// entire `.innerHTML` on every relevant state change, which makes a native
// selection an unreliable anchor to extend from across two separate clicks
// — see "Line selection: click and browser text selection" in
// .claude/docs/diff-render.md.
//
// `onApprove` (opts.onApproveClick, home.mjs's approveClickAt) is checked
// FIRST, before any of the plain row-selection logic above: a click landing
// on one of rowCellHTML's `[data-seg-dot]` markers (a call segment's real
// dot, or its hover-only ring — segDotMarkers/segHoverRingMarkers) never runs
// the ordinary click-select path at all, it dispatches straight to the
// approve action instead. One event, one resolved outcome — never both
// selecting AND approving on the same click, which a second, separately-wired
// `@click` listener firing after this `@mousedown` would otherwise risk. The
// line/group gutter toggles this used to also route (`[data-approve-toggle]`)
// were removed — see rowApproveEnabled's own doc comment. This is the one
// remaining branch that still calls `preventDefault()`/`stopPropagation()` —
// a dot is a small, isolated click target, not a text-selection surface.
function onBlockMouseDown(e, cb, onApprove) {
  if (e.button !== 0) return
  const el = e.target && e.target.closest && e.target.closest('[data-row]')
  if (onApprove && el) {
    const toggleEl = e.target.closest('[data-seg-dot]')
    if (toggleEl) {
      const row = +el.getAttribute('data-row')
      if (!Number.isNaN(row)) {
        e.preventDefault()
        e.stopPropagation()
        const segStart = +toggleEl.getAttribute('data-call-seg')
        onApprove(row, 'call', Number.isNaN(segStart) ? null : segStart)
        return
      }
    }
  }
  if (!cb) return
  if (!el) return
  const i = +el.getAttribute('data-row')
  if (Number.isNaN(i)) return
  const segEl = e.target && e.target.closest && e.target.closest('[data-call-seg]')
  const segStart = segEl ? +segEl.getAttribute('data-call-seg') : null
  cb(i, segStart == null || Number.isNaN(segStart) ? null : segStart, e.currentTarget, e.shiftKey)
}

// onBlockContextMenu — the right-click counterpart of onBlockMouseDown above,
// and this app's one entry point into "the right-click context menu" (see
// command-palette.md) for a diff card. Right-click on a [data-row] resolves
// SYNCHRONOUSLY (unlike a mousedown, a right-click never starts a drag/native
// selection gesture, so there's nothing to defer to mouseup) via `cb`
// (home.mjs's handleRowContextMenu), which returns whether it actually landed
// on a real navigation unit (a changed line/call) — `false` for a click on an
// unchanged/filler line, per resolveClickSelection's own "no landable unit →
// no interaction" rule. Only on `true` do we preventDefault/stopPropagation:
// otherwise the native browser context menu stays (Copy/Look up on ordinary
// read-only code, exactly the reviewer's explicit answer for that case).
//
// A right-click that lands OUTSIDE any row (the card's header, gutter, empty
// space) falls back to `onOpenMenu` — the exact same callback
// blockMenuButton's own click already runs — so right-clicking anywhere on
// the card still reaches the block palette, mirroring "rechtsklik opent
// hetzelfde menu dat Enter op die plek zou openen". `onOpenMenu` is the RAW
// opt (may be undefined for a preview/testClass card that never wires it),
// not the no-op-defaulted `onOpenMenu` local used by blockMenuButton — a card
// with no real menu of its own must leave the native browser menu in place
// here too.
function onBlockContextMenu(e, cb, onOpenMenu) {
  const el = e.target && e.target.closest && e.target.closest('[data-row]')
  if (el) {
    if (!cb) return
    const i = +el.getAttribute('data-row')
    if (Number.isNaN(i)) return
    const segEl = e.target && e.target.closest && e.target.closest('[data-call-seg]')
    const segStart = segEl ? +segEl.getAttribute('data-call-seg') : null
    const handled = cb(i, segStart == null || Number.isNaN(segStart) ? null : segStart, e.clientX, e.clientY)
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
    return
  }
  if (!onOpenMenu) return
  e.preventDefault()
  e.stopPropagation()
  onOpenMenu({ native: true, x: e.clientX, y: e.clientY })
}

// onCallSegHover toggles the `call-seg-hover` marker (index.html's own
// `<style>` gives `.call-seg.call-seg-hover` its actual grey tint) on EVERY
// sub-span of the call-segment the pointer entered/left — not just the one
// element `mouseover`/`mouseout` fired on — because one logical segment can
// render as several adjacent spans (see CALL_HOVER_CLS's own doc comment).
// `mouseover`/`mouseout` (not `mouseenter`/`mouseleave`, which don't bubble)
// delegated on the whole card, same shape as onBlockMouseDown above — always
// wired (no opt-out), since it's a pure CSS class toggle with no side effect
// on `state` at all, unlike the click handler, which stays opt-in per card via
// `cb`.
function onCallSegHover(e, on) {
  if (isSpuriousHover(e)) return
  const el = e.target && e.target.closest && e.target.closest('[data-call-seg]')
  if (!el) return
  const row = el.closest('[data-row]')
  if (!row) return
  const seg = el.getAttribute('data-call-seg')
  row.querySelectorAll('[data-call-seg="' + seg + '"]').forEach((n) => n.classList.toggle('call-seg-hover', on))
}

// disarmRowPairHover/isSpuriousHover — a stationary mouse pointer can still
// fire a genuine (not synthetic) `mouseover`/`mouseout` when the DOM
// underneath it changes shape: a pane's `.innerHTML` is fully replaced on
// every navigation step (a fresh `<div>` per row, see paneHTML/unifiedHTML),
// so a reviewer whose mouse happens to rest anywhere over the diff while
// stepping with the KEYBOARD would otherwise see `onRowPairHover`/
// `onCallSegHover` toggle a class on every such step — a `class` attribute
// mutation on every keystroke, exactly the "flicker" class of bug
// `.claude/rules/arrowjs-pitfalls.md` warns about elsewhere, and measured
// live via `tests/navigate.spec.mjs`'s "only patches the highlight"
// mutation-count assertion.
//
// Same underlying idea as `overview.mjs`'s `hoverEnabled`/`lastMouseX`/
// `lastMouseY` gate (a stationary pointer must not act after a repaint), but
// keyed off COORDINATES rather than event ORDERING: an initial attempt armed
// on the next `mousemove` and disarmed on repaint, trusting that a genuine
// hover is always preceded by its own `mousemove` — false in practice
// (browsers, and Playwright's own `.hover()`, can fire `mouseover` for a
// freshly-entered element BEFORE the `mousemove` to that same position).
// Instead: `disarmRowPairHover()` (called right before a pane's `.innerHTML`
// is rewritten) snapshots the pointer's LAST KNOWN position; `isSpuriousHover`
// compares an incoming mouseover/mouseout's own `clientX`/`clientY` against
// that snapshot — identical coordinates mean the pointer never actually
// moved since the DOM churned underneath it (spurious), different
// coordinates mean a real hover (genuine), regardless of which event fires
// first. `lastPtrX`/`lastPtrY` are kept live by every call (not just
// mousemove), so the snapshot at disarm time is always fresh.
let lastPtrX = null
let lastPtrY = null
let disarmedPtrX = null
let disarmedPtrY = null
function disarmRowPairHover() {
  disarmedPtrX = lastPtrX
  disarmedPtrY = lastPtrY
}
function isSpuriousHover(e) {
  lastPtrX = e.clientX
  lastPtrY = e.clientY
  if (disarmedPtrX === null) return false
  const spurious = e.clientX === disarmedPtrX && e.clientY === disarmedPtrY
  if (!spurious) {
    // A genuine move away confirms the guard already did its job — clear it
    // so a later coincidental return to that exact pixel isn't misjudged.
    disarmedPtrX = null
    disarmedPtrY = null
  }
  return spurious
}

// onRowPairHover toggles `row-pair-hover` (index.html's `.row-pair-hover` —
// the same grey inset bar the plain per-row hover affordance shows) on EVERY
// row sharing the hovered row's `data-row-pair` index, including the row the
// pointer is actually over. The old (left) and new (right) pane are two
// entirely separate <code> elements in a split diff, so hovering one pane's
// row has no way to reach its counterpart in the other pane through CSS
// `:hover` alone — and since only the new/right pane keeps its own native
// `cursor-pointer`/`hover:` classes (the old/left pane is never a click
// target, see "Only the new/right pane drives selection" in
// diff-render.md), the old pane needs this JS-driven class for its OWN
// affordance too, not only to propagate to its counterpart. Delegated the
// same way as onCallSegHover: always wired, a pure CSS class toggle with no
// `state` side effect. Reviewer request: "het moet hover state krijgen als
// nieuw connected ook hovert, en andersom".
function onRowPairHover(e, on) {
  if (isSpuriousHover(e)) return
  const el = e.target && e.target.closest && e.target.closest('[data-row-pair]')
  if (!el) return
  const key = el.getAttribute('data-row-pair')
  const root = e.currentTarget || el.closest('article') || el
  root.querySelectorAll('[data-row-pair="' + key + '"]').forEach((n) => n.classList.toggle('row-pair-hover', on))
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
// in place (see onPaneClick above). `breadcrumb` (optional — only ever set
// for a yaml/yml file, see yamlBreadcrumbsForSegs below) renders as a second,
// smaller line inside the same spacer: the key hierarchy the collapsed run
// sits under, so the reviewer doesn't lose track of "which path/response/…
// am I looking at" once the surrounding structure scrolls out of view.
function collapsedRunHTML(start, end, breadcrumb) {
  const n = end - start + 1
  return (
    `<div class="block cursor-pointer select-none whitespace-pre border-y border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 text-center text-[10px] leading-relaxed text-slate-400 dark:text-zinc-500 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-300"` +
    ` data-collapsed-run="${start}-${end}" data-testid="collapsed-run" title="Klik om deze regels te tonen">` +
    `⋯ ${n} ongewijzigde regels` +
    (breadcrumb
      ? `<div data-testid="collapsed-run-breadcrumb" class="mt-0.5 truncate text-slate-400 dark:text-zinc-500">${escapeHtml(breadcrumb)}</div>`
      : '') +
    `</div>`
  )
}

// ── YAML key-hierarchy breadcrumb for a collapsed run ───────────────────────
// A whole-file yaml/yml fallback block (e.g. an OpenAPI spec) loses the
// surrounding key hierarchy once a long unchanged run of sibling keys gets
// collapsed (see above) — the reviewer sees a changed `description:` line
// with no clue it sits under `paths > /products/{id}/clone > post`. This is
// deliberately NOT a real YAML parser (no volwaardige parser nodig): a plain
// indentation/key tracker is enough to answer "what's the ancestor chain of
// the next visible line" for the flow-mapping-free, `key: value`-per-line
// style every yaml file in this repo actually uses.
//
// YAML_KEY_RE matches a mapping key at the start of a line: optional leading
// indentation + optional `- ` list-item prefix(es), then either a quoted key
// (any characters, including `:`, up to the matching quote — needed for a
// path key like '/products/{id}/clone') or an unquoted key (no `:`/`#`), then
// the `:` that makes it a mapping key. Lines that don't match (comments,
// blank lines, scalar/list-item lines with no key of their own) are ignored
// — they don't change the ancestor stack.
const YAML_KEY_RE = /^(\s*)((?:-\s+)*)(?:(['"])((?:(?!\3).)*)\3|([^\s:#][^:]*?))\s*:(\s|$)/

// yamlRowKey extracts {depth, key} from one row's text via YAML_KEY_RE, or
// null when the row isn't a mapping-key line (comment/blank/valueless list
// item). Shared by the stack-building pass and its next-line lookahead below.
function yamlRowKey(rows, i) {
  if (i < 0 || i >= rows.length) return null
  const r = rows[i]
  const text = r.left != null ? r.left : r.right
  if (text == null) return null
  const m = YAML_KEY_RE.exec(text)
  if (!m) return null
  return { depth: m[1].length + m[2].length, key: m[4] != null ? m[4] : m[5].trim() }
}

// yamlBreadcrumbsForSegs walks every row ONCE, maintaining a depth-ordered
// stack of {depth, key}: a new key pops every stack entry at or above its own
// depth (indentation + `- ` prefix length), then pushes itself. For each skip
// segment it snapshots the ancestor chain of the NEXT (first VISIBLE) row —
// NOT simply the stack right after the segment's last hidden row, because
// that row's own key is a SIBLING of the next line in the common case (both
// at the same depth), not an ancestor. So right before that last hidden row's
// key would be pushed, we peek at the next row's depth and pop anything at or
// above it first — the same pop the main loop would perform anyway once it
// reaches that next row, just done one row early so the snapshot reflects it.
// Returns a Map from `${start}-${end}` to a ' > '-joined breadcrumb string
// (segments with an empty ancestor chain, e.g. top-level, are omitted — no
// breadcrumb to show).
function yamlBreadcrumbsForSegs(rows, segs) {
  const skipEnds = new Set()
  for (const seg of segs) if (seg.skip) skipEnds.add(seg.end)
  if (skipEnds.size === 0) return new Map()
  const out = new Map()
  const stack = []
  for (let i = 0; i < rows.length; i++) {
    if (skipEnds.has(i)) {
      const next = yamlRowKey(rows, i + 1)
      if (next) while (stack.length && stack[stack.length - 1].depth >= next.depth) stack.pop()
      if (stack.length) {
        for (const seg of segs) {
          if (seg.skip && seg.end === i) out.set(seg.start + '-' + seg.end, stack.map((s) => s.key).join(' > '))
        }
      }
    }
    const cur = yamlRowKey(rows, i)
    if (cur) {
      while (stack.length && stack[stack.length - 1].depth >= cur.depth) stack.pop()
      stack.push(cur)
    }
  }
  return out
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
  focused = true,
  lineSummaries = null,
  isYaml = false,
  commentRange = null,
  // emitMeta: threaded straight from codePane — see its own doc comment.
  // false ONLY for the split stand's old/left pane.
  emitMeta = true,
) {
  const parts = []
  const pushRow = (i) => {
    const r = rows[i]
    // Partial call approval: once at least one — but not all — of this row's
    // call segments is approved, every segment gets a dot marker (solid =
    // approved, hollow = waiting) UNDER its own first character, inside the
    // code line itself (see segDotMarkers). Only the side that actually shows
    // the segments draws them — the same canonical side the ✓/💬 use, so this
    // now agrees with emitMeta too — and since they are ::after
    // pseudo-elements they add no row and no width, so both panes stay
    // line-for-line aligned for free.
    const partial = partialCallApproval(rows, i, approved, approvedCalls)
    const approveHere = emitMeta && (sideKey === 'right' || r.right == null)
    const segDots =
      partial && approveHere ? segDotMarkers(sideKey === 'left' ? r.left : r.right, partial) : null
    parts.push(
      rowCellHTML(
        r,
        i,
        sideKey,
        group,
        approved,
        commented,
        wrap,
        focused,
        { commentRange, emitMeta },
        lineSummaries,
        segDots,
      ),
    )
  }
  const plan = collapsePlan(rows, commented)
  if (!plan) {
    for (let i = 0; i < rows.length; i++) pushRow(i)
  } else {
    const breadcrumbs = isYaml ? yamlBreadcrumbsForSegs(rows, plan) : null
    for (const seg of plan) {
      if (seg.skip) parts.push(collapsedRunHTML(seg.start, seg.end, breadcrumbs && breadcrumbs.get(seg.start + '-' + seg.end)))
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
function unifiedRowHTML(
  r,
  i,
  group,
  approved,
  commented,
  focused = true,
  lineSummaries = null,
  segDots = null,
  commentRange = null,
) {
  const paired = r.left != null && r.right != null && !!r.leftMark && !!r.rightMark
  // BOTH lines of a paired row draw the comment-range bar (unlike every other
  // per-row marking here, which is deliberately emitted once): each line is
  // its own box, so leaving the decorative old/upper half out would break the
  // bar into a dashed line instead of the continuous range it must read as.
  const meta = { gutter: true, emitMeta: true, commentRange }
  if (paired) {
    return (
      rowCellHTML(r, i, 'left', group, approved, commented, false, focused, { gutter: true, emitMeta: false, commentRange }, lineSummaries) +
      rowCellHTML(r, i, 'right', group, approved, commented, false, focused, meta, lineSummaries, segDots)
    )
  }
  if (r.right != null) {
    return rowCellHTML(r, i, 'right', group, approved, commented, false, focused, meta, lineSummaries, segDots)
  }
  if (r.left != null) {
    return rowCellHTML(r, i, 'left', group, approved, commented, false, focused, meta, lineSummaries, segDots)
  }
  return ''
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
  focused = true,
  lineSummaries = null,
  isYaml = false,
  commentRange = null,
) {
  const parts = []
  const pushRow = (i) => {
    const r = rows[i]
    // Same per-segment dot markers as paneHTML, on the same "current" side
    // (the new/right line when there is one, else the old/left line of a pure
    // deletion) — which in the unified stand is exactly the line carrying the
    // row's metadata (emitMeta), see unifiedRowHTML.
    const partial = partialCallApproval(rows, i, approved, approvedCalls)
    const segDots = partial ? segDotMarkers(r.right != null ? r.right : r.left, partial) : null
    parts.push(unifiedRowHTML(r, i, group, approved, commented, focused, lineSummaries, segDots, commentRange))
  }
  const plan = collapsePlan(rows, commented)
  if (!plan) {
    for (let i = 0; i < rows.length; i++) pushRow(i)
  } else {
    const breadcrumbs = isYaml ? yamlBreadcrumbsForSegs(rows, plan) : null
    for (const seg of plan) {
      if (seg.skip) parts.push(collapsedRunHTML(seg.start, seg.end, breadcrumbs && breadcrumbs.get(seg.start + '-' + seg.end)))
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
function unifiedCodeDiff(
  rows,
  hintsEnabled,
  activeGroup,
  approvedFn,
  commentedFn,
  approvedCallsFn,
  lineSummaryFn = () => new Map(),
  diffActive = () => false,
  isYaml = false,
  commentRangeFn = () => new Set(),
) {
  return html`
    <div
      class="${'relative flex flex-1 overflow-hidden border-t border-slate-100 dark:border-zinc-800/60 ' +
      diffFloorCls(rows.length)}"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      <div class="no-scrollbar min-h-0 flex-1 overflow-auto" data-pane="new" data-scrollsync @scroll="${syncScroll}">
        <code
          class="language-php m-0 block py-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
          @click="${(e) => onPaneClick(rows, e)}"
          .innerHTML="${() => {
            disarmRowPairHover()
            return unifiedHTML(rows, activeGroup(), approvedFn(), commentedFn(), approvedCallsFn(), diffActive(), lineSummaryFn(), isYaml, commentRangeFn())
          }}"
        ></code>
      </div>
      ${scrollHint('up')}
      ${scrollHint('down')}
    </div>
  `
}

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

// SEG_DOT_* are the per-segment call-approval markers: a small dot drawn just
// UNDER the segment's own first character, via a ::after pseudo-element on that
// character's own span. It lives inside the code line on purpose — the earlier
// version was a separate monospace row below the line that positioned its dots
// with literal leading spaces and a `col = start + 1` step, which assumed a dot
// is exactly one character cell wide (it isn't: ~6px in a ~6.6px cell, so every
// dot after the first drifted left) and could not follow a WRAPPED line at all
// in the `fit` stand. Rendered as ::after it needs no column arithmetic and no
// second row, so it is aligned by construction in every stand.
// An approved segment gets a SOLID dot, a still-waiting one a HOLLOW (ring)
// one, so the strip reads at a glance as progress — shape carries the meaning,
// the emerald tint is decoration on top (the reviewer is colourblind, see
// CLAUDE.md).
const SEG_DOT_BASE =
  "relative after:pointer-events-none after:absolute after:left-0 after:top-[1em] after:h-1.5 after:w-1.5 after:rounded-full after:content-['']"
const SEG_DOT_DONE_CLS = SEG_DOT_BASE + ' after:bg-emerald-500'
const SEG_DOT_TODO_CLS = SEG_DOT_BASE + ' after:border after:border-emerald-500'

// segDotMarkers maps the char index each dot marker sits on -> its class, for
// one partially approved row: the segment's first NON-SPACE character (a dot
// under the indentation of a segment that starts mid-line would read as
// belonging to nothing). `partial` is partialCallApproval's own return value.
function segDotMarkers(text, partial) {
  const map = new Map()
  if (!partial || text == null) return map
  for (const seg of partial.segs) {
    let ci = seg.start
    while (ci < seg.end && /\s/.test(text[ci])) ci++
    if (ci >= text.length) continue
    map.set(ci, partial.approvedStarts.has(seg.start) ? SEG_DOT_DONE_CLS : SEG_DOT_TODO_CLS)
  }
  return map
}

// SEG_DOT_HOVER_CLS is a THIRD segment marker, next to the DONE/TODO dots
// above: a hollow ring that only appears on hover of the row (rowCellHTML's
// `rowApproveEnabled` — `group/row`), for a row that carries no approval at
// all yet (see hoverSegMarks/segHoverRingMarkers below). `after:opacity-0
// group-hover/row:after:opacity-100` is the same hover-reveal Tailwind
// pattern the removed line/group gutter toggles used to use, applied to the
// ::after pseudo-element instead of the element itself. This is the one
// mouse-approve affordance from the original "clickable gutter" cut that
// stayed — the line/group toggles were removed in favour of the command
// palette showing itself on a mouse selection, see
// .claude/docs/command-palette.md.
const SEG_DOT_HOVER_CLS =
  SEG_DOT_BASE + ' after:border after:border-slate-400 dark:after:border-zinc-500 after:opacity-0 group-hover/row:after:opacity-100'

// segHoverRingMarkers is segDotMarkers' mouse-only counterpart: one hollow,
// hover-only ring per call segment, for a row that has real call structure
// (more than one segment) but ISN'T approved at all yet (rowCellHTML only
// calls this when segDots is empty — a partially-approved row already shows
// its real dots, which onBlockMouseDown's `[data-seg-dot]` delegation also
// makes clickable). Same "segment's own first non-space character" placement
// as segDotMarkers, deliberately kept in lockstep with it.
function segHoverRingMarkers(text, callSegs) {
  const map = new Map()
  if (!callSegs || callSegs.length <= 1 || text == null) return map
  for (const seg of callSegs) {
    let ci = seg.start
    while (ci < seg.end && /\s/.test(text[ci])) ci++
    if (ci >= text.length) continue
    map.set(ci, SEG_DOT_HOVER_CLS)
  }
  return map
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
// it carries a del/ins mark and isn't a whitespace-only re-alignment. Exported
// for home.mjs's referenceRows, which needs the exact same "is this row
// changed?" answer to decide which call sites sit on an UNCHANGED line.
export function rowChanged(r) {
  return !!(r.leftMark || r.rightMark) && !wsOnly(r)
}

// UNDERLINE_CLS is the thin underline that marks the *active* call segment when
// the reviewer has drilled navigation down to the finest level (gran === 'call').
// Its colour is the same indigo (#6366f1) as the inset left bar of an active row,
// so "the selected segment within the line" reads as the finest step of the same
// accent.
export const UNDERLINE_CLS = 'underline decoration-2 decoration-[#6366f1] underline-offset-2'

// CALL_HOVER_CLS marks a call-segment as click-selectable at 'call'
// granularity — a grey hover tint, same colour family as the plain-row hover
// bar (rowCellHTML's `#94a3b8`/`#71717a`), adapted from an inset left BAR to a
// background TINT because a segment sits mid-line, not at the row's own left
// edge (see "Line selection: click and browser text selection" in
// .claude/docs/diff-render.md). Reviewer request: "als ik op code druk met
// mijn cursor, dan wil ik het selecteren als call... laat het zien met een
// grijze hover state" — the hover is what tells the reviewer exactly where a
// segment's boundary is, since "on code" vs "beside characters" alone gives
// no visual cue up front.
//
// Deliberately NOT a plain Tailwind `hover:` variant: Prism's own token spans
// (`<span class="token ...">`) interrupt the character stream our own
// per-character overlay (markChars) walks, so one LOGICAL call-segment often
// renders as several ADJACENT DOM spans sharing the same `data-call-seg`
// value (one per Prism token) rather than a single merged span. A bare
// `hover:` class would then only light up whichever ONE sub-span the cursor
// happens to sit over — a couple of characters at a time — defeating the
// whole point of showing the segment's FULL boundary at a glance. `call-seg`
// is therefore a plain marker class with no visual effect of its own; the
// grey tint only applies via `.call-seg.call-seg-hover` (index.html's
// `<style>`, light + the two dark mirrors — see "What can't use a Tailwind
// `dark:` variant" in conventions.md), toggled on EVERY sub-span of the same
// segment together by the delegated `onCallSegHover` below.
const CALL_HOVER_CLS = 'call-seg cursor-pointer rounded-sm'

// callSegAt finds the call-chain segment (rowCallSegments' shape,
// `{start, end}` half-open char ranges) containing character index `pi`, or
// null. `segs` is null for any row/side that isn't call-eligible (only ever
// computed for a NEW/right-side row whose text was actually segmented — see
// rowCellHTML's own `callSegs` and callSegmentsForRow below), so this is a
// no-op everywheres else (the old/left pane never gets a 'call' selection at
// all — reviewer confirmed "oude kant alleen 'line'").
function callSegAt(segs, pi) {
  return segs ? segs.find((s) => pi >= s.start && pi < s.end) || null : null
}

// highlightChanges renders one side of a modified row: Prism-highlighted like any
// line. A real content change no longer gets its own char-level background here
// — the line-level row background (rose/emerald pane tint) already shows what
// changed. The one exception is a whitespace-only re-alignment (`ws`): the row
// itself stays untinted (see paneHTML), so the shifted whitespace still needs
// its own soft marker to be visible at all — see `wsOnly` in blocks-and-ingest.md.
// `underline` is an optional Set of char indices (the active call-segment) that
// gets the indigo underline regardless of `ws`; `segDots` is the optional
// char-index -> class Map of the call-approval dot markers (segDotMarkers).
// `callSegs` (optional, see callSegmentsForRow) wraps each call-chain segment
// in a hoverable, clickable span (CALL_HOVER_CLS + `data-call-seg`) — null for
// the old/left side, where a call selection doesn't exist.
function highlightChanges(r, sideKey, ws, underline, segDots = null, callSegs = null) {
  const text = sideKey === 'left' ? r.left : r.right
  const markCls = ws ? (sideKey === 'left' ? 'bg-rose-200 dark:bg-rose-500/30' : 'bg-emerald-200 dark:bg-emerald-500/30') : ''
  const { leftMarked, rightMarked } = ws ? charDiffSides(r.left, r.right) : {}
  const marked = ws ? (sideKey === 'left' ? leftMarked : rightMarked) : null
  return markChars(
    highlight(text),
    (pi) => {
      const parts = []
      if (marked && marked.has(pi)) parts.push(markCls)
      if (underline && underline.has(pi)) parts.push(UNDERLINE_CLS)
      const dot = segDots && segDots.get(pi)
      if (dot) parts.push(dot)
      if (callSegAt(callSegs, pi)) parts.push(CALL_HOVER_CLS)
      return parts.join(' ')
    },
    (pi) => {
      const seg = callSegAt(callSegs, pi)
      return (segDots && segDots.has(pi) ? ` data-seg-dot="${pi}"` : '') + (seg ? ` data-call-seg="${seg.start}"` : '')
    },
  )
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
// `attrOf(plaintextIndex)` is optional and returns EXTRA attributes for that
// char's span (a leading-space-prefixed string like ` data-seg-dot="8"`, `''`
// for none) — used by the call-approval dot markers, which need a test/query
// hook next to their class. It takes part in the "same span" comparison, so two
// neighbouring chars only share a span when class AND attributes match.
export function markChars(html, classOf, attrOf = null) {
  let out = ''
  let pi = 0 // plaintext index into the original line
  let i = 0
  let open = '' // the class string of the currently-open span ('' = none)
  let openAttr = ''
  const ensure = (cls, attr = '') => {
    if (cls === open && attr === openAttr) return
    if (open || openAttr) out += '</span>'
    open = ''
    openAttr = ''
    if (cls || attr) {
      out += `<span class="${cls}"${attr}>`
      open = cls
      openAttr = attr
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
      ensure(classOf(pi), attrOf ? attrOf(pi) : '')
      out += html.slice(i, to)
      pi++
      i = to
      continue
    }
    ensure(classOf(pi), attrOf ? attrOf(pi) : '')
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
export function unitsFor(rows, gran, extraRows = []) {
  const base = gran === 'line' ? changeLines(rows) : gran === 'call' ? changeCalls(rows) : changeGroups(rows)
  if (!extraRows || extraRows.length === 0) return base
  return withReferenceUnits(base, rows, gran, extraRows)
}

// withReferenceUnits merges "reference" units — landable but NOT approvable —
// into a granularity's ordinary unit list. `extraRows` are row indices that
// carry no change of their own yet are worth standing on anyway: an
// UNCHANGED line that holds a resolved call into underlying code (see
// referenceRows in home.mjs). Reviewer request: "er zijn uitzonderlijke
// situaties waarbij je onderliggende code hebt gelinkt aan regels die niet
// zijn aangepast, zoals bij tests blokken. In dat geval wil ik ook de regel
// kunnen selecteren (niet approven enzo) zodat ik ook naar die onderliggende
// code kan gaan".
//
// Every such unit is tagged **`ref: true`**, which is the ONLY thing that
// makes it different from an ordinary unit — approval never had to learn about
// it, because approval is derived exclusively from changedRows and a reference
// unit contains none (see approveTargetRows/unitFullyApproved in home.mjs).
// A row already covered by a real unit is skipped, so nothing is ever
// duplicated (structurally impossible for group/line — a change run never
// spans an unchanged row — but guarded rather than assumed).
//
// The merged list stays in row order; Array#sort is stable, so a 'call'
// row's own several segment units keep their relative order.
function withReferenceUnits(base, rows, gran, extraRows) {
  const out = base.slice()
  for (const i of extraRows) {
    if (i < 0 || i >= rows.length) continue
    if (base.some((u) => u.start <= i && i <= u.end)) continue
    out.push(referenceUnit(rows, i, gran))
  }
  return out.sort((a, b) => a.start - b.start)
}

// referenceUnit builds the single unit an unchanged row contributes at `gran`.
// At 'group'/'line' that is the plain { start, end } shape every consumer
// already reads. At 'call' it is ONE unit spanning the whole line (never a
// per-segment split like changeCalls does): there is nothing changed on this
// row to zoom into, and callScopeMethods matches a call site's segStart
// against the unit's, which rowCallSegments reports as 0 for a row that isn't
// an `ins` — so a single whole-line segment is exactly what lines up.
function referenceUnit(rows, i, gran) {
  if (gran !== 'call') return { start: i, end: i, ref: true }
  const r = rows[i]
  const useRight = r.right != null
  return {
    start: i,
    end: i,
    ref: true,
    char: true,
    left: useRight ? new Set() : fullSet(r.left || ''),
    right: useRight ? fullSet(r.right) : new Set(),
    segStart: 0,
  }
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

// rowAnchorText returns the text a reviewer actually SEES on a row: the new
// (right) side when the row has one, else the old (left) side of a pure
// deletion. Deliberately keyed off presence rather than displayText's
// `rightMark === 'ins'` test, because this is the exact rule the Go side uses
// (rowDisplayText, blockstats.go) — the two must agree character for character,
// since an approval anchor written here is matched against it after new commits
// land (see approvalAnchors in home.mjs and reanchor.go).
export function rowAnchorText(r) {
  if (!r) return ''
  if (r.right != null) return r.right
  return r.left || ''
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

// isSweepableFillerRow reports whether a changed row is "filler" that
// sweepBracketOnlyForward may silently pull along after an approve action —
// either bracket/punctuation-only (isBracketOnlyRow) OR a completely BLANK
// changed row (rowChanged but !rowHasContent, e.g. a blank line the PR
// inserted between two statements). Both share the same reasoning: there is
// nothing on the row for the reviewer to actually judge, so requiring a
// separate approve step for it is pure friction. Reported case (screenshot):
// approving `$pageData['pageBlocks'] = ...;` left the blank `+` line right
// below it without its own ✓, even though there's nothing to review on that
// blank line either.
//
// This does NOT change what counts toward changedRows/the approve total — a
// bracket-only row already counted before this row was added to the sweep,
// and a blank row is EXCLUDED from changedRows by rowHasContent (see its own
// doc comment) and stays excluded: blockApproved/approveSummary/the server-side
// `total` (blockstats.go) only ever check membership of `changedRows(rows)` in
// `b.approvedRows`, so an extra index that isn't in `changedRows` is simply
// ignored by their `.every()`/`.filter()` calls — it can never make the
// counter or the total run ahead. The ONLY visible effect of sweeping a blank
// row is that its own left-margin checkmark appears (rowCellHTML's
// `isApproved` is purely `changed && approved.has(i)`, it never re-checks
// rowHasContent) — exactly the reported "it should look approved too".
//
// No Go port needed for this reason: blockstats.go's changedRowCount already
// mirrors changedRows/rowHasContent for the TOTAL (and must keep doing so —
// see its own doc comment), but the SWEEP itself only decides which specific
// row indices end up in the client-only b.approvedRows array; it never
// changes what the total counts or how the total is computed, so there is no
// corresponding Go concept to keep in lockstep with (same reasoning
// isBracketOnlyRow's own doc comment already gives).
function isSweepableFillerRow(r) {
  return isBracketOnlyRow(r) || (rowChanged(r) && !rowHasContent(r))
}

// sweepBracketOnlyForward extends a set of just-approved row indices with the
// run of directly FOLLOWING (forward only — never backward, a deliberate
// scope choice) changed rows that are pure filler (isSweepableFillerRow: a
// bracket/punctuation-only row like `});`/`},`, OR a completely blank changed
// row) — approving a line/group also approves the filler row(s) right after
// it, so the reviewer never has to approve those separately. The chain may
// freely MIX both kinds in any order (a blank line followed by a bracket-only
// closer, or vice versa) — isSweepableFillerRow is checked per row, so a run
// of consecutive filler rows of either kind is swept as one, and the chain
// only stops at the first row that is either unchanged (a real gap) or
// carries actual content to review. One-way: only meant to be applied on the
// ADD path of an approve toggle (see toggleApprove in home.mjs) — retracting
// an approval never un-approves an already-swept neighbor, so there is no
// shared-row edge case (a filler row sitting between two independently-
// approved lines) to resolve. `target` must be non-empty; returns it
// unchanged otherwise.
export function sweepBracketOnlyForward(rows, target) {
  if (!target.length) return target
  const set = new Set(target)
  const hi = Math.max(...target)
  for (let j = hi + 1; j < rows.length && isSweepableFillerRow(rows[j]); j++) set.add(j)
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
//
// A PURE DELETION never splits either (isPureDeletionRow: the row's other pane
// stays empty). Reviewer request: "verwijderde regels, waarbij de andere pane
// leeg blijft, moet als group volledig geselecteerd kunnen worden" — a removed
// run of 20 lines used to become four separate 5-row groups, so acknowledging
// one deletion cost four approve actions. There is also nothing to read in
// chunks there: the code is gone, the reviewer judges the removal as a whole.
// The cap still applies to every other run (added/modified code), and an
// unchanged row still breaks the run, so a deletion group never swallows the
// code around it.
const MAX_GROUP = 5
function isPureDeletionRow(r) {
  return !!r.leftMark && r.rightMark !== 'ins'
}
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
    if (!run || (run.end - run.start + 1 >= MAX_GROUP && hasLetter(r) && !isPureDeletionRow(r))) {
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
  return callSegmentsForRow(rows[i])
}

// callSegmentsForRow is rowCallSegments' actual implementation, taking the row
// object directly instead of a (rows, i) pair — rowCellHTML only ever has `r`
// itself on hand (see its own `callSegs`, used for the call-segment hover/click
// affordance), so this avoids threading the whole aligned-rows array through
// for a lookup that only ever reads `rows[i]` anyway.
function callSegmentsForRow(r) {
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
