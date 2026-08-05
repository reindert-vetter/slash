# Analysis workflows: relations, call resolution, coverage, AI passes

The workflows that derive the review *tree* — which block hangs under which, what
a call points at, what a test covers — plus the two LLM-backed description/risk
passes. Engine mechanics live in `.claude/docs/tembed-workflows.md`, endpoints
in `.claude/docs/tembed-endpoints.md`.

## Relations between blocks (`build_relations` + `modules/relations`)

One Execution per PR, deriving **many-to-many relations** between blocks — the
call-graph edges, but meaning-driven instead of textual. The first `kind`,
**`event_listener`**: a changed block that dispatches an event becomes the
**parent** of the `Listener::handle` for it, **provided that handle is itself
also changed** in this PR (both sides must change for a link).

- **`modules/relations`** (`data/relations.db`):
  `relations(pr, parent_id, child_id, kind, line)`, block id =
  `<pr>:<file>:<symbol>`. `line` is the **absolute source line within the
  parent's own text** where the detector found the trigger; the frontend uses it
  to reorder the Underlying-code panel around the selected `group` unit (see
  `groupLineRange` in `home.mjs`). `0` = a row from before the field existed.
  `Replace(pr, rels)` is a full swap per PR (so replay-safe); `kind` keeps the
  table open for later types.
- **Analysis service `relations.go`** (package main, not a module — it reads the
  head worktree) runs a list of **detectors**. The event→listener map comes from
  three sources unioned: the `handle(EventType $e)` type hint, a `$listen` array
  in a `*ServiceProvider.php`, and `Event::listen(...)` calls; dispatch sites are
  scanned per block body. `blockText(headDir, b)` returns the full `codeSide`
  (text + the absolute start line of a **fresh** scan, not `b`'s possibly stale
  `Line`), and each detector converts its regex match offset to an absolute line
  via `matchLine`.
- **`providerListenerDetector` is the mirror of `eventListenerDetector`:** the
  latter only finds a parent via a **dispatch site**, so a ServiceProvider that
  only *registers* never became a parent. This one scans a changed
  `<class-header>` block of a `*ServiceProvider.php` with the same regexes and
  makes the provider the parent (still `KindEventListener` — the child is still
  "the listener", regardless of dispatch vs. register). Still both-changed.

### Laravel request chain

Five more kinds, all **both-changed**, so the highest level that *does* change
automatically becomes the tree root (relation children sort to the bottom of the
left list). The head worktree may be read freely for the mapping. Middleware is
**deliberately out of scope**. Shared helpers: `blockIndex`, `blockText`,
`edgeEmitter` (dedup).

- **`route_controller`** — a changed route file (whole-file `ROUTE` block) →
  the changed controller methods it calls: array-callable, string-callable
  `'Ns\X@m'` (namespace ignored via `shortName`), and resource routes →
  **every** changed CONTROLLER method of that class.
- **`controller_request`** — controller method → the changed `XRequest` block
  from a type-hinted parameter → all changed REQUEST methods of that class.
- **`controller_resource`** — → the changed API Resource it builds/returns
  (`new XResource(`, `XResource::make|collection(`, `): XResource`).
- **`controller_model`** — → the changed route-model-bound `Model` from a
  type-hinted parameter, filtered on the MODEL category so
  Request/Resource/interfaces drop out → **all** changed methods of that class
  (agreed granularity: a model param names a class, not a method).
- **`request_policy`** — a changed `FormRequest::authorize` → the Policy
  method it checks (`->can('ability', XPolicy::class)`, ability = method). A
  `Model::class` ref resolves via the `$policies` map in a `*ServiceProvider`,
  with the `{Model}Policy` convention as fallback. `POLICY` is its own
  category; `isPolicyBlock` falls back to path/suffix so a not-yet-re-ingested
  block also matches.

### Workflow + frontend

- Runs `buildRelations` once at start and again on every **`rebuild`** Signal.
  `EnsureRelations(ctx, pr)` starts/reuses one per PR and is called by
  `handleIngest` after a successful ingest.
- Block JSON carries a computed **`id`** so the frontend can match
  `parentId`/`childId`.
- `home.mjs` loads relations in `loadBlocks` and splits `state.blocks`
  (top-level = `allBlocks` minus children) from `state.allBlocks`; children
  render in the Underlying-code card. `childrenOf` carries the relation `kind`
  per child so `KIND_LABEL` names the **child's role as seen from its parent**
  (`route_controller`→"controller", etc.). The chain nests for free via drilling.
- Tests: `relations_test.go`, `tests/relations.spec.mjs` (seeded via
  `slash seed -relations`).

## Resolving (also unchanged) called methods (`resolve_call` + `modules/callresolve` + `modules/claude`)

The Underlying-code card also links the **method calls** a changed block makes
to their **definition**, even in a file the PR did not change. Two layers: a Go
resolver first, an LLM as fallback.

**Why a separate read model, not `relations`:** these children point to
unchanged files (so their block id is not a PR block the frontend knows), and
`relations.Replace` is a full swap per PR — an expensive LLM resolution would
vanish on a rebuild.

### `modules/callresolve` (`data/callresolve.db`)

`call_resolutions(pr, caller_id, call_key, status, child_*, kind, model,
confidence, updated_at)`, PK `(pr, caller_id, call_key)`. The row carries the
**full child descriptor + code text**, so the frontend needs no extra fetch.
`status`: `resolved` (Go), `unresolved` (Go failed → automatic LLM search),
`searching`/`found`/`notfound` (LLM).

- `UpsertGo` writes Go rows but **never overwrites** a `searching`/`found`
  row → the LLM wins over a rebuild. It *does* reset a `notfound` row back to
  `unresolved` (see `resolveCallAttempted` below for why that matters).
- `Prune(pr, keep)` removes any row whose `(caller_id, call_key)` isn't in the
  current Go scan (caller fell out of the PR, or the call site is no longer on
  a changed line) — including LLM rows, since the site is gone.
- **`kind`** (default `method_call`) distinguishes a normal call from a
  **class-level** child (`ChildMethod` empty — the whole model/enum). An empty
  Kind normalises to `method_call` on write, so none of the plain call rules
  needed changes; only `emitKind` callers pass something else
  (`model_usage`/`migration_model`/`data_provider`/`translation`/
  `trait_usage`). Frontend: the label branches on `childMethod` (empty → bare
  class name, never an ugly `Class::`), `KIND_LABEL` maps the words, and
  `DIFFSTAT_KINDS` gives them the same `+A −R`/`Unchanged` badge.

### Go resolution rules (`callresolve_analysis.go`)

`resolveCalls` builds one worktree-wide index (`buildSymbolIndex`:
class→methods, method→blocks, Eloquent scope alias, enums, macros, facades,
models, model `$casts`, traits, commands) and scans each changed new-side block
with regexes.

Two scoping rules that apply to every rule below:

- **`idxSkipDirs` only skips genuinely vendored/generated dirs** (`vendor`,
  `node_modules`, `.git`, `storage`, `public`) — deliberately **not** `tests/`:
  a custom test base class or shared trait is app code, and excluding it made
  every call to an inherited test helper escalate to the expensive agentic pass.
  Purely additive — a unique match can't become more ambiguous. See
  `TestResolveCallsTestHelperClassIndexed`.
- **Only the changed lines** of a block are scanned (`changedNewLines`, a
  per-file base↔head diff; a missing base file → everything counts as changed).
  A call on an unchanged line never produces a child — that used to give
  unrelated "Underlying code". Rule 2d is the one documented exception.

Rules, in order:

- **1–2 — plain calls.** `$this->`/`self::`/`static::` (own class);
  `Foo::m(`/`(new Foo)->m(`; `$var->m(` via the **receiver variable name**
  (`$order->billingAddress()` → `Order::billingAddress`, even when several
  classes have that method — the call key is the bare method name, so two
  receivers calling the same method in one block collapse onto the first match);
  `->m(` on a **unique** global or scope match. Ambiguous (>1 candidate) →
  `unresolved`; a method that exists nowhere in the app worktree (framework
  calls like `->where(`) also → `unresolved`, since it sits on a changed line
  and the automatic search should try.
- **2b/2c/2d — Eloquent models.** `new Foo(` on a model class explicitly
  **excludes** the constructor even when one exists (the reviewer wants the
  model, not its constructor body). `scanModels` indexes every `app/Models/`
  file as a **whole-class synthetic block** (`ChildMethod` empty), so
  `new Model()`/`Model::…` (2c) and a **type-hinted model parameter** (2d) both
  emit one deduped `model_usage` child. 2d scans the **whole** block body
  instead of only the changed lines — a deliberate, documented exception: a
  parameter type is a structural property of the whole (changed) function,
  mirroring `controllerModelDetector`. Inherited Eloquent methods
  (`fill`/`save`/`query`) stay plain `unresolved`.
- **3 — facades.** `scanFacades` links `class X extends …Facade` +
  `getFacadeAccessor()`, so a `Foo::m(` that doesn't resolve on `Foo` retries on
  the accessor. A method on neither stays `unresolved` (vendor isn't indexed).
- **3c — Artisan commands.** `$schedule->command('accounting:import …')`
  resolves to the command class's `handle`, via `scanCommands` (`$signature`'s
  first token). The **call key is the command name**, so different scheduled
  commands stay separate children and the generic `->command(` arrow call is
  suppressed. A framework command (`queue:work`) → `unresolved`.
- **5/5a — Eloquent magic properties.** `->name` without parentheses is the
  relation **method** `name()`; treated as a call only when `name`'s body is a
  relation (`morphOne`/`hasMany`/`belongsTo`), so bare attribute access (`->id`)
  stays ignored. First the receiver variable name, then generically: unique →
  resolved, multiple models → `unresolved`. Runs after rule 4, so a real
  `->name()` call wins the key.
- **5b — `$casts` targets.** A field cast to an enum/class is not a relation
  method, so 5/5a matched nothing and it produced silently nothing.
  `scanModelCasts` (legacy `protected $casts = [...]` array form only; the
  Laravel 11 `casts(): array` method form is out of v1 scope) indexes
  `model.field → class`; exactly one same-name enum → whole-enum child, another
  model → whole-model child, several same-name enums or a non-indexed target →
  `unresolved`, never silently nothing, since the call site is on a changed line.
- **6 — enum cases.** `Foo::NAME` **without** parentheses resolves to the enum
  declaration when `Foo` is an indexed enum defining that case (`scanEnums` →
  synthetic block; `child_method` = the case name). `Foo::class` and constants
  on non-enum classes are ignored; the same case on several enums →
  `unresolved`. The frontend's `findCallSites` therefore also matches `::name`.
- **7 — API Resource `toArray()`.** A Resource used on a changed line surfaces
  its own `toArray()`, since that's where the output is defined — even when the
  Resource class itself isn't changed (unlike `controllerResourceDetector`'s
  both-changed relation). Call key `resource:<class>`. A Resource that doesn't
  override `toArray()` yields **nothing**, never `unresolved` — that's an
  absence, not an ambiguity. `reResourceUse`/`reResourceReturn` also match a
  versioned/collection suffix (`AffiliateResourceV2`, `…ResourceCollection`),
  anchored right before the `(`/`::`/return-type boundary so `ResourceManager`
  never matches.
- **8 — trait usage.** `use TraitName;` in a changed `<class-header>` surfaces
  the trait's own definition (`scanTraits`, whole-class synthetic block). Only
  the plain, comma-separated form ending in `;` — a trait-adaptation block
  (`{ A::foo insteadof B; }`) is out of v1 scope, as is a `use` after the first
  method (that text falls outside every scanned block). Call key
  `trait_usage:<trait>`; an unindexed name (vendor, typo) → nothing.
- **Laravel macros** (`scanMacros`): a `Builder::macro('joinAddress',
  function …)` inside a boot method is a closure and thus invisible to
  `ScanBlocks` (`skipBody` swallows it), so the registration is detected by
  regex and turned into a synthetic block. Its code comes from `blockSource`'s
  line-slicing fallback (the symbol lookup fails for a nested block).
- **A call key containing `:`** (`migration_model:`, `data_provider:`,
  `resource:`, `trait_usage:`, `translation:`, a command name) can never match
  a real call-site identifier in `findCallSites`, so such a child shows at
  group/list level and isn't tied to one line/call.

### Rule-based extras, all merged into the same `UpsertGo`/`Prune`

Three more resolvers that are **rule-based, so no LLM fallback** — an
unmappable case yields **silently nothing**, never `unresolved`, never a search:

- **Migration → model (`resolveMigrationModels`).** A changed migration usually
  belongs to an existing, unchanged model ("add a column"), which is why this is
  a callresolve rule rather than a both-changed relation detector. Scope: a
  changed `MIGRATION`/`up` block (a migration is the anonymous `return new class
  extends Migration`, so `Class == ""`; never `down`). Per
  `Schema::create|table('table', …)` match, table → model via an explicit
  `protected $table` override or the Eloquent convention (`singularizeTable`, a
  deliberately **pragmatic** inflector: `-ies`→`-y`, trailing `-s`, then
  `studly`). One deduped child per table, key `migration_model:<table>`.
- **PHPUnit data providers (`resolveDataProviders`).** A test with
  `#[DataProvider('m')]` (or the legacy `@dataProvider` tag) shows the provider
  itself, usually unchanged. No ambiguity to resolve: a bare `#[DataProvider]`
  always names a method **on the test's own class** (the `DataProviderExternal`
  form is out of scope). Reuses `methodZone` to read the attribute/docblock
  text. Key `data_provider:<name>`.
- **Translation keys (`resolveTranslations`).** A `trans('file.key')` / `__()` /
  `@lang()` / `trans_choice()` call on a **changed line** surfaces the Laravel
  lang file(s) — **one child per locale**. The key splits on the **first** `.`
  (before → `<fileSeg>.php`, rest → the nested array path), locales are the
  lang-root subdirs containing that file, and `sliceLangKey` extracts the value
  source (a quoted scalar or a nested `[...]`). Key
  `translation:<locale>:<key>` (unique per locale), `Kind translation`,
  `ChildClass` = the locale; an **absent** key still emits a row with empty code
  so the UI can mark "ontbreekt in <locale>". **v1 boundaries, silently
  skipped:** a dynamic key, a namespaced/vendor key (`pkg::file.key`), and a
  bare whole-file reference. Frontend: always a **leaf value view**
  (`translationValueView`, current value per locale, no diff), never drillable;
  `findCallSites` couples it via the key **string literal** (the same literal
  for every locale) and `resolvedCallTargetIds` skips `translation` so a changed
  lang file's own block stays in the left list.

All of these are **merged** into the one `UpsertGo`/`Prune` call in the
`buildRelations` Activity (and in the headless `slash relations` twin), so they
share the keep set and need no prune scope of their own.

### `modules/claude` — the CLI bridge

`claude -p <prompt> --model <id>`, with a context timeout. Agentic runs get
`cwd` = head worktree + read-only tools (`Read,Grep,Glob`).
**`SLASH_CLAUDE=off`** → `claude.Fake`.

- **Context-only calls run from a neutral scratch cwd, not the slash repo.**
  `claude` auto-loads the project's `CLAUDE.md` + `.claude/rules` from its cwd
  on every call — pure overhead (and a large token bill) for a context-only
  prompt about PHP code. `Module` therefore holds a `scratchDir` **under
  `os.TempDir()`**, explicitly not under `dataDir`: `claude` walks **up** the
  tree looking for a `CLAUDE.md`, so an empty subfolder of this repo does not
  help. Nothing changes for the agentic pass: that worktree carries
  plug-and-pay's own `CLAUDE.md`, and turning that off would need `--bare` + a
  separate `ANTHROPIC_API_KEY` — an auth/billing decision, deliberately
  untouched.
- **The static instruction text per action is decoupled from the varying call
  content via `--append-system-prompt`.** `RunRequest.SystemPrompt` carries the
  call-independent part — byte-for-byte the text that used to sit inline in
  `-p` — now in `modules/claude/prompts/*.md`, embedded with `//go:embed`.
  Deliberately **not** under `.claude/` (which would itself be subject to
  auto-discovery in an interactive session here): this is prompt content for a
  subprocess, not documentation. A byte-equality test pins the relocation; side
  benefit is that the piece is identical across repeated calls of the same
  action, so `claude`'s own prompt cache can reuse it.
- Both changes live inside `Module.Run`/the payload, so the number and order of
  `cl.Run` calls per workflow body is unchanged.
- **Shared style rules for reviewer-facing text:** every prompt whose output
  the reviewer reads as prose (`chat.md`, `chat_shell.md`, `explain_code.md`,
  `pr_summary.md`, `code_warning.md`'s Dutch `text` finding) forbids a hyphen
  ("-") within a sentence unless the phrasing truly requires one (compound
  words like "code-wijzigingen" are fine — only a sentence-level hyphen is
  banned). A new prompt file that produces reviewer-facing prose should carry
  the same line. On top of that, `chat.md`/`chat_shell.md` alone cap the
  conversational answer (and the `comment_action` reply `body`) at roughly 700
  characters, excluding any ` ``` ` code example — a code example is never
  truncated to fit. `explain_code.md`/`pr_summary.md`/`code_warning.md` keep
  their own, already-fitting length constraints (the ~275-character footer cap,
  "2-4 sentences", "1-3 sentences" per finding) instead of a second, looser cap.

### Workflow `resolve_call`

`markCallsSearching` → `resolveWithModel` (Haiku, context-only shortlist from
the Go index) → `saveResolutions`. Purely automatic, no Signal. Every LLM claim
is verified against the worktree (`verifyDefinition` + path containment) before
it becomes `found`.

- **Haiku only — no automatic escalation to Sonnet; don't reintroduce it.** The
  agentic Sonnet escalation was removed on explicit request, so an
  uncertain/not-found outcome simply stays `notfound`. The generic agentic
  machinery still exists in `resolve_call.go` but is never called from this
  workflow, and `Entry.HadCandidates` still travels in the result while driving
  nothing. Pinned by `TestResolveCallNeverEscalatesToSonnet`.
- **A curated denylist (`vendorBuiltinNames`) skips even the Haiku call** for a
  handful of very common vendor/framework method names (PHPUnit/Laravel HTTP
  test DSL, Schema Blueprint, `cases`) — but **only** when the Go index also had
  zero candidates, so a same-named app method is never suppressed
  (`TestResolveCallVendorBuiltinDoesNotSuppressRealCandidate`). Saves spend and
  the pointless "Searching…" chip.

### The search starts automatically server-side

Right after `buildRelations`' `UpsertGo`/`Prune` (so via both `build_relations`
and the delta refresh), `autoStartResolveCall` groups the fresh scan's
`unresolved` rows **per caller** and starts one Execution per group — the
reviewer needn't open a block first. **Fire-and-forget** (its own goroutine), so
ingest never waits on a live claude call. `StartResolveCall` is **idempotent**
(`resolveCallRunID` over `pr|callerId|sorted(calls)`), so the automatic trigger
and the frontend's own `startCallSearch` safety net can never both spend a call.

- **Never re-submits an already-attempted call, across any number of later
  rebuilds:** `groupUnresolvedCalls` requires a call to be `unresolved` **and**
  absent from `resolveCallAttempted(pr)` — the durable set of every
  `(callerId, callKey)` that ever appeared in a `resolve_call` input, read from
  the event history, **not** from the read model's status. Load-bearing:
  `UpsertGo` resets a `notfound` row back to `unresolved` on every rebuild that
  doesn't touch that call, so a DB snapshot could only distinguish "already
  attempted" for the one rebuild right after a search. Accepted consequence:
  such a row's status can keep cosmetically flipping to `unresolved` — the
  guarantee is "never a second LLM call", not "the status reflects that it was
  tried".
- **Deliberately server-only:** the headless twin `slash relations <pr>`
  bypasses the engine entirely and starts no search; such a PR relies on the
  frontend trigger once a server is running.

**A tab already open on this PR is told when this search lands**, not just a
later fresh open: `saveResolutions` (and `buildRelations`' own `UpsertGo`)
publish `callresolve.changed` over the SSE channel (`eventbus.go`), so
`src/home.mjs` refetches `/api/callresolve` on its own — see "callresolve/
testcovers" under "Migrating a poller onto this channel" in
`.claude/docs/server-events.md` for the full mechanism and why it mattered
(this fire-and-forget search is exactly what made a just-generated PR's
navigation look "frozen" for the reviewer who stayed on the page).

### Frontend

`state.callResolve` adds `resolved`/`found` rows as children and starts the
search for `unresolved` calls automatically in the `setRelated` watch (deduped
in `searchRequested`, resolving the block's **whole** unresolved set rather than
the selection's). `findCallSites` maps each call to the diff segment it's on;
`callScopeMethods` scopes to the selected unit in diff mode and shows all calls
in list mode. Ordering: definition changed in this PR → call on a changed line →
rest. A `found` child shows a **`source: haiku`** badge; Go-resolved shows none.
The list is computed in a watch and pushed via `setRelated`, never in a render
binding (that races with the diff over `b.code`). See
`.claude/docs/underlying-code.md`.

Tests: `callresolve_analysis_test.go`, `resolve_call_test.go`,
`modules/callresolve/callresolve_test.go`; frontend via
`slash seed -callresolve <json>`.

## Linking test coverage (`resolve_test_covers` + `modules/testcovers`)

A PHPUnit test links to the method it tests, in **both directions**: a test
shows the tested method as a child, and a tested method shows "covered by
TestX::testY" (only when the test itself also changes, since only then is there
a test PR block to hang it on). Go detector first, a **limited** AI fallback for
one specific case.

**Why a dedicated module:** the tested method is often in an unchanged file, so
its block id is not a PR block — same reason as `callresolve`, hence a row
likewise carries the full child descriptor + code text.

- **`modules/testcovers`** (`data/testcovers.db`):
  `test_covers(pr, test_id, target_key, status, covered_*, annotation, model,
  confidence, updated_at, line)`. `target_key` mirrors `call_key`:
  `method:Class::method` (statically resolved), `class:Class` (AI territory),
  `none`. `line` (distinct from `covered_line`, the tested method's declaration)
  is where the annotation sits **in the test file**, used to reorder the panel
  around the selected group. Only set on a `resolved`/`unresolved` row; a
  `found` row that escalated from a class-only annotation deliberately doesn't
  carry it (too much plumbing for this narrow path), so it degrades to the same
  "not in the group" tier as `covered_by`.
  Statuses:
  - **`resolved`** — a **method-level** annotation (`#[CoversMethod(X::class,
    'm')]`, `@covers X::m`, `@coversDefaultClass` + `@covers ::m`) always names
    both class and method, so it resolves statically, verified against the
    worktree. **`#[CoversMethod]` names both regardless of where it sits** —
    including above the class declaration, so `coverTargets` matches it against
    the class zone too and it then resolves for **every** test method of that
    class. The opposite of `#[CoversClass]`, which only ever names a class
    wherever it sits and therefore stays LLM territory.
  - **`unannotated`** — no annotation at all → **permanent warning, never AI**
    — UNLESS `singleNonTestStartBlock` finds this PR has exactly **one**
    non-TEST top-level block (not a relation child, see below): the test is
    then linked to it as a `resolved` row instead, `Annotation:
    "single-startpoint"` (display-inert — the frontend never reads
    `annotation`). Deliberately placed in the deterministic Go scan, not
    `resolve_test_covers`: the shortcut only ever fills in what would
    otherwise have been the terminal, LLM-free `unannotated` status, so it can
    never race or conflict with the AI branch below, which only ever touches
    an `unresolved` row (an explicit but incomplete annotation always keeps
    its own search — the shortcut never overrides one). "Top-level" is
    computed the same way the frontend derives `state.blocks` (`allBlocks` −
    relation children): a block whose id is absent from `rels`' `child_id`
    column, using the `rels` this same Activity/the headless `slash relations`
    twin just built. Zero or ≥2 such blocks → no shortcut, ordinary
    `unannotated`.
  - **`unresolved`** — a class-level-only annotation → triggers the search.
  - **`searching`/`found`/`notfound`** — LLM-owned, as in callresolve.
  `UpsertGo` never overwrites an LLM-owned row; `Prune` cleans up orphans.
- **Static detector `testcovers_analysis.go`** scans, per **changed test file**
  (no whole-worktree scan), the raw text around each test method (`methodZone`,
  bounded by the previous block) and around the class declaration (`classZone`)
  for the four annotation forms — pure regex, no parser. A method-level
  annotation wins over a class-level one for the same class (no needless AI
  search). A test method is recognised via the `test` prefix or a
  `#[Test]`/`@test` marker, so `setUp`/helpers stay out. Called **inside the
  existing `buildRelations` Activity**, like callresolve's Go rows.
- **AI branch:** runs **only** for `unresolved` (a class-level-only annotation),
  never for `unannotated`. Haiku gets the **candidate methods of the named
  class** + the test body and picks which one is exercised. **Haiku only — the
  automatic Sonnet escalation was removed; don't reintroduce it** (the machinery
  remains but is uncalled). Verification is stricter than `verifyDefinition`:
  the class is already fixed by the annotation, so only the method's existence
  on that class is checked.
- **Sibling reuse within the same test class (`reuseSiblingCovers`):** several
  tests in one file often cover the same class, so before asking Haiku the
  workflow checks whether a **sibling** test (same PR + same test file, i.e. the
  same `<pr>:<file>:` prefix, different `test_id`) already resolved that class.
  Matched via **`CoveredClass`**, not the raw `target_key` — a `resolved` row
  carries `method:…` and a `found`/`unresolved` row `class:…`, so only that
  field identifies "the same tested class" across both forms. Only **`resolved`**
  (most authoritative) and **`found`** are reused, never
  `notfound`/`searching`/`unresolved`/`unannotated` (an earlier miss says
  nothing about another test); `resolved` wins, then `List`'s own stable order.
  A reused row is a **literal copy** (no "reused" marker). **Determinism:** the
  lookup is its own Activity (`reuseTestCoverSiblings`, the only reader of
  `List`; the matching itself is pure), so the **number** of model calls is a
  function of a recorded result — the same pattern as callresolve's
  `HadCandidates` gate. This only saves Haiku calls; it does not reintroduce
  Sonnet.
- **A tab already open on this PR is told when this search lands**, same as
  callresolve above: `saveTestCoverResolutions` (and `buildRelations`' own
  `UpsertGo`) publish `testcovers.changed` over the SSE channel — see
  `.claude/docs/server-events.md`.
- **Frontend:** direction 1 = `resolvedTestCoverChildren` (`covers` child, same
  diffstat/`source` badges as a call child); direction 2 = `coveredByChildren`
  (`covered_by`, reusing the existing test PR block, so no code snapshot). Both
  **block-level**, so they drop out at `gran==='call'` like listener children —
  coverage is not a line-bound concept. `directChildBlocks`/`nestedPrBlocks`
  include **only direction 1**, to avoid a method↔test cycle in the recursive
  approval rollup. **Test coverage hides no block from the left list** — neither
  side: a tested method that is a PR block is always changed, primary reviewable
  code, so a test must never make it disappear. A **warning**
  (`related-covers-warning`) shows for an `unannotated` row, or a `notfound` one
  after a failed search, with different text per case; the "searching…"
  indicator reuses callresolve's own helpers, and the search starts
  automatically from the same `setRelated` watch.
- Tests: `testcovers_analysis_test.go`, `resolve_test_covers_test.go`,
  `modules/testcovers/testcovers_test.go`, `tests/testcovers.spec.mjs` (seeded
  via `slash seed -testcovers <json>`).

## AI description of a code unit (`explain_code` + `modules/explanations`)

Generates the **footer description**: a short Dutch Opus explanation of the
focused `line`/`group` unit (see `.claude/docs/footer.md`) — **every** such
unit with real code, not only one containing an if-statement (that earlier
frontend gate was lifted with "Diepgravend onderzoek"). One Execution per
**unit + code hash**, no Signals.

- **`modules/explanations`** (`data/explanations.db`):
  `explanations(pr, block_id, unit_key, code_hash, status, text, model,
  updated_at)`, at most one live row per unit — a new hash (new commit)
  overwrites it. `status`: `searching`/`done`/`failed` (terminal: the footer then
  shows nothing and doesn't ask again). A row with an **empty `code_hash`**
  matches any hash on the frontend side (seed fixtures).
- **Input-driven, no worktree reads:** the input carries the unit code, the
  surrounding block as context (frontend-truncated), file/label/gran, the
  `unitKey` (same codeRef shape as `commentPath`) and the `codeHash` (frontend
  `fnv1a` over `EXPLAIN_PROMPT_VERSION + '|' + code + context`; the backend only
  stores it). So the body is a pure function of its input.
- The prompt caps the answer at ~40 words / ~275 characters, measured against
  `line-clamp-2` at the footer's real width, so it fits without ending in "…".
  **`EXPLAIN_PROMPT_VERSION`** (frontend-only, folded into `codeHash`) exists
  for exactly this kind of change: bumping it invalidates every previously
  generated row with no backend migration — a stale hash simply stops matching
  and the row is lazily regenerated.
- **Flow:** `markExplainSearching` → `generateExplanation` (Opus, context-only;
  empty output → `failed`) → `saveExplanation`. The done/failed decision reads
  the **stored** result, so replay-deterministic.
- **Idempotent start** via `explainRunID` (`expl-` + sha256 over
  pr|blockId|unitKey|codeHash — hashed because block ids contain paths/colons
  and Run IDs are used as JSONL file names).
- **Frontend:** the footer watch builds a request for the focused unit as soon
  as it has non-blank code, shows "generating…", and starts with a 600ms
  debounce, deduped in `explainRequested` and **only after the read model loaded
  at least once** (`explanationsLoaded`) — otherwise a fresh run would overwrite
  an existing/seeded row before the first GET landed.
- Tests: `explain_test.go`, `modules/explanations/explanations_test.go`,
  `tests/footer-explanation.spec.mjs`.

## AI risk check of the whole PR (`code_warning` + `code_warning.go`)

A **PR-wide, agentic** risk check — correctness, security, style/quality — that
also looks at code a change is **connected** to (callers, called code, tests,
listeners) which the PR itself doesn't touch. Deliberately **agentic Opus only**
(with `Read`/`Grep`/`Glob` in the head worktree): the whole point is that the
model explores the worktree to find something outside the context we hand it (a
caller whose call no longer matches a changed signature, a test still checking
the old form, a listener not handling a new payload field). Opus because this is
a manually triggered, low-frequency action.

- **Trigger: manual (the `/` menu item "Diepgravend onderzoek", see
  `.claude/docs/command-palette.md`) OR automatic, on real new code.**
  `autoStartCodeWarning` (workflows.go) fires it fire-and-forget from exactly
  two places: `buildRelationsWorkflow`'s one-time build at Execution start (a
  PR's very first ingest) and `prStatusWorkflow`'s delta-refresh branch, but
  **only** in the `!res.Skipped` case — i.e. `refreshIngestDelta` actually found
  a newer head SHA. A bare `rebuild` Signal (a manual "Regenereren" with no new
  commits) deliberately does **not** auto-trigger it — see the doc comment on
  `buildRelationsWorkflow`'s one-time call. Both call sites go through a tiny
  `autoStartCodeWarning` **Activity** that only queues the PR onto a single
  serial worker and returns immediately (mirrors `autoStartResolveCall`), so
  neither ingest nor the delta-refresh ever waits on a live, possibly slow
  agentic Opus call; on replay tembed returns the recorded (empty) Activity
  result without re-invoking the function, so the PR is queued exactly once
  per real occurrence. A manual "Diepgravend onderzoek" is never gated by
  anything below.
  **Serialized + deferred past server startup:** `enqueueAutoStartCodeWarning`/
  `runCodeWarnWorker` (`TaskManager`) drain one PR at a time — never a
  goroutine per trigger — so a burst of PRs all reporting "new commits" at
  once (the exact scenario after downtime: every `pollIngestRefresh` poller
  wakes and finds a newer head SHA) never launches more than one Opus call
  concurrently. That worker (and `pollIngestRefresh`/`pollImportComments`/
  `EnsureInbox`/`EnsureTaskInbox`'s initial fetch) additionally waits on the
  `TaskManager`'s ready gate (`ArmReadyGate`/`MarkReady`/`waitReady`), armed in
  `newTasks` and opened only after `runServe` (`main.go`) has actually bound
  the HTTP listener (`net.Listen`, before `http.Serve`) — so this whole class
  of startup-recovery background work (network calls, `claude` subprocess
  calls, `workflows.db` writes) never competes with, and thereby delays, the
  synchronous work `Engine.Recover`/`ListenAndServe` still have to do. Every
  test/CLI caller that never calls `ArmReadyGate` sees `waitReady` as a no-op
  (the gate defaults to already-open), so this is invisible outside the real
  server boot path.
- **Reviewer on/off switch (`modules/autowarn` + `WorkflowAutoWarn`/
  `SignalAutoWarn`):** a toggle next to the theme button in `prInfoCard`
  (`data-testid=auto-warn-toggle`, `src/autowarn.mjs`) turns the AUTOMATIC
  trigger above off entirely — `autoStartCodeWarning` (the `TaskManager`
  method, not the Activity) checks `AutoWarnEnabled` first and does nothing
  when it's off. Manually starting it from the menu is **never** gated by this.
  Default is **enabled** (the reviewer's own words: "gewoon toch altijd doen…
  het moet een optie zijn die je aan en uit kan zetten"). Deliberately **not**
  `localStorage` (like the theme preference) or `settings.json` (read once per
  process — see `settings.go`): the toggle gates a **backend** decision that
  must be readable the instant the trigger wants to fire, so it rides the same
  one-Execution-per-repo Signal pattern as `task_snooze`
  (`EnsureAutoWarn`/`SignalAutoWarn` → `saveAutoWarnEnabled` Activity →
  `autowarn.SetEnabled`), read via `GET /api/autowarn`
  (`autowarn.Enabled`, defaults to `true`). No numeric token-budget gate was
  built — deliberately rejected; every earlier idea for "pause automatic
  generation once an AI budget runs low" (a `claude` CLI rate-limit query, a
  local usage-history file) turned out to be either only a post-hoc
  allowed/rejected flag or an OS-app-specific, undocumented file — neither
  reliable enough to gate a feature on, and the reviewer explicitly asked for a
  plain on/off switch instead.
- **Re-running it is a deliberate "refresh"** (whether manual or automatic) —
  no idempotent Run ID: every run supersedes the previous findings of the
  files in scope, so it replaces rather than stacks. **Incremental scope on a
  new commit is deliberately NOT built**: a fast-follow could piggyback on
  `refreshIngestDelta`'s changed-file list, but that touches `pr_status`'s body
  and `ingestResult`'s schema — the automatic trigger still reviews the PR's
  **whole current changed-file scope** every time (`resolveWarningScope`'s
  existing default), never just the new delta.
- **Scope + cap (`resolveWarningScope`,** read-only): the files come from the
  PR's current blocks (`Files` empty → all changed files; filled → passed
  through, reserved for that fast-follow). The findings cap is
  **`warningsPerBlock` (2) × blocks-in-scope**, floor 2 — "on average ~2 per
  block", not a fixed number. The model is told the cap, but it is
  **hard-enforced in Go** (sort on `file, line`, truncate), so a model ignoring
  the instruction can't exceed it.
- **Findings carry their own anchor, mapped onto the existing comment model:**
  the model returns `[{"file","line","text"}]`. **Hallucination protection:** a
  finding is trusted only if its `file` is literally one of the files the prompt
  named — a made-up path is silently rejected. `anchoredWarning` then reuses
  **literally** `blockForLine`/`rowForLine`, the same mechanism an imported
  GitHub review comment uses: inside a block → a normal block-scoped warning
  (`Kind ""`, `Gran "line"`); not inside one (an unchanged/context line, or a
  slightly-off line) → **PR-wide** (`Kind "ai_warning"`, added to `isPRWide`)
  instead of being discarded, with `File` still set as a hint.
- **Auto-supersede, scoped per file** (`supersedeFileWarnings`, run **before**
  the agentic call): for each file in scope, every existing `Source:"ai"`
  comment on it is deleted via the **existing delete Signal** on its own
  Execution — best-effort per comment (an already-closed run can't be signalled
  and must not block the rest). A file **outside** scope keeps its old warnings.
- **Every warning is a normal `task_code_comment` Execution** — no new comment
  machinery: `createWarningComment` calls `StartCodeComment` with `Source:"ai"`
  + `Local:true` (never to GitHub) and `Author:"AI check"`. Being a full
  Execution, the reviewer can resolve or delete it like any other comment.
- **A block-anchored finding retracts the reviewer's approval of that exact
  row — but only the FIRST time.** Mirrors "Placing a comment retracts the
  approval it hangs on" (`.claude/docs/approval.md`) and **reuses the same
  mechanism** rather than a second write path: `revokeApprovalForWarning`
  (Activity) reads the block's current approved state (`approvals.List`),
  drops the row (plus any call-segment key whose row falls in it — same
  group/line logic as `revokeApprovalForComment`, factored out as
  `removeApprovalRowRange` in `code_warning.go`), and signals the PR's
  `approve` tracker with the trimmed set via the existing `SignalSet` route
  (`EnsureApprovals` + `engine.SignalWorkflow(runID, SignalSet, …)`) — exactly
  what the UI itself would send. **Identity for "already revoked once" is
  `(pr, blockId, row)`** — the anchor, never the comment id (a stale AI comment
  is deleted and a fresh one created on every run via `supersedeFileWarnings`)
  and never the finding's wording (the model may rephrase the same issue
  between runs). `modules/warnrevoke`'s `MarkIfNew` records that tuple once;
  `codeWarningWorkflow` only calls `revokeApprovalForWarning` when
  `markWarningRevocation`'s Activity result says it's new. Consequence: if the
  reviewer sees the warning, decides the code is fine, and re-approves that
  row, a **later** run whose finding recurs on the same row does **not** undo
  that approval again — only a warning on a **different** row is treated as
  new. An unanchored `ai_warning` (no block/row) never revokes anything.
- **Determinism:** the body only does `ExecuteActivity` calls in a fixed order
  (scope → supersede → the one Opus call → per finding: `createWarningComment`,
  then `markWarningRevocation` + conditionally `revokeApprovalForWarning`), and
  every count comes from a **stored** Activity result — never a live check.
- **Frontend:** the same warning-triangle SVG as `related-covers-warning`, now
  as an `aiWarningBadge` pill; the Taken card shows the run as "Risk check" with
  either "searching the PR for risks…" or the **exact** number of findings —
  including "no risks found" — via `WorkflowRunView.WarningsFound`.
- Tests: `code_warning_test.go` (anchoring, PR-wide fallback, hallucination
  guard, supersede, the findings cap, the once-only revoke, and the automatic
  trigger firing/skipping-when-disabled/not-on-a-bare-rebuild),
  `modules/autowarn/autowarn_test.go`, `modules/warnrevoke/warnrevoke_test.go`.
