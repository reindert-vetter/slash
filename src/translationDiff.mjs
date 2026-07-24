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

// readArray: s[i] is '['. Returns { node:{t:'arr', entries:[{key,node}]}, next }.
// Only string-keyed `'k' => v` entries are captured; anything else is skipped
// gracefully so a stray list entry can't derail the scan.
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
      const k = readString(s, i)
      let j = skipTrivia(s, k.next)
      if (s[j] === '=' && s[j + 1] === '>') {
        j = skipTrivia(s, j + 2)
        const v = readValue(s, j)
        entries.push({ key: k.value, node: v.node })
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

// flatten turns nested entries into a flat list of { key, val } leaves, keys
// joined with '.' — the same dotted form Laravel's trans('file.a.b') uses.
function flatten(entries, prefix, out) {
  for (const e of entries) {
    const key = prefix ? prefix + '.' + e.key : e.key
    if (e.node.t === 'arr') flatten(e.node.entries, key, out)
    else out.push({ key, val: e.node.v })
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

// --- render helpers (arrow.js html) ---
//
// Every `class` attribute below is a FULL static literal (never a partial
// `class="${x} more"` interpolation — arrow.js throws "Invalid HTML position"
// on that, see .claude/rules/conventions.md's whole-value rule). Only text
// content and whole sub-templates are interpolated.

// translationBlockView — mode 1: a changes-only overview of a whole lang file.
export function translationBlockView(oldText, newText) {
  const { added, removed, changed } = translationChanges(oldText, newText)
  const rows = []
  for (const c of changed) {
    rows.push(
      html`<div class="px-4 py-2.5" data-testid="translation-row">
        <div class="flex items-baseline justify-between gap-2">
          <span class="block font-mono text-[11px] text-slate-500 dark:text-zinc-400">${c.key}</span>
          <span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">gewijzigd</span>
        </div>
        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-rose-600 line-through dark:text-rose-300/80">${c.oldVal}</p>
        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-emerald-700 dark:text-emerald-300">${c.newVal}</p>
      </div>`.key('c:' + c.key),
    )
  }
  for (const a of added) {
    rows.push(
      html`<div class="px-4 py-2.5" data-testid="translation-row">
        <div class="flex items-baseline justify-between gap-2">
          <span class="block font-mono text-[11px] text-slate-500 dark:text-zinc-400">${a.key}</span>
          <span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">nieuw</span>
        </div>
        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-emerald-700 dark:text-emerald-300">${a.val}</p>
      </div>`.key('a:' + a.key),
    )
  }
  for (const r of removed) {
    rows.push(
      html`<div class="px-4 py-2.5" data-testid="translation-row">
        <div class="flex items-baseline justify-between gap-2">
          <span class="block font-mono text-[11px] text-slate-500 dark:text-zinc-400">${r.key}</span>
          <span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">weg</span>
        </div>
        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-rose-600 line-through dark:text-rose-300">${r.val}</p>
      </div>`.key('r:' + r.key),
    )
  }
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
export function translationSiblingView(fileText, keys, locale) {
  const map = parseLangFile(fileText)
  const rows = keys.map((k) => {
    const has = map.has(k)
    return html`<div class="px-4 py-2.5" data-testid="translation-sibling-row">
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
