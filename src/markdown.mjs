// markdown.mjs — a minimal, safe Markdown → HTML renderer for the PR-info
// column (prInfoCard in home.mjs): the Claude-generated summary and the
// GitHub PR body/Jira description are Markdown, but were until now shown as
// a plain escaped string (no headings/lists/links/code rendering).
//
// This is a thin wrapper around the vendored `snarkdown`
// (src/vendor/snarkdown.js, ~1kb), used exactly as it renders out of the
// box: headings, lists, bold/italic/strike, blockquotes, inline code, links,
// images and `---` rules. The only thing layered on top here:
//   - Fenced code blocks are pulled out *before* everything else, tagged with
//     the announced language (see below) and highlighted with Prism via
//     `highlightForLang` (Block.mjs) instead of snarkdown's own bare-escaped
//     `<pre><code>`.
//   - The XSS safety net described below.
//
// Safety: the raw Markdown text is fully HTML-escaped (`escapeHtml`) before
// it reaches snarkdown, so any literal `<script>`/`<img onerror=...>` etc. in
// a PR body becomes inert text instead of live HTML — snarkdown then only
// adds the tags *it* generates from recognised Markdown syntax (it does NOT
// escape arbitrary HTML in the source text itself, only the attribute
// values it builds, e.g. link/image URLs — see the header comment in
// src/vendor/snarkdown.js). Link/image URLs additionally go through
// `sanitizeUrls`, which neutralises `javascript:`/`vbscript:`/
// `data:text/html` schemes as defense in depth (snarkdown's own `encodeAttr`
// already prevents breaking out of the `href="…"`/`src="…"` attribute via a
// quote, since a `"` in the URL is escaped to `&quot;` and can't inject a new
// attribute — so an `<img src>` can never gain an inline `onerror=...`
// handler). Code-fence content is escaped by Prism's `highlight()` (see
// Block.mjs), never by us directly. The combined result is safe to feed into
// arrow.js's `.innerHTML` binding.
//
// One deliberate, narrow exception to "all raw HTML is escaped": a literal
// `<img src alt width height />` tag (GitHub's own drag-and-drop screenshot
// upload writes this instead of `![]()` syntax) is recognised through a
// strict attribute allow-list and re-emitted as a plain image — see
// `extractRawImages` below for the exact safety net.

import snarkdown from './vendor/snarkdown.js'
import { highlightForLang } from './Block.mjs'
import { highlightMentions } from './mentions.mjs'
import { t } from './i18n.mjs'

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Fenced code blocks are pulled out first so their content never gets
// HTML-escaped by us (Prism's highlight() does its own escaping) — running
// escapeHtml over already-Prism-highlighted markup would double-escape it.
// Replaced with a placeholder that survives escapeHtml + snarkdown untouched
// (no markdown-special or HTML-special characters), then substituted back.
//
// The SAME pattern (as a fresh RegExp instance, since `g` regexes carry
// mutable `lastIndex` state across calls) backs `countCodeFences` and
// `annotateFenceNumbers` below, so every caller numbers fences identically —
// load-bearing: a reviewer types "codeblok 3" in the Claude chat meaning the
// SAME block the badge shows, see RelatedPanel.mjs's claudeThreadContextBlock.
const CODE_FENCE_SOURCE = '```[ \\t]*(\\S*)\\n([\\s\\S]*?)\\n```'
const CODE_FENCE_RE = new RegExp(CODE_FENCE_SOURCE, 'g')

// countCodeFences counts the fenced code blocks in `text` without rendering
// anything — used to compute the running start-index for a later message's
// own fences, so numbering is continuous across a whole thread rather than
// resetting to 1 in every bubble.
export function countCodeFences(text) {
  if (!text) return 0
  const re = new RegExp(CODE_FENCE_SOURCE, 'g')
  return (String(text).match(re) || []).length
}

// A ```suggestion fence is GitHub's own convention for "replace the selected
// lines with this" — never a language. Detected case-insensitively; every
// other announced word (or none) is treated as an ordinary language tag.
function isSuggestionLang(lang) {
  return String(lang || '')
    .trim()
    .toLowerCase() === 'suggestion'
}

// fenceLabel is the ONE place that turns (counter, isSuggestion) into display
// text, shared between the visual badge below and the plain-text marker
// `annotateFenceNumbers` puts in front of the same fence for Claude's own
// copy of the context — so the two can never drift apart in wording.
function fenceLabel(counter, isSuggestion) {
  return isSuggestion ? t('Suggestie {n}', { n: counter }) : t('Codeblok {n}', { n: counter })
}

// extractCodeFences renders each fence to a small card: a slim header with
// the running number (`fenceLabel`) plus the announced language (or "php",
// the pre-existing default for an unannounced fence — see
// `highlightForLang`), and the Prism-highlighted code underneath. A
// ```suggestion fence gets a visually distinct header (no language word, a
// "Suggestie N" label and its own accent) instead — per the colorblind rule
// (never colour-only) the WORD "Suggestie" carries the meaning, the accent
// colour is decoration on top.
//
// `class="language-php"` is kept on every `<code>` regardless of the actual
// grammar used to highlight it — this is a CSS *scoping* class, not a claim
// about the language (see the Prism/theming note in
// `.claude/rules/conventions.md`): the token-colour rules in index.html's
// `<style>` are the only place that reads it, and Prism's token names
// (keyword/string/comment/number/operator/…) are shared across every vendored
// grammar, so every fence gets the same colour treatment this way without a
// second CSS block per language.
//
// EVERY fence — including a `suggestion` one, since the reviewer explicitly
// asked for a suggestion to get the same full-size preview as an ordinary code
// example — carries its own data on the WRAPPER `<div data-testid="code-fence">`:
// the RAW code + resolved language word as `data-fence-code`/`data-fence-lang`
// (HTML-entity-encoded via `escapeHtml`, decoded back by the browser's own
// attribute parsing when read via `.dataset`), next to the pre-existing
// `data-fence-index`/`data-fence-suggestion`/`data-fence-truncated`, plus
// `data-fence-label` — the very same "Codeblok N"/"Suggestie N" text the
// header shows (`fenceLabel`), so the preview card below can carry the exact
// name the reviewer reads on the bubble instead of inventing a second one —
// and `data-fence-context` (`fenceContext`, below), a short snippet of the
// chat text that sat directly above this fence, omitted when there was none.
// That is
// the data source `RelatedPanel.mjs`'s `recomputeCodePreviews` reads off the
// DOM for every fence currently rendered in the comment/Claude columns — this
// file has no reactive state of its own (a pure string renderer, see the
// header comment), so reading it straight off the element avoids re-parsing
// the message text elsewhere.
//
// There used to be a `<button data-testid="code-fence-open">Bekijk volledig ↗`
// in the header carrying those two attributes. It was the original click
// target (D2 in claude-chat-panel.md); once the preview column became always-on
// it was a dead button that still opened nothing, so it is REMOVED on explicit
// request ("geen actie nodig") — only its data attributes moved up to the
// wrapper. Don't reintroduce a button here to carry data: the wrapper already
// exists and is the element the preview walks.
// INLINE_MAX_LINES/FADE — see "truncate" below: a truncated fence shows at
// most this many source lines inline (the last one carries the fade mask), so
// a reviewer sees a couple of lines' worth of context, never the full block.
const INLINE_MAX_LINES = 3

// fenceContext(raw) — a short snippet of the chat text that sat directly
// above a fence, for the code-preview card's title (CodePreview.mjs, see
// "A full-size code-preview column" in .claude/docs/claude-chat-panel.md):
// the reviewer asked to see "wat voor tekst erboven stond in de chat" while
// walking the cards, so each card can say what it was about. Only the LAST
// paragraph of the preceding text is used (split on a blank line) — with 2+
// fences in one message, each gets just the paragraph directly above it,
// not the whole message repeated. A few common Markdown decorations
// (heading `#`, a bullet `-`/`*`, `**`/`` ` ``) are stripped since this is a
// plain-text hint, not rendered Markdown, and whitespace/newlines collapse to
// single spaces.
//
// Deliberately NOT cut to a fixed character count with a manually appended
// '…' any more (reviewer report: that made the "…" land well short of a wide
// card's real right edge, or mid-width instead of flush against it). The
// VISIBLE clipping is CSS `truncate` (CodePreview.mjs's context line),
// applied only while the card is collapsed — expanded shows this in full —
// so the cut always lands exactly at the box's own actual edge, whatever
// that happens to be. `FENCE_CONTEXT_SAFETY_MAX` below is a defensive cap
// only, against a pathological single-paragraph wall of text with no blank
// line anywhere above the fence — not the normal truncation mechanism, and
// deliberately not given its own "…" (CSS still clips it the same way).
const FENCE_CONTEXT_SAFETY_MAX = 400
function fenceContext(raw) {
  let t = String(raw || '').trim()
  if (!t) return ''
  const paragraphs = t.split(/\n\s*\n/)
  t = paragraphs[paragraphs.length - 1].trim()
  t = t
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  return t.length > FENCE_CONTEXT_SAFETY_MAX ? t.slice(0, FENCE_CONTEXT_SAFETY_MAX).trimEnd() : t
}

function extractCodeFences(text, store, startIndex, truncate) {
  let counter = startIndex
  // lastEnd tracks where the PREVIOUS fence (or the start of `text`) ended,
  // so `fenceContext` below sees only the text between two fences, never text
  // already attributed to an earlier one — see its own doc comment.
  let lastEnd = 0
  return text.replace(CODE_FENCE_RE, (m, lang, code, offset) => {
    counter += 1
    const rawLang = String(lang || '').trim()
    const suggestion = isSuggestionLang(rawLang)
    const context = fenceContext(text.slice(lastEnd, offset))
    lastEnd = offset + m.length
    // `truncate` (comment/Claude-chat bodies only, see renderMarkdown's own
    // doc comment) caps the INLINE rendering to a couple of lines — the full
    // code is already shown in full size in the code-preview card stacked
    // below the comment/Claude column (see "A full-size code-preview column"
    // in .claude/docs/claude-chat-panel.md), so the inline copy only needs to
    // give a taste, not the whole thing. `data-fence-code` below still carries
    // the FULL raw code regardless — that attribute is what the preview card
    // reads, and must never be shortened.
    const lines = code.split('\n')
    const isLong = truncate && lines.length > INLINE_MAX_LINES - 1
    const visibleCode = isLong ? lines.slice(0, INLINE_MAX_LINES).join('\n') : code
    const highlighted = highlightForLang(visibleCode, suggestion ? '' : rawLang)
    const label = fenceLabel(counter, suggestion)
    const langWord = rawLang && !suggestion ? rawLang.toLowerCase() : suggestion ? '' : 'php'
    const wrapperCls = suggestion
      ? 'my-2 rounded border-2 border-emerald-400 dark:border-emerald-500/60 overflow-hidden'
      : 'my-2 rounded border border-slate-200 dark:border-zinc-700 overflow-hidden'
    const headerCls = suggestion
      ? 'flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border-b border-emerald-200 dark:border-emerald-500/30'
      : 'flex items-center justify-between px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border-b border-slate-200 dark:border-zinc-700'
    // A truncated fence's <pre> gets `code-fence-fade-bottom` (index.html) — a
    // plain mask-image gradient fading the LAST visible line to transparent,
    // the purely visual "there's more, see the full preview below" cue the
    // reviewer asked for instead of a "+N regels" text line. Shape/mask, not
    // colour, per the colourblind rule.
    //
    // `whitespace-pre-wrap break-words` (reviewer report: a TS block's own
    // long lines — type annotations, JSDoc — ran straight off the right edge
    // of the bubble and were silently clipped by the wrapper's own
    // `overflow-hidden`, with no scrollbar and no wrap to show the rest; not
    // TS-specific, any language's long-enough line hit the same clip, TS
    // just gets there sooner). Same fix Footer.mjs already uses for its own
    // long diff lines ("so the entire line is visible without an invisible
    // (no-scrollbar) horizontal scroll" — WIDE_AT there) — applied here
    // UNCONDITIONALLY rather than past a length threshold, since this pane is
    // already narrow (the chat/comment bubble's own `max-w-[92%]`) and
    // deliberately just a few-line "taste" (see `truncate` above): a line
    // that already fits never wraps, so nothing changes for the common case.
    const preCls = 'code m-0 whitespace-pre-wrap break-words' + (isLong ? ' code-fence-fade-bottom' : '')
    const html =
      `<div class="${wrapperCls}" data-testid="code-fence" data-fence-index="${counter}"` +
      `${suggestion ? ' data-fence-suggestion="true"' : ''}${langWord ? ` data-fence-lang="${escapeHtml(langWord)}"` : ''}` +
      `${isLong ? ' data-fence-truncated="true"' : ''} data-fence-label="${escapeHtml(label)}"` +
      `${context ? ` data-fence-context="${escapeHtml(context)}"` : ''}` +
      ` data-fence-code="${escapeHtml(code)}">` +
      `<div class="${headerCls}"><span class="flex items-center">${escapeHtml(label)}` +
      (langWord ? `<span class="ml-2 uppercase tracking-wide">${escapeHtml(langWord)}</span>` : '') +
      `</span></div><pre class="${preCls}"><code class="language-php">${highlighted}</code></pre></div>`
    const token = ` MD${store.length} `
    store.push(html)
    return `\n\n${token}\n\n`
  })
}

function applyPlaceholders(html, store) {
  return html.replace(/ MD(\d+) /g, (m, i) => store[Number(i)] ?? '')
}

// annotateFenceNumbers returns `text` with a plain "[Codeblok N]"/"[Suggestie
// N]" marker line inserted right before each fence — used ONLY for the text
// sent to Claude as invisible context (RelatedPanel.mjs's
// claudeThreadContextBlock), never for display. Uses the exact same
// `fenceLabel` numbering `extractCodeFences` renders into the visual badge,
// so "codeblok 3" means the same block whether the reviewer reads it on
// screen or asks Claude about it.
export function annotateFenceNumbers(text, startIndex = 0) {
  if (!text) return { text: text || '', count: 0 }
  let counter = startIndex
  const annotated = String(text).replace(CODE_FENCE_RE, (m, lang) => {
    counter += 1
    const label = fenceLabel(counter, isSuggestionLang(lang))
    return `[${label}]\n${m}`
  })
  return { text: annotated, count: counter }
}

// Emphasis snarkdown applies but GitHub/CommonMark does NOT
// ---------------------------------------------------------
// snarkdown treats every `_`/`__`/`*`/`**`/`~~` it meets as an emphasis
// delimiter, and its own `flush()` auto-CLOSES whatever is still open at the
// end of the text. Two reviewer-reported bugs came straight out of that, both
// on text nobody wrote as Markdown (an identifier inside a comment, an
// AI-generated risk warning):
//
//   1. `payment_external_id` rendered as payment<em>external</em>id. An
//      intra-word `_` is literal in CommonMark/GitHub — emphasis with `_`
//      never starts or ends inside a word.
//   2. "wat via __toString een volledige datum …" turned EVERYTHING from
//      `toString` to the end of the comment bold: one unpaired `__` that
//      snarkdown opens and never sees closed, then auto-closes at the very
//      end. CommonMark leaves a delimiter that cannot pair as literal text.
//
// Both are fixed the same way: the offending delimiter characters are swapped
// for a private-use placeholder BEFORE snarkdown sees them and swapped back
// straight after (`restoreProtectedChars`), so they end up as plain, visible
// text. Private-use codepoints on purpose: not Markdown-special, not
// HTML-special, so they pass through `escapeHtml` and snarkdown untouched, and
// the swap-back happens before `applyPlaceholders`, so a code fence's
// Prism-highlighted HTML is never scanned for them.
//
// Deliberately NOT done: patching src/vendor/snarkdown.js (vendored verbatim,
// see its header) or implementing CommonMark's full delimiter-run algorithm.
// This is the flanking rule only — enough for both bugs above.
const PROTECT = { _: '\uE000', '*': '\uE001', '~': '\uE002' }
const PROTECTED_RE = /[\uE000-\uE002]/g
const UNPROTECT = { '\uE000': '_', '\uE001': '*', '\uE002': '~' }

// A private-use codepoint that came in with the source text itself would be
// turned into a stray `_`/`*`/`~` by the swap-back, so drop it up front.
function stripProtectedChars(text) {
  return text.replace(PROTECTED_RE, '')
}

// Bug 1: an underscore run with an alphanumeric on BOTH sides is part of the
// word (`payment_external_id`, `a__b`), never emphasis. `_id`/`id_` — only one
// side alphanumeric — are deliberately left alone: those still take part in
// ordinary emphasis pairing below, exactly as CommonMark's flanking rules
// allow. `*` is untouched here, since CommonMark *does* allow intra-word `*`
// emphasis.
function protectIntraWordUnderscores(text) {
  return text.replace(/([A-Za-z0-9])(_+)(?=[A-Za-z0-9])/g, (m, before, run) => before + PROTECT._.repeat(run.length))
}

// The scan for bug 2. An inline code span is consumed as one atom so a
// delimiter inside it is skipped — snarkdown's own tokenizer gets to it first
// too (its `` `([^`].*?)` `` alternative), so it never was emphasis. Kept in
// step with that pattern: single line, at least one character.
const EMPHASIS_SCAN_SOURCE = '`[^`\\n]+`|__|\\*\\*|[_*]|~~'
// `* * *` is a horizontal rule and a leading `* ` is a list bullet — both are
// consumed by an earlier alternative of snarkdown's tokenizer, so neutralising
// them would break the rule/list instead of fixing anything.
const HR_LINE_RE = /^[ \t]*\*([ \t]+\*)+[ \t]*$/
const BLANK_RE = /^[ \t]*$/

function isStructuralAsterisk(text, index, raw) {
  if (raw[0] !== '*') return false
  const start = text.lastIndexOf('\n', index - 1) + 1
  let end = text.indexOf('\n', index)
  if (end < 0) end = text.length
  if (HR_LINE_RE.test(text.slice(start, end))) return true
  return raw === '*' && BLANK_RE.test(text.slice(start, index)) && /^[ \t]/.test(text.slice(index + 1))
}

// neutralizeUnpairedEmphasis walks the delimiters in order and pairs them per
// KIND (`__` only with `__`, `*` only with `*`, …) the way snarkdown's own
// `context` stack does, but with CommonMark's flanking rule on top: a
// delimiter can only OPEN when a non-space follows it and can only CLOSE when a
// non-space precedes it. Whatever is left unpaired — a stack leftover or a
// delimiter that can neither open nor close — becomes literal text.
function neutralizeUnpairedEmphasis(text) {
  const re = new RegExp(EMPHASIS_SCAN_SOURCE, 'g')
  const tokens = []
  let m
  while ((m = re.exec(text))) {
    const raw = m[0]
    if (raw[0] === '`') continue
    if (isStructuralAsterisk(text, m.index, raw)) continue
    tokens.push({ index: m.index, raw })
  }
  if (!tokens.length) return text
  const stacks = new Map()
  const unpaired = new Set()
  for (const tok of tokens) {
    const nextCh = text[tok.index + tok.raw.length] || ''
    const prevCh = text[tok.index - 1] || ''
    const canOpen = nextCh !== '' && !/\s/.test(nextCh)
    const canClose = prevCh !== '' && !/\s/.test(prevCh)
    const stack = stacks.get(tok.raw) || []
    stacks.set(tok.raw, stack)
    if (canClose && stack.length) stack.pop()
    else if (canOpen) stack.push(tok)
    else unpaired.add(tok.index)
  }
  for (const stack of stacks.values()) for (const tok of stack) unpaired.add(tok.index)
  if (!unpaired.size) return text
  let out = ''
  let cursor = 0
  for (const tok of tokens) {
    if (!unpaired.has(tok.index)) continue
    out += text.slice(cursor, tok.index) + PROTECT[tok.raw[0]].repeat(tok.raw.length)
    cursor = tok.index + tok.raw.length
  }
  return out + text.slice(cursor)
}

function restoreProtectedChars(html) {
  return html.replace(PROTECTED_RE, (ch) => UNPROTECT[ch])
}

// Defense in depth: neutralise dangerous URL schemes in href/src attributes.
const UNSAFE_SCHEME_RE = /^\s*(javascript|vbscript|data:text\/html):/i

function sanitizeUrls(html) {
  return html.replace(/(href|src)="([^"]*)"/gi, (m, attr, url) => {
    const decoded = url.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    if (UNSAFE_SCHEME_RE.test(decoded)) return `${attr}="#"`
    return m
  })
}

// extractRawImages — a deliberate, narrow exception to "every raw HTML tag in
// the source is escaped to inert text" (see the XSS header comment at the top
// of this file), for one reviewer-reported case: GitHub's drag-and-drop
// screenshot upload writes a literal `<img width height alt src />` tag into
// the PR body instead of `![]()` Markdown syntax (GitHub itself renders that
// raw HTML natively; we did not, so it showed up as a wall of escaped tag
// text — see the screenshot in the task that added this).
//
// Runs in the SAME extraction slot as `extractCodeFences` — before
// `escapeHtml`, using the SAME placeholder `store`/token mechanism — so an
// `<img>` written *inside* a fenced code block is left alone (already
// consumed as fence content by then) and every placeholder still survives
// `escapeHtml`+snarkdown untouched.
//
// The safety net is a STRICT allow-list, not a parser: only a double-quoted
// `src`/`alt`/`width`/`height` attribute is ever read off the tag — anything
// else (an `onerror=`, an `onload=`, a stray extra attribute) is silently
// dropped, never carried into the output. `src` additionally goes through the
// same `UNSAFE_SCHEME_RE` check `sanitizeUrls` uses below. A tag with no
// recognisable (quoted) `src`, or an unsafe one, is returned UNCHANGED — it
// then falls through to the ordinary `escapeHtml` pipeline exactly as before,
// landing as inert text. This is why the existing
// `<img src=x onerror="alert(1)">` XSS test still passes unchanged: that `src`
// is unquoted, so it is never recognised here.
//
// The tag this function emits is a bare, unstyled `<img src alt width
// height>` — deliberately the same shape snarkdown's own image renderer
// produces for `![]()` syntax — so it needs no styling/lightbox logic of its
// own: `enhanceImages` (below) and `imageLightbox.mjs` see it as an ordinary
// Markdown image once the placeholder is substituted back in, including the
// "2+ images with only whitespace between them" grouping for a run of pasted
// screenshots.
const RAW_IMG_RE = /<img\b([^>]*)\/?>/gi
const RAW_IMG_ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g
const RAW_IMG_ALLOWED_ATTRS = ['src', 'alt', 'width', 'height']

function extractRawImages(text, store) {
  return text.replace(RAW_IMG_RE, (m, attrsStr) => {
    const attrs = {}
    let am
    const attrRe = new RegExp(RAW_IMG_ATTR_RE)
    while ((am = attrRe.exec(attrsStr))) {
      const name = am[1].toLowerCase()
      if (RAW_IMG_ALLOWED_ATTRS.includes(name) && !(name in attrs)) attrs[name] = am[2]
    }
    if (!attrs.src) return m
    const decoded = attrs.src.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    if (UNSAFE_SCHEME_RE.test(decoded)) return m
    let html = `<img src="${escapeHtml(attrs.src)}"`
    if (attrs.alt) html += ` alt="${escapeHtml(attrs.alt)}"`
    if (attrs.width) html += ` width="${escapeHtml(attrs.width)}"`
    if (attrs.height) html += ` height="${escapeHtml(attrs.height)}"`
    html += '>'
    const token = ` MD${store.length} `
    store.push(html)
    return token
  })
}

// enhanceImages — turns snarkdown's bare `<img src alt>` (no styling, no
// click behaviour at all) into something worth looking at: every image gets
// a shared border/rounding + `cursor-zoom-in`, and a RUN of 2 or more images
// with nothing but whitespace between them (no other text/tags — the
// "several screenshots pasted one after another" case: reviewer request,
// "als er meerdere afbeeldingen achter elkaar zijn zonder tekst, laat het
// mooi naast elkaar zien") gets wrapped in a flex row so they sit side by
// side instead of stacking one huge image per line. snarkdown itself never
// wraps a line in a `<p>` (see src/vendor/snarkdown.js — there is no
// paragraph handling at all), so two images on consecutive source lines
// really do end up as `<img>(\s*)<img>` in the output with nothing else
// between them, making this a plain, reliable regex scan rather than a real
// HTML/DOM parse.
//
// `data-md-image` marks every image this function produces, so
// initImageLightbox's delegated click handler (src/imageLightbox.mjs) can
// tell a rendered-markdown screenshot apart from an unrelated `<img>` inside
// the same `.markdown-body` container (in practice there never is one, but
// this is a cheap, explicit guard rather than relying on ancestor scoping
// alone). Runs BEFORE highlightMentions (mentions only ever touches text
// between tags, so order doesn't matter for correctness) and after
// sanitizeUrls, so a neutralised `src="#"` still gets the same treatment.
const IMG_CLASS =
  'max-w-full h-auto rounded-lg border border-slate-200 dark:border-zinc-700 cursor-zoom-in'
// [&_img]: arbitrary-variant overrides ONLY apply inside this wrapper, so a
// solo image (IMG_CLASS alone) keeps its natural, width-capped size while a
// grouped one becomes a fixed-height thumbnail that lines up neatly with its
// siblings — same image tag, same class, no second img class to keep in sync.
const IMG_GROUP_CLASS =
  'flex flex-wrap gap-2 my-2 [&_img]:h-48 [&_img]:w-auto [&_img]:max-w-full [&_img]:flex-shrink-0 [&_img]:object-cover'
const IMG_TAG_RE = /<img\b([^>]*)>/gi
const IMG_RUN_RE = /(?:<img\b[^>]*>\s*){2,}/g

function enhanceImages(html) {
  let out = html.replace(IMG_TAG_RE, (m, attrs) => `<img class="${IMG_CLASS}" data-md-image="true"${attrs}>`)
  out = out.replace(IMG_RUN_RE, (run) => `<div class="${IMG_GROUP_CLASS}">${run.trim()}</div>`)
  return out
}

// hardBreaks(text) -> the same text with every SINGLE newline turned into a
// Markdown hard break (two trailing spaces), so a line the author typed on its
// own stays on its own line. Markdown collapses a single newline into a space,
// which is right for prose written in a Markdown editor but wrong for a chat
// message: a reviewer pressing Shift+Enter in the Claude composer saw their
// two lines render as one running sentence (snarkdown's tokenizer only emits
// `<br />` for `  \n`/`\n\n`, see src/vendor/snarkdown.js's TAGS).
//
// Applied by the CALLER, before renderMarkdown — which keeps it in front of
// every step inside it (escaping, the fence extraction, highlightMentions) and
// leaves every other render point (comment bodies, the PR description) exactly
// as it was. A blank line still means a paragraph break: the regex only
// matches a newline that is neither preceded nor followed by another one.
// Fenced blocks are split out first so their own lines never gain stray
// trailing spaces.
export function hardBreaks(text) {
  if (!text) return ''
  return String(text)
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('')
}

// renderMarkdown(text, startIndex, truncate) -> safe HTML string, meant for
// arrow.js's `.innerHTML="${() => renderMarkdown(...)}"` binding. `startIndex`
// (default 0, i.e. the first fence in `text` is numbered 1) lets a caller
// continue the running code-block count across several messages instead of
// resetting to 1 in every bubble — see `countCodeFences` above.
//
// `truncate` (default false) caps every fence's INLINE code to a couple of
// lines with a fade on the last one (see `extractCodeFences`'s own comment) —
// on, ONLY for comment/Claude-chat bodies (`RelatedPanel.mjs`'s `commentBody`,
// `ClaudeChat.mjs`'s bubble renderers), where the full code is already shown
// in full size in the code-preview card below (see "A full-size code-preview
// column" in .claude/docs/claude-chat-panel.md) — everywhere else (the PR
// summary/description in `prInfoCard`, the task-inbox description) there is no
// such card to point at, so those keep the untruncated, pre-existing
// rendering (the default `false`).
export function renderMarkdown(text, startIndex = 0, truncate = false) {
  if (!text) return ''
  const store = []
  let src = String(text)
  src = extractCodeFences(src, store, startIndex, truncate)
  src = extractRawImages(src, store)
  src = escapeHtml(src)
  // Keep snarkdown away from the two emphasis cases it gets wrong (an
  // intra-word `_`, an unpairable `**`/`__`) — see the block comment above
  // `PROTECT`. The swap-back sits right after snarkdown and BEFORE
  // applyPlaceholders, so a fence's Prism HTML is never touched.
  src = stripProtectedChars(src)
  src = protectIntraWordUnderscores(src)
  src = neutralizeUnpairedEmphasis(src)
  let out = snarkdown(src)
  out = restoreProtectedChars(out)
  out = applyPlaceholders(out, store)
  out = sanitizeUrls(out)
  out = enhanceImages(out)
  // Last: highlight an @mention of the local reviewer (see mentions.mjs). Runs
  // on the finished, already-escaped HTML and only ADDS a <mark> around inert
  // text, so it can't undermine the XSS layer above — and being here means
  // every render point (comment bodies, PR description, chat bubbles) gets it
  // without a signature change.
  out = highlightMentions(out)
  return out
}
