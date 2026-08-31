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
  row → the LLM wins over a rebuild. A `notfound` row is protected **narrowly**:
  an incoming `unresolved` (the Go resolver still can't pin it) leaves it alone,
  an incoming `resolved` (a rebuild that *can* pin it now) still wins. It used
  to reset `notfound` → `unresolved` unconditionally, which stranded answered
  rows: the UI then showed a permanent "zoeken…" pill for a search nobody was
  running, because both triggers correctly refuse to re-ask (see "The search
  starts automatically server-side" below). `testcovers.UpsertGo` protects
  `notfound` **unconditionally** — deliberately different, there is no better
  static answer to let through for a class-level-only annotation.
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
  **One widening inside `keepChanged` itself:** a changed line sitting inside a
  call's still-OPEN argument list also pulls in the line(s) that OPENED that
  call, so a multi-line
  `$instance = new self(` + `sessionId: (string) $state['session_id'],` gives a
  child even when only that one argument line changed — the call NAME is on an
  untouched line, so the scan never used to see it and the reviewer got no
  underlying code for the very argument he edited (reviewer request,
  2026-08-21). `openParenLines` keeps a stack of "which line did this
  still-unclosed `(` open on" (quoted strings opaque, a `//`/`#` line comment
  ends the line, `#[` is an attribute — block comments deliberately not
  tracked), and ONLY those lines are added, never the whole statement: they are
  exactly the call names the changed argument belongs to, at every nesting
  level. It applies to every `keepChanged` caller (`resolveCalls`,
  `resolveTranslations`, `resolveConfigCalls`), which is intentional — a
  translation/config key inside the opening line of a call whose argument
  changed is the same situation. The frontend has its own, separate half of
  this rule for the CURSOR side (`argListSites`, see "Scoping to the navigation
  cursor" in `.claude/docs/underlying-code.md`).

  **The two sides deliberately keep one small difference, investigated and not
  unified.** `openParenLines` (Go) treats a `#` as a line comment (ending the
  scan on that line, `#[` is a PHP attribute, not a comment) because it runs
  over a block's real *source* text, where a genuine `#` comment can appear.
  `skipToArgListEnd` (JS, `src/home.mjs`) does **not** — it runs over *diff
  rows*, where a leading `#[Attribute(...)]` on its own promoted-property line
  is far more likely than a real `#` comment, and a real PHP 8 attribute's own
  parens are already balanced on one line, so treating `#` as a comment there
  would gain nothing. Checked against the real app worktrees (`data/worktrees/
  *-base`, 1400+ PHP files): **zero** genuine `#`-line-comments occur anywhere
  — every `#` is either `#[Attribute(...)]`, a hex-colour string literal
  (`'#F97316'`, opaque to both sides' quote-tracking), or a `#`-heading inside a
  heredoc prompt string (not PHP comment syntax at all, unhandled by both sides
  equally). Block comments (`/* */`) are untracked by both sides for the same
  reason: only `/** */` docblocks occur in practice, always *above* a
  statement, never inside a still-open argument list. So the JS side's choice
  to never treat `#` as a comment is deliberately the safer failure mode
  (over-counting: the argument-list scope can run a little too long, never too
  short) for input that is, in practice, never a real `#` comment — and even in
  the theoretical case, the two functions feed different systems (Go decides
  whether a call is scanned into a graph edge at all; JS only narrows which
  already-resolved child is *shown* for the current cursor), so a divergence
  between them can widen the UI's scoping, never fabricate or hide a graph
  edge. Conclusion: no shared implementation is worth the coupling this would
  add between the Go backend and the frontend `.mjs` — leave both as they are.

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
  **`$this->`/`self::`/`static::` inside an ANONYMOUS class** (e.g. every
  Laravel migration's `return new class extends Migration { ... }`) used to
  silently produce nothing at all, not even `unresolved`: `Block.Class` is
  `""` for such a method (`phpscan.go` has no stable name to key an anonymous
  class on — see the `resolveMigrationModels` bullet below), and
  `buildSymbolIndex` used to skip every `Class == ""` block from `idx.byClass`
  entirely, so `methodOnClass(idx, "", m[1])` always looked up an empty
  bucket. Fixed by indexing such methods separately, keyed by FILE instead of
  class name (`idx.anonMethods`, looked up via `methodInAnonClass`) — "own
  class" for a call inside an anonymous class body unambiguously means "this
  same anonymous class, this same file". Reported bug: a migration's private
  helper methods (`$this->renameIndex(...)`, called from `up()`) showed no
  Underlying-code card. Test: `TestResolveCallsAnonymousClassOwnMethod`.
- **1b — `parent::m(`.** Resolves to a method on the caller's PARENT class.
  `phpscan.go` now stamps every method `Block` with `Parent` (the class
  frame's `extends` target, via the new `classExtendsTarget` header scan —
  set for a named class AND an anonymous one alike, e.g. `new class extends
  Migration`), and `buildSymbolIndex` indexes it as `idx.classParent`
  (named class → parent, by short name) / `idx.anonParent` (anonymous class →
  parent, by file, mirroring `idx.anonMethods`). A `parent::m(` that resolves
  through that map to an indexed method → `resolved`; a parent the worktree
  index doesn't see at all (very often the case — a framework class like
  `Migration`/`Model`/`Command`/`TestCase`, `vendor` is skipped) or that
  doesn't declare `m()` → `unresolved`, same "call site is on a changed line,
  let the automatic search try" reasoning as rule 1's own unknown-method
  fallback, never silence. `parent::` had no rule at all before this — it
  simply matched nothing. Tests: `TestResolveCallsParentMethod`/
  `TestResolveCallsParentMethodUnindexed`.
- **2b — `new Foo(` → `Foo::__construct`,** keyed by the class short name so
  distinct constructions never collapse and `findCallSites` can match `Foo(`; a
  class with no explicit `__construct` gets no card. **`new self(` /
  `new static(`** resolve against the CALLER's own class (`b.Class`, or
  `methodInAnonClass` per file inside an anonymous class — exactly rule 1's own
  "own class" handling); they had no rule at all before 2026-08-21, so a static
  factory's `$instance = new self(...)` showed no constructor at all. Their call
  KEY stays the literal `self`/`static`, never the resolved class name: the
  frontend looks a key up as a literal in the caller's own text and
  `SessionState(` appears nowhere in `new self(`, so keying it by the class
  would create a card that is then scoped away at every diff granularity.
  `new parent(` is not PHP and has no rule. Test:
  `TestResolveCallsConstructorSelf`.
- **2b-bis — a `new Foo(...)` with no explicit chained call also shows the
  class's first OTHER method,** next to its constructor, on explicit request
  ("validate is de eerste method van MaxLengthWithoutHtml ... ik wil die dus
  ook als onderliggende blok zien"). The reported case is a Laravel validation
  Rule object handed straight to a `rules()` array
  (`new MaxLengthWithoutHtml(3000)`): the framework calls the Rule's real
  method (`validate`) through the `Rule` interface, so no call site for it
  ever appears in the caller's own source — only the constructor was ever
  visible, exactly rule 6c-bis's own reasoning for a bare `Foo::class`
  reference, now extended to this shape too. Reuses `classEntryPoints`/
  `KindClassFirstMethod`, key `class_method:<Class>` — same shape and same
  frontend rendering as 6c-bis, no frontend change beyond scoping (below).
  **Gated on "no explicit chained call"** (`chainedCallFollows` +
  `closingParenIndex`, a depth-tracked matching-paren scan mirroring
  `openParenLines`' char-scanning rules): `(new Foo)->m(` (rule 2, wrapped in
  parens) and PHP 8's unparenthesized `new Foo()->m(` are excluded — those
  already name the exact method in play, so a constructor + arbitrary first
  method beside it would be noise, the same trade-off 6c-bis's own doc comment
  argues for that shape. Not applied to `new self(`/`new static(` (the
  caller's own class, already visible in this file) or an Eloquent model
  (rule 2c owns that shape). Frontend scoping: `findCallSites`'
  `class_ctor:`/`class_method:` branch (`home.mjs`) now matches **either**
  the `Foo::class` literal (6c-bis's own origin) **or** the `Foo(`
  constructor-call literal (this rule's origin), so the card scopes to
  whichever form is actually in the caller's text. Tests:
  `TestResolveCallsNewObjectFirstMethod`,
  `TestResolveCallsNewObjectChainedCallNoFirstMethod`.
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
- **3b — a native enum method (`Foo::cases()`).** PHP declares
  `cases`/`from`/`tryFrom` for every enum itself, so no worktree block ever
  defines them and `methodOnClass` always misses. On an **indexed enum**
  receiver the child is the enum DECLARATION (`nativeEnumMethods` +
  `idx.enums`, exactly rule 6's shape with `child_method` = the method name,
  so the card reads `CustomerInclude::cases`). On any other receiver such a
  call — and more generally any name in `resolve_call.go`'s
  `vendorBuiltinNames` denylist (`isVendorBuiltin`) — resolves to **nothing at
  all**: it must NOT reach the unique-global-candidate fallback above, and
  `unresolved` is no better, since that same denylist records that neither
  Haiku nor the agentic Sonnet can ever find app code for these (the row would
  only offer a "Zoeken…" affordance that never finds anything). Same "silently
  nothing" trade-off as rules 6b/6c/8. Reported bug (PR 13381):
  `new MultipleIn(CustomerInclude::cases())` showed the wholly unrelated
  `Interval::cases` (`modules/Statistics/Enums/Interval.php`) as underlying
  code, purely because that was the only app symbol named `cases` and the
  fallback treats a single global candidate as certain. Tests:
  `TestResolveCallsEnumCasesCall`/
  `TestResolveCallsBuiltinStaticNoGlobalFallback`.
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
- **4a — `app(Foo::class)->m(`.** A container-resolved receiver names its own
  class literally, so the call is deterministic even though the bare method
  name is ambiguous app-wide. `reClassRefReceiver` is anchored at the END of
  the text preceding an `->m(` match, so it only fires for a `Foo::class )`
  sitting directly in front of that arrow (`app(...)`/`resolve(...)`/
  `make(...)` alike — the container function name is not checked, only the
  `::class` + `)`); the method is then looked up with `methodOnClass`. An
  unindexed class (vendor/framework) falls through to rule 4's ordinary
  unique-candidate/`unresolved` path unchanged. Runs INSIDE rule 4, before its
  `idx.candidates` fallback.
  Motivation is twofold and both halves are load-bearing: (1) `->run(`/
  `->handle(` on a container-resolved Activity is the single most common shape
  in this codebase's tests, and every one of them used to be shipped off to
  the LLM (`resolve_call`) to re-discover what the source already spells out —
  paid for, per call site; (2) that LLM row then raced rule 6c-bis's own
  entry-point row for the same class into a **duplicate card** in the
  Onderliggende-code panel (reported on PR 13392: `app(…Activity::class)
  ->run('_v2')` showed `CreateAndBackfillSubscriptionViewsActivity::run` twice,
  once badged "eerste method" and once "bron: haiku"). Go and the LLM were both
  right; the panel just had two rows for one target. Tests:
  `TestResolveCallsAppClassReceiver`/`TestResolveCallsAppClassReceiverUnknownClass`.
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
  with that constant → **silently nothing**, never `unresolved`.
- **6b-bis — a constant on the caller's OWN class** (`self::NAME`,
  `static::NAME`, or the caller's own class name). Rule 9 emits that
  declaration as its own member card — but **only** when this PR also changed
  the class's `<class-header>` block, so the own-class reference used to be
  skipped outright and resolved to silently nothing whenever there was no such
  block. The shape that made this visible is a Laravel migration's
  **anonymous** class (`return new class extends Migration`): it never gets a
  `<class-header>` block at all (`phpscan.go`'s `headerEligible`) and its
  `Block.Class` is empty, so `self` matched no indexed class either and
  `foreach (self::ATTRIBUTES as ...)` showed no underlying code.
  `ownClassConstDecl` therefore reads the caller's **own file**, walks to its
  class body's opening brace with phpscan's own `classHeaderName` (matching the
  class by short name, `""` meaning the anonymous one) and hands that body to
  the same `scanClassMembers` every other member rule uses — deliberately not
  via the symbol index, which by design cannot key an anonymous class. Same
  kind `const_ref`, same bare-constant call key, so the frontend needed no
  change and the card scopes to the `::NAME` line like any other reference.
  **Skipped whenever that file+class HAS a `<class-header>` region in the head
  worktree** (`memberHostFiles`): rule 9 owns the declaration there, and two
  cards for one declaration is worse than none. Deliberately the region in the
  worktree, not the presence of a `<class-header>` BLOCK in the PR — since
  `splitClassHeaderMembers` a class whose header holds nothing but members has
  no such block left, while rule 9 still covers it. Two classes in one file
  declaring the same constant → **silently nothing**, like every other Go-only
  rule here. Test: `TestResolveCallsOwnClassConstRef`.
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
  **Scoped to this rule and to 2b-bis's own `new Foo(...)`-with-no-chained-call
  case (see above) — not to model usage or an Activity stub:** those already
  point at the exact method (or model) in play, so a constructor + arbitrary
  first method beside it would be noise. Before 2b-bis this line read "Scoped
  to this rule ONLY", which was true until a plain `new Foo(...)` reference
  (no chained call — the framework invokes the real method through an
  interface, so no call site for it exists anywhere) needed the identical
  treatment; don't re-read that as still 6c-only. Both keys contain a `:`, but — reversed on
  explicit request, 2026-08-17 — are no longer in the frontend's
  `isBlockLevelCallKey`: the caller's line holds `Foo::class`, never a call to
  the method being shown, but that IS a real literal site (the same one rule
  6c's own `class_ref` child already scopes to), so `findCallSites` matches the
  class name against it and both cards are scoped to the selected group/line/
  call like an ordinary call, instead of staying visible regardless of the
  cursor. Tests: `TestResolveCallsClassRefEntryPoints`,
  `tests/related-class-ref-entry-points.spec.mjs`,
  `tests/related-class-ref-entry-points-scope.spec.mjs`.
  **Both rows stay in the read model even when the caller ALSO calls that very
  method** (`app(Foo::class)->run()` → this rule's `class_method:Foo` plus rule
  4a's `run`, both pointing at `Foo::run`): deduplicating server-side would
  have to guess which of the two the reviewer wants, and it could never repair
  a PR ingested before rule 4a existed. The frontend collapses them to one card
  instead — `preferredCallRows` in `home.mjs`, see "One card per resolved call
  target" in `.claude/docs/underlying-code.md`.
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
- **9 — class members (`resolveClassMembers`).** A class's declared members
  (trait uses aside) used to sit in one coarse `<class-header>` blob; since
  `splitClassHeaderMembers` (`phpscan.go`, see
  `.claude/docs/blocks-and-ingest.md`) **each member is a block of its own**.
  This rule points them at the class's changed **methods** as Onderliggende
  code, so `$listen` or `MAX_TRIES` sits next to the diff of whatever uses it:
  **every constant**, changed or not (explicitly requested — an untouched
  constant is reference material the reviewer wants to see), and **only a
  changed/added property** (an unchanged one is noise). A **removed** member is
  never emitted: it doesn't exist on the head side, and its own removed-side
  block already shows the deletion. Changed-ness comes from comparing the same
  region on the base worktree (`normalizeMemberText`; no base file → everything
  counts as changed), and rides on the **kind**: `class_property` /
  `class_constant_changed` / `class_constant`. Call key
  `class_member:const:<NAME>` / `class_member:prop:$<name>`.
  `scanClassMembers` (`phpscan.go`) does the splitting with the same lexer
  primitives as `scanPHP`, so a `;` inside a string/comment/heredoc/bracket pair
  never ends a statement — that is what keeps a multi-line array default one
  member. Silent limits: a grouped declaration (`const A = 1, B = 2;`) is one
  member named after the first name; an unterminated statement is dropped rather
  than swallowing the rest; an enum `case X = 'x';` and a `use Trait;` match
  nothing (the latter has rule 8). Same scope boundary rule 8 accepts: only the
  `<class-header>` region is scanned, so a constant declared **after** the first
  method is silently missed. **Two known, still-open holes (separate task, do
  not assume they are covered by anything above):** a `const` declared after
  the first method belongs to **no block at all** (the header region ends at
  the first `function`, and methods only cover their own spans), and an
  `interface` const gets no header block either (`phpscan.go`'s
  `headerEligible` excludes interfaces and anonymous classes) — in both cases
  the change is invisible in the review tree and counts in no approval total.
  An `enum` const is fine (measured with `scanPHP`).
  **A changed member IS a block**, so its entry composes to a real block id and
  the panel renders it with its own diff, approval and drill-down while its
  standalone index row is hidden as an ordinary resolved call target — an
  unchanged constant still composes to nothing and stays the read-only leaf
  card it always was (see `.claude/docs/underlying-code.md`).
  **The `CallerID`s are the class's changed, non-header, non-member top-level
  blocks — its methods** (`classSiblingIDs`, ALL of them when several changed,
  never a single "chosen" one). Only with no such sibling do they fall back to
  the class's own `<class-header>` block, and only if the split left one
  (`classHeaderBlockIDs`). The rule keys off the class's changed blocks, **not**
  off a stored `<class-header>` block, and reads the header region with
  `extractBlockSourceRaw`: a class whose header holds nothing but members has no
  header block left, and split, the region would only cover the part above the
  first member.
  **`headerHasOwnChange` is REMOVED** (with `swallowedClassHeaderIds` in
  `home.mjs`). It existed because a member card attached to a sibling is scoped
  to its usage site, so a changed constant referenced only from **unchanged**
  code showed nowhere in diff mode while the header holding its one changed row
  was hidden from the index and thus from every approval counter — Reindert:
  *"als een php constante is aangepast, maar het kan niet als onderliggende
  code ergens aan gekoppeld worden, laat het dan zien als losse blok wat ik moet
  goedkeuren"*. The split answers that structurally: an unreferenced member
  keeps its own visible, approvable index row, so the flag has nothing left to
  protect, and the +6-14% index noise its coarse "every header stays visible"
  fallback used to add is gone with it. Tests:
  `TestResolveClassMembers`/`TestResolveClassMembersAddedFile`/
  `TestResolveClassMembersAttachedToSibling`/
  `TestResolveClassMembersAttachedToEverySibling`/
  `TestResolveClassMembersChangedMemberAttachesToSibling` and
  `TestResolveCallsConstRef` (`callresolve_analysis_test.go`).
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
  **One dynamic-key shape IS resolved** — a sibling rule,
  `resolveEnumValueTranslations`, links `trans('prefix.' . $this->value)` /
  the `__()` alias, called from a block classified `ENUM`, to the key EVERY
  case of that BACKED enum resolves to at runtime: it reads the enum's own
  `case NAME = 'value';` declarations (`enumCaseValues`, a whole-file text
  scan — plug-and-pay convention is one enum per file, same simplification
  `resolveMigrationModels`/`resolveDataProviders` already make) and, for each
  case, appends its value to the static prefix and resolves that key exactly
  like `resolveTranslations` — via the shared `emitTranslationChildren`
  helper both now call — one child per (case × locale). Reported case:
  `OrderSummaryInclude::getLabel` returning
  `trans('includes.orders.' . $this->value)` showed "Geen onderliggende
  code." even though every case's key existed in both lang files. Deliberately
  narrow: only PHP's own backed-enum `$this->value` (not a custom accessor),
  only a static leading literal with no further concatenation, only
  `trans()`/`__()` (not `trans_choice`/`@lang` — no reported case needs
  them). **A resolved key from this rule has no literal for its FULL string
  anywhere in the caller** — only the static PREFIX is actually quoted in the
  source (the case's own value is never written out) — so `findCallSites`'
  `translation:` branch (`home.mjs`) matches EITHER the full key OR that
  prefix (the key with its last dot-segment stripped back to the trailing
  `.`), or `callScopeMethods`' `hideOutOfScope` filter would hide such a
  child at every diff granularity, reading exactly like the reported bug.
  Tests: `TestResolveEnumValueTranslations`/
  `TestResolveEnumValueTranslationsNonEnumSkipped`
  (`callresolve_analysis_test.go`), `tests/related-translation-enum-scope.spec.mjs`
  (fixture PR 129, `enumtranslation-*.json` +
  `materializeEnumTranslationWorktrees`) for the frontend prefix-matching fix.
- **Vue-i18n keys (`resolveVueTranslations`, `vuetranslations.go`).** The
  Vue-side sibling of `resolveTranslations`: a `$t('a.b.c')`/`$tc('a.b.c')`
  call on a changed line of a `.vue` block emits the **identical** shape —
  `CallKey translation:<locale>:<key>`, `Kind translation`, `ChildClass` =
  locale — so the frontend needs no change at all. Deliberately **only**
  `$t`/`$tc` (Vue's global "magic" helpers); a bare `t(...)` (the name
  `const { t } = useI18n()` returns) is out of scope — too common a short
  identifier to scan for safely. Two structural differences from the PHP rule,
  both because a Vue-i18n key carries no file information of its own (unlike
  `trans('file.key')`, where the first segment names the lang file): (1) the
  key is a plain dot-path straight into **one** big per-locale JSON blob
  (`sliceJSONKey`/`findKeyInJSONObjectBody` mirror `sliceLangKey`/
  `findKeyInArrayBody`, swapped to JSON syntax, and don't restrict the leaf's
  type — an array leaf, e.g. a pluralization form, is returned as its raw
  source text same as a string); (2) which JSON file to read depends on where
  the CALLING `.vue` file lives, not on the key — `candidateVueLocaleDirs`
  walks every ancestor directory of the `.vue` file up to the worktree root
  and collects **every** `locales`/`lang` subdirectory found (nearest first),
  because some app "domains" (e.g. `admin/src/domains/MediaLibrary`) ship
  their own `locales/{locale}.json` that gets `mergeLocaleMessage`'d into the
  app-wide instance at runtime — so a key can live in the domain's own file OR
  fall back to the app-wide one; `emitVueTranslationChildren` tries the
  candidates nearest-first per locale. A file with no reachable locales
  directory, or a key that's dynamic (a template literal, or followed by JS's
  `+` concatenation), silently produces no entry. Tests:
  `TestVueTranslationKeysIn`, `TestSliceJSONKey`,
  `TestCandidateVueLocaleDirsNearestWinsWithFallback` (`vuetranslations_test.go`).
- **Config values + `.env.example` (`resolveConfigCalls`).** Reviewer request:
  "als ik een `config(` code zie, wil ik als onderliggende blok zowel de config
  file/regel zien & .env.example zien (als dat is aangepast)". A
  `config('file.key.path')` call on a **changed line** surfaces the value
  declared in `config/<file>.php` (assumes the standard flat Laravel layout,
  `config/<fileSeg>.php` directly under the worktree root — reuses
  `sliceLangKey`, which despite its name/doc is fully generic: it only walks a
  `return [ ... ]` array, so a config file's bare values/`env(...)` calls parse
  the same way a lang file's quoted scalars do). Key `config:<key>`, `Kind
  config_value`, no locale concept (one config file per key, not one per
  locale) so — unlike `resolveTranslations` — a missing key produces **no**
  entry at all, same "silently nothing" as a missing config file. A dynamic/
  concatenated argument or the `config(['key' => value])` array-set form is
  skipped, mirroring `resolveTranslations`' own decoys.
  **`.env.example` sibling:** only emitted when the resolved config value
  itself reads a static `env('VAR', ...)` call **AND that EXACT `VAR=` line in
  `.env.example` was changed or added by this PR** — gated on the specific
  line via `changedNewLines`, not "the file changed somewhere" (explicit
  clarification from Reindert after the first draft of this rule gated on the
  whole file). `findEnvExampleLine` scans `.env.example` as plain `KEY=value`
  lines (not a PHP array, unlike the config file itself). Key
  `config_env:<key>` — must differ from the `config:<key>` sibling's own key
  since both share the same `(pr, caller_id, call_key)` primary key — `Kind
  env_example`, `ChildMethod` = the env var name. Frontend: both kinds are
  read-only **leaves** like `translation`/`const_ref` (`KIND_LABEL` words
  `config`/`.env.example`, no diffstat — not in `DIFFSTAT_KINDS`, since neither
  is ever itself a call target that "changed" or "didn't"), `findCallSites`
  couples both to the SAME literal (the quoted key string inside the caller's
  `config(...)` call — the env var name itself never appears in the caller's
  PHP source at all), and `resolvedCallTargetIds` skips both.

All of these are **merged** into the one `UpsertGo`/`Prune` call in the
`buildRelations` Activity (and in the headless `slash relations` twin), so they
share the keep set and need no prune scope of their own.

### `resolveTSCalls` (TypeScript, same-file, Go-only)

Everything above this point is PHP: `buildSymbolIndex` walks only `.php`
files, and every rule's regex is PHP syntax. `resolveTSCalls`
(`tscallresolve_analysis.go`) is a deliberately much smaller TypeScript
sibling, added alongside `tsscan.go`'s per-function block splitting (see
"`tsscan.go`: TypeScript function splitting (v1, functions only)" in
`.claude/docs/blocks-and-ingest.md`) so a resolved call actually shows up as
"Onderliggende code" — without it, splitting a `.ts` file into blocks alone
gets a reviewer nothing more than a shorter list of un-linked cards.

- **File-scoped, not worktree-wide.** No `symbolIndex` equivalent: for each
  changed/added top-level TS block, it re-scans that block's OWN file with
  `scanTSFunctions` to get the set of top-level function names declared
  there, and matches call sites only against THAT set — a call to a function
  declared in another file (an import) is not resolved. Matches the concrete
  request this was built for (PR 13538's `firePurchaseEvent`, called from
  `trackEvents` in the very same file) and keeps the v1 scope narrow, exactly
  like `tsscan.go`'s own "functions only, one file at a time" framing.
- **Only the caller's changed lines are scanned** — `changedNewLines` +
  `fileChangeSet.keepChanged`, the exact same line-scoping mechanism every
  PHP rule above uses (see the two scoping rules that apply to every rule
  under "Go resolution rules"), reused unchanged.
- **A match is `\bname\s*\(` on those changed lines** — the same shape
  `findCallSites`' generic fallback branch matches on the frontend
  (`home.mjs`, the bare-identifier regex at the bottom of the `if`/`else`
  chain), so `CallKey` = the bare function name needs **no frontend change**
  to scope/show the resulting card at the right group/line/call granularity.
- **`Kind` is left empty**, normalising to `method_call` on write exactly
  like every plain PHP call (rules 1-2) — no new `Kind` constant needed, and
  the frontend's existing `method_call` rendering/diffstat handling applies
  unchanged.
- **Go-only, on purpose — never `StatusUnresolved`.** An ambiguous or
  unmatched call is silently skipped, the same "silently nothing on a miss"
  precedent as the three rule-based extras just above
  (`resolveMigrationModels`/`resolveDataProviders`/`resolveTranslations`/
  `resolveConfigCalls`). This is deliberate, not a missing feature: emitting
  `StatusUnresolved` would let `autoStartResolveCall`'s automatic search (see
  below) pick it up and spend a Haiku call trying to resolve TypeScript code
  with prompts and a symbol index that only understand PHP.
- **Merged into the same `UpsertGo`/`Prune` call** as every PHP rule, at both
  call sites (`workflows.go`'s `buildRelations` Activity and the headless
  `slash relations` twin in `main.go`) — no separate prune scope, same as the
  rule-based extras.

Tests: `tscallresolve_analysis_test.go` (same-file resolution, an
expression-bodied arrow — which `tsscan.go` never turns into a block in the
first place — never appearing as a spurious caller, and a `.php` block never
reaching this path at all).

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
- **The three chat prompts also REQUIRE a fence** (`chat.md`,
  `chat_readonly.md`, `chat_shell.md`, one shared paragraph): whenever the
  answer shows what a piece of code looks like, the real lines go in a
  ` ``` ` block, and more than a few enumerated fields/lines belong in a fence
  instead of a row of backticked names. Added because the cap above, without
  it, pushed answers the other way — a "hoe ziet X eruit" question came back
  as prose full of inline-code pills and no code block at all. See "Emitting a
  fence at all is a PROMPT rule" in `.claude/docs/claude-chat-panel.md`.

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

### Why "Call zoeken" felt slow, and the three fixes (measured against PR 13381)

Measured directly from the tembed event history (`data/workflows.db`):
across 1089 completed `resolve_call` runs (all PRs) the median duration was
~29s, but p90 ~108s and p99 ~234s, with a max of ~51 minutes — a long tail. For
PR 13381 specifically (18 runs, 17 completed) two runs took ~11-12 minutes
each for only 3 calls, running **fully concurrently** with each other AND with
an unrelated agentic `code_warning` run. Three causes, all fixed:

1. **`resolveCallsWithModel` (`resolve_call.go`) used to call `claude` once per
   entry in `arg.Calls`, strictly sequentially** — a caller with N unresolved
   calls always cost N × (a single Haiku call, ~30s typical, `contextTimeout`
   90s cap). Now each call runs in its **own goroutine**; this is purely an
   internal speedup of the single `resolveWithModel` Activity — its result is
   still recorded as one event, so nothing about workflow determinism changes
   (a replay just reuses the recorded result, see
   `.claude/rules/workflow-determinism.md`).
2. **`tembed.Engine.StartWorkflow(ID)` runs a workflow with no blocking point
   fully synchronously on the calling goroutine** — there is no
   background-yield for a *live* start, only `Recover()` at startup
   prioritises (see `.claude/docs/tembed-workflows.md`). Two call sites relied
   on this without meaning to:
   - `handleResolveCall` (`tasks_api.go`) used to call `StartResolveCall`
     directly, so the HTTP response for the "Zoek" click hung until the whole
     LLM pass finished (minutes). It now starts the Execution in its own
     goroutine and returns the **deterministic** `resolveCallRunID(in)`
     immediately — the client tracks progress exactly like the automatic
     trigger already does (poll `/api/callresolve` + the `callresolve.changed`
     SSE event). A failed background start is only logged, mirroring
     `autoStartResolveCall`'s own best-effort handling.
   - `autoStartResolveCall`'s loop over `groupUnresolvedCalls` used to call
     `StartResolveCall` for each caller **in the same loop**, so caller N
     waited for every one of callers 1..N-1's full LLM pass to finish first —
     visible in the event history as runs starting at the exact millisecond
     the previous one ended. It now starts each caller's Execution in its own
     goroutine too.
3. **A shared, process-wide cap: `resolveCallSemaphore` (`resolve_call.go`), a
   buffered channel of size 4.** Fixes 1 and 2 both add concurrency (calls
   within a caller AND callers within a PR), which would otherwise multiply
   unboundedly — a big rebuild could try to run dozens of `claude` subprocesses
   at once. The cap is a single package-level channel, so it is shared by
   every concurrent `resolve_call` run, not one pool per run/Activity — every
   goroutine from both fixes 1 and 2 acquires a slot from the SAME pool before
   calling `cl.Run`. Chosen conservatively (4) rather than maximized: the
   measured PR-13381 outliers show this machine/account does not absorb a
   burst of concurrent `claude` processes for free (each call there ran ~7x
   slower than the ~30s typical), so a much higher cap risks amplifying that
   same contention instead of curing it; 4 still gives real parallelism for
   the common case of a caller with a handful of unresolved calls. Tests:
   `TestResolveCallsWithModelRunsConcurrentlyBoundedBySemaphore` (bounds
   `slow.maxConcurrent()` between 2 and 4), `TestHandleResolveCallDoesNotBlockOnTheLLMCall`
   (the HTTP response returns well under the LLM delay).

### The search starts automatically server-side

Right after `buildRelations`' `UpsertGo`/`Prune` (so via both `build_relations`
and the delta refresh), `autoStartResolveCall` groups the fresh scan's
`unresolved` rows **per caller** and starts one Execution **per goroutine**
(bounded by `resolveCallSemaphore`, see above) — the reviewer needn't open a
block first. **Fire-and-forget** (its own goroutine), so ingest never waits on
a live claude call. `StartResolveCall` is **idempotent**
(`resolveCallRunID` over `pr|callerId|sorted(calls)` — plus `|attempt=N` from the
second round on, see below), so the automatic trigger and the frontend's own
`startCallSearch` safety net can never both spend a call.

- **At most one search plus one retry per call, ever** (`maxResolveCallAttempts`
  = 2). `groupUnresolvedCalls` requires a call to be `unresolved` in the fresh
  scan **and** to have fewer than that many attempts in
  `resolveCallAttempts(pr)` — a **count** per `(callerId, callKey)` of every
  `resolve_call` input it ever appeared in, read from the event history, **not**
  from the read model's status (a status can be rewritten by a rebuild; the
  history never forgets, across any number of rebuilds and any restart).
- **The retry only fires for a STRANDED row**, never for an answered one:
  besides the attempt count, `groupUnresolvedCalls` requires the **stored**
  status (`storedCallStatuses`, a plain module read, taken after this rebuild's
  own `UpsertGo`) to still be `unresolved`. The fresh Go scan reports every
  unpinnable call as `unresolved` regardless of what the LLM answered, so
  without that second condition each rebuild would hand *every* answered call a
  second LLM pass. `notfound`/`found` (an answer survives, see `UpsertGo` above)
  and `searching` (a run is in flight) are left alone.
- **A retry needs its own Run ID, and that is the whole point.** A plain
  resubmit of the same set is by design an idempotent no-op, which is exactly
  why stranded rows could never repair themselves. `ResolveCallInput.Attempt`
  (the search *generation*) therefore joins `resolveCallRunID`'s key — **only
  when > 0**, so a generation-0 ID stays byte-identical to every ID minted
  before the field existed (an answered call must not silently re-run).
  Calls are grouped per `(callerId, generation)` so every call in one input
  truthfully shares that input's `Attempt`.
- **The retry lands on the next relations build of that PR**, not on a page
  load: reading the attempt counts walks the whole event history, which is far
  too heavy for the HTTP path. Deliberate choice (reviewer-approved) — the
  frontend trigger stays generation-0 only.
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

**`blockIdPrefix()` must read `state.allBlocks[0]`, never `state.blocks[0]`.**
`resolvedCallTargetIds`/`testCallTargetIds`/`callChildId` (`home.mjs`)
reconstruct a call-resolution row's child id as
`blockIdPrefix() + ':' + childFile + ':' + childClass::childMethod` to match it
against a real PR block id (`<pr>:<file>:<symbol>` for the primary repo,
`<repoKey>#<pr>:...` otherwise — see `model.go`'s `Block.ID()`).
`blockIdPrefix()` copies that prefix off an existing real block rather than
hardcoding `state.pr`, purely to also cover the non-primary-repo form. Reported
bug: a top-level block whose only resolved caller is a TEST method (the
`testCallTargetIds` exemption, see above) visibly jumped in and out of
"Onderliggende code" every ~5 seconds, with the reviewer just sitting there.
Root cause was reading `state.blocks[0]` — which is not always a real
block — instead: once the target sorts to the bottom under "Onderliggende
code", a synthetic `test_class` row (`testClassRowItem`/`groupTestClasses`, id
`testclass:<file>::<class>`, see `.claude/docs/test-class-grouping.md`) can
become `state.blocks[0]`, corrupting the prefix (literally `"testclass"`)
used to reconstruct the very childId that reclassifies the target — which
un-classifies it, sorting it back to the top, restoring a real
`state.blocks[0]` on the NEXT `recomputeLeftList()` call, and so on: a
self-referential feedback loop oscillating once per recompute (the
comment-poll's `indexComments()` watch alone already fires one every 5s, see
`RelatedPanel.mjs`'s `refreshTimer`). `state.allBlocks` holds only real PR
blocks (never a synthetic `test_class`/`comment`/push-todo row), so reading
its `[0]` instead is stable regardless of how the sidebar currently sorts.
Test: `tests/blockidprefix-testclass-flicker.spec.mjs` (PR 110's fixture,
mocks one `/api/callresolve` row, samples across three comment-poll ticks).

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
- **The search also starts automatically server-side**, mirroring
  `autoStartResolveCall` above: right after `buildRelations`' own
  `UpsertGo`/`Prune` of the testcovers rows, `autoStartResolveTestCovers`
  groups the fresh scan's `unresolved` class-level-only targets **per test**
  (`groupUnresolvedTestCovers`) and starts one `resolve_test_covers` Execution
  per group, fire-and-forget (its own goroutine) so `buildRelations`/
  `EnsureRelations`/`prStatusWorkflow`'s delta refresh never waits on a live
  claude call. `StartResolveTestCovers` is now **idempotent**
  (`resolveTestCoversRunID` over `pr|testId|sorted(classes)`, the same shape as
  `resolveCallRunID` — it used to be a bare `StartWorkflow`, non-deterministic
  Run ID, before this trigger existed), so the automatic trigger and the
  frontend's own `startTestCoverSearch` safety net can never both spend a call.
  Never re-submits an already-attempted `(testId, class)` pair, across any
  number of later rebuilds, for the same reason `groupUnresolvedCalls` doesn't:
  `resolveTestCoversAttempted(pr)` reads the durable event history, not the
  read model's own fluctuating status. Deliberately **not** gated by the "Live
  AI assistent" toggle (`autowarn`) — like `resolve_call`, this builds the
  navigation structure rather than describing anything. Deliberately
  server-only, same as `resolve_call`: the headless `slash relations <pr>`
  starts no search. Tests: `TestGroupUnresolvedTestCovers`,
  `TestResolveTestCoversRunIDStableAndSensitive`,
  `TestAutoStartResolveTestCoversOnBuildRelations`
  (`resolve_test_covers_test.go`).
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
  `.claude/docs/underlying-code.md`. At `gran==='line'` a `covers` child is
  kept when its own ANCHOR ROW is the selected row (the same anchoring the
  per-line badge uses) instead of dropping out with the rest — see "A `covers`
  child stays visible at `gran='line'` on its own anchor row" in that same
  file. `directChildBlocks`/`nestedPrBlocks`
  include **only direction 1**, to avoid a method↔test cycle in the recursive
  approval rollup. **Test coverage hides no block from the left list** — neither
  side: a tested method that is a PR block is always changed, primary reviewable
  code, so a test must never make it disappear. A **warning**
  (`related-covers-warning`) shows for an `unannotated` row, or a `notfound` one
  after a failed search, with different text per case; the "zoeken…" indicator
  reuses callresolve's own helpers (so it too shows only for a `searching` row,
  never for a merely `unresolved` one — see "Automatic LLM search for unresolved
  calls" in `.claude/docs/underlying-code.md`), and the search starts
  automatically from the same `setRelated` watch.
- Tests: `testcovers_analysis_test.go`, `resolve_test_covers_test.go`,
  `modules/testcovers/testcovers_test.go`, `tests/testcovers.spec.mjs` (seeded
  via `slash seed -testcovers <json>`).

## AI description of a code unit (`explain_code` + `modules/explanations`)

Generates the **footer description**: a short Dutch Haiku explanation of the
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
- **Flow:** `markExplainSearching` → `generateExplanation` (Haiku, context-only;
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

## Short titles for review comments (`comment_titles` + `comment_titles.go`)

Gives a **long comment** a heading: one Dutch sentence of **at most 6 words**,
generated by Haiku, rendered above the comment's own (then clamped) body. Born
from a screenshot of an AI-controle finding whose three sentences filled the
entire card, which made a comment column unscannable — see "A long comment gets
a generated title" in `.claude/docs/comments-panel.md` for the rendering side.

- **Batched, not per comment.** One Execution titles a whole set: the prompt
  numbers the comments `1..N` and the model answers
  `[{"n":1,"title":"…"}, …]`. A run per comment would start dozens of `claude`
  subprocesses for a one-line answer each. The **index**, not the comment id, is
  what the model echoes — an id like `cmt-1a2b…` it reproduces unreliably. The
  batch is capped at `maxCommentTitleBatch` (25) and each body clipped to
  `maxCommentTitleBody` (1200 chars) in the prompt; whatever doesn't fit rides
  along on the next request.
- **Storage is the existing comments read-model**, not a module of its own:
  `comments.title`/`title_status`/`title_body_len` (light `ALTER TABLE … ADD
  COLUMN`, same pattern as `avatar_url`). So the title arrives through the
  `GET /api/comments` poll the UI already runs — no new endpoint on the read
  side, no second polling channel. `status`: `searching`/`done`/`failed`
  (terminal — the frontend never re-asks for that exact body). `Save` preserves
  all three columns via `COALESCE` subselects, exactly like
  `reaction_count`/`status`/`github_id`: it is an `INSERT OR REPLACE`, so a
  re-save of the comment would otherwise silently drop the title.
- **Flow:** `markCommentTitlesSearching` → `generateCommentTitles` (Haiku,
  context-only; reads the bodies from the read-model itself, like
  `summarize_chat` reads its transcript) → `saveCommentTitles`. Three
  Activities, fixed order; the per-comment done/failed decision reads the
  **stored** Activity result, and the batch is sorted by id before anything
  iterates it (never a map range — see
  `.claude/rules/workflow-determinism.md`). The 6-word cap is enforced on our
  side in the save step (`trimToTitleWords`, a pure function), so a chatty model
  can't break the one-line heading.
- **Idempotent start** via `commentTitlesRunID` (`ctitle-` + sha256 over the PR
  plus the sorted `id:bodyLen` pairs), so the frontend may fire on every comment
  poll. `bodyLen` is what pins the **version**: the reviewer can edit their own
  comment, and an edit changes the length, which changes the Run ID and yields a
  fresh title instead of a deduped no-op keeping the stale one. Deliberately a
  length rather than a content hash — the same cheap fingerprint
  `summarize_chat` uses with its message count, computable in the browser
  without hashing, at the **accepted cost** of missing an edit that keeps the
  length identical.
- **Frontend-triggered, hence no backfill.** `loadComments` (`RelatedPanel.mjs`)
  collects every comment that `needsTitle` (body over `TITLE_MIN_BODY` = 90
  chars, no usable/searching/failed title, not a bare Claude-chat anchor) and
  POSTs `/api/workflows/comment_titles`. That covers comments written long
  before this feature existed by the very same path, so nothing has to be
  migrated. `lastTitleRunKey` keeps the 5s poll from re-POSTing an identical
  batch (the Run ID would dedup it server-side anyway, but a request per tick is
  still a request per tick).
- **Gated by the "Live AI assistent" switch** (`autoWarn.enabled`,
  `src/autowarn.mjs`) — this is automatic, unasked-for Claude work, exactly like
  `code_warning` and the footer's `explain_code`.
- Tests: `comment_titles_test.go` (batch, skipped comment → `failed`, dedup, an
  edited body, `Recover()` not re-running the LLM call, a vanished comment),
  `modules/comments/comments_test.go`'s `TestTitleRoundTrip`, and
  `tests/comment-title.spec.mjs` (render + the later-arriving-title key). A spec
  that wants to drive the real workflow can program the Fake through
  **`SLASH_CLAUDE_COMMENT_TITLES`** (the raw JSON array, keyed on
  `CommentTitleSystemPrompt` — mirrors `SLASH_CLAUDE_CHAT_SUMMARY`); the harness
  deliberately does **not** set it globally, since a canned answer would then
  put a title on long comments in every other spec.

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
  not a description. Also gates `autoStartKiloCheck` (`workflows.go`) — the
  automatic `claude_chat` conversation started on a freshly imported kilo-code
  review comment, see "A kilo-code finding gets an automatic verification
  chat" in `.claude/docs/workflows-comments.md`. See `.claude/docs/footer.md`
  and `src/autowarn.mjs`. Deliberately **not**
  `localStorage` (like the theme preference) or `settings.json` (read once per
  process — see `settings.go`): the toggle gates a **backend** decision that
  must be readable the instant the trigger wants to fire, so it rides the same
  one-Execution-per-repo Signal pattern as `pr_inbox`
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
- **A file already reviewed at its current content is skipped — no Opus call
  at all** (`modules/warnreviewed`, `data/warnreviewed.db`:
  `reviewed_files(repo, pr, file, hash, reviewed_at)`, same shape as
  `warndismiss` above). Reviewer request: "ik wil ai warnings alleen genereren
  op code wat niet eerder al gecontroleerd is door ai warnings flow" — the
  automatic re-run on every ingest refresh used to spend a full agentic Opus
  call on every changed file again, even one this same check had already
  looked at and found nothing new to say about.
  - **File-level, not line-level**: the identity is (repo, pr, file) → sha256
    of the file's HEAD content (`warnreviewed.HashContent`). Any change
    anywhere in the file — even one unrelated line — puts the whole file back
    in scope; `resolveWarningScope` already reasons per file, not per line.
  - `resolveWarningScope` hashes each candidate file's current head content
    (`hashHeadFiles`, `code_warning.go`) and drops it from `scope.Files` only
    when that hash equals what's stored (`filesNeedingReview`,
    `code_warning.go`) — so `supersedeFileWarnings` never even touches that
    file's existing comments, and the reviewer's earlier findings on it stay
    exactly as they are. If every file in the PR's changed-file scope is
    already reviewed at its current content, `scope.Files` comes back empty
    and `codeWarningWorkflow` returns `{"found":0}` before doing anything
    else — no supersede, no Opus call, whether the trigger was automatic or
    the manual "Diepgravend onderzoek".
  - **A file that can't be read right now (missing, worktree not ready, a
    permission error) is NEVER treated as unchanged** — `filesNeedingReview`
    only ever trusts a hash it could actually compute this run; an absent
    entry always means "review it again". Uncertainty must never silently
    skip a review — a redundant Opus call is the accepted cost, a missed
    finding is not.
  - **Recorded only after the agentic call actually ran**: `runCodeWarningReview`
    now also returns `ok` (true only when the Opus call itself succeeded, even
    with zero findings) — a CLI/model failure must not be recorded as "this
    file was reviewed". `runAgenticReview` (the Activity, `workflows.go`) then
    hashes and records (`warnreviewed.MarkReviewed`, an upsert) every file it
    was actually asked to review — i.e. `arg.Files`, the already-filtered
    scope. Best-effort like `warndismiss`'s own writes: a store read/write
    error only costs a redundant review later, never a missed one.
  - Tests: `TestFilesNeedingReview` (`code_warning_test.go`, the pure
    filtering decision), `TestCodeWarningSkipsUnchangedFile` (a second run
    makes no further Opus call and leaves the existing finding untouched),
    `modules/warnreviewed/warnreviewed_test.go` (store round-trip + repo
    scoping, mirroring `TestModulesAreRepoScoped`'s `warndismiss` coverage).
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
    being discarded, with `File` still set as a hint. The frontend now shows
    that `File` (+ line) as a mono chip in the comment detail card's header
    (`commentFileChip`, `RelatedPanel.mjs`, `data-testid=comment-detail-file`):
    such a finding has no block and no diff row, so without it nothing on the
    card said what the finding was even about. Generic over every kind, not
    special-cased on `ai_warning`; an empty `File` renders no chip.
- **More than `maxOrphanWarnings` (5) unanchored findings in one batch = a bad
  run: throw it away and review once more.** A whole batch landing PR-wide
  means the model's line numbers were off across the board, and the reviewer
  gets a PR-comment list full of findings pointing at nothing (the reported
  symptom). So `codeWarningWorkflow` counts them (`countOrphanWarnings`,
  `workflows.go`) right after `runAgenticReview` and, over the threshold,
  creates **no** comment from that batch, runs the new **`purgeOrphanWarnings`**
  Activity, and executes `runAgenticReview` a **second** time. Details that are
  deliberate:
  - **Exactly one retry**, and its result is created unconditionally — orphans
    included. A second bad batch is still worth showing, and looping on the
    outcome of an LLM call would be unbounded and expensive.
  - Deterministic despite the branch: the count comes from the **recorded**
    Activity result, so a replay takes the same branch and finds the same fixed
    number of Activities in the history.
  - `purgeOrphanWarnings` deletes every `Kind "ai_warning"` + `Source "ai"`
    comment of the PR through the same delete Signal `supersedeFileWarnings`
    uses, but **unscoped to the files under review** — that is the whole reason
    it exists next to the supersede: an orphan naming a file the PR doesn't
    touch (the model misremembering a path) matches no scope and would
    otherwise survive every later run and pile up.
  - **This is also the "a new commit landed" hook.** A commit never turns an
    existing warning into an orphan by itself — `Kind` is fixed at creation and
    `planCommentReanchor` skips every `Kind != ""` comment (`reanchor.go`), so
    re-anchoring only ever moves a block-scoped comment's `anchorState` — but a
    commit does re-run this workflow (`pr_status` →
    `autoStartCodeWarning`, see `.claude/docs/workflows-trackers.md`). So the
    check sits where the orphans are actually born, and needs no trigger of its
    own. Tests: `TestCodeWarningRetriesOnTooManyOrphans`,
    `TestCodeWarningKeepsOrphansAfterOneRetry` (`code_warning_test.go`, driven
    by `scriptedClaude` — the `claude.Fake` programs one fixed output per
    model, and both passes run inside a single synchronous Execution).
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
  `data/warndismiss.db`: `dismissed_warnings(pr, file, fingerprint, text,
  created_at)`). The check re-runs automatically on every ingest refresh with
  new code, and the supersede below wipes the previous findings first — so a
  resolved or deleted finding used to return as a fresh **open** comment on
  the very next run ("ik kan ai waarschuwing niet resolven of verwijderen").
  Neither existing store could answer this: a deleted comment leaves no row,
  and a resolved one is deleted by that same supersede.
  - **Identity is the finding's TEXT, not its line**
    (`warndismiss.Fingerprint`: lowercased, whitespace collapsed, sha256),
    keyed per `(pr, file)` — never per line, deliberately: a later commit
    shifts lines, and the text is what the reviewer actually judged. This
    fingerprint match is a **hard floor, enforced in Go**
    (`dropDismissedFindings`, run unconditionally after every agentic call):
    a near-identical repeat (cosmetic whitespace/case differences only) is
    always dropped, regardless of what the model does.
  - **On top of that hard floor, the finding's own TEXT is also stored**
    (`warndismiss.Add`'s `text` column, `warndismiss.List`) and handed to the
    model as prompt context (`warningReviewArg.PastDismissed`,
    `dismissedFindingsInScope` in `code_warning.go`, scoped to the files
    under review like `Existing` already is) — a second, **best-effort**
    layer that closes the accepted gap the hard floor still has: a genuinely
    REPHRASED repeat produces a different fingerprint and used to surface
    again, since normalisation only catches near-identical wording. The
    prompt lists every past-dismissed finding's file + text under a section
    telling the model to skip a new finding that makes essentially the same
    point, even reworded (`code_warning.md`'s matching rule, next to the
    existing "skip a duplicate of an existing comment" one for `Existing`).
    This is a judgment call, not a second hard filter — the model can still
    let a rephrased repeat through, unlike the fingerprint check. Scope
    stays per-file, not per-line, same reasoning as the fingerprint check.
    Tests: `TestListReturnsDismissedText`, `TestMigrateTextAddsColumnToExistingDB`
    (`modules/warndismiss`), `TestDismissedFindingsInScope`,
    `TestCodeWarningPromptsPastDismissed` (`code_warning_test.go`).
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
