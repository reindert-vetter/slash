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
  and the automatic search should try. **`Foo::m(` also falls back to the same
  unique-global-candidate rule** when `Foo` itself doesn't declare `m()` and
  isn't a facade — `methodOnClass` has no `extends`-chain awareness, so a
  static call **inherited** from a base class (`final class PromotionsV2
  extends UnleashFeature` calling `PromotionsV2::isEnabled()`, only ever
  declared on the abstract `UnleashFeature`) used to fall through to
  `unresolved` and then usually `notfound` (no visible card at all — a
  `method_call` child only renders once `resolved`/`found`, unlike
  `testcovers`' `unannotated`/`notfound`, which get their own warning icon).
  Several same-named methods elsewhere in the app still stay `unresolved`,
  same ambiguity rule as the `->m(` case. Tests:
  `TestResolveCallsStaticInheritedMethod`/
  `TestResolveCallsStaticInheritedMethodAmbiguous`.
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
- **3a2 — Temporal Activity stubs.** `$var = Workflow::newActivityStub(FooActivity::class,
  …)` then `$var->m(` → the Activity's method, via `reActivityStubVar` mapping
  the stub variable to the Activity's short class name (whole-file scan,
  cached like the rule-3a interface map). Exists because the plain
  receiver-name heuristic (3b) assumes the variable is named after its class
  (`$order` → `Order`), which a Temporal stub variable usually isn't
  (`$runCommand` for `RunCommandActivity`) — so without this rule a workflow's
  `->run(`/`->handle(` call on its own Activity stub fell through to rule 4's
  global unique-match (ambiguous for a common method name) or `unresolved`.
  Runs before 3b/4 and marks the call key `seen`, mirroring 3a. An
  unindexed Activity class (vendor/framework) still resolves to `unresolved`,
  never silently nothing — the call sits on a changed line.
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
  synthetic block; `child_method` = the case name). `Foo::class` is handled
  separately by rule 6c below; the same case on several enums →
  `unresolved`. The frontend's `findCallSites` therefore also matches `::name`.
- **6b — constants on a plain class.** No enum by that name → `classConstDecl`
  looks the class up in the symbol index (which indexes the `<class-header>`
  block too, so a class with **no methods at all** is still found) and returns
  the constant's **own declaration**, not the whole class — for an enum the
  entire declaration is the useful unit, for an ordinary class it would be a
  wall of unrelated methods. Kind `const_ref`, call key the bare constant name
  (a real literal, so it stays scoped to the line it's used on, unlike the
  `class_member:` keys below). Two files declaring the same short class name
  with that constant → **silently nothing**, never `unresolved`. A reference to
  the caller's **own** class is skipped: rule 9 already emits that declaration
  as its own card, and two cards for one declaration is worse than none.
- **6c — bare `Foo::class`.** The generic sibling of 3a2: a plain class
  reference with no call, no `$var` assignment, no `$casts` entry — e.g. a
  Temporal workflow's `'activities' => [FooActivity::class, ...]` array, which
  has no `$var->method()` for 3a2's stub-variable heuristic to key on at all.
  Reuses rule 6's own `Foo::class` matches (which rule 6 itself skips via
  `key == "class"`). A model → `model_usage` (the same kind `new Model()`/
  `Model::method()` already produce, so the two never show duplicate cards for
  one model); anything else → `classHeaderBlockFor` looks up the `<class-header>`
  block across the worktree and emits `Kind: class_ref`. A class already
  claimed under this key by an earlier rule (constructor 2b, model usage 2c, an
  Activity stub 3a2) is skipped via `seen`, so this rule only fills the gap
  those left. An unindexed class (vendor/framework/exception) resolves to
  **silently nothing**, never `unresolved` — `::class` is used far too often
  for purposes with no "underlying code" at all (type hints, exception
  classes) to treat every miss as an LLM-search candidate. The frontend's
  `findCallSites` matches `\bname\s*::\s*class\b` for this (the class name
  sits BEFORE the `::`, unlike rule 6's own `::name`).
- **6c-bis — that same `Foo::class` also shows the class's entry points.** On
  explicit request ("laat ook 2 blokken als onderliggende code zien, ook al
  zijn ze niet aangepast: de content van `__construct` en de eerste andere
  method"): a class header on its own is only the declaration region, and only
  interesting when the PR changed it, so rule 6c additionally emits the class's
  `__construct` (`Kind: class_ctor`, key `class_ctor:<class>`) and its first
  OTHER method by declaration line (`Kind: class_first_method`, key
  `class_method:<class>`). `classEntryPoints` picks both from the worktree-wide
  symbol index, scoped to the file `classHeaderBlockFor` already resolved the
  class to — so these are usually blocks the PR never touched at all, which is
  exactly the point. Either may be absent: **no constructor → only the first
  method** (deliberately no "then show the first two" fallback). A method the
  PR DID change is shown here anyway and additionally keeps its own row in the
  index (`resolvedCallTargetIds` skips these two kinds, like `translation`).
  Scoped to this rule ONLY: `new Foo(...)`, model usage and an Activity stub
  already point at the exact method in play, so a constructor + arbitrary first
  method beside it would be noise. Both keys contain a `:` and are listed in
  the frontend's `isBlockLevelCallKey` — the caller's line holds `Foo::class`,
  never a call to the method being shown, so there is no literal site to scope
  by. Tests: `TestResolveCallsClassRefEntryPoints`,
  `tests/related-class-ref-entry-points.spec.mjs`.
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
- **9 — class members (`resolveClassMembers`).** A `<class-header>` block is one
  coarse blob (trait uses, constants, properties — see `phpscan.go`'s
  `classHeaderSentinel`). This rule breaks its **declared members** out into a
  card each, so `$listen` or `MAX_TRIES` sits next to the diff as its own unit:
  **every constant**, changed or not (explicitly requested — an untouched
  constant is reference material the reviewer wants to see), and **only a
  changed/added property** (an unchanged one is noise). A **removed** member is
  never emitted: it doesn't exist on the head side, and the header's own diff
  already shows the deletion. Changed-ness comes from comparing the same region
  on the base worktree (`normalizeMemberText`; no base file → everything counts
  as changed), and rides on the **kind**: `class_property` /
  `class_constant_changed` / `class_constant`. Call key
  `class_member:const:<NAME>` / `class_member:prop:$<name>`.
  `scanClassMembers` (`phpscan.go`) does the splitting with the same lexer
  primitives as `scanPHP`, so a `;` inside a string/comment/heredoc/bracket pair
  never ends a statement — that is what keeps a multi-line array default one
  member. Silent limits: a grouped declaration (`const A = 1, B = 2;`) is one
  member named after the first name; a leading PHPDoc/attribute is not folded
  into the member's text; an unterminated statement is dropped rather than
  swallowing the rest; an enum `case X = 'x';` and a `use Trait;` match nothing
  (the latter has rule 8). Same scope boundary rule 8 accepts: only the
  `<class-header>` region is scanned, so a constant declared **after** the first
  method is silently missed. **A member never becomes a block** — no id, no
  approval, no row in the block index (see `.claude/docs/underlying-code.md`).
  **The `CallerID` is the header's OWN block only when the class has no other
  changed block in this PR** (`classSiblingIDs`) — otherwise every OTHER
  changed, non-header top-level block of the same file/class becomes a caller
  (ALL of them, when several changed, never a single "chosen" one), so the
  `<class-header>` block's own top-level row can be hidden from the index
  entirely (`swallowedClassHeaderIds`, `home.mjs`) — see
  `.claude/docs/underlying-code.md`. Reversed on explicit request: the header
  used to always stay visible, with the members as a pure addition; a header
  with no sibling at all still behaves exactly like before, since there is
  nowhere else to hang its members. Tests:
  `TestResolveClassMembers`/`TestResolveClassMembersAddedFile`/
  `TestResolveClassMembersAttachedToSibling`/
  `TestResolveClassMembersAttachedToEverySibling` and `TestResolveCallsConstRef`
  (`callresolve_analysis_test.go`).
  **Frontend-only sharpening (no change to the Go emission above):** attached
  to a sibling, `class_member:` is no longer unconditionally block-level in
  `home.mjs` — `callScopeMethods`/`findCallSites` treat it that way only while
  the caller is the header block itself; against a sibling caller they match a
  real usage site (`->name`/`::name`/`::$name`) and scope the card to the
  selected group/line/call like an ordinary call. See "Attached to a sibling…"
  in `.claude/docs/underlying-code.md`.
- **Laravel macros** (`scanMacros`): a `Builder::macro('joinAddress',
  function …)` inside a boot method is a closure and thus invisible to
  `ScanBlocks` (`skipBody` swallows it), so the registration is detected by
  regex and turned into a synthetic block. Its code comes from `blockSource`'s
  line-slicing fallback (the symbol lookup fails for a nested block).
- **A call key containing `:`** (`migration_model:`, `data_provider:`,
  `resource:`, `trait_usage:`, `translation:`, a command name) can never match
  a real call-site identifier in `findCallSites`, so such a child shows at
  group/list level and isn't tied to one line/call. `class_member:` is the one
  exception attached to a sibling caller — `findCallSites` has a dedicated
  branch for it there, see above.

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
  around the selected group. Only set when the annotation sits directly above
  the TEST METHOD ITSELF. Two cases deliberately leave it 0, both degrading to
  the same "not in the group" tier as `covered_by`: a `found` row that
  escalated from a class-only annotation (too much plumbing for this narrow
  path), and — the bug behind a reported "0/8 badge with no underlying card"
  on a real PR, 2026-08-10 — a Go-`resolved` row whose `#[CoversMethod]`/
  `#[CoversClass]`/bare `@covers Class` instead sits **above the class**
  (`coverTargets`' classZoneText fallback, see below): that line is shared
  verbatim by every test method in the file, so it's never "this test's own
  line" — comparing it against one method's own row range made the covers
  child wrongly score as out-of-scope everywhere, and the frontend's
  `newLineToRowOf` could coincidentally miscount it onto an unrelated row of
  that method whenever the (wrong) line number happened to be smaller than
  the method's own row count.
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
  coverage is not a line-bound concept. A `covers` row whose `Line` is 0 (the
  class-level-annotation case above, or a `found` escalation) is, at
  `gran==='group'`, scoped to the covering test's own `// When` section
  instead of shown unconditionally — see "A class-level `#[CoversMethod]`/
  found-escalated `covers` child scopes to `// When`" in
  `.claude/docs/underlying-code.md`. `directChildBlocks`/`nestedPrBlocks`
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
  `SignalAutoWarn`):** the **"Live AI assistent"** toggle next to the theme
  button in `prInfoCard` (`data-testid=auto-warn-toggle`, `src/autowarn.mjs`)
  turns the AUTOMATIC trigger above off entirely — `autoStartCodeWarning` (the `TaskManager`
  method, not the Activity) checks `AutoWarnEnabled` first and does nothing
  when it's off. Manually starting it from the menu is **never** gated by this.
  Default is **enabled** (the reviewer's own words: "gewoon toch altijd doen…
  het moet een optie zijn die je aan en uit kan zetten").
  **The same switch also gates `explain_code`** — the footer's AI description
  is neither requested nor shown while it is off ("als dat uit staat, ook geen
  live descriptions toevoegen aan geselecteerde dingen"), which is why it is
  named for the assistant rather than for the risk check. Deliberately NOT
  `resolve_call`/`resolve_test_covers`: those derive the navigation structure,
  not a description. See `.claude/docs/footer.md` and `src/autowarn.mjs`. Deliberately **not**
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
- **A finding must anchor on a line the PR CHANGED.** The model may read and
  reason about anything in the worktree (that is the whole point of the
  agentic pass), but a finding about code this PR left alone is out of scope —
  reported bug: a warning hung on an untouched `const searchTerm = …` line far
  below the real changes. Same instruct-plus-verify shape as the file-scope
  hallucination guard: `changedLineSets` (`code_warning.go`, reusing
  `changedNewLines` from `callresolve_analysis.go`) computes the changed
  head-side lines per scope file, `describeChangedLines` renders them into the
  prompt as compact ranges per file, `code_warning.md` states the rule, and
  `allows` then **hard-drops** every finding on any other line. Dropped
  outright, deliberately **not** demoted to a PR-wide finding: an unrelated
  remark must disappear, not resurface without an anchor. A file with no base
  copy (added file) allows everything, matching `keepChanged`'s own fallback.
  Consequence for the two anchoring fallbacks below: they are now vangnets,
  not the normal route (see `anchoredWarning`'s doc comment) — the block-wide
  one only fires when `rowForLine` cannot map a genuinely changed line.
- **Findings carry their own anchor, mapped onto the existing comment model:**
  the model returns `[{"file","line","text"}]`. **Hallucination protection:** a
  finding is trusted only if its `file` is literally one of the files the prompt
  named — a made-up path is silently rejected. `anchoredWarning` then reuses
  **literally** `blockForLine`/`rowForLine`, the same mechanism an imported
  GitHub review comment uses, with THREE outcomes:
  - **Pinned to an exact row** (`blockForLine` and `rowForLine` both succeed):
    a normal block-scoped warning (`Kind ""`, `Gran "line"`), anchored on that
    row like any other line comment.
  - **Pinned to a block, not to a row** (`blockForLine` succeeds,
    `rowForLine` doesn't — the finding is genuinely ABOUT an unchanged/context
    line inside the block, e.g. a docblock promise, rather than about a
    changed line): still `Kind ""`, but anchored on the block's own **first
    changed row** (`firstChangedRowIndex`, `blockstats.go`) instead of being
    left unpinned, with **`BlockWide: true`** on the comment
    (`comments.Comment.BlockWide`). Reported bug this replaced: an unpinned
    anchor (`RowStart -1`) used to mean "shown anywhere within this block" for
    EVERY selection inside it (`commentUnder`, `RelatedPanel.mjs`) — a finding
    about a docblock on line 88 kept surfacing under a completely unrelated
    line/group of the same block. A real row anchor makes the EXISTING
    row-containment filter apply normally (no frontend filtering change
    needed); the frontend badges `BlockWide` as
    **"Geldt voor het hele blok"** (`blockWideBadge`, `RelatedPanel.mjs`) so
    the reviewer doesn't read it as being about that one row specifically —
    word-first per the colorblind rule, not a colour-only signal.
  - **Not inside any block at all** (`blockForLine` fails — an unchanged/
    context line outside every block, or a line the model got slightly
    wrong) → **PR-wide** (`Kind "ai_warning"`, added to `isPRWide`) instead of
    being discarded, with `File` still set as a hint.
- **The PR's own stated intent goes into the prompt**, so a choice the author
  already explained isn't reported back at them as a risk. `resolveWarningScope`
  reads `prmeta.Get` — **no extra network call**, `pr_status` already fetched
  and stored all of it — and carries the PR **title**, the PR **description**
  and the linked **Jira ticket's description** on `warningScope` →
  `warningReviewArg` → the top of `warningPrompt`. `code_warning.md` tells the
  model to treat them as intent: only flag what the explanation doesn't
  actually cover. Missing metadata (no prmeta row yet, no Jira link) just
  leaves that part of the prompt out.
  **Jira *comments* are deliberately NOT included**: `modules/jira` fetches
  `summary,description` via `acli jira workitem view`, and adding a `comment`
  field could not be verified against a real, authenticated `acli` (it errors
  out unauthenticated), so the shape stayed a guess. Revisit with an
  authenticated `acli` if the ticket discussion turns out to matter.
- **The open conversation already on the PR is handed to the model as
  context, so it can skip a duplicate.** `existingLineCommentsInScope`
  (`code_warning.go`, called from the `runAgenticReview` Activity right before
  `runCodeWarningReview`) reads `cs.List` and keeps **two** kinds of open,
  non-AI thread: the line-anchored (`Kind ""`) comments on a file in scope,
  and the **PR-wide** ones (`isPRWide` — where "we chose X because Y" usually
  gets written) — each **with its replies** (the "/resolve"/"/reopen"
  sentinels filtered out), since a reply is often exactly where the concern
  was already answered. Scoped entries sort by file+line, PR-wide ones by id,
  and the list is capped at `maxPromptComments`; every free-text field passes
  through `clipForPrompt` (`maxPromptDescription`/`maxPromptComment`) so one
  runaway description or thread can't crowd out the rest of the prompt.
  Deciding whether a finding still adds something new is the **model's** call,
  per an instruction in `code_warning.md`'s system prompt — deliberately not a
  Go-side dedup filter (that would need the same semantic judgment a second,
  redundant call would only duplicate). An old AI-authored comment never
  appears here: `supersedeFileWarnings` already deleted every one in scope
  earlier in the same workflow.
- **`CodeWarningSystemPrompt` (`modules/claude/prompts.go`) is the
  concatenation of TWO embedded files, deliberately kept separate.**
  `prompts/code_warning.md` is the fixed task framing + JSON contract (the
  agentic-review instruction, the hyphen style rule, the "skip a duplicate of
  an existing comment" rule) — it changes rarely. `prompts/
  code_warning_patterns.md` is plug-and-pay/plug-and-pay's own, team-specific
  checklist of recurring review patterns (Backend/Laravel, Frontend Vue/TS,
  Tests, Copy & translations, Naming — mined from real inline PR comments by
  the team's most active reviewers) and is expected to **keep growing**. The
  patterns file is explicitly additive — its own opening line says so — never
  a replacement for what the agentic review already finds on its own, and
  every pattern in it is phrased so the model verifies it with
  Read/Grep/Glob against the checked-out worktree before flagging (e.g. Glob
  the module's test directory before claiming "no test", Grep the sibling
  locale file before claiming a missing translation key) rather than
  pattern-matching from a bullet's title. A new recurring team pattern is
  added to `code_warning_patterns.md`, never inline into
  `code_warning.md` — that keeps the contract file stable and the checklist a
  one-file diff.
- **A finding the reviewer dismissed never comes back** (`modules/warndismiss`,
  `data/warndismiss.db`: `dismissed_warnings(pr, file, fingerprint,
  created_at)`). The check re-runs automatically on every ingest refresh with
  new code, and the supersede below wipes the previous findings first — so a
  resolved or deleted finding used to return as a fresh **open** comment on
  the very next run ("ik kan ai waarschuwing niet resolven of verwijderen").
  Neither existing store could answer this: a deleted comment leaves no row,
  and a resolved one is deleted by that same supersede.
  - **Identity is the finding's TEXT, not its line**
    (`warndismiss.Fingerprint`: lowercased, whitespace collapsed, sha256),
    keyed per `(pr, file)`. A later commit shifts lines; the text is what the
    reviewer judged. **Known limit, accepted:** a genuinely REPHRASED repeat
    gets a different fingerprint and surfaces again — normalisation only
    catches the near-identical wording, which is the common case for the same
    prompt over the same code.
  - **Two write points, both chosen to leave every workflow body's Activity
    order untouched** (tembed replays positionally, so an inserted step would
    break every still-open comment thread): the **resolved** half is recorded
    inside `supersedeFileWarnings` itself, right before it deletes a
    `Status == "resolved"` AI comment; the **deleted** half is the last step of
    `taskCodeCommentWorkflow`'s delete branch (`recordWarningDismissed`), which
    is safe because that branch **completes** the Execution — a deleted
    thread is never replayed. A supersede-driven delete carries
    `Source: "ai"` and is explicitly **not** counted as a dismissal: that is
    the check replacing its own findings, not a reviewer judging one.
  - **The filter** lives inside the existing `runAgenticReview` Activity
    (`dropDismissedFindings`, `code_warning.go`), not as a step of its own —
    same reason. Best-effort: a nil store or a read error passes every finding
    through, since a bookkeeping problem must never swallow a real risk.
  - Tests: `modules/warndismiss/warndismiss_test.go`,
    `TestCodeWarningSkipsResolvedFinding`/`TestCodeWarningSkipsDeletedFinding`
    (the latter also pins that an untouched finding still returns).
- **Auto-supersede, scoped per file** (`supersedeFileWarnings`, run **before**
  the agentic call): for each file in scope, every existing `Source:"ai"`
  comment on it is deleted via the **existing delete Signal** on its own
  Execution — best-effort per comment (an already-closed run can't be signalled
  and must not block the rest). A file **outside** scope keeps its old warnings.
- **Every warning is a normal `task_code_comment` Execution** — no new comment
  machinery: `createWarningComment` calls `StartCodeComment` with `Source:"ai"`
  + `Local:true` (never to GitHub) and `Author:"AI check"`. Being a full
  Execution, the reviewer can resolve or delete it like any other comment.
- **A finding never touches the reviewer's approval.** It used to retract the
  approval of the exact row it anchored to, once per `(pr, blockId, row)`
  (`revokeApprovalForWarning`/`markWarningRevocation` + `modules/warnrevoke`);
  all of that is **removed** — see "Placing a comment (or an AI finding) does
  NOT retract an approval" in `.claude/docs/approval.md`. An automatic risk
  check runs on every ingest refresh, so a recurring finding kept silently
  eating approvals the reviewer had already given.
- **Determinism:** the body only does `ExecuteActivity` calls in a fixed order
  (scope → supersede → the one Opus call → `createWarningComment` per finding),
  and every count comes from a **stored** Activity result — never a live check.
- **Frontend:** the same warning-triangle SVG as `related-covers-warning`, now
  as an `aiWarningBadge` pill; the Taken card shows the run as "Risk check" with
  either "searching the PR for risks…" or the **exact** number of findings —
  including "no risks found" — via `WorkflowRunView.WarningsFound`.
- Tests: `code_warning_test.go` (anchoring, the block-wide-first-row fallback
  — `TestAnchoredWarningFallsBackToBlockWideFirstRow`, exercising
  `anchoredWarning` directly rather than the whole workflow — PR-wide
  fallback, hallucination guard, supersede, the findings cap,
  `TestCodeWarningKeepsApproval`, and the automatic trigger
  firing/skipping-when-disabled/not-on-a-bare-rebuild),
  `modules/autowarn/autowarn_test.go`; the frontend badge/scoping side:
  `tests/comment-block-wide-anchor.spec.mjs`.
