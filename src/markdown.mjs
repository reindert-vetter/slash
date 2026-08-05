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

import snarkdown from './vendor/snarkdown.js'
import { highlightForLang } from './Block.mjs'
import { highlightMentions } from './mentions.mjs'

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
  return isSuggestion ? `Suggestie ${counter}` : `Codeblok ${counter}`
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
// Every non-suggestion fence also gets a native `<button
// data-testid="code-fence-open">` in its header — no longer a click target
// (see "A full-size code-preview column" in claude-chat-panel.md: the
// standalone code-preview column is always on, not opened by clicking), but
// still the data source `RelatedPanel.mjs`'s `recomputeCodePreviews` reads
// off the DOM for every fence currently rendered in the comment/Claude
// columns. The button carries the RAW code + resolved language word as
// `data-fence-code`/`data-fence-lang` (HTML-entity-encoded via `escapeHtml`,
// decoded back by the browser's own attribute parsing when read via
// `.dataset`) — this file has no reactive state of its own (a pure string
// renderer, see the header comment), so reading it straight off the button
// avoids re-parsing the message text elsewhere. A `suggestion` fence gets no
// button: it is GitHub's own "replace these lines" convention, not a
// general code example to preview/compare.
function extractCodeFences(text, store, startIndex) {
  let counter = startIndex
  return text.replace(CODE_FENCE_RE, (m, lang, code) => {
    counter += 1
    const rawLang = String(lang || '').trim()
    const suggestion = isSuggestionLang(rawLang)
    const highlighted = highlightForLang(code, suggestion ? '' : rawLang)
    const label = fenceLabel(counter, suggestion)
    const langWord = rawLang && !suggestion ? rawLang.toLowerCase() : suggestion ? '' : 'php'
    const wrapperCls = suggestion
      ? 'my-2 rounded border-2 border-emerald-400 dark:border-emerald-500/60 overflow-hidden'
      : 'my-2 rounded border border-slate-200 dark:border-zinc-700 overflow-hidden'
    const headerCls = suggestion
      ? 'flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border-b border-emerald-200 dark:border-emerald-500/30'
      : 'flex items-center justify-between px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border-b border-slate-200 dark:border-zinc-700'
    const openButton = suggestion
      ? ''
      : `<button type="button" class="ml-2 shrink-0 rounded border border-slate-300 dark:border-zinc-600 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700" ` +
        `data-testid="code-fence-open" data-fence-code="${escapeHtml(code)}" data-fence-lang="${escapeHtml(langWord)}">Bekijk volledig ↗</button>`
    const html =
      `<div class="${wrapperCls}" data-testid="code-fence" data-fence-index="${counter}"` +
      `${suggestion ? ' data-fence-suggestion="true"' : ''}${langWord ? ` data-fence-lang="${escapeHtml(langWord)}"` : ''}>` +
      `<div class="${headerCls}"><span class="flex items-center">${escapeHtml(label)}` +
      (langWord ? `<span class="ml-2 uppercase tracking-wide">${escapeHtml(langWord)}</span>` : '') +
      `</span>${openButton}</div><pre class="code m-0"><code class="language-php">${highlighted}</code></pre></div>`
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

// Defense in depth: neutralise dangerous URL schemes in href/src attributes.
const UNSAFE_SCHEME_RE = /^\s*(javascript|vbscript|data:text\/html):/i

function sanitizeUrls(html) {
  return html.replace(/(href|src)="([^"]*)"/gi, (m, attr, url) => {
    const decoded = url.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    if (UNSAFE_SCHEME_RE.test(decoded)) return `${attr}="#"`
    return m
  })
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

// renderMarkdown(text, startIndex) -> safe HTML string, meant for arrow.js's
// `.innerHTML="${() => renderMarkdown(...)}"` binding. `startIndex` (default
// 0, i.e. the first fence in `text` is numbered 1) lets a caller continue the
// running code-block count across several messages instead of resetting to 1
// in every bubble — see `countCodeFences` above.
export function renderMarkdown(text, startIndex = 0) {
  if (!text) return ''
  const store = []
  let src = String(text)
  src = extractCodeFences(src, store, startIndex)
  src = escapeHtml(src)
  let out = snarkdown(src)
  out = applyPlaceholders(out, store)
  out = sanitizeUrls(out)
  // Last: highlight an @mention of the local reviewer (see mentions.mjs). Runs
  // on the finished, already-escaped HTML and only ADDS a <mark> around inert
  // text, so it can't undermine the XSS layer above — and being here means
  // every render point (comment bodies, PR description, chat bubbles) gets it
  // without a signature change.
  out = highlightMentions(out)
  return out
}
