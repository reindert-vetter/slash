# The "Underlying code" card (`RelatedPanel`)

`RelatedPanel.mjs`'s default export, `data-testid=related-code`: the child blocks
of the currently focused column — relation children, resolved method calls, and
test-coverage links — as small Prism-highlighted excerpts. Sits directly right of
the block column in `<main>`'s flow (see `.claude/docs/detail-layout.md`);
`Enter`/click on a child drills it open as its own column
(`.claude/docs/drilling.md`).

## The children and their badges

Each child is one card (`data-testid=related-item`). It follows
`focusedBlock()`, so it moves along with a drilled column.

- A **relation child** carries a kind badge (`listener`, and the other
  `KIND_LABEL` words for the Laravel request chain), fed from the relations read
  model via `GET /api/relations?pr=N`. `home.mjs`
  (`childrenOf`/`relatedChildren`) pulls the children from `state.allBlocks` and
  lazily loads their code. See "Relations between blocks" in
  `.claude/docs/workflows-analysis.md`.
- A **method call** (`kind=method_call`, from `GET /api/callresolve` — code +
  descriptor sit in the row, so no extra fetch) has no word badge but a **diff
  stat** (`data-testid=related-diffstat`): `+A −R` (green/red, added/removed lines
  of the called definition, via `diffStat` in `Block.mjs`, git-`--stat` style), or
  a gray **`Unchanged`** badge when the call points into a file the PR doesn't
  change (`r.diff` is `null`). Only calls on **lines the PR changed** get a row
  (plus the call whose argument list a changed line sits inside — see
  `keepChanged`'s open-paren widening in
  `.claude/docs/workflows-analysis.md`); **enum cases** (`AddressType::BILLING`) resolve to their enum declaration. See
  "Resolving (also unchanged) called methods" in
  `.claude/docs/workflows-analysis.md`.
- **Test coverage**, both directions, from `GET /api/testcovers`: `kind=covers`
  (a test block shows the tested method, same diff stat/`Unchanged` badge as
  `method_call`) and `kind=covered_by` (a tested production method shows "covered
  by TestX::testY", reusing the existing test PR block). Both are **block-level**
  and thus drop out at `gran==='line'`/`'call'`. A test without a usable coverage
  annotation shows a **warning** in the card header instead of a child
  (`data-testid=related-covers-warning`, custom inline SVG + explanation — never
  an AI guess). See "Linking test coverage" in
  `.claude/docs/workflows-analysis.md`.
- A **class member** — a class's declared properties/constants (kinds
  `class_property`/`class_constant_changed`/`class_constant`), plus a
  `Foo::MAX_TRIES` reference resolved to its declaration (`const_ref`) — which
  also covers a reference to the caller's **own** class (`self::ATTRIBUTES` in
  a migration's anonymous class, which has no `<class-header>` region for the
  member cards to come from; see rule 6b-bis in
  `.claude/docs/workflows-analysis.md`).
  **A member the PR CHANGED is a real PR block** since
  `splitClassHeaderMembers` (`phpscan.go`, see
  `.claude/docs/blocks-and-ingest.md`), so such a child is no leaf at all: it
  falls through to the ordinary call-target branch of `resolvedCallChildren`
  and carries its own diff, approval, drill-hint chips and drill-down, and its
  standalone index row is hidden by the ordinary `resolvedCallTargetIds` path
  once something references it. Only a member that is **not** a block — an
  UNCHANGED constant, kept as reference material — is still a read-only
  **leaf** like `translation`: no diff stat, no approval, no drill-hint chips,
  and no row of its own in the index (it never had one). The old blanket
  `CLASS_MEMBER_KINDS` skip in `resolvedCallTargetIds` is gone, and the leaf
  branch in `resolvedCallChildren` now only fires when no PR block matches the
  composed child id. Which members
  appear (every constant, only changed properties) and why: "9 — class members"
  in `.claude/docs/workflows-analysis.md`.
  Since they sit side by side, each of the three header kinds carries a **word**
  badge — `Gewijzigd`/`Ongewijzigd` (`data-testid=related-member-status`,
  `memberStatusBadge`); colour is decoration only. `const_ref` deliberately gets
  no such word: it is pure reference material, and calling it "ongewijzigd"
  would assert something that rule never checked. Drilling into one is left on
  the default path (`resolveChildBlock` builds a synthetic read-only frame from
  the embedded code). Test: `tests/related-class-members.spec.mjs` (mocked
  `/api/callresolve` on PR 91, like `callresolve-live-update.spec.mjs`).
  **The callers are the class's changed METHODS.** `resolveClassMembers`
  attaches its member entries to every changed, non-header, non-member
  top-level block of the SAME class/file in this PR (`classSiblingIDs`,
  `callresolve_analysis.go`) — several changed siblings all get the SAME member
  cards, there is no single "chosen" host. Only when no such sibling exists do
  they fall back to the class's own `<class-header>` block, and only if the
  split left one (`classHeaderBlockIDs`).
  It keys off the class's changed blocks, **not** off a stored `<class-header>`
  block: a class whose header holds nothing but members has no header block
  left at all, and the rule must still run for it.
  **Two mechanisms this replaced, so nobody reintroduces them:**
  `headerHasOwnChange` (keep a header whose OWN member changed as its own
  caller) and `swallowedClassHeaderIds` (hide a header block from the index
  once its members landed on a sibling) are both **removed**. Both existed for
  one reason — a changed member attached to a sibling is scoped to its usage
  site, so a constant used only from unchanged code showed nowhere in diff mode
  while the header holding its changed row was hidden from every approval
  counter. A member block now always carries its own approvable rows, whether
  or not anything references it, so the caller is unconditionally the changed
  siblings and a `<class-header>` block is never hidden: what is left in it (a
  class's `use Trait;` statements) is real changed code that keeps its own
  approvable row. Tests:
  `TestResolveClassMembersAttachedToSibling`/
  `TestResolveClassMembersAttachedToEverySibling`/
  `TestResolveClassMembersChangedMemberAttachesToSibling`
  (`callresolve_analysis_test.go`), `tests/related-class-header-sibling.spec.mjs`
  (PR 114: a referenced member block, an unchanged constant, and a header with
  no member cards).
  **Attached to a sibling, a member card is now itself scoped to the selected
  group/line/call** — sharpened on explicit request, since attaching to
  *every* changed sibling used to also mean showing on every one of that
  sibling's groups/lines regardless of whether the member is actually used
  there ("gerelateerde constanten en properties wil ik alleen zien als het te
  maken heeft met de geselecteerde groep/regel", Reindert).
  `callScopeMethods`/`findCallSites` (`home.mjs`) treat `class_member:` as
  block-level (`isBlockLevelCallKey`, never scoped away) **only** while the
  caller is the `<class-header>` block itself (the no-sibling fallback above,
  where the member's declaration line IS the header's own diff and there is
  no other usage site to look for); attached to a sibling they instead match a
  real usage site — the bare member name as a property access (`->name`) or a
  constant/static-property access (`::name`/`::$name`) inside that sibling's
  code — and hide/show exactly like an ordinary resolved call at every
  granularity. A member never referenced anywhere in a given sibling
  disappears there in diff mode entirely (no fallback to a
  `<class-header>` card) — which used to be the reason a CHANGED member was
  kept off a sibling altogether (`headerHasOwnChange`, removed above): the same
  scoping hid a changed constant whose only usage site sits on unchanged code.
  That no longer costs anything, because the member is its own approvable block
  in the index whenever nothing references it; **list mode is unaffected** (no active cursor to
  scope by, same as every other call type) and keeps showing the full
  reference list. Test: `tests/related-class-member-scope.spec.mjs` (PR 115).
- A **`config('file.key.path')` call** — the value declared in
  `config/<file>.php` (`kind=config_value`), plus an optional **`.env.example`**
  sibling (`kind=env_example`) shown only when that value reads a static
  `env('VAR', ...)` AND that exact `VAR=` line in `.env.example` was itself
  changed/added by this PR (not "the file changed somewhere" — gated on the
  specific line). Same read-only-leaf shape as `translation`/`const_ref` (no PR
  block, no diff stat, no approval, no drill-hint chips, never a row of their
  own in the block index), badges `config`/`.env.example`. See "Config values +
  `.env.example`" in `.claude/docs/workflows-analysis.md`.
- The **entry points of a referenced class** — next to the `<class-header>`
  card a bare `Foo::class` already produced, its `__construct`
  (`class_ctor`, badge "constructor") and its first other method
  (`class_first_method`, badge "eerste method"), see "6c-bis" in
  `.claude/docs/workflows-analysis.md`. **The first-other-method card alone
  (no `class_ctor` sibling, since rule 2b already shows the constructor)
  also appears next to a plain `new Foo(...)` construction that has no
  explicit chained call** — rule "2b-bis" in the same doc, reported case: a
  Laravel validation Rule object handed straight to a `rules()` array
  (`new MaxLengthWithoutHtml(3000)`), whose real method (`validate`) is only
  ever invoked by the framework through the `Rule` interface, never by a
  visible call in the caller's own source. A `(new Foo)->m(`/PHP 8's
  unparenthesized `new Foo()->m(` — an explicit chained call — gets no such
  card, same "already points at the exact method" reasoning as the
  `Foo::class` case. Both origins are shown **even when this PR changed
  neither** — the header/constructor alone says too little about what a
  class is — and both behave like an ordinary call into an unchanged file
  (diffstat or `Ongewijzigd` badge, no index row of their own taken away: a
  method this PR DID change keeps its own row and shows here as well). Tests:
  `tests/related-class-ref-entry-points.spec.mjs`,
  `TestResolveCallsNewObjectFirstMethod`/
  `TestResolveCallsNewObjectChainedCallNoFirstMethod`
  (`callresolve_analysis_test.go`).
  **Scoped to the selected group/line/call like an ordinary call** (reversed
  on explicit request, 2026-08-17): both cards now only show while the
  `Foo::class` reference itself sits within the selected unit — no longer
  block-level/always-visible regardless of the cursor. Before this, selecting
  an unrelated call/line elsewhere in the same block still showed them, which
  read as "this call resolves to that method" with no actual relation between
  the two (reported bug: selecting `$request->isPartner()` still showed
  `CommissionRepository::getAsPartner` as "eerste methode"). List mode is
  unaffected (no active cursor to scope by). Test:
  `tests/related-class-ref-entry-points-scope.spec.mjs`.
- An **approval badge** (`data-testid=related-approval`, `done/total`, green + ✓
  when fully approved) on any child that is itself a PR block, rendered in that
  child's own header (`approvalBadge`). Per-child only — there is **no**
  panel-header rollup element (no `related-approval-total` testid; an earlier
  version of this doc claimed one). A call into an unchanged file has no approval
  concept and no badge. Counts ride along on the descriptor (`approve`, filled by
  `relatedChildren`/`resolvedCallChildren` via `blockApproveCount`); the same
  `{done,total}` also feeds the sidebar pill — see
  `.claude/docs/approval.md`.
- **An eye glyph** (`viewOnlyBadge`, `data-testid=related-view-only`) in the
  same header slot whenever the card has **neither** an approve counter
  (`approvalBadge`) **nor** a comment avatar (`commentActivityBadge`) —
  reviewer's own wording: "als er geen avatar aanwezig is en geen aantal
  approved aantal regels is, laat dan een oogje zien". That is exactly the
  reference material: a call/covered method into a file this PR doesn't change,
  and the read-only class members — reachable (since reference units, also from
  an UNCHANGED line: see "Reference units" in
  `.claude/docs/keyboard-navigation.md`) but never approvable. Colourblind
  rule: the meaning sits in the SHAPE plus its title text, the glyph is drawn
  in the ordinary neutral slate/zinc.
- A child found by an LLM carries a **`source: haiku/sonnet`** badge;
  Go-resolved children show none.
- Selecting an `Unchanged` child gets the same indigo border as any other selected
  item. An earlier version gave it a gray ring even while selected ("nothing to
  review"); that exception was dropped — the app has one single
  blue-selected/gray-unselected border rule (see "Focus highlight per stop" in
  `.claude/docs/keyboard-navigation.md`), and the `Unchanged` **text** badge
  still carries that signal.

### The card looked fine in dark mode but not in light mode — the border rule was never the bug

Reviewer report: this card's selected/unselected border "isn't good" in light
mode, while dark mode (with the identical border classes) already looked
right. The border itself was a red herring: `relatedCard`/`nestedChip`/
`testsBar` already used the exact same `border-indigo-300 …`/`border-slate-300
…` pair as `Block.mjs`'s `diffActive` border (see above) — byte-for-byte,
confirmed in source. The actual cause was the card's own **background**:
`bg-slate-50/60 dark:bg-zinc-800/40`. `index.html`'s `<body>` is
`bg-slate-50 dark:bg-zinc-950`, so in light mode a translucent `slate-50/60`
laid over a `slate-50` page is almost exactly the page's own colour — the card
had no visible background of its own to show a border against, selected or
not. In dark mode `zinc-800/40` over `zinc-950` reads clearly lighter than the
page, so the same card had a real background there and looked fine. Confirmed
with side-by-side screenshots against a live PR (forced-selected vs default,
light vs dark) before touching anything: switching only the light half to a
solid `bg-white` (matching `Block.mjs`'s own card background) made the card —
and its border, unmodified — pop exactly like the dark-mode version, with zero
change to the border classes. Fixed on all three call sites that share this
background (`relatedCard`, `nestedChip`, `testsBar`); `dark:bg-zinc-800/40` is
untouched everywhere. **Don't re-diagnose this as a border-color issue** — the
border rule is fine and shared app-wide; check a card's own background against
the page background first when a selection highlight "doesn't show" in one
theme but not the other.

In the card header the **title (`class::method`) is always visible** (gets the
first line, truncates only at extreme length); the **file path** sits below it on
its own line and truncates.

A **relation child** also stays in the left list as a fully navigable row (own
diff, selection, `?sel=` restore) but sorts to the very bottom under an
**"Onderliggende code" heading** (`data-testid=underlying-heading`,
`BlockList.mjs`), marked via `state.underlyingIds` (a plain `{blockId: true}` map,
reassigned wholesale alongside `state.blocks`). The PR-wide approval header skips
those rows when summing `state.approvalTotal` (already counted in their parent's
subtree).

`recomputeLeftList` (`home.mjs`) determines the left list: `state.blocks` =
`allBlocks` minus any **PR block that is the definition of a resolved/found method
call** (`resolvedCallTargetIds`, including a relation child that is also such a
target) — so a function shown as "Underlying code" under a parent doesn't *also*
appear separately in the left list. It runs on `loadBlocks` and after every
`loadCallResolve`, preserving selection by **block id** so a reload doesn't shift
the cursor.

**Exception, symmetric with `testCoverTargetIds`:** a resolved-call target whose
**caller is a TEST block** (`testCallTargetIds`, `home.mjs`) — a test literally
calling the production method it exercises, as opposed to only covering it via a
`@covers` annotation — is exempt from `resolvedCallTargetIds`'s hidden set. Such a
target is always primary, reviewable PR code (e.g. the very action a new test
method is added for), never incidental reference code, so a test resolved-calling
it must not make it vanish from the index — the same reasoning that already kept
`testCoverTargetIds` out of the hidden set. Instead of merely staying visible at
its ordinary category rank, it joins `state.underlyingIds` alongside relation
children (`recomputeLeftList`'s `childIds`), so it sorts to the bottom under the
same "Onderliggende code" heading. Before this exemption, a PR consisting only of
a changed production method plus new tests for it showed a single index entry —
the test class — with the actual changed code hidden entirely, reachable only by
drilling from the test's own Onderliggende-code panel.

**A `testCallTargetIds` row with a CONFIRMED zero approval total gets no index
row at all.** Such a row's card already shows no checkbox (see "A block with
zero changed rows has nothing to approve" in `.claude/docs/approval.md`), so
giving it its own "Onderliggende code" index slot on top of that is a dead
entry with nothing to do — reported on PR 13392's
`DeleteTenantSubscriptionsActivity.php` (a real, whitespace/trivial-only diff
called from a test). `recomputeLeftList`'s `visibleBlocks` filter drops a
`testCallTargetIds` member whenever `state.blockTotals[b.id] === 0` (strict,
not falsy — `undefined` means the stats haven't loaded yet, so the row stays
visible until the real number is known); `loadBlocks` re-runs
`recomputeLeftList` a second time once `loadBlockStats` lands, since the first
run happens before `state.blockTotals` is filled. The block stays in
`state.allBlocks`, so it's untouched everywhere else: the Onderliggende-code
panel still shows it and it still drills open.

**Deliberately scoped to `testCallTargetIds` only, not every `childIds`
row.** An ordinary relation child (`state.relations`) only exists between two
blocks that BOTH changed (see "Relations between blocks" in
`.claude/docs/workflows-analysis.md`), so a confirmed-zero relation child
should never occur for real ingested data — applying the filter there too
turned out to only catch fixture/test-support blocks with no real diffable
source (several existing specs seed a relation child living outside any real
worktree), a testing artifact rather than a real "nothing to approve" case.
`resolvedCallTargetIds`'s ordinary (non-test) call targets are unaffected
either — those already hide outright as pure reference code, never gaining an
index row in the first place. An ordinary top-level block with total 0 also
keeps its own index slot, per the general "zero changed rows" case in
`.claude/docs/approval.md` — only a `testCallTargetIds` row loses it.

## One card per resolved call target

Two DIFFERENT call keys of one caller can resolve to the very same definition,
and the panel used to render that as two identical cards. The real case
(reported on PR 13392) is `app(Foo::class)->run('_v2')`: rule 6c-bis emits the
class's entry points (`class_method:Foo` → `Foo::run`, badged "eerste method")
while the `->run(` call itself is its own row — so
`CreateAndBackfillSubscriptionViewsActivity::run` showed up twice, once as
"eerste method" and once as "bron: haiku". Both rows were correct; there was
just no rule saying one target gets one card.

`preferredCallRows(b)` (`home.mjs`) is `callRows` minus the losers: it groups a
caller's `resolved`/`found` rows by their target (`callTargetKey` — file +
class + method) and keeps the best-ranked row per target (`callRowRank`, lowest
wins):

1. **a real Go-resolved call** — its call key IS the literal in the source, so
   it scopes to the actual call segment and carries the call arrow;
2. **a Go-resolved synthetic entry point** (`class_ctor`/`class_first_method`,
   keyed to the `Foo::class` literal instead);
3. **an LLM-found row** (`status: 'found'`) — deterministic Go resolution beats
   a model's, on explicit request ("de Go-rij blijft").

Ties keep source order, and a row with nothing to point at (an `unresolved`
call, a class-level row with no method) is never deduplicated.

- **Used by `resolvedCallChildren` AND `callArrowPairs`, deliberately both** —
  an arrow must never point at a card the panel no longer renders (the same
  rule the scoping section below states for `hideOutOfScope`).
- **Every other `callRows` consumer keeps the raw rows.**
  `directChildBlocks`, `lineChildSummaries`, `resolvedCallTargetIds`,
  `firstUnapprovedCallSiteInUnit` and `referenceRows` all collapse their rows
  onto the target BLOCK id via a Set/Map already, so a duplicate row is
  harmless there — and dropping it would cost them a real call site (the
  approve-through-call walk still needs to know about both the `Foo::class`
  literal and the `->run(` segment).
- **The backend now prevents the common case at the source, but this stays.**
  `callresolve_analysis.go`'s rule 4a resolves `app(Foo::class)->m(`
  deterministically, so no LLM lookup is requested for it any more (see
  `.claude/docs/workflows-analysis.md`). That fixes newly ingested PRs only —
  a PR ingested before it still carries the stored `found` row — and it does
  not remove the entry-point row, which is exactly the duplicate this function
  drops. Ranking 1 above 2 also means the surviving card is the deterministic
  one on such an older PR.

Test: `tests/related-duplicate-call-target.spec.mjs` (fixture PR 122,
`duptarget-*.json` + `materializeDupTargetWorktrees`), which seeds both
branches: one target covered by an entry point + an LLM row, another by an
entry point + a Go-resolved real call.

## "loading code…" vs. "no code found"

Every child descriptor carries a `loading` flag, set in `home.mjs` (the
`setRelated` watch chain) — **never** by `RelatedPanel` reading `b.code`. For a
**lazy** PR-block child (relation child/`covered_by`) it's `!kid.code`
(`ensureCode` always sets `kid.code` to an object once the fetch completes, even on
error: `{error}`); for an **embedded**-code child (`method_call`/`covers`, code
sits in the callresolve/testcovers row) it's hard `false`.

`relatedCard` renders three-way: code → excerpt; empty + `loading` → "loading
code…"; empty + not loading (a completed load that turned out empty/error, or an
empty embedded `childCode`) → the end state **"no code found"**
(`data-testid=related-empty`, same gray style). The item key encodes that state
(`related:<id>:code|load|empty`), otherwise the loading→code/empty transition can
freeze on a reused keyed node (`.claude/rules/arrowjs-pitfalls.md`). Test:
`tests/related-empty-code.spec.mjs` (PR 96 embedded empty; PR 90 lazy load that
completes empty).

## List navigation

`↓` falling through whatever sits before this card — the last inline comment
conversation (see `.claude/docs/comments-panel.md`) or the embedded Claude chat
(`.claude/docs/claude-chat-panel.md`), which is where a bare `→` from the diff
now lands — selects the **first** item (`cs.codeSel=0`); `↓`/`↑` move through them (clamping at the last — `↑` on the
first steps back onto the last inline comment conversation if the unit has one,
else out to the diff, via `hasVisibleComments`/`enterCommentsTail`); `←`, from
ANY position, always exits straight to the diff instead — unlike `↑` it never
detours through the comments, even when the unit has them (explicit request:
`←` means "the code to the left", not "the previous stop"). The selected item
gets an indigo ring (`data-active=true`). All items stack **vertically** at
full width. Full chain: `.claude/docs/keyboard-navigation.md`.

The card has **no fixed height cap**: it grows with its content up to the block
column's full height and then scrolls internally (`min-h-0`, body
`flex-1 overflow-auto`). Code excerpts **wrap** (`whitespace-pre-wrap
break-words`, no horizontal scroll).

### Cards above the cursor collapse to just their header

`relatedCard`'s `collapsed = () => cs.focus === 'code' && i < cs.codeSel`: any
child card the reviewer has stepped past on the way down (its index sits
before `cs.codeSel` in the flat vertical list) shrinks to just its header —
the badges, the label and the `file:line` line — with its code excerpt/
translation view and its drill-hint chip column (`nestedChipColumn`) hidden.
Reviewer request: "als ik van de eerste onderliggende code naar beneden ga,
dan wil ik dat de bovenstaande blokken ingeklapt worden, en als ik naar boven
ga, dan moet het weer uitgeklapt worden. onderstaande blokken moeten
uitgevouwen zijn." A card at or below the cursor (`i >= cs.codeSel`) always
renders in full.

- **A pure function of the index comparison, not a stored toggle.** Moving
  `cs.codeSel` back up (`↑`) "un-collapses" a card for free the moment the
  cursor passes it again — there is nothing to reset. Same reasoning as
  `selected` right above it: read inside `relatedCard`'s own nested `${() =>
  …}` bindings, never in the outer `.map()` closure that builds the list (see
  the outer-closure-coupling pitfall in `.claude/rules/arrowjs-pitfalls.md`),
  so a step only re-renders the two cards whose collapsed state actually
  flipped.
- **Applies everywhere a card can appear above the cursor** — an ordinary
  relation/call/covered-method child, a class-member card, and an expanded
  test row (`testsBar`'s own children, once toggled open, are ordinary
  `relatedCard` entries at their own index). `testsBar` itself needs no
  separate collapse: the grouped-tests bar is already a single compact row.
  Since there is exactly one `RelatedPanel` instance whose children always
  come from `focusedBlock()` (see "Reactivity" below), this collapse behaviour
  is identical at every drill depth — the top-level block's Underlying-code
  list and every drilled column's own list.
- **`data-collapsed="true"/"false"`** on `data-testid=related-item` (also a
  reactive function binding) marks the state for tests/inspection.
- **Still fully clickable while collapsed** — the app-wide mouse rule ("a
  click does what the key does", `.claude/docs/mouse-navigation.md`) is
  untouched: `@click` still drills the child regardless of `collapsed()`.

`scrollCodeIntoView` still calls **`alignToTopVertical(el)`**, which scrolls
the first vertically scrolling ancestor so the selected card sits at that
container's top (only ever scrolling DOWN to reach that alignment, clamped at
`scrollTop 0`, and never touching the horizontal axis — it shares
`verticalScroller` with `scrollIntoViewVertical`, so the `scrollIntoView` axis
rule in `.claude/rules/arrowjs-pitfalls.md` still holds). The sticky "▲ N
hierboven" hint (`moreAboveHint`) this used to pair with is **gone** for this
list — now redundant, since the collapsed cards above already show what's
there without a separate count. `InlineComments` is `moreAboveHint`'s only
caller left (`comment-more-above`), and there it does more than hint: comment
cards have no equivalent collapse, so the ones above the expanded card are not
rendered at all and the (now clickable) hint is the only way back — see "The
selected conversation hides the ones above it" in
`.claude/docs/comments-panel.md`.
Test: `tests/related-more-above-hint.spec.mjs`.

**Refresh restore of the panel cursor:** `cs.focus`/`codeSel`/`sel`/`threadPos`
live in the URL under their own `rel` namespace
(`bindUrlState(cs, …, { ns:'rel' })`), so a refresh returns to the same child /
the same comment thread. Because the data pushes (`setRelated`/`loadComments`)
clamp `cs` while loading — and the mirror watch would immediately reflect that into
the URL — `RelatedPanel` snapshots the restored values in `restorePending` and
reapplies them, clamped, exactly once via **`applyRelRestore`** once the
children/comments are in (only focusing if the target exists, then clearing so
later navigation stays free). See skill `url-state` and the URL-state section in
`CLAUDE.md`.

## Column width (`relatedColumnWidthCls`)

The width of the **entire** column (not per card) is a reactive `${() => …}` class
binding on `<section data-testid=related-code>` instead of a static string. It
takes a **representative non-comment** code line across all currently shown
top-level cards (`rc.children`, excluding the `tests_group` bar — nested chips and
the drill-preview column keep their own fixed `w-72`) and turns that character
count into `clamp(min, calc(Nch + 2rem), max)` — **purely arithmetic on an
already-known character count**, no live DOM measurement
(`scrollWidth`/`getBoundingClientRect`) that could race a layout pass.

**`ch` here is NOT one monospace glyph** (this file used to claim it was): it
is one glyph of the font of the element carrying the class — the page's
proportional `ui-sans-serif` at 16px, ~1.5× the code panes' own monospace
advance. A diff CARD's width was moved off `ch` for exactly that reason (see
"The chars → px conversion" in `.claude/docs/diff-card.md`); this column
deliberately keeps `ch`, because it is `clamp()`ed between a floor and a
ceiling either way — the only effect is that it reaches its ceiling at a
lower character count, never a clipped line and never a column past the
ceiling.

- `min` = the default floor `42rem`/`49.2rem` (matching a one-sided/`a`-narrowed
  block, see `.claude/docs/detail-layout.md`).
- `max` = `56rem`/`65rem` — deliberately **below** the block column's own
  `70rem`/`82rem`, so one long line can't grow this card to half the screen.
- `clamp()` handles "no code" and "everything shorter than the floor" for free.

**Comment lines deliberately don't count** (`codeGrowthChars`, a state-machine
scan that skips a leading PHPDoc block, `//`/`#` lines and intervening `*`
continuations) — a long prose comment wraps neatly and must never widen the
column; only real code (long chains, wide return types) does.

**Not the longest line but the 75th percentile** (nearest-rank) of the remaining
line lengths: one extreme outlier must not single-handedly push the column to the
ceiling — that line just wraps. The plain median was too aggressive the other way
(in a method with 3-4 real content lines the loose `{`/`}` lines pull it to almost
0 even for a genuinely wide method), so the 75th percentile is the middle ground.

Only reacts to `rc.children` — the same plain snapshot `kids()` reads — so it adds
no co-subscription on the selected block's `b.code`. Consequence: the width
symmetry with the neighbouring column is a **default**, not a guarantee. Test:
`tests/related-code-grow.spec.mjs`.

**The card list's own scroll wrapper drops its LEFT padding (`p-3 pl-0`).**
`comment-claude-row` (`home.mjs`) puts its shared card border flush against the
column's true left edge, with no left inset of its own; this section's ordinary
`p-3` padding used to indent every "Onderliggende code" card 12px further right
than that, so the cards visibly didn't line up on the left with the comment/chat
card above them (reviewer report, confirmed with a pixel measurement:
231px vs. 219px). Top/right/bottom keep the original `p-3` spacing — only the
left side was trimmed.

`InlineComments`/`ClaudeChatPanel` reuse this same clamp **scaled**, not
verbatim: `commentColumnWidthCls()` (2/3) and `claudeColumnWidthCls()` (1/3),
sitting side by side in `comments-and-related`'s first row — see
"The embedded Claude chat column" in `.claude/docs/detail-layout.md` and
`.claude/docs/comments-panel.md`.

### An empty column is narrow, and only while nothing sits above it

The clamp above has a **floor** (42rem / 49.2rem, 40rem below the narrow
breakpoint) that it never drops below — however little there is to show. For a
column holding literally nothing but the sentence "Geen onderliggende code."
that floor is dead space, and it is not harmless: measured on a live PR (13431,
`StatisticsActivitiesIndexTest::it_gives_amount_obligation_…` at
`gran=line`, viewport 2000px) the column claimed **787px** next to a 1429px
diff card inside a 1952px `<main>`. The moment the keyboard moved into the
panel (`?rel.foc=code` → `scrollRelatedIntoView`, see
`.claude/docs/detail-layout.md`), `<main>` scrolled to its own maximum and cut
**240px off the diff card's LEFT edge** — and since nearly every line of that
test method is short, the remaining visible slice of the card held no text at
all. Reported as "de kaart is enorm hoog en vrijwel volledig lege groene
vlakte", with the card's title starting mid-word. (The card itself was fine:
976px tall for 51 rows, no internal scroll anywhere — only `<main>`'s own
horizontal scroll.)

**`RELATED_EMPTY_WIDTH_CLS`** (`w-[18rem]`, `RelatedPanel.mjs`) replaces the
whole clamp when **`relatedColumnIsEmpty()`** holds. One flat token, no
`narrow:`/`2xl:` variants — it already sits well below every one of those
floors, exactly like `NARROW_FIXED_WIDTH_CLS` in `Block.mjs` — and still
parseable by `parseAutoWidthPx`'s bare-rem branch, so a drag on this column
keeps snapping back correctly (`.claude/docs/column-resize.md`).

"Empty" is deliberately strict, four terms:

- `rc.children.length === 0` — no child cards at all.
- `!rc.warning` — the "Dekking niet te bepalen" line keeps the normal width,
  it is real content.
- `!claudeChatVisible() && !hasCommentClaudeFooter()` — **the gate.** These
  two are exactly the expression `home.mjs`'s `comment-claude-row` uses for
  its own `hidden` class, so the narrow width can only ever apply while that
  row is hidden (measured: 0px wide). That keeps the documented invariant
  `commentColumnWidthCls() + connector + claudeColumnWidthCls() ===
  relatedColumnWidthCls()` intact — those two siblings keep deriving from the
  unchanged clamp, and there is simply nothing above the column to line up
  with. Both sides are covered by tests:
  `tests/related-code-grow.spec.mjs` (empty → narrow) and
  `tests/comment-claude-column-widths.spec.mjs` (row visible → clamp width,
  sum exact).

**Deliberately NOT gated on the "zoeken…" pill** (`searching()`):
an unresolved call whose LLM search is still running is the normal state for a
test method full of framework calls, and waiting for it would keep the dead
787px for as long as the search takes. If the search does land a child, the
column simply widens then — the same content-driven behaviour it always had.

**What this does NOT fix:** once the column legitimately HAS content, a focused
panel next to a wide diff card still scrolls `<main>` right and leaves the card
partly off the left edge (measured in the same state after the covers child
became visible again: 1429px card + 1010px column in a 1952px `<main>` → 463px
cut). That is `scrollRelatedIntoView`'s ordinary `inline:'nearest'` behaviour
plus the left-edge chevron hint, not this bug.

### Narrow viewport (< 1400px)

A hard Tailwind cutoff, not a vw-scaling formula: `index.html`'s
`tailwind.config` defines a custom **max-width** screen `narrow: { max: '1399px' }`
(Tailwind emits a screen's CSS after the corresponding unprefixed utility — the
same source-order mechanism `2xl:` already relies on — so a `narrow:` class
alongside a base class wins below 1400px with no specificity conflict; at/above
1400px nothing changes). Motivation: on a ~1378px window a two-sided diff card
(`w-[70rem]` = 1120px) next to even the floor of this column (672px) overflowed by
430px, so the reviewer had to scroll away most of the diff to glimpse this column.

- **`relatedColumnWidthCls`** (and thus `commentColumnWidthCls`/
  `claudeColumnWidthCls`, scaled off it) drops floor/ceiling from
  `w-[42rem]`/`w-[56rem]` (672/896px) to **`w-[40rem]`/`w-[48rem]` (640/768px)**.
- **`widthCls`'s own narrow tier is HISTORICAL** — it applied to the fixed
  `split`/`unified` width tiers a PHP diff card used to have (`w-[70rem]`/
  `w-[42rem]` → `w-[42rem]`/`w-[28rem]`). Those fixed tiers are gone: every
  stand's PHP width is content-driven now (`contentWidthCls`,
  `.claude/docs/diff-card.md`) with no `narrow:`-specific variant at all — see
  "Narrow viewport (`narrow:`, < 1400px) — no longer a `widthCls` concern" there.
  The budget math below (measured against the removed 672px/448px tiers) is
  kept for the historical reasoning, not as a currently-accurate number for a
  PHP diff card.
- **The sum at the common floor (as measured when this was written):** `42rem`
  + `1rem` (`gap-4`) + `40rem` = `83rem` = 1328px, comfortably inside a
  ~1378px window (vs. the reported 1808px before). A genuinely wide child
  still grows this column to its (lower) ceiling and may still need some
  horizontal scroll — narrowing improves the typical case, it doesn't
  guarantee every combination fits.

The Playwright default viewport (1280×720, see
`.claude/docs/testing-playwright.md`) is itself below 1400px, so effectively the
whole suite exercises the narrow widths — `related-code-grow.spec.mjs`'s ceiling
assertion reflects 768px.

## Drill hint chips (a recursive mini-tree growing rightward)

Any child whose block **itself** still has changed underlying code shows a short
**dotted dash** to the right of its card toward a chip column
(`data-testid=related-nested`, `w-72` — doubled from `w-36` so longer labels fit):
one chip per changed (grand)child (`data-testid=related-nested-chip`) with

- the **full `class::method` label**, which **wraps and is never truncated**
  (`whitespace-normal break-words`; bare name without a class — the shared
  `blockLabel` helper in `Block.mjs`);
- its own **diff stat `+A −B`** (`data-testid=related-nested-diffstat`, `diffStat`
  over the lazily-`ensureCode`d kid; a gray **`…`** placeholder while loading —
  never "Unchanged", every chip target is by definition a changed PR block);
- the **approval `done/total`** (`data-testid=related-nested-approval`,
  `blockApproveCount` of the block itself — deliberately not the subtree; ✓ prefix
  when fully approved, hidden at `total 0`).

No file line in the chip (the full `label · file` sits in `title`).

**Recursive and rightward, not indented below:** each chip is a flex row
(`nestedChip`) — the chip button, followed (if that child has further changed
children) by its **own** chip column via `nestedChipColumn`, the same function that
renders the top-level column next to the card and now the **only** recursive
building block at any depth (the earlier indented-below `nestedSubChips` is gone).
Depth cap **2 chip levels** below the card (`NESTED_DEPTH`, `home.mjs` — every
level multiplies `ensureCode` fetches, and looking deeper is what drilling is for);
per level capped at **3 chips + "+N more"** (`data-testid=related-nested-more`,
never keyboard-reachable), cycle-safe via a shared `seen` set (the
`nestedPrBlocks` pattern). Since a row can now be wider than its own `w-72`
column, the card's existing `overflow-auto` body also scrolls horizontally — a
consequence of the layout, no separate CSS.

Data comes from `nestedChangedKids(prBlock, parentId, seen, depth)` (`home.mjs`):
plain descriptors on `r.nested` plus a recursive key signature `r.nestedSig`
(`nestedSigOf`), built in the same descriptor builders/`setRelated` watch as
everything else — never in a render binding, so no `b.code` race.
`directChildBlocks` by definition only yields **PR blocks**, so an
`Unchanged`/synthetic call target never gets a chip (such a call child explicitly
gets `nested: []`). Chips ride on the descriptor, so they appear at every
granularity where the child itself is visible.

A **click on a chip at depth d drills d+1 levels at once** (the card child, then
every ancestor chip, then the chip itself — sequential `drillIntoChild` steps via
the same `drill` callback, with `stopPropagation` so the card click doesn't also
drill one level beyond); `Enter` on the card remains the normal single-level drill.

### Keyboard through the chip tree (`cs.chipPath`)

A second, nested cursor next to `cs.codeSel`: empty (`[]`) = the keyboard is on
the card itself, `[i]` the i-th top-level chip, `[i,j]` its j-th subchip (one index
per depth, mirroring the recursive `nested` shape). Only meaningful within
`cs.focus==='code'` (`handleRelatedKey`), spatially consistent with the rightward
growth:

- **`→`** descends into whatever is focused (card or chip) toward its own first
  nested chip (no-op without nested children).
- **`←`** climbs one level back; only with an empty `chipPath` does it fall through
  to "leave the panel". This is a **deliberate behaviour change** — `←` used to
  always close the panel regardless of chip focus.
- **`↓`/`↑`** walk the **siblings at the current depth** (`chipListAt`, clamped at
  both ends, no flow into another level) as long as `chipPath` isn't empty,
  otherwise the existing `cs.codeSel` behaviour over the cards.
- **`Enter`** drills the whole chain via `focusedChipChain()` (ancestors + focused
  chip, mirroring the click handler).

`chipPath` resets to `[]` as soon as `codeSel` changes and on every `setRelated`
push (the tree can rebuild, so an old depth index isn't trustworthy). The focus
ring (`data-active` on the chip) is scoped on `cs.codeSel` **as well as**
`chipPath`, because two different cards can have the same chip-tree shape and thus
the same path — without that check the "focused" chip lit up on every card with
that shape at once (regression: the last test in
`tests/related-nested-chip.spec.mjs` drills three levels deep and verifies only
the card at `codeSel` shows an active ring).

### arrow.js details for the cards/chips

The card root of `relatedCard` is a flex row (card `min-w-0 flex-1`). The approval
count is a **precomputed string** (`approveText`) in an always-present element, and
every conditional sub-template (chip column, diff stat) runs through a
`${() => …}` **function binding** — never a static template↔string ternary, which
leaked arrow's template function as text on chunk reuse (see
`.claude/rules/arrowjs-pitfalls.md`). The card `.key` in `fullCard` carries
`r.nestedSig` so every tree change (set/approval/diff loaded) builds a fresh node;
chip keys are the **id path** (the same id can hang under two parents).
`data-child-id` stays on the innermost card, so the call-arrow overlay (which
targets the card's **left** edge) isn't affected by the chips on the right. The
`tests_group` bar gets no chips.

## Grouping covering tests into a horizontal bar

`groupTestChildren` (`home.mjs`) + `testsBar` (`RelatedPanel.mjs`): as soon as a
block shows, besides its `covered_by` children, **other** (non-test) children too,
those tests collapse into one horizontal row
(`data-testid=related-tests-bar`: chevron + "N tests" pill + one compact chip per
test method, `data-testid=related-tests-chip`), always sorted to the very
**bottom**, below every other child — so they don't push the actual underlying
code down, and don't sit above it either (reviewer request: the bar used to
take the slot of the first test in the sorted order, which could land it above
code cards).

Click or `Enter` on the bar **toggles** `state.testsExpanded` (ephemeral, not in
the URL, reset to closed on a block switch via `lastRelatedBlockId` in the
`setRelated` watch callback; it's an inline dep in that watch getter): expanded,
the tests render as ordinary child cards directly below the bar (the bar stays as
a collapse toggle). With **no** other children (or no tests) this is a no-op — the
tests render as ordinary cards.

The group item rides along **within** the child list as a synthetic
`kind:'tests_group'` descriptor, so the panel cursor (`cs.codeSel` indexes
`rc.children` 1-to-1) needs no special case: `Enter`/click lands in
`drillIntoChild`, which branches on the child (toggle instead of drill);
`orderedChildBlocks` filters it out, just like `covered_by`. The bar's `.key`
encodes open/closed + the test ids (fresh node per toggle). Test:
`tests/related-tests-group.spec.mjs` (fixture PR 99, `testsgroup-*.json` +
`materializeTestsGroupWorktrees`).

## Call-arrow overlay (`src/callArrows.mjs`)

A smooth indigo bezier arrow from the changed call site in the **active navigation
unit** (right edge of the new pane, at the call-site row's height) to the
corresponding **changed** child card — exclusively for a `method_call` child whose
definition is itself a PR block (an `Unchanged` target never gets one), one arrow
per matching child, only in diff mode and only for **the column that holds the
keyboard**: the top-level block (`focusLevel === 0`, `state.gran`/`state.change`)
**or** the focused drilled column (`focusLevel > 0`, its own
`state.drillCursor[focusLevel-1]`). Exactly the `approveContext()` idiom —
`callArrowPairs(b)` guards on `b === focusedBlock()`. Every drilled column is a
full navigable diff, so there's no reason for the arrow to vanish on drilling.

The DOM side (`main.querySelector('[data-pane="new"]')` /
`panel.querySelector('[data-child-id]')`) needed **no** change: a non-focused
column always collapses to a rail without `[data-pane]`, so the query
automatically finds the one remaining pane — that of the keyboard-owning column,
at any depth.

**Scope mirrors the panel's visibility exactly** (`resolvedCallChildren`'s
`hideOutOfScope`) at **every** granularity, `group` included — so there's no
fallback to "the child's first known call site anywhere in the block": a card the
panel doesn't show must never receive an arrow.

**Deliberately an imperative drawing layer**, not a reactive template (the
`updateHints`/`positionMenu` model): `callArrowPairs` (`home.mjs`) computes the
pairs in the **callback** of the existing `setRelated` watch (untracked — no new
reactive `b.code` reader, so no stuck-on-loading race) and pushes them via
`setCallArrows` to `callArrows.mjs`, which purely reads the DOM
(`getBoundingClientRect` on the `data-row` row in `paneHTML` resp. the
`data-child-id` card on `relatedCard` — two static attributes) and redraws one
**statically mounted** `position:fixed` `<svg data-testid=call-arrows>` (top-level
next to `MenuHost`, `z-[15]`: above `<main>`'s z-10, below the sidebar's z-20 and
the command menu; `pointer-events:none`). Path `data-testid=call-arrow`, stroke
`#6366f1` at 0.45 opacity — a bare curve, deliberately **no arrowhead marker**
(reviewer request: "haal het pijltje weg, het lijntje laten staan" — the line
alone already identifies which row/card belong together, and a marker-end
`<marker>` def used to sit in the same `innerHTML` write). Both endpoints
(`x1`/`x2` in `buildArrowPaths`) get the same small fixed `LINE_SHIFT_X`
(8px, bumped from 4px on 2026-08-24 — "het moet net linkerblok en rechterblok
aanraken") nudge to the right of the raw pane-edge/card-edge anchor — purely
cosmetic, the shape/slope is unchanged; `x1`/`x2`'s own base offsets (-6/-10)
differ, so one shared shift can't make both ends touch exactly, but 8 gets
both close. The svg is laid exactly over `<main>`'s rect on
each draw and clips itself, so arrows never draw over the
pr-index/PR-info/sidebar/footer.

**Suspended for the duration of a column resize.** A drag on any column's
resize handle, or a held `c`/`v` keyboard resize (`.claude/docs/column-resize.md`),
moves the very anchors this overlay measures — the pane's right edge, a
card's own edge — continuously, without touching any of this module's normal
redraw triggers. `suspendCallArrows()`/`resumeCallArrows()` (`callArrows.mjs`)
hide the overlay the instant such a gesture starts and bring it back via the
ordinary tracked-settle schedule once it ends, so the line never sits stuck
at a stale, pre-resize position; `columnWidth.mjs`'s `startColumnResize`/
`startKeyResize` are the only callers.

Redraw triggers: rAF-coalesced on the watch itself, `resize`, capture `scroll`
(including inner scrollers), and — every push (`setCallArrows`/
`setCommentArrows`/`resettleCallArrows`) — a **tracked settle**
(`scheduleArrowSettle`, `SETTLE_MS = 320`): instead of one immediate draw plus
one more after a flat delay, it redraws on **every animation frame** until
`SETTLE_MS` has elapsed. Reviewer report: "de pijltjes gaan best traag mee als
onderliggende blokken van plek veranderen" — the earlier immediate+250ms-later
schedule left the arrow visibly stuck at its pre-move anchor for the whole
250ms (the card's own 200ms width/position CSS transition), then snapping once
— reading as laggy rather than following. Redrawing every frame while that
transition is actually running instead moves the arrow's endpoint in step with
the card. `scheduleArrowDraw` itself still coalesces each individual frame
into one rAF (unchanged), so a settle window costs exactly the same per-frame
work the pre-existing scroll/resize handling already did, just sustained for
`SETTLE_MS` instead of firing once; a second `scheduleArrowSettle()` call
while one is still running just extends the window (`settleUntil`), never
starts a second parallel loop (`settling` guard).

**The `a` toggle needs an explicit resettle.** It touches none of the `setRelated`
watch's dependencies, so the watch doesn't fire and `setCallArrows` isn't called
again — while every card's width changes anyway, leaving the arrow drawn at the
pre-toggle coordinates. `toggleDiffView` (`home.mjs`) therefore calls
`resettleCallArrows()`: the same tracked-settle schedule, without changing the
pairs (only the geometry changed).

A call-site row scrolled out of the diff viewport loses its arrow (the same
visibility rule as `updateHints`); a child card scrolled out internally keeps an
arrow **clamped** to the panel edge. Test: `tests/call-arrows.spec.mjs` (fixture
PR 100, `arrow-*.json` + `materializeArrowWorktrees`).

**A second, sibling arrow family links a comment card to its own diff row**
the same way — see "Linking a comment card to its diff row" in
`.claude/docs/comments-panel.md`. `callArrows.mjs` draws both families in one
pass (`setCallArrows`/`setCommentArrows`, a shared `buildArrowPaths` helper).

## Scoping to the navigation cursor

`home.mjs` (`callScopeMethods`/`findCallSites`) links every resolved call to the
diff segment it sits on.

- **`gran==='call'`** — exactly the method of that one call (land on
  `->billingAddress` and you see `Order::billingAddress`); a segment without a
  resolved call gives an empty card.
- **`gran==='line'`** — only calls whose site falls within
  `[unit.start, unit.end]`.
- **`line`/`call` are a hard filter (hiding)** — you never see a call, listener,
  `covers`/`covered_by` child of a line you did *not* select
  (`relatedChildren`'s `scoped` flag). **One exception, at `line` only:** a
  `covers` child whose own anchor row IS the selected row stays visible — see
  "A `covers` child stays visible at `gran='line'` on its own anchor row"
  below.
- **A multi-line call's own argument rows count as its site too**
  (`findCallSites`' `spanArgs` parameter → `argListSites`, `home.mjs`). A call
  site is one row, but a call is not: selecting only
  `sessionId: (string) $state['session_id'],` inside a
  `$instance = new self(` used to scope the `SessionState::__construct` card
  away, because the `self` site sits on the `new self(` row alone — "ik wil bij
  `new ` ook de constructor parameters zien. Die wil ik ook zien als ik
  bijvoorbeeld alleen `sessionId ...` selecteer" (Reindert, 2026-08-21).
  `argListSites` walks the paren depth on from the matched `(` (strings opaque,
  `//` ends a row, capped at `ARG_LIST_MAX_ROWS`) and adds every continuation
  row as an extra site — one per call SEGMENT of that row, so `call`
  granularity matches whichever argument segment the cursor is on, not just
  `line`/`group`. Only a real call-open match (`name(`) can have an argument
  list; the `->prop` / `::CASE` / `Foo::class` alternatives never do.
  **`spanArgs` is passed by `callScopeMethods` ONLY** (so also by
  `unresolvedCalls`, which shares it): the primary-site consumers keep pointing
  at the row carrying the call NAME — `lineChildSummaries`' per-row avatar+N
  badge, the call-arrow overlay's anchor row, the "does this call sit on a
  changed row?" ordering heuristic and `referenceRows`' nav stops. Widening
  those would put a badge and an arrow target on every line of a long argument
  list, which is noise, not information. The Go resolver has the matching half
  of this rule for which lines are SCANNED at all (`keepChanged`'s open-paren
  widening, see "Only the changed lines" in
  `.claude/docs/workflows-analysis.md`) — together they make a call whose
  argument line is the only changed line both produce a child and be reachable
  from the cursor.
- **List mode** (no diff) shows **all** resolved calls of the block.
- **A Shift+arrow range widens `[unit.start, unit.end]` to the merged range**
  (`state.rangeAnchor`/`rangeUnit`, see "Shift+↑/↓" in
  `.claude/docs/keyboard-navigation.md`) at both `line` and `group` — every
  call/relation whose site sits anywhere inside the SELECTED RANGE stays
  visible, not just under the lone cursor row. `callScopeMethods`/
  `groupLineRange` resolve their unit via `focusedActiveUnit()` (the same
  helper `activeGroup` uses for highlighting) rather than a second,
  range-blind `navUnitsOf(...)[cur.change]` lookup — this used to be the one
  place a range didn't yet act like a bigger group. Test:
  `tests/range-select-related-scope.spec.mjs`.

### `gran==='group'` hides out-of-scope children too

Same hard filter as `line`/`call`, not merely a reorder below the in-scope ones.
This reverses an earlier deliberate choice ("a group spans multiple lines, so a
child shouldn't disappear") — reversed on explicit request, because it produced
exactly the confusing result of several cards next to a selected group, only some
of which belonged to it, with no visual distinction. Don't reintroduce.

Every relation/annotation carries an **absolute source line** recorded server-side
by the detector that found it (`relations.Relation.Line` resp.
`testcovers.Entry.Line`, see `.claude/docs/workflows-analysis.md`).
`groupLineRange(b, rows)` converts the selected group unit to that same absolute
range (reusing `unitLineRange`), and **`groupTierForLine(range, line)`** is the one
function every group-scoping decision goes through: it scores a child's recorded
line into a `groupTier` of `0` (kept) or `1` (out of scope, filtered out by
`relatedChildren`).

**The load-bearing rule behind it: hide only what can be PROVEN to sit outside the
selected group — missing scope information is never itself a reason to hide.**
`groupTierForLine` returns tier `0` whenever there is no active range at all (list
mode, or another granularity) **or** the child's own `line` is falsy (a relation
recorded before the field existed — `Line`'s own "0 = legacy row" convention — or
a fixture that never set one): "nothing to compare", not "line 0, presumably out
of range". Three exemptions follow:

1. **A block-level synthetic callKey**
   (`resource:`/`migration_model:`/`data_provider:`/`trait_usage:`, see
   `isBlockLevelCallKey`) has no site to compare — always kept, as at
   `line`/`call`. `trait_usage:` was added *because* of this change: `group` is
   the **default** granularity, so once it hard-filtered, `findCallSites`
   silently finding no site would have made a trait-usage child disappear
   almost always.
   `class_member:` is in `isBlockLevelCallKey`'s regex too, but is only
   actually treated as block-level **while the caller IS the `<class-header>`
   block itself** (the no-sibling fallback, see the class-member paragraph
   below) — there the members it names *are* the header block's own diff
   lines, so scoping them away per selected group would hide exactly the
   declarations the reviewer came for. Attached to a **sibling** method
   instead (the common case since `3228440`), `callScopeMethods`/
   `findCallSites` fall through to a real usage-site match (the member's own
   name as a property/constant access, `->name`/`::name`/`::$name`) and it is
   scoped exactly like an ordinary call — "alleen zien als het te maken heeft
   met de geselecteerde groep/regel" (Reindert, sharpening the earlier
   always-block-level behaviour). A member never referenced anywhere in that
   sibling's code disappears at every diff granularity for that sibling —
   there is deliberately no fallback back to a `<class-header>` card (which is
   no longer hidden, but also no longer holds the member — see
   `splitClassHeaderMembers` in `.claude/docs/blocks-and-ingest.md`); list mode
   still shows the full, unscoped reference list, same as before. The `const_ref` rule is deliberately **not** in the set at all —
   its key is a real literal on a real line, like any ordinary call, for
   every caller.
2. **A `covered_by` child** (`coveredByChildren`) never carries a site of its own —
   the annotation lives in the *test's* file, not the viewed block's. Explicitly
   kept **always** visible: a hard filter would hide "covered by TestX::testY"
   almost every time the reviewer is in diff mode. `coveredByChildren` no longer
   takes a `range` parameter; its `groupTier` is unconditionally `0`.
3. **A relation child with no recorded `line`** — kept, never treated as "line 0
   is out of range". This is also what keeps several existing Playwright
   fixtures correct.
   **A `covers` child with no recorded `line` is narrower** (`testCoverGroupTier`,
   `home.mjs`): instead of the blanket "always kept" above, it falls back to
   scoping by the covering TEST's own `// When` section — see "A class-level
   `#[CoversMethod]`/found-escalated `covers` child scopes to `// When`" below.

**`translation:` children are NOT exempt** — that callKey couples to a real
string-literal site (the quoted key inside `trans()`/`__()`/`@lang()`), so it stays
hard-scoped to the line it's used on, like an ordinary method call.

Outside `gran==='group'`, `groupTierForLine`'s `!range` guard keeps every tier at
`0` — a no-op, so the ordering below is unchanged.

### A class-level `#[CoversMethod]`/found-escalated `covers` child scopes to `// When`

A `covers` target with no natural single line of its own — either an LLM
`found` row escalated from a class-only annotation, or (the common shape in
practice) a Go-`resolved` row whose `#[CoversMethod]`/`#[CoversClass]`/bare
`@covers Class` sits **above the class**, not above this one test method (see
"Linking test coverage" in `.claude/docs/workflows-analysis.md`) —
`testcovers.Entry.Line` is `0` for both. Showing such a card on **every**
group/line/call of every test method in the class (the original, too-loose
"no information ⇒ never hide" treatment) reads as "linked to all lines";
Reindert asked for it to be scoped to the covering test's own `// When`
section instead — the closest thing that target has to "its own line", since
that's where the tested action actually runs.

`whenSectionRows(rows)` (`home.mjs`) scans the TEST block's own aligned rows
for every `// When` comment (case-insensitive, the codebase's Given/When/Then
convention) and collects the row indices of the **statement lines that
follow it** — repeated for every `// When` occurrence in the method (a test
can have more than one Given/When/Then cycle). **The comment row itself is
deliberately excluded** — Reindert: "cursor op de comment-regel zelf toont
de kaart niet" — collection starts at the first row after the comment and
stops at (not including) the next comment row (any `//` line, not only
another marker) or a blank row, whichever comes first, or the end of the
block. `testCoverGroupTier` (`home.mjs`) then hides the child (`groupTier 1`)
at `gran==='group'` unless the selected unit's own row range overlaps one of
those rows (`groupUnitRowRange`, the row-index counterpart of
`groupLineRange` — no line round-trip needed since both sides are already in
row space); no `// When` found at all, or no active group range, both fall
back to "keep" like every other exemption here. The per-line badge
(`lineChildSummaries`) mirrors this: such a child's badge now sits on every
`// When` statement row instead of nowhere (a silent, badge-less consequence
of leaving `Line` at 0, see 121be8d) or the coincidentally wrong row that bug
produced. A real per-method annotation (`Line` truthy) is untouched — it
keeps its own `groupTierForLine` scoping on the annotation's own line, as
before. Test: `tests/testcovers-when-scope.spec.mjs`.

### A `covers` child stays visible at `gran='line'` on its own anchor row

`line`/`call` scoping used to drop **every** `covers` child (`relatedChildren`'s
`scoped` flag), which contradicted the per-line badge on one and the same row:
reported on live PR 13431, the `getJson(...)` line of
`StatisticsActivitiesIndexTest::it_gives_amount_obligation_…` showed a
`✓ 2/2` "onderliggende code" badge while stepping onto that very line with `d`
made the panel say "Geen onderliggende code." — the badge and the panel
disagreeing about the same child. (The reviewer read that as "is the underlying
block not found yet?"; it was found — `GET /api/testcovers` had a `resolved`
row for `ActivityReader::read`. The `getJson` call itself is a genuinely
`unresolved` callresolve row and always will be: it is Laravel's own test
helper in `vendor/`, outside the scanned repo, and the real target behind the
URL is a route, not a method call.)

**`lineAnchoredTestCoverChildren`** (`home.mjs`) is the exception:
at `gran==='line'` it keeps exactly those `covers` rows whose **anchor row**
falls inside the selected line unit (a Shift-range included, since it reads
`focusedActiveUnit()`), and resolves that anchor with the **identical rule
`lineChildSummaries` uses for the badge** — `newLineToRowOf(r.line)` for a row
with a real recorded line, `whenSectionRows` for one with `Line === 0` — so the
two cannot drift apart again. It passes that as a row filter into
`resolvedTestCoverChildren`'s new optional `rowFilter` param; every other
caller is unchanged.

**`gran==='call'` deliberately keeps the old behaviour** (call-site children
only): a call segment is FINER than a row, and a `covers` target is not the
target of that one call. Test: the `gran=line` case in
`tests/testcovers-when-scope.spec.mjs`.

**Inline comment blocks are unaffected by all of this** —
`InlineComments`/`commentUnder` already hard-filter by aligned-row range at *every*
granularity, `group` included.

## Ordering within a tier

0. **Pending sorts first** (see its own section right below) — checked
   BEFORE the priority tiers.
1. A call whose definition itself changes in this PR (a real child block) — `prio 0`.
2. A call on a recently changed line — `prio 1`.
3. The rest — `prio 2`.

**Within the same prio the largest child wins** (most non-empty lines, `codeSize`
over the child source — `childCode` for a call, loaded `code` for a listener), so
substantial changed code sits on top and trivial one-liners sink. Load-bearing
because relation accessors (e.g. a 3-line Eloquent `MorphOne`) are **also**
`added` PR blocks and thus `prio 0` — they'd otherwise land before a genuinely
changed method purely on source order. A child whose code hasn't arrived counts as
`size 0` and sinks until it loads; equal prio+size keeps source order (stable
sort). Block-level listener children drop out at `line`/`call`.

### Pending sorts first

Reviewer request: "laat de blok bovenaan zien die nog niet zijn goedgekeurd —
als ik spatie druk moet ik naar de eerste onderliggend blok [gaan]". `Space`
already walked to the first not-yet-approved unit depth-first
(`findNextUnapproved`, see "`findNextUnapproved()` — walking the review tree"
in `.claude/docs/command-palette.md`) — this only fixes the panel's own
top-to-bottom order to agree with where it actually lands, so the reviewer no
longer has to hunt for which card Space just jumped to.

`relatedChildren` (`home.mjs`) computes a `pending` flag per child descriptor —
`true` when `subtreeApproveCount(...)` (its OWN rows **plus every PR block
nested under it**, not just `blockApproveCount`) has `done < total` — and sorts
by `groupTier` → **`pending` (unapproved first)** → the existing `prio` → `size`.
Subtree-wide is load-bearing: a card can show a fully-done own total (e.g.
`7/7`) while a nested drill-hint chip underneath it is still open, and that
card must still sort/lead as "not done" — the reviewer would otherwise have to
notice a chip buried under an already-green card. A leaf that is never a real
PR block (a translation/config-value/env-example/unchanged class-member card,
`approve: null`) is always `pending: false` — there is nothing there to
approve, ever.

**`nestedChangedKids`** (the recursive drill-hint-chip builder, same file)
applies the identical rule to its own `directChildBlocks(prBlock)` list before
building the chip descriptors — so a still-open chip leads a fully-approved
sibling chip too, at every nesting depth, not only among the panel's top-level
cards.

Test: `tests/related-pending-first.spec.mjs` (top-level card order); the
existing sibling-walk/preview-column fixtures
(`tests/drill-sibling-walk.spec.mjs`, `tests/drill-preview.spec.mjs`) were
updated to enter via the now-first (still-pending) sibling instead of the
previously-first one, since `←`/`→`'s own sibling-stepping (`drillNextChange`/
`drillPrevChange`) reuses this same `orderedChildBlocks` ranking and therefore
changed order too — a deliberate, not incidental, side effect: walking
forward through siblings now also visits the unapproved one first.

## Translation children: en/nl paired side by side

Reviewer request: "de translations blokjes rechts, dat mag de helft smaller
zodat de engelse links kan en rechts de nederlandse van dezelfde key, gooi
daar dot streepjes als verticale verdeler." Every `kind:'translation'` child
of the same `transKey` (one per locale, `resolvedCallChildren`, `home.mjs`)
now renders as ONE row instead of stacking as separate full-width cards: the
Laravel dot-path (`transKey`, e.g. `includes.orders.billing`) sits ONCE in a
shared heading above (`translationKeyHeading`, `data-testid=
related-translation-key`) — no longer repeated per card's own title, which
now shows only the locale word (`en`/`nl`) — and the card(s) sit side by side
below it, each an even share of the row's width (plain `min-w-0 flex-1`
wrappers, `relatedCard` itself carries no width class), separated by a
dotted vertical line (`divide-x divide-dotted`). A key with only one locale
(no partner found) still gets the shared heading, just alone at full width —
deliberately consistent rather than a special case. `translationGroupRow`
(`RelatedPanel.mjs`) builds the row; every other child kind (relation/call/
covers/class-member/config/…) is completely unaffected.

**Ordering, and why it had to move too:** the resolver/sort above emits
translation children grouped by LOCALE first (every `en` key, then every
`nl` key) — fine for a flat vertical stack, wrong once same-key siblings sit
side by side, because the panel cursor (`cs.codeSel`) still walks `rc.children`
in that exact array order. `interleaveTranslationSiblings` (`home.mjs`,
called at the end of `relatedChildren`, right before `groupTestChildren`)
re-groups translation entries so same-`transKey` siblings become ADJACENT
(`en` first, other locales alphabetical) — a no-op below 2 translation
children, and every non-translation child keeps its original position. This
is what makes `↓`/`↑` land where the reviewer would expect: stepping past the
`en` card selects the `nl` card drawn right next to it, not a different row's
sibling further down the list.

**The panel cursor itself needed no change at all.** `RelatedPanel`'s render
loop (`RelatedPanel.mjs`, the default export) walks `kids()` once and groups
a RUN of consecutive same-`transKey` translation entries into one
`translationGroupRow(...)` call — but every card inside keeps its OWN,
unrenumbered index `i` from that same array, so `selected()`/`collapsed()`/
`data-active`/`data-child-id` inside `relatedCard` work exactly as for any
other child: `cs.codeSel` still indexes `rc.children` 1-to-1 (see "The card
looked fine…" above and `.claude/rules/conventions.md`'s snapshot-by-id
rule — the reorder happens once, in `home.mjs`, before the list is pushed,
never as a render-time renumbering). Nested drill-hint chips never apply here
(a translation leaf's own `nested` is always `[]`), so `nestedChipColumn`
needed no change.

Tests: `tests/translation.spec.mjs`, `tests/related-translation-enum-scope.spec.mjs`.

## Reactivity: the list is pushed, not computed in a binding

The child list is computed in a `watch` in `home.mjs` and pushed into the panel via
`setRelated` — the same decoupling as `setCommentScope`. **Load-bearing**: if the
render binding read the selected block's `b.code` (via `blockRows`), it would race
`home.mjs`'s diff render over that same `b.code` and the diff would stay stuck on
"loading".

**Equally load-bearing: the watch getter must enumerate the navigation state
_inline_** (`state.selected`, `mode`, `change`, `gran`, the block lists,
`callResolve`, `relations`, `curBlock().code`), computing the children only in the
_callback_ (`() => setRelated(relatedChildren(), unresolvedCalls())`). Compute them
in the getter and all reactive reads hide inside
`relatedChildren`/`unresolvedCalls`, whose early returns (empty block at load,
`resolved.length === 0`, scope shortcuts) let the crystallized run drop
`state.selected` from its dependency set — the watch stops re-subscribing and the
panel **freezes** on the block selected at load time. See the watch-deps rule in
`.claude/rules/arrowjs-pitfalls.md`.

## Automatic LLM search for unresolved calls

No button: `home.mjs` calls `startCallSearch(focusedBlock())` in the `setRelated`
watch as soon as the panel shows a block with `unresolved` calls
(`POST /api/workflows/resolve_call`, deduped per caller+callKey in
`searchRequested` so it fires once). It resolves the block's **entire** unresolved
set, not just the selected unit, so the reviewer never has to navigate anywhere.

While searching, the card shows a "zoeken…" pill
(`data-testid=related-searching`) — `position:absolute right-2 top-2 z-10` on
the `<section>` itself, so it floats above the scrollable list instead of taking
flow space. **The scrollable wrapper reserves top padding (`pt-9`) for exactly
as long as that pill shows** (`searching()`, a reactive whole-value class
binding): without it the pill sat on top of the first card's right-aligned
header badges (`diffStatBadge`/`approvalBadge`). Deliberate trade-off: no
permanent empty strip once nothing is searching, at the cost of the list
shifting a few pixels when a search starts/finishes.

**Only a row that is really `searching` gets the pill — a merely `unresolved`
row does not** (it used to: `searching() || pending() > 0`). `unresolved` means
"the Go resolver could not pin this call", which is not by itself a running
action, and a reviewer reported exactly the resulting lie: a permanent "zoeken…"
with nothing under "Taken" (PR 13431, a row stranded at `unresolved` by an older
`callresolve.UpsertGo` while both search triggers correctly refused to re-ask
it). A real search still surfaces — the `markCallsSearching` Activity marks its
rows `searching` before the LLM call — just one poll tick later than the old,
over-eager condition. Tests:
`tests/related-searching-only-while-searching.spec.mjs` (both directions),
`tests/related-searching-overlap.spec.mjs` (the `pt-9` reservation).

See "Resolving (also unchanged) called methods" in
`.claude/docs/workflows-analysis.md`.
