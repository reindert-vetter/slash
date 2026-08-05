Additional, team-specific recurring risk patterns for plug-and-pay/plug-and-pay, distilled from thousands of real inline PR review comments by the team's most active reviewers. These EXTEND the review above — they never narrow it. Keep finding everything you would already find; treat this list as extra angles to also check, not a replacement checklist. Only report a pattern below when you actually find it in the diff/connected code, never because it is on this list. Every pattern below must still be verified by actually reading the relevant code with Read/Grep/Glob before you report it — do not pattern-match from a bullet's title alone (e.g. never claim "no test" or "missing translation key" without first checking).

## Backend (Laravel/PHP)

- No DB calls inside API Resources. Relation or DB access inside a `JsonResource` causes an N+1 on index endpoints. It should be wrapped in `Resource::whenInclude(Incl::X, fn() => ...)` so it only loads when actually requested.
- Respect module boundaries. A module reaching into another module's internals directly (e.g. `Modules\Forms\...` used from `Modules\Affiliates`, or a model that clearly belongs elsewhere) should go through an SDK or that module's `Client`/`Shared` facade instead.
- `sdks/` passes data, it doesn't hold Services. A real business `Service` class inside `sdks/` belongs in the module that owns the logic; the SDK's only job is carrying data across the module boundary.
- Missing tests, missing factories. A new endpoint, an N+1 fix, or a new business rule routinely needs a test, and a test that hand-builds fixtures usually needs a factory instead. Before flagging "no test", use Glob to check the module's own test directory for a test file matching the changed class/endpoint — only flag when you actually don't find one.
- Comment the why, only when it's non-obvious. A guard, an ordering, or a workaround that isn't self-evident from the code earns a one-line "why" comment; self-explanatory code should not have one added. This cuts both ways: also flag an unnecessary comment restating what the code already says.
- Magic literals move to config or an existing enum. A hardcoded day count belongs in `config()`; a raw string compared against known values belongs on an existing enum via `::tryFrom()`. A redundant `?? null` right after a `tryFrom()` call is a smell; the default should be passed as its second argument instead. Use Grep to check whether a matching enum/config key already exists before flagging this.
- Keep query and business logic out of controllers. A local variable built from a query directly in a controller method should move into a Builder or Repository, or be passed in as a parameter instead of being rebuilt inline.
- Routes live in the module's `Http/Routes/api.php`. A route registered somewhere else (a provider, ad hoc) makes the endpoint hard to find later.
- New relations need real foreign keys and cascade behavior. A pivot or relation table without FKs/`onDelete` leaves orphaned rows once the parent is soft or force deleted. Prefer `unsignedInteger`/`foreignId` over a bare `integer` for non-negative counters.
- Think through tenant and soft-delete edge cases. Any new relation or policy touching a tenant-scoped or soft-deletable model: what happens if the related row is soft-deleted, or the tenant is gone? A relation that still needs to resolve across a soft delete needs `withTrashed()`.
- Catch the specific exception. A broad `catch (\Exception $e)` around a specific external/API call should narrow to the exception class that call can actually throw; check the callee (Grep/Read) for what it actually declares or is documented to throw.
- Check for an existing helper before writing a new one. Before flagging a new parsing/formatting helper as fine, Grep for an existing `Request::macro` or shared helper doing the same thing.
- Mind the index, wrap multi-step writes in a transaction. Watch for a query losing its index benefit (e.g. `->max()` replacing an indexed backward scan) or an unnecessary extra subquery/join, and a "read, then write based on it" sequence that should be wrapped in a transaction to avoid a race.
- Use `static::`, not `self::`, in a method a subclass might override. `self::` always resolves to the defining class, even when called through a subclass; late static binding (`static::`) is what makes the override actually take effect. Check whether the class is actually extended anywhere (Grep) before flagging this as a real risk rather than a style nit.
- Mark Eloquent-model constructor properties `#[WithoutRelations]` on Notifications/Mailables. A queued notification serializing a model's loaded relations along with it has caused real incidents; the property should be annotated so only the model itself gets serialized.
- Don't let a Policy silently default-allow or default-deny an unhandled case. A blanket default in `view`/`update` etc. hides a real gap; an uncovered case should fail loudly (a 500) rather than quietly passing or blocking.
- Keep return types and property order consistent across sibling classes of the same shape. A family of Event/Data classes that model the same kind of thing should agree on nullability, return type, and property order; check the siblings (Grep/Read) before flagging a mismatch.
- A value repeated in more than one place belongs on the relevant enum as a method, not copy-pasted as a raw array/match statement wherever it's needed. Grep for other occurrences of the same values before flagging.
- Prefer `->when($condition, fn (Builder $q) => ...)` for conditional query building over branching outside the query chain.
- Destructive/irreversible migration steps (a `DROP`) are a real risk to flag whenever a migration file in the current changed-file scope contains one alongside unrelated feature-code changes in that same scope — a `DROP` ships best on its own, so its blast radius isn't tied to a feature rollback. Only flag when you can actually see a `DROP` in a migration file that is part of this review's scope; do not speculate about a separate PR or history you cannot see.
- Seeders use the existing model Factory, not hand-built records; same rule as tests, and it applies just as often here.
- A seeder/script that gets run repeatedly needs to clean up its own related rows, not just the primary ones, or reruns leave orphaned data behind.

## Frontend (Vue/TS)

- Don't fight auto-import. An explicit `import` for something the build already auto-imports (a composable, a component) should be removed; check the project's auto-import config/convention (Grep for how sibling files reference the same composable) before flagging.
- Use the established data-fetching composables. A manual `fetch` wrapped in `try/catch` should go back to the codebase's `useFetchIndex`/`useFetchShow`, with its own `{ error }` destructure. Grep for these composables' existing usage before assuming they apply here.
- Dedupe near-identical view logic into a composable. The same logic repeated across sibling tabs/views (e.g. "active" vs. "completed") should move into a shared composable instead of being copy-pasted; check the sibling file to confirm the duplication is real before flagging.
- Reuse `util/datetime`. "Tomorrow", "now", date formatting: check that helper file (Grep/Read) before flagging a hand-rolled date computation as fine.
- Remove redundant reactivity. A `ref()` around something already reactive, or a `watch` callback with no real condition guarding it, should be simplified.
- Don't read `props.x` or a ref's `.value` directly inside `<template>`. Both are automatically unwrapped/exposed there; they should be referenced through a `computed` in `<script setup>` instead.
- Don't give a local ref/computed the same name as an existing prop. Vue's template resolution prefers the prop, so the local one silently never takes effect; this is a real, easy-to-miss bug, not just a style nit. Confirm the name collision by checking the component's `defineProps` before flagging.

## Tests

- Assert the actual outcome, not just a count. `assertJsonPath` and a status-code check should sit alongside `assertJsonCount`, checking the specific id/value, not only that the shape looks right.
- `ignoreException()`, not `expectException()`, when asserting afterward. `expectException()` stops the test at the exception, so anything asserted after it silently never runs; this matters whenever a test both expects an exception and still wants to check the response status.
- Cover the edge cases, not just the happy path. A tenant-isolation case (acting as a different tenant), a `null`-vs-empty-string case, and "does the filter also apply when X" for a new query parameter are all recurring gaps worth checking for.
- No body on a `DELETE` request unless the endpoint genuinely needs one.
- Missing tests, missing factories; same rule as backend, comes up just as often here. Check the module's test directory (Glob) before flagging.
- Check for an existing test covering the same scenario before adding a new one. Grep the test directory for a similarly named test method before flagging a new test as a duplicate.
- Put the unauthorized/404 case first in the test file. It's usually the first thing worth checking for an endpoint, so it reads better leading the file rather than buried after the happy path.

## Copy & translations

- `en.json`/`nl.json` parity. A key added to one locale and not the other, in either direction, is a real, verifiable gap: Grep the sibling locale file for the exact key before flagging a missing translation. Only flag when you have actually confirmed the key is absent from the other file, not just absent from the diff.
- Match tone, formality, and tense to the copy around it. Dutch formality ("we're generally not this formal" for the surrounding file), English verb tense (present-perfect vs. simple-past, depending on whether the situation still holds), and consistent terminology within one file ("this rule" vs. "the rule").
- Keep punctuation and ordering consistent with sibling keys. Same casing, same closing punctuation, roughly alphabetical placement where the surrounding keys already are.

## Naming

- Name the positive state, not its negation. `isEnabled` over `isDisabled`, `isFirst` over `isNotFirst`, `isQualified` over `isUnqualified`, `isActive` over `isBroken`, even where the negative reads more naturally at one call site.
- One name per concept, within a file. Two names for the same thing in one PR, or a name that doesn't match what it actually returns, is worth flagging.
- Clear out dead code you notice along the way. Not just what the diff itself added: a now-unused method, import, or translation key nearby too. Confirm it is actually unused (Grep for other references) before flagging.
- Match the capitalization the tool/vendor itself uses (e.g. "ClickHouse", not "Clickhouse" or "clickhouse"); consistency with how the thing spells its own name.
