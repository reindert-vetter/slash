// urlState.mjs — persist reactive navigation state in the URL query string so a
// browser refresh restores exactly where you were.
//
// Everything is *namespaced* (`ns`): the main navigation writes bare params
// (`?pr=..&sel=..`), and any extra window/panel opened alongside it passes its
// own `ns` so its params live in the same query string without clashing
// (`?pr=..&sel=..&diff.file=..`). One URL therefore describes the whole open
// workspace and reopens it verbatim.

import { watch } from './vendor/arrow.js'

// A field maps one reactive-state key to one query param:
//   key     – property on the reactive state object
//   param   – query-param name without the namespace prefix (defaults to `key`)
//   parse   – string → value when restoring (default: identity string)
//   format  – value → string when writing (default: String); return null to omit
//   default – value treated as "empty"; the param is dropped when state equals it,
//             keeping the URL short and canonical

const withPrefix = (ns) => (ns ? ns + '.' : '')

// bindUrlState restores `fields` from the current URL into `state`, then keeps the
// URL in sync on every change via history.replaceState (no history spam, so Back
// still leaves the app). Call it once, right after creating the reactive state and
// before the first render reads it.
export function bindUrlState(state, fields, { ns = '' } = {}) {
  const prefix = withPrefix(ns)
  const nameOf = (f) => prefix + (f.param || f.key)

  // 1. Restore — only touch keys actually present in the URL, so unspecified
  //    params keep the state's own defaults.
  const incoming = new URLSearchParams(location.search)
  for (const f of fields) {
    const raw = incoming.get(nameOf(f))
    if (raw === null) continue
    const val = f.parse ? f.parse(raw) : raw
    if (val !== undefined) state[f.key] = val
  }

  // 2. Persist — watch re-runs whenever any read key changes. Reading state[f.key]
  //    inside the map is what registers the dependency, so list every field here.
  watch(
    () => fields.map((f) => [f, state[f.key]]),
    (pairs) => {
      const params = new URLSearchParams(location.search)
      for (const [f, val] of pairs) {
        const isDefault = 'default' in f && val === f.default
        const str = f.format ? f.format(val) : String(val)
        if (isDefault || str === null || str === '') params.delete(nameOf(f))
        else params.set(nameOf(f), str)
      }
      const qs = params.toString()
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash)
    },
  )
}

// num is a convenience parser: query params are always strings, this coerces to a
// finite number and falls back to `fallback` for junk ("", "abc", …).
export function num(fallback = 0) {
  return (raw) => {
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
}
