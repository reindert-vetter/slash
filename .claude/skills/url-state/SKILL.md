---
name: url-state
description: Persist reactive frontend navigation state in the URL query string (via src/urlState.mjs) so a refresh or shared link reopens the exact same spot. Namespaced so extra windows/panels keep their own params alongside the main navigation. Use when adding or debugging refresh-restore / deep-link state, or when a new window/panel needs to survive a reload.
---

# URL-state persistence

Navigatie-positie hoort in de **URL-query-string** te staan, zodat een refresh (of
een gedeelde link) precies terugkomt waar je was. De helper zit in
`src/urlState.mjs`; de hoofd-navigatie bindt 'm in `home.mjs`.

## Waarom query params (en niet localStorage/hash)

- **Deelbaar & bookmarkbaar** — de hele open workspace zit in de URL.
- **Meerdere vensters naast elkaar.** Elk extra venster/paneel krijgt een eigen
  **namespace** (`ns`) zodat zijn params in dezelfde query-string leven zonder te
  botsen: hoofd-navigatie schrijft kale params (`?pr=..&sel=..`), een tweede
  venster b.v. `?pr=..&sel=..&diff.file=..`. Eén URL beschrijft alles.

## API — `bindUrlState(state, fields, { ns } = {})`

Roep het **één keer aan, direct na `reactive(...)` en vóór de eerste render**, zodat
herstelde waarden al in `state` staan. Twee dingen gebeuren:

1. **Restore** — leest alleen de params die in de URL staan (rest houdt zijn eigen
   default in `state`).
2. **Persist** — een arrow.js `watch` schrijft bij elke wijziging terug met
   `history.replaceState` (geen history-spam, Back verlaat de app netjes).

Elk `field` mapt één state-key op één param:

| veld      | betekenis |
|-----------|-----------|
| `key`     | property op het reactive-state object |
| `param`   | param-naam zonder namespace-prefix (default: `key`) |
| `parse`   | `string → value` bij restore (default: identity). Gebruik `num(fallback)` voor getallen |
| `format`  | `value → string` bij schrijven (default: `String`); `null` = param weglaten |
| `default` | waarde die als "leeg" telt → param wordt weggelaten (korte, canonieke URL) |

Voorbeeld (de hoofd-navigatie in `home.mjs`):

```js
import { bindUrlState, num } from './urlState.mjs'

bindUrlState(state, [
  { key: 'pr',       param: 'pr',   parse: num(PR), default: PR },
  { key: 'selected', param: 'sel',  parse: num(0),  default: 0 },
  { key: 'mode',     param: 'mode', default: 'list' },
  { key: 'change',   param: 'chg',  parse: num(0),  default: 0 },
])
```

## Een extra venster/paneel toevoegen

1. Maak zijn eigen `reactive(...)`-state.
2. `bindUrlState(panelState, [...], { ns: 'diff' })` — kies een korte, unieke `ns`.
3. Klaar: zijn params (`diff.<param>`) staan naast de hoofd-navigatie en overleven
   een refresh onafhankelijk.

## Valkuilen (uit de praktijk)

- **Bind vóór de eerste render.** Doe je 't erna, dan heeft de render al de default
  gelezen en flikkert het.
- **Async data laadt later.** Een herstelde `selected`/`change` kan buiten bereik
  vallen tot de blocks/code geladen zijn. Clamp na het laden — zie `loadBlocks`
  (clamp `selected`) en `ensureCode` in `home.mjs` (clamp `change`, en val terug
  naar `mode:'list'` als het herstelde block geen navigeerbare wijzigingen heeft).
- **Kale keys reageren niet als attribuut-waarde** — dit is state-sync, niet arrow's
  attribuut-binding; de gewone arrow.js-regels gelden verder in de templates.
- **`watch` trackt alleen wat je leest.** De `fields.map(f => state[f.key])` in de
  helper is precies wat de dependencies registreert — zet elk veld in de lijst.

## Test

`tests/urlstate.spec.mjs` rijdt de echte app: toetsaanslagen → assert query-string
→ `page.reload()` → assert dat de positie terugkomt (en dat defaults de param weer
opschonen). Kopieer dat patroon voor een nieuw venster.
