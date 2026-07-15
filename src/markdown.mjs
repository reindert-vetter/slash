// markdown.mjs — a minimal, safe Markdown → HTML renderer for the PR-info
// column (prInfoCard in home.mjs): the Claude-generated summary and the
// GitHub PR body/Jira description are Markdown, but were until now shown as
// a plain escaped string (no headings/lists/links/code rendering).
//
// This is a thin wrapper around the vendored `snarkdown`
// (src/vendor/snarkdown.js, ~1kb), used exactly as it renders out of the
// box: headings, lists, bold/italic/strike, blockquotes, inline code, links,
// images and `---` rules. The only thing layered on top here:
//   - Fenced code blocks are pulled out *before* everything else and
//     highlighted with the same Prism `highlight()` used by the diff panes
//     (Block.mjs) instead of snarkdown's own bare-escaped `<pre><code>`.
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
import { highlight } from './Block.mjs'

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
const CODE_FENCE_RE = /```[ \t]*(\S*)\n([\s\S]*?)\n```/g

function extractCodeFences(text, store) {
  return text.replace(CODE_FENCE_RE, (m, lang, code) => {
    const html = `<pre class="code"><code class="language-php">${highlight(code)}</code></pre>`
    const token = ` MD${store.length} `
    store.push(html)
    return `\n\n${token}\n\n`
  })
}

function applyPlaceholders(html, store) {
  return html.replace(/ MD(\d+) /g, (m, i) => store[Number(i)] ?? '')
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

// renderMarkdown(text) -> safe HTML string, meant for arrow.js's
// `.innerHTML="${() => renderMarkdown(...)}"` binding.
export function renderMarkdown(text) {
  if (!text) return ''
  const store = []
  let src = String(text)
  src = extractCodeFences(src, store)
  src = escapeHtml(src)
  let out = snarkdown(src)
  out = applyPlaceholders(out, store)
  out = sanitizeUrls(out)
  return out
}
