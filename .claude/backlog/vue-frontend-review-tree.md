# Backlog: make a Vue frontend PR reviewable as a tree

**Status: planned, not started.** The open questions this note used to end with
have been answered (see "Answered design decisions" below) and the phased plan
is written out. No phase has landed yet. Nothing here is code.

Reference PR: <https://github.com/plug-and-pay/plug-and-pay/pull/12112>
Reference file:
`resources/admin/src/views/settings/plugins/partials/google-merchant-center/GoogleMerchantCenterModal.vue`

Today the pipeline is PHP-only (see `.claude/docs/blocks-and-ingest.md`): a PR
becomes function/method-level blocks via the PHP scanner. A `.vue` file falls
straight into `wholeFileBlock` (every non-`.php` file does), so such a PR is one
undifferentiated blob and effectively unreviewable in the tree. Everything below
is about closing that gap.

## What should become visible

### 1. The HTML/template is a first-class block

The template must be shown **in full** — not summarised, not trimmed to changed
hunks. It is the anchor the rest of the structure hangs off.

### 2. Constants become blocks, and blocks nest under other blocks

A constant is a block of its own, and can appear as **Underlying code** under
another block — under a script block, or under the HTML that uses it. Same
"child card" mechanism as the existing PHP call resolution
(`.claude/docs/underlying-code.md`).

### 3. A template call resolves to its handler

```html
<BaseButton :loading="saving" :label="$t('_base.save')" @click="saveSettings(context.value)" />
```

`saveSettings` is a call. It should resolve to the function that implements it
and appear as Underlying code beneath this line — the Vue equivalent of the
existing `resolve_call` workflow (`.claude/docs/workflows-analysis.md`).

### 4. Translations are linked

`$t('...')` keys should resolve to their translation entries, so the reviewer
sees the actual copy instead of a key. Applies to labels, help texts, and
anything else routed through `$t`.

### 5. A form field carries its whole chain, frontend through backend

```html
<FormKit
  :label="$t('settings.plugins.google_merchant_center.wizard.brand.label')"
  :help="$t('settings.plugins.google_merchant_center.wizard.brand.help')"
  name="gmc_brand"
  type="text"
  validation="required"
/>
```

A field like this ends up at the backend. Under such a field the reviewer wants
to see, as Underlying code:

- **What the frontend does to the value before sending it** — any transform,
  mapping, or normalisation between the input and the request payload.
- **The Laravel rules that validate it** on the backend. There can be more than
  one; show all of them, not just the first match.

### 6. A request call expands into request → controller → resource

Around `useFetchPost` (and its siblings), show as Underlying code:

- the **request** class,
- the **resource**,
- and, **when the controller was changed in this PR**, the controller —
  positioned *between* request and resource, matching the real call order.

### 7. Error handling deserves extra weight in the AI warnings

The AI risk check (`code_warning`, see `.claude/docs/workflows-analysis.md`)
should pay particular attention to error handling in this kind of code.

### 8. A value in the template gets a summary card, visible only in the selection

Added after the original note (Reindert): the **submit** gets real underlying
blocks — the whole chain of item 3 + 6 — but a **value inside the HTML** gets
something smaller: one **summary card** showing *how that value is modified*.
And that card is **only visible while the value is in the reviewer's
selection**. Full design in phase 5 below.

## Answered design decisions

These replace the "open questions" this note used to end with. Each is decided,
not a suggestion.

### How does a `.vue` file get scanned into blocks?

A new scanner `vuescan.go` next to `phpscan.go`, hooked into `ScanBlocks`'
dispatch. Not a real parser — the same lexer style as `phpscan.go`: split the
SFC into top-level sections, then split `<script setup>` into its top-level
declarations. Details in phase 1.

### What is a "block" in a template?

The **whole** `<template>` section, one block — it is the anchor (item 1). Not
per component tag, not per section. Individual tags/values become *children*
(Underlying code), never blocks of their own.

### How do the frontend-to-backend links get resolved?

A mixture, fixed per link type — static where it can be deterministic, LLM only
where it genuinely can't:

- **Static (Go, free, deterministic):** template identifier → script block in
  the same file; component tag → imported `.vue` path (the `import` map plus the
  `@` → `resources/admin/src/` alias); `$t('key')`/`t('key')` →
  `resources/admin/src/locales/{nl,en}.json` (a JSON path walk, sibling of the
  existing `sliceLangKey`); `useFetchPost/Put/Show/Delete("<path>")` → route
  file (`routes/api*.php`, `routes/client/web.php`) → controller method.
- **LLM (via the existing `resolve_call` escalation — Go writes
  `status=unresolved`, the LLM pass answers):** only "field name → the Laravel
  validation rules" and "what does the frontend do to the value before sending
  it" (phase 6).
- Every static row carries a real file+line. No LLM claim without a source —
  same line as the existing `related-covers-warning`: rather a warning than a
  guess.

### Does this reuse `build_relations`/`resolve_call`?

Yes, almost entirely. **No new Workflow Type.**

- Blocks: `ingest`/`scanAndStoreBlocks` unchanged apart from the new scanner.
- Children: new **`callresolve` rows with new `Kind`s**, emitted by new
  resolvers appended in the **existing** `buildRelations` Activity, right next
  to `resolveTranslations`/`resolveConfigCalls`/`resolveClassMembers`. That
  gives `UpsertGo`/`Prune`/`GET /api/callresolve`/the RelatedPanel cards/
  drilling/approval/the SSE invalidation **for free**.
- LLM: the existing `resolve_call` workflow (`unresolved` → search).
- The `relations` module is deliberately **not** used here: its kinds are
  Laravel-shaped and both parent and child must be PR blocks, while a Vue child
  often lives in an unchanged file — callresolve's read-only-leaf shape
  (`ChildCode` embedded in the row, like `translation`/`const_ref`/
  `config_value`) fits that exactly.

### Which file types?

`.vue` **and** `.ts`/`.js`/`.mjs` (phase 1c). `.json` — including the locale
files — stays a whole-file block; phase 3 surfaces its values as translation
children instead.

### Is the summary card of item 8 also for PHP blocks?

No. Vue/frontend only.

## Phased plan

Each phase lands on its own. Do not attempt this as one change.

### Phase 1 — a `.vue` becomes real blocks (Go)

`vuescan.go`, hooked into `ScanBlocks`' dispatch:

1. Split the SFC into top-level sections (`<template>`, `<script[ setup]>`,
   `<style>`) at column 0.
2. `<template>` → **one** block.
3. `<script setup>` → every top-level declaration its own block:
   `function NAME`, `const NAME = (…) => {…}`, `const NAME = computed(…)`,
   `const NAME = ref(…)` — brace/paren-balanced to its end.
4. Everything in the script belonging to no declaration (imports, `interface`,
   `defineEmits`, loose statements) → one `<script-header>` sentinel block,
   the pattern of `<class-header>`.
5. `<style>` → one block.

`Class` = the component name (basename without extension), so labels read
`GoogleMerchantCenterModal::saveSettings`. New category `COMPONENT`.

**Hard invariant, with its own test: the emitted blocks TILE the file** — every
line belongs to exactly one block. This is the Blade lesson from
`.claude/docs/blocks-and-ingest.md` ("≥1 block is no proof the file was
understood"); without it a changed line silently disappears from the tree.

### Phase 1b — highlighting, and no trim for the template (frontend, small)

The diff panes always call `highlight(code)` (i.e. php). Thread one
`langForFile(file, blockName)` through it: a template → `markup`, a script block
→ `typescript` (both grammars are already vendored, `highlightForLang` already
exists).

Plus: the template block opts **out** of `diffLines`' common prefix/suffix trim
— otherwise it is still cut down to the changed hunks, which item 1 forbids. The
≥300-row collapse spacers stay: those are expandable, so nothing is hidden
irreversibly.

### Phase 1c — `.ts` / `.js` / `.mjs`

The declaration lexer from phase 1 becomes its own `jsscan.go`, used by **both**
a `.vue`'s `<script>` section and a standalone `.ts`/`.js`/`.mjs` file:
top-level `export function` / `function` / `const NAME =` / `class NAME` → a
block; imports/types/loose statements → a `<file-header>` sentinel; the same
tiling invariant. Category `FRONTEND`, applied **after** the existing
`categoryRules` but **before** the `typeDirCategory` table, so a `.ts` inside a
`Services/` directory still classifies as SERVICE.

**Two one-time consequences, recorded so they aren't rediscovered as bugs:**

- **Existing anchors on frontend files break, once.** Such a file is one
  whole-file block today; after this phase its block id is different. The
  re-anchor pass (`reanchor.go`) moves row positions, but does not cover an
  identity change — comments/approvals that sat on such a whole-file block lose
  their anchor. Small in practice (frontend is barely reviewed in the tree
  today), but real.
- **Frontend PRs produce many more blocks than before.** Noise, but the wanted
  kind: every changed piece becomes navigable.

### Phase 2 — template → script (item 2)

`resolveVueLocals`: for every identifier/component tag on a **changed** template
line, one callresolve row. Kinds `vue_local` (a script block in the same file —
a real PR block when it changed, otherwise a read-only leaf with embedded code)
and `vue_component` (an imported `.vue`, via the import map + the `@` alias). A
new `findCallSites` branch for the Vue literal forms. Constants-as-blocks
(item 2) falls out for free, since phase 1 already makes a `const` a block.
Drilling, approval and the SSE invalidation work immediately.

### Phase 3 — `$t()` → the real copy (item 4)

`resolveVueTranslations`: a JSON path walk in
`resources/admin/src/locales/{nl,en}.json`, one row per locale, read-only leaf,
reusing `Kind = translation` — badge and frontend unchanged. Also covers
`t("…")` in the script.

### Phase 4 — submit → request → controller → resource (items 3 + 6)

Scope is exactly **the `@click` handler and its `useFetch*` chain**, nothing
else. FormKit `type="step"`/`type="submit"` is explicitly out of scope.

`resolveVueSubmit`: `@click="handler(...)"` → the handler block (phase 2 already
does this) → the `useFetchPost/Put/Show/Delete("<path>")` calls **inside that
handler block** → route file (`routes/api*.php`, `routes/client/web.php`) →
controller method → its request class and resource. Kinds `vue_request`,
`vue_controller`, `vue_resource`, emitted in the real call order (request →
controller → resource), and the **controller only when the PR changed it**
(item 6). Static route matching first; whatever fails goes into the existing
`resolve_call` LLM path as `status=unresolved`.

Note the anchoring: the chain hangs off the **handler block**, not off the
`@click` line in the template. Via phase 2 the handler block is a child of the
template, so the reviewer reaches it in one drill step — which is the
"underlying blocks for the submit" the request asks for.

### Phase 5 — a summary card per value, visible only in the selection (item 8)

Kind `value_summary`, `callKey = value:<name>`, read-only leaf.

**What counts as a value:** every `:prop="expr"` binding, every `{{ expr }}`
interpolation, every `v-model`/`v-if` expression, plus a form field's `name`.
**Content: code fragments only** — the places where that value is set or
transformed, each with a real file+line (e.g.
`formData.value.gmc_brand = data.value?.gmc_brand ?? tenant.value?.name ?? null`,
`(tenant.value?.domain ?? "").replace(/\/+$/, "")`). No LLM, no summary
sentence, therefore no AI toggle and no cost.

**Five noise filters, all deterministic:**

1. Only values on a **changed** line (the same `keepChanged` rule every other
   resolver follows).
2. **No fragments → no row.** A pure pass-through binding (`:label="$t(...)"`,
   which already has a translation child) yields nothing and disappears.
3. The identifier must be **declared in the same SFC's script**. A
   template-local (a `v-for` item, a slot prop such as `context.value` in the
   reference file) or an unresolvable expression gets **no** row rather than a
   guess.
4. A deny-list for static/framework attributes (`class`, `id`, `type`,
   `step-inner-class`, …); static attributes don't count at all, except `name`
   on a form field.
5. A **cap per block** (12 rows, deterministic order) so a 300-line template
   can't emit 80 cards.

Against `findCallSites` false positives on a common name (`data`, `saving`): the
Vue branch matches **only in expression positions** — `{{ … }}`, `:attr="…"`,
`@ev="…"`, `v-*="…"` — never in free text or a class attribute, with word
boundaries.

**Visibility: hidden in list mode too — this INVERTS the existing default.**
Today `scope == null` in `resolvedCallChildren` (`home.mjs`) means "no
narrowing, show everything": that is list mode, an unfocused column, and the
window before the block's code has loaded. For `value_summary` that default
flips, with one clause in the same filter:

```js
.filter((r) => (r.kind === 'value_summary'
  ? scope != null && scope.has(r.callKey)          // only on an explicit selection
  : scope == null || !hideOutOfScope || scope.has(r.callKey)))
```

So the card is invisible in list mode, invisible on an unfocused/railed column,
and invisible until the block's code has loaded (it appears as soon as it has).
In diff mode it then behaves exactly like an ordinary call: `gran='call'`
matches the one segment, `line`/`group` match the selected unit's range,
including a merged Shift+↑/↓ range.

Test (Playwright, its own reserved PR number): absent in list mode, absent on
another group, present as soon as the value is in the selection.

### Phase 6 — form field → backend rules (item 5)

Kinds `vue_field_rule` (**all** matches, not the first) and
`vue_field_transform`. The LLM is allowed here, via the existing `resolve_call`
path, but every row must carry a real file+line — no source, no row.

### Phase 7 — weigh error handling heavier (item 7)

A prompt-only change in `code_warning` for `COMPONENT`/`FRONTEND` blocks, plus a
test on the prompt composition.

## Decisions a later session should not re-litigate

- **The summary card of phase 5 gets NO per-row badge.** The per-line
  "onderliggende code" badge (`lineChildSummaries`, `home.mjs`) only counts
  children that are real PR blocks, so a read-only leaf like this produces no
  badge anyway — and that is deliberate, matching "only visible when the value
  is in the selection" literally. Accepted consequence: the reviewer cannot
  *see* that there is something to select. Revisit only on request.
- **A prop passed to a child component** (`:set-completed="setCompleted"`) does
  get a card — "every prop binding" — but only when filters 2 and 3 above
  yield something.
- **Phase 1c covers `.ts`, `.js` and `.mjs` in one go.** `.json` (including the
  locale files) stays a whole-file block; phase 3 surfaces its values as
  translation children.

## Docs

Per phase, when that phase lands: one new `.claude/docs/vue-blocks.md` with its
index line in `CLAUDE.md`, plus one paragraph in `blocks-and-ingest.md` /
`workflows-analysis.md` / `underlying-code.md`. Nothing rewritten. Not before —
a doc file for an unbuilt phase would describe code that doesn't exist.
