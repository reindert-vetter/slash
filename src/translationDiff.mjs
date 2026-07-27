// translationDiff — parse PHP Laravel translation (lang) files and render them
// as a clean, human-readable overview instead of a raw code diff.
//
// Two render modes (see .claude/rules/blocks-and-ingest.md, "Translation blocks"):
//   1. translationBlockView(old, new)  — a standalone changed lang file (a
//      TRANSLATION block): a CHANGES-ONLY list (added / removed / changed keys,
//      old → new), no unchanged keys.
//   2. translationValueView(code, key, locale) — a resolved trans() child: the
//      CURRENT value of one key in one locale (nl/en/…), no diff; a locale where
//      the key is absent renders a "missing in <locale>" marker.
//   +  translationSiblingView(fileText, keys, locale) — the companion card next
//      to a standalone block: the current values, in a SIBLING locale, of exactly
//      the keys that changed in the primary block (so the reviewer sees whether
//      that locale still needs updating).
//
// The parser is a small, tolerant, quote-aware scanner for `return [ ... ];`
// arrays with 'key' => 'value' | 'key' => [ ...nested... ] entries. It is NOT a
// full PHP parser: it understands nested `[...]` arrays, single/double-quoted
// strings (with escapes), and // # /* */ comments. Legacy `array( ... )` and
// numeric/list arrays are out of v1 scope (plug-and-pay lang files use `[...]`
// with string keys). Values are returned unescaped so they read as plain text.

import { html } from './vendor/arrow.js'

// skipTrivia advances i past whitespace and //, #, /* */ comments.
function skipTrivia(s, i) {
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (s[i] === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (s[i] === '#') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    break
  }
  return i
}

// readString: s[i] is an opening quote. Returns { value, next } with PHP escape
// rules applied (single-quote: only \' and \\; double-quote: the common set).
function readString(s, i) {
  const q = s[i]
  i++
  let out = ''
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      const n = s[i + 1]
      if (q === "'") {
        if (n === "'" || n === '\\') {
          out += n
          i += 2
          continue
        }
        out += '\\'
        i++
        continue
      }
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', $: '$' }
      if (n in map) {
        out += map[n]
        i += 2
        continue
      }
      out += '\\'
      i++
      continue
    }
    if (c === q) return { value: out, next: i + 1 }
    out += c
    i++
  }
  return { value: out, next: i }
}

// readValue parses a value at s[i]: a quoted string, a nested [ ... ] array, or a
// bare scalar token (number/true/false/null/constant) up to the next , or ].
function readValue(s, i) {
  i = skipTrivia(s, i)
  const c = s[i]
  if (c === "'" || c === '"') {
    const r = readString(s, i)
    return { node: { t: 'str', v: r.value }, next: r.next }
  }
  if (c === '[') return readArray(s, i)
  let j = i
  while (j < s.length && s[j] !== ',' && s[j] !== ']') j++
  return { node: { t: 'str', v: s.slice(i, j).trim() }, next: j }
}

// readArray: s[i] is '['. Returns { node:{t:'arr', entries:[{key,node,pos}]}, next }.
// Only string-keyed `'k' => v` entries are captured; anything else is skipped
// gracefully so a stray list entry can't derail the scan. `pos` is the byte
// offset of the entry's own key token (its opening quote) within the text
// this readArray call was invoked on — used by lineOf/translationChangeUnits
// below to anchor a leaf key to its source line, without a full parser.
function readArray(s, i) {
  i++ // past '['
  const entries = []
  for (;;) {
    i = skipTrivia(s, i)
    if (i >= s.length || s[i] === ']') {
      i++
      break
    }
    if (s[i] === "'" || s[i] === '"') {
      const keyPos = i
      const k = readString(s, i)
      let j = skipTrivia(s, k.next)
      if (s[j] === '=' && s[j + 1] === '>') {
        j = skipTrivia(s, j + 2)
        const v = readValue(s, j)
        entries.push({ key: k.value, node: v.node, pos: keyPos })
        i = skipTrivia(s, v.next)
        if (s[i] === ',') i++
        continue
      }
      // A quoted string that is not a key (a bare list value) — skip it.
      i = skipTrivia(s, k.next)
      if (s[i] === ',') i++
      continue
    }
    // A non-string key / list entry — skip one value to stay in sync.
    const v = readValue(s, i)
    i = skipTrivia(s, v.next)
    if (s[i] === ',') i++
    if (v.next >= s.length) break
  }
  return { node: { t: 'arr', entries }, next: i }
}

// flatten turns nested entries into a flat list of { key, val, pos } leaves,
// keys joined with '.' — the same dotted form Laravel's trans('file.a.b')
// uses. `pos` is the leaf's OWN key position (never the position of an
// ancestor array) — a nested value's line is anchored on the innermost key
// that actually carries it, which is exactly the line a reviewer would point
// at in the file.
function flatten(entries, prefix, out) {
  for (const e of entries) {
    const key = prefix ? prefix + '.' + e.key : e.key
    if (e.node.t === 'arr') flatten(e.node.entries, key, out)
    else out.push({ key, val: e.node.v, pos: e.pos })
  }
  return out
}

// parseLangFile parses a whole `return [ ... ];` lang file into a flat
// dotted-key → value Map. Unparseable / no array → empty Map.
export function parseLangFile(text) {
  const src = text || ''
  const r = /return\b/.exec(src)
  const start = r ? r.index + r[0].length : 0
  const open = src.indexOf('[', start)
  if (open < 0) return new Map()
  const node = readArray(src, open).node
  const map = new Map()
  for (const { key, val } of flatten(node.entries, '', [])) map.set(key, val)
  return map
}

// parseLangFileEntries is parseLangFile's positioned sibling: the same flat
// dotted-key list, but as an ARRAY (order preserved) of { key, val, pos }
// leaves instead of a Map — used by translationChangeUnits below to derive a
// source line per key. Unparseable / no array → [].
export function parseLangFileEntries(text) {
  const src = text || ''
  const r = /return\b/.exec(src)
  const start = r ? r.index + r[0].length : 0
  const open = src.indexOf('[', start)
  if (open < 0) return []
  const node = readArray(src, open).node
  return flatten(node.entries, '', [])
}

// lineOf converts a byte offset into a 1-based line number within `text` —
// the same "count the newlines before it" approach relations.go's matchLine
// uses server-side, just in JS.
function lineOf(text, pos) {
  if (pos == null || pos < 0) return null
  let line = 1
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

// parseLangValue parses a single value fragment (what a resolved trans() child
// carries as its code): a quoted scalar, a nested [ ... ] array, or empty.
export function parseLangValue(text) {
  const t = (text || '').trim()
  if (!t) return { empty: true, scalar: null, entries: [] }
  const c = t[0]
  if (c === "'" || c === '"') return { empty: false, scalar: readString(t, 0).value, entries: [] }
  if (c === '[') {
    const node = readArray(t, 0).node
    return { empty: false, scalar: null, entries: flatten(node.entries, '', []) }
  }
  return { empty: false, scalar: t, entries: [] }
}

// translationChanges diffs two lang files by key: added (new only), removed (old
// only), changed (in both, different value). Unchanged keys are dropped.
export function translationChanges(oldText, newText) {
  const o = parseLangFile(oldText)
  const n = parseLangFile(newText)
  const added = []
  const removed = []
  const changed = []
  for (const [k, v] of n) if (!o.has(k)) added.push({ key: k, val: v })
  for (const [k, v] of o) if (!n.has(k)) removed.push({ key: k, val: v })
  for (const [k, v] of n) if (o.has(k) && o.get(k) !== v) changed.push({ key: k, oldVal: o.get(k), newVal: v })
  return { added, removed, changed }
}

// changedKeysOf returns every key touched by a change (added, removed or
// changed) — used to scope the companion sibling card.
export function changedKeysOf(oldText, newText) {
  const { added, removed, changed } = translationChanges(oldText, newText)
  return [...changed.map((c) => c.key), ...added.map((a) => a.key), ...removed.map((r) => r.key)]
}

// translationChangeUnits is translationChanges' per-key NAVIGATION list: one
// unit per changed/added/removed key, in the same order translationBlockView
// renders them (changed, then added, then removed — so a caller's unit index
// matches the visible row order 1-to-1), each carrying the 1-based source
// line(s) the key sits on in oldText/newText (via lineOf, above) — a
// 'changed'/'added' key only exists in newText (newLine), a 'removed' key
// only in oldText (oldLine). Used by Block.mjs's translationRowUnits to map
// each key onto its aligned-diff row (see blockRows) so per-key approve/
// comment can reuse the SAME row-indexed infrastructure as an ordinary code
// block, instead of a parallel system.
export function translationChangeUnits(oldText, newText) {
  const oldEntries = parseLangFileEntries(oldText)
  const newEntries = parseLangFileEntries(newText)
  const oldByKey = new Map(oldEntries.map((e) => [e.key, e]))
  const newByKey = new Map(newEntries.map((e) => [e.key, e]))
  const units = []
  for (const e of newEntries) {
    const o = oldByKey.get(e.key)
    if (o && o.val !== e.val) {
      units.push({ key: e.key, kind: 'changed', oldVal: o.val, newVal: e.val, oldLine: lineOf(oldText, o.pos), newLine: lineOf(newText, e.pos) })
    }
  }
  for (const e of newEntries) {
    if (!oldByKey.has(e.key)) units.push({ key: e.key, kind: 'added', val: e.val, newLine: lineOf(newText, e.pos) })
  }
  for (const e of oldEntries) {
    if (!newByKey.has(e.key)) units.push({ key: e.key, kind: 'removed', val: e.val, oldLine: lineOf(oldText, e.pos) })
  }
  return units
}

// --- render helpers (arrow.js html) ---
//
// Every `class` attribute below is a FULL static literal (never a partial
// `class="${x} more"` interpolation — arrow.js throws "Invalid HTML position"
// on that, see .claude/rules/conventions.md's whole-value rule). Only text
// content and whole sub-templates are interpolated.

// KIND_BADGE — the small uppercase pill per per-key row kind, keyed by
// translationChangeUnits' own `kind` value.
const KIND_BADGE = {
  changed: 'gewijzigd',
  added: 'nieuw',
  removed: 'weg',
}
const KIND_BADGE_CLS = {
  changed: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  added: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  removed: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
}

// translationRowCls — the row's own class, reactive over whether it's the
// unit the reviewer is currently navigated to (indigo ring, same idiom as
// the diff's active-row highlight) — a whole-value function binding (see
// conventions.md), not a partial interpolation.
function translationRowCls(active) {
  return (
    'flex items-center gap-3 px-4 py-2.5 ' +
    (active ? 'bg-indigo-50 shadow-[inset_3px_0_0_#6366f1] dark:bg-indigo-500/10' : '')
  )
}

// translationBlockView — mode 1: a changes-only, per-key NAVIGABLE overview of
// a whole lang file. `units` is Block.mjs's translationRowUnits(b) — the
// ordered (changed, added, removed) per-key list, each already carrying its
// mapped aligned-diff `row` (see blockRows) — so index i here is exactly the
// unit index home.mjs's state.change walks with ↑/↓. `opts.activeIndex()`
// highlights the current unit; `opts.approvedRowSet()` (the SAME Set
// Block.mjs's approvedFn already produces for a normal code block) shows a
// ✓ once a key's row is approved — per-key approve therefore rides entirely
// on the existing row-approval plumbing, no separate state.
export function translationBlockView(units, opts = {}) {
  const activeIndex = opts.activeIndex || (() => null)
  const approvedRowSet = opts.approvedRowSet || (() => new Set())
  const rows = units.map((u, i) => {
    // active/approved are read from within THIS row's OWN nested
    // ${() => ...} bindings below (never resolved once up front, as an
    // earlier version of this did) — translationBlockView itself is only
    // called once per code-load/focus change (the outer slot in Block.mjs
    // that picks TRANSLATION vs. codeDiff), so a plain, synchronous read of
    // activeIndex()/approvedRowSet() here would freeze the highlight at
    // whatever it was on that one render and never move again on ↑/↓ — the
    // same "outer closure vs. nested reactive slot" distinction as
    // codeDiff's own per-row highlight (see conventions.md) and
    // home.mjs's companionCard/activeKeyFn just below.
    const isApproved = () => u.row != null && approvedRowSet().has(u.row)
    // valueEls is an ARRAY of one or two <p> templates — a single `html`` ``
    // tag can only ever hold one root element (two sibling <p>s in one tag,
    // as the 'changed' case needs, throws arrow.js's "Invalid HTML position"
    // — see conventions.md), so each paragraph gets its own tagged template
    // and they're combined via the ordinary keyed-array slot instead.
    const valueEls =
      u.kind === 'changed'
        ? [
            html`<p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-rose-600 line-through dark:text-rose-300/80">${u.oldVal}</p>`.key(
              'old',
            ),
            html`<p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-emerald-700 dark:text-emerald-300">${u.newVal}</p>`.key('new'),
          ]
        : [
            html`<p
              class="${'whitespace-pre-wrap break-words text-sm leading-relaxed ' +
              (u.kind === 'removed' ? 'text-rose-600 line-through dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300')}"
            >
              ${u.val}
            </p>`.key('val'),
          ]
    return html`<div
      class="${() => translationRowCls(activeIndex() === i)}"
      data-testid="translation-row"
      data-active="${() => (activeIndex() === i ? '1' : '0')}"
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="block font-mono text-[11px] text-slate-500 dark:text-zinc-400">${u.key}</span>
          <span class="${'shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ' + KIND_BADGE_CLS[u.kind]}">${KIND_BADGE[u.kind]}</span>
        </div>
        ${valueEls}
      </div>
      <span class="shrink-0 text-[11px] font-bold text-emerald-600 dark:text-emerald-400" title="Goedgekeurd">${() => (isApproved() ? '✓' : '')}</span>
    </div>`.key('u:' + u.kind + ':' + u.key)
  })
  if (rows.length === 0) {
    rows.push(html`<p class="px-4 py-3 text-sm italic text-slate-400 dark:text-zinc-500">geen sleutelwijzigingen</p>`.key('none'))
  }
  return html`<div data-testid="translation-overview" class="flex flex-col divide-y divide-slate-100 dark:divide-zinc-800/60">${rows}</div>`
}

// translationValueView — mode 2: the current value of one resolved key in one
// locale. A key absent in that locale → a "missing" marker.
export function translationValueView(code, key, locale) {
  const v = parseLangValue(code)
  if (v.empty) {
    return html`<p data-testid="translation-missing" class="px-3 py-2 text-[11px] font-medium text-rose-500 dark:text-rose-400">
      ontbreekt in ${locale}
    </p>`
  }
  if (v.scalar != null) {
    return html`<div data-testid="translation-value" class="px-3 py-2">
      <p class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300">${v.scalar}</p>
    </div>`
  }
  const rows = v.entries.map((e) =>
    html`<div class="px-3 py-1.5">
      <span class="block font-mono text-[10px] text-slate-400 dark:text-zinc-500">${e.key}</span>
      <p class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300">${e.val}</p>
    </div>`.key(e.key),
  )
  if (rows.length === 0) {
    rows.push(
      html`<p data-testid="translation-missing" class="px-3 py-2 text-[11px] font-medium text-rose-500 dark:text-rose-400">ontbreekt in ${locale}</p>`.key(
        'none',
      ),
    )
  }
  return html`<div data-testid="translation-value" class="divide-y divide-slate-100 dark:divide-zinc-800/60">${rows}</div>`
}

// translationSiblingView — the companion card: for each key that changed in the
// primary block, the current value in this sibling locale (or a "missing"
// marker), so the reviewer sees whether the sibling still needs updating.
// `activeKeyFn` (optional, a FUNCTION — the companion card is read-only and
// has no cursor of its own, but mirrors the primary nl block's own cursor)
// highlights the row for the SAME key currently selected there, purely as
// visual context — see home.mjs's companionCard. It's read from within this
// row's OWN nested ${() => ...} binding (not resolved once up front) so a
// step only re-evaluates that one row's class/data-active, instead of
// forcing home.mjs's outer DetailPanel closure — which calls this function —
// to depend on the reviewer's navigation cursor (see the comment on
// companionCard/activeKeyFn in home.mjs for why that matters).
export function translationSiblingView(fileText, keys, locale, activeKeyFn = () => null) {
  const map = parseLangFile(fileText)
  const rows = keys.map((k) => {
    const has = map.has(k)
    const rowCls = (active) => (active ? 'bg-indigo-50 shadow-[inset_3px_0_0_#6366f1] dark:bg-indigo-500/10 ' : '') + 'px-4 py-2.5'
    return html`<div
      class="${() => rowCls(activeKeyFn() === k)}"
      data-testid="translation-sibling-row"
      data-active="${() => (activeKeyFn() === k ? '1' : '0')}"
    >
      <span class="block font-mono text-[11px] text-slate-500 dark:text-zinc-400">${k}</span>
      ${has
        ? html`<p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 dark:text-zinc-300">${map.get(k)}</p>`
        : html`<p class="text-sm font-medium text-rose-500 dark:text-rose-400">ontbreekt in ${locale}</p>`}
    </div>`.key(k)
  })
  if (rows.length === 0) {
    rows.push(html`<p class="px-4 py-3 text-sm italic text-slate-400 dark:text-zinc-500">geen gewijzigde sleutels</p>`.key('none'))
  }
  return html`<div data-testid="translation-sibling" class="flex flex-col divide-y divide-slate-100 dark:divide-zinc-800/60">${rows}</div>`
}

// localeOf derives the locale segment from a lang file path
// (resources/lang/<locale>/<file>.php → <locale>). "" if it doesn't look like a
// lang path.
export function localeOf(path) {
  const m = /(?:^|\/)lang\/([^/]+)\//.exec(path || '')
  return m ? m[1] : ''
}
