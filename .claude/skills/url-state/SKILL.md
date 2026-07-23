---
name: url-state
description: Persist reactive frontend navigation state in the URL query string (via src/urlState.mjs) so a refresh or shared link reopens the exact same spot. Namespaced so extra windows/panels keep their own params alongside the main navigation. Use when adding or debugging refresh-restore / deep-link state, or when a new window/panel needs to survive a reload.
---

# URL-state persistence

Navigation position belongs in the **URL query string**, so a refresh (or a
shared link) returns exactly to where you were. The helper lives in
`src/urlState.mjs`; the main navigation binds it in `home.mjs`.

## Why query params (and not localStorage/hash)

- **Shareable & bookmarkable** — the whole open workspace sits in the URL.
- **Multiple windows side by side.** Every extra window/panel gets its own
  **namespace** (`ns`) so its params live in the same query string without
  colliding: the main navigation writes bare params (`?pr=..&sel=..`), a
  second window e.g. `?pr=..&sel=..&diff.file=..`. One URL describes
  everything.

## API — `bindUrlState(state, fields, { ns } = {})`

Call it **once, right after `reactive(...)` and before the first render**, so
restored values are already in `state`. Two things happen:

1. **Restore** — reads only the params present in the URL (the rest keeps
   its own default in `state`).
2. **Persist** — an arrow.js `watch` writes back on every change with
   `history.replaceState` (no history spam, Back leaves the app cleanly).

Each `field` maps one state key to one param:

| field     | meaning |
|-----------|---------|
| `key`     | property on the reactive-state object |
| `param`   | param name without the namespace prefix (default: `key`) |
| `parse`   | `string → value` on restore (default: identity). Use `num(fallback)` for numbers |
| `format`  | `value → string` on write (default: `String`); `null` = omit the param |
| `default` | value that counts as "empty" → the param is omitted (short, canonical URL) |

Example (the main navigation in `home.mjs`):

```js
import { bindUrlState, num } from './urlState.mjs'

bindUrlState(state, [
  { key: 'pr',       param: 'pr',   parse: num(PR), default: PR },
  { key: 'selected', param: 'sel',  parse: num(0),  default: 0 },
  { key: 'mode',     param: 'mode', default: 'list' },
  { key: 'change',   param: 'chg',  parse: num(0),  default: 0 },
])
```

## Adding an extra window/panel

1. Create its own `reactive(...)` state.
2. `bindUrlState(panelState, [...], { ns: 'rel' })` — pick a short, unique `ns`.
3. Done: its params (`rel.<param>`) sit alongside the main navigation and
   survive a refresh independently.

`RelatedPanel` really does this (`src/RelatedPanel.mjs`): it binds its own
`cs` cursor under `ns:'rel'` (`focus`→`rel.foc`, `codeSel`→`rel.code`,
`sel`→`rel.csel`, `threadPos`→`rel.thr`) so a refresh puts you back on the
same Underlying-code child / the same comment thread. See there for a
complete example including the async-clobber solution below.

## Pitfalls (from practice)

- **Bind before the first render.** Do it after, and the render has already
  read the default, causing a flicker.
- **Async data loads later.** A restored `selected`/`change` can fall out of
  range until the blocks/code are loaded. Clamp after loading — see
  `loadBlocks` (clamps `selected`) and `ensureCode` in `home.mjs` (clamps
  `change`, and falls back to `mode:'list'` if the restored block has no
  navigable changes).
- **The mirror `watch` wipes restored params while loading.** If your state
  gets overwritten by an async data push after the restore (e.g. a
  clamp-to-0 while the data is still empty), the `watch` immediately mirrors
  that reset to the URL and you lose the restored value before you could use
  it. Solution (see `RelatedPanel.applyRelRestore`): **snapshot** the
  restored values after `bindUrlState` into a separate `restorePending`, and
  reapply them **once, clamped**, once the data is in (at the end of the
  load functions). Only restore a position if its target really exists, and
  clear the snapshot afterward so later navigation isn't hijacked.
- **Bare keys don't react as attribute values** — this is state sync, not
  arrow's attribute binding; arrow.js's regular rules still apply elsewhere
  in the templates.
- **`watch` only tracks what you read.** The `fields.map(f => state[f.key])`
  in the helper is exactly what registers the dependencies — put every field
  in the list.

## Test

`tests/urlstate.spec.mjs` drives the real app: keystrokes → assert query
string → `page.reload()` → assert that the position comes back (and that
defaults clean the param up again). Copy this pattern for a new window.
