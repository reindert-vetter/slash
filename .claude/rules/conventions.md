# Conventions (filled in by this scaffold — correct where needed)

- Frontend modules are `.mjs`, one component per file, PascalCase for
  component files (`Block.mjs`), lowercase for page modules (`home.mjs`).
- Vendored libs (arrow.js, Prism) live in `src/vendor/` and are imported with a
  relative path, not via a CDN module. Tailwind is the exception (Play CDN).
  arrow.js is vendored in `src/vendor/arrow.js`.
- **Local patch to arrow.js (`src/vendor/arrow.js`)** — there is one deliberate
  change in the vendored arrow.js, marked with a `LOCAL PATCH` comment in the
  header: the template-expression evaluator `rt` skips a **released slot**
  (`typeof W[t]=="function"` guard) instead of calling it. Without that guard,
  a reactive effect that still fires in the microtask flush after its keyed
  node has been cleaned up crashes with `W[t] is not a function`
  (use-after-free) — among other places, during **drilling** (opening an
  Underlying-code child as its own column re-scopes the panel and tears down
  cards mid-flush). On an arrow.js upgrade this patch must be **reapplied**
  (see the comment for the original line).
- **arrow.js pitfalls** (from practice): no HTML comments (`<!-- -->`) in an
  `html`` `` template (throws "Invalid HTML position"); a reactive attribute
  value must be the **entire** value (`class="${() => ...}"`, not
  `class="x ${...}"`). You inject raw HTML via the `.innerHTML` binding
  (`.innerHTML="${() => htmlString}"`) — arrow.js then sets the property
  instead of escaping. Make sure the string is safe (e.g. Prism.highlight,
  which escapes itself).
- **arrow.js `watch(getter, cb)` — enumerate your reactive deps _inline_ in the
  getter.** If you hide all reads inside a called function with early
  returns/conditional paths (e.g. `watch(() => buildStuff(), …)`), the
  dependency set varies per run and the crystallized run can drop a key it
  previously subscribed to — the watch stops re-subscribing and stops firing.
  So list the state it must track literally
  (`() => [state.a, state.b, obj && obj.x]`) and do the actual work in the
  _callback_. That's how the `setCommentScope` and `setRelated` watches in
  `home.mjs` do it; an earlier `setRelated` watch that did **not** do this let
  the related panel freeze on the block that was selected at load time (see
  `.claude/rules/detail-layout.md`).
- **arrow.js — a `${() => …}` slot that switches between a single element and a
  keyed array (`.map()`) freezes after an empty render.** Observed in the
  comment list of `RelatedPanel.mjs`: the slot returned either
  `visibleComments().map(...)` (keyed rows) or a single
  `<p>No comments yet</p>`. Navigate to a block **without** comments (the slot
  renders the single `<p>`) and then back to a block **with** a comment, and
  the slot binding did re-run and returned a non-empty array, but arrow.js no
  longer rendered the rows — the list stayed empty while `cs.view` **was**
  populated (the comment still showed in the thread header, which returns a
  string). **Solution:** always emit **the same kind** from that slot — wrap
  the empty state in an **array of one**
  (`[html\`<p …>…</p>\`.key('no-comments')]`) so the slot's shape stably stays
  a keyed array. Re-keying the panel or a scalar version counter didn't help;
  only the stable array shape did.
- **arrow.js — never key a template whose entire body is one toggling
  expression (`` html`${() => cond ? sub() : ''}` ``).** Related to the
  single↔array pitfall above, but worse: arrow.js sets a chunk's DOM
  boundaries (`ref.f`/`ref.l`) only at **hydration**; if the nested reconciler
  later swaps that content (template ↔ `''`), it replaces the DOM **without**
  updating the owner chunk's `ref`. For a template whose expression is the
  entire body, that expression **is** the chunk boundary — the `ref` therefore
  points to removed nodes after one toggle. If such a template sits as a
  **keyed item in a list**, the keyed reconcile then derails step by step:
  `patchKeyedList` bails on the stale ref (parent `null`), the generic
  fallback path loses the chunk (a text placeholder instead of the chunk), and
  a subsequent run uses the stale ref as an **anchor** — newly mounted items
  end up in a detached fragment and disappear from view, after which two
  reconciler administrations fight over the same chunks (infinite microtask
  loop, tab freezes). That's how the look-ahead preview card disappeared
  under repeated ↓/↑ through same-file blocks: `stepChevronSlot` (`home.mjs`)
  was such a bare wrapper, keyed as `step-up`/`step-down` in the block column.
  (Unpatched upstream 1.0.6 already crashes on the same scenario earlier with
  `expressionPool[effect] is not a function` — LOCAL PATCH 1 masks that crash
  down to silent render corruption.) **Solution:** give such a slot a
  **stable element root** and toggle **inside** that root, e.g.
  `` html`<div class="contents">${() => cond ? sub() : ''}</div>` `` — the
  `ref` then points permanently to the element. The **static** `contents`
  class is doubly deliberate: `display:contents` removes the wrapper box from
  layout (content shows → it becomes the flex item itself; empty → **no**
  flex item, so no `gap` artifact either), and a static class avoids a
  reactive attribute binding that would be set again on every navigation step
  (the flicker test in `navigate.spec.mjs` requires zero attribute mutations
  per step). Regression test: `tests/step-preview-stability.spec.mjs`.
  **Side effect, separately confirmed:** the same derailment also corrupted a
  completely different, nested `${() => componentCall(...)}` embedding in the
  same block-column list — `Block.mjs`'s `${() => codeDiff(...)}` — with a
  visible, silent symptom: after a same-file ↓/↑ cycle the selected card
  showed the **correct title** (`class::method`, an ordinary reactive text
  binding, hence not affected itself) but the **code of the previously
  selected block** — no crash, just wrong content, unless you happened to also
  hit the previously described `Cannot read properties of null (reading
  'after')` crash. Confirmed by bracketing the exact fix commit with a
  git-worktree comparison (before/after) against the same real PR data:
  before the `stepChevronSlot` fix the mismatch + crash reproduced reliably,
  after it didn't — so **no separate fix needed**, the same stable-element
  root fixed it too. Regression test: `tests/diff-code-vs-title.spec.mjs`
  (the same ↓/↑ cycle as `step-preview-stability.spec.mjs`, but instead of
  checking for the preview card's presence, verifies that the rendered diff
  text of the selected card always belongs to that block's own `/api/code`
  source — never a neighboring block).
- **arrow.js — a STATICALLY interpolated value that per instance is either a
  template or a string (`` ${cond ? html`…` : ''} `` without `() =>`) leaks
  the template function as text on chunk reuse.** Observed in the drill-hint
  chips of `RelatedPanel.mjs`: literally **`i=>je(n,i)`** appeared where the
  approval counter should be — that (in the vendored, minified build) is the
  template function itself: `html`` ` returns
  `const n=(i=>je(n,i)); n.isT=!0` (`bt` in `vendor/arrow.js`). Mechanism: if
  a chunk hydrates such a static slot with the **string** branch (`''`), `Ve`
  registers a **text-node binding** for that slot and the chunk stays
  reusable (`r` stays true); arrow caches chunks per template shape (`g`) and
  reuses such a cached chunk for a later instance with the same shape
  (`U`→`pe`). The static patch path `pe` knows only three cases —
  attribute, function binding, or **`textNode.data = value`** — so if the new
  value is a **template**, the template function gets written to `Text.data`
  and stringified. (If the template branch hydrates first, it sets `r=false`
  instead — which is why the bug is intermittent and a fresh first render
  doesn't show it.) **Solution, two allowed forms:** (1) make the slot
  **always a string** — precompute the text as a plain string on the
  descriptor (e.g. `approveText` in `nestedChangedKids`, `home.mjs`) and
  render it in an always-present element (hiding can use a precomputed
  whole-value class); or (2) turn it into a **`${() => …}` function binding**
  — arrow's reactive path (`re`) handles template↔`''` swaps correctly, and a
  closure that only reads a plain (non-reactive) descriptor object registers
  no deps and therefore can't co-subscribe to anything. Statically
  interpolating a template is only allowed if that slot is a template in
  **every** instance of that shape (like `testsBar`'s always-populated chip
  `.map()`). Regression test: the `=>` assertion in
  `tests/related-nested-chip.spec.mjs`.
- **arrow.js reuses a keyed node without re-running its function bindings —
  and sometimes drops an `.innerHTML`/attribute update for co-subscribers.**
  Two related pitfalls, both observed in the block cards of `DetailPanel`
  (`home.mjs`):
  1. If a keyed node switches role but its `.key(...)` stays the same (e.g. a
     block going from *preview* to *selected* on ↓/↑), arrow.js **moves +
     patches** the existing node instead of rebuilding it: the
     `${() => …}` function bindings inside don't re-run and a frozen binding
     (e.g. the `activeGroup` highlight) never fires for the new state.
  2. If **multiple** reactive consumers subscribe to the same property (e.g.
     the diff render reads `b.code` and a `watch` getter reads
     `curBlock().code`), arrow.js **intermittently** drops the
     `null→loaded` update of the diff binding — the diff stays stuck on
     "loading" while the code is already there.
  Solution (both): let non-navigation transitions force a **fresh** node via
  the key, and rebuild the card from the outside instead of relying on the
  fragile `b.code` binding. Concretely in `home.mjs`: the block-card key
  encodes role (`sel`/`prev`) **and** code status (`load`/`code`/`err`). The
  DetailPanel binding subscribes to `state.codeVersion` (bumped by
  `ensureCode` as soon as code arrives) — a counter alongside `b.code` — so
  it reliably re-runs and flips the key, which produces a **fresh** diff
  binding that reads the loaded code. The `setCommentScope`/`setRelated`
  watches still read `curBlock().code` (they have to, to follow the cursor);
  that makes them co-subscribers and is exactly why the diff binding itself
  can miss the update — hence rebuilding via the key instead of adding yet
  another `b.code` reader. See `.claude/rules/detail-layout.md`.
- **A `state.x` read that you call synchronously inside an outer array-building
  `${() => {...}}` closure (instead of in its own nested reactive slot) makes
  the ENTIRE closure depend on `state.x`** — even if the outcome itself only
  concerns one small element. Seen in `home.mjs`'s `DetailPanel`: the
  block-column closure that builds all `Block(...)` cards called
  `canStep(-1)`/`canStep(1)` (for the gray step chevron) **directly**;
  `canStep` reads `state.change`/`mode`/`focusLevel`. As a result, the entire
  closure — and thus every `Block()` call with **fresh**
  `activeGroup`/`hintsEnabled`/`diffActive`/etc. closures — re-ran on
  **every** ↑/↓ step. The `.key(...)` prevented a full DOM-node replacement
  (arrow matches it and reuses the node via `move+patch`), but every
  function-bound attribute slot (`class`, checkbox `.indeterminate`,
  category badge, etc.) still got **re-set** (`setAttribute` doesn't compare
  against the old value) — a measurable `MutationObserver` cascade over the
  ENTIRE card on every step, which read as visible flickering (not just the
  highlight shifting, the whole card "breathed" along). **Solution:** move
  the `state.change` read to its own nested
  `${() => canStep(...) ? … : ''}` binding (the same shape as the existing
  `${() => menu.open ? menuOverlay() : ''}` toggle) so only that small slot
  reacts to navigation state; the outer closure stays limited to the deps it
  explicitly names (`selected`/`codeVersion`/`focusLevel`). See
  `stepChevronSlot` in `home.mjs` and `.claude/rules/detail-layout.md`.
- **arrow.js doesn't fully clean up a dropped (conditionally rendered)
  subtree — its reactive expressions stay subscribed (use-after-free).** Seen
  in the **command menu** (`home.mjs` + `CommandMenu.mjs`): the overlay hangs
  off a `${() => menu.open ? menuOverlay() : ''}` binding. On close that
  returns `''` and the overlay disappears from the DOM, **but** the list/row
  bindings of that `CommandMenu` instance stay subscribed to the state object
  they were built against. If a **later** open mutates that object (a
  different `mode`, or entering a submenu that sets `sub`), those **orphan
  bindings** fire against expression slots that have since been released →
  arrow throws `W[t] is not a function` (a counter index in arrow's slot pool
  points to a recycled slot). Reopening in the same mode doesn't crash (no
  dep changes), cross-mode or a submenu does. It's a **latent** bug: the old
  flow never opened a second menu (Enter/`/` were swallowed while the
  composer was open), so it only became visible once the comment-kind
  `compose` mode opened a menu **over** the composer.
  **Solution:** split the menu state into a **stable** `menu` (only `open`,
  which the top-level binding hangs off) and a **disposable**
  `let ms = reactive({query, sel, sub, mode})` that `openMenu` **replaces**
  with a fresh object on **every** open. Orphan bindings from a previous open
  then point to the **old** `ms`, which we never touch again, so they never
  fire; only the live bindings (against the current `ms`) run. `closeMenu`
  only sets `menu.open=false` — it deliberately leaves `ms` alone.
  (Always-mounted-with-CSS-hiding does **not** work: then `CommandMenu` would
  already render at page load — before a block is selected — and the label
  functions that read `curBlock()` would throw anyway, corrupting the slot
  pool.) See `.claude/rules/keyboard-navigation.md`.
- **This same disposal gap is also a memory leak, not just a crash risk — and
  the `ms` swap above only fixes the crash.** The `ms` swap prevents an
  orphan binding from **crashing** (it hangs off an object that never
  changes again, so it never fires again), but arrow.js's `Ft` teardown
  (cleaning up a dropped keyed node) only cleans up the expression slots the
  node **itself directly** owns — it never cascades into a nested piece of
  template embedded via `${() => componentCall(...)}` (such as
  `${CommandMenu(ms, ...)}` in `menuOverlay()`, or `${() => codeDiff(...)}` in
  `Block.mjs`). Such a nested reconciler tree (every row, every `.innerHTML`
  binding in it) therefore stays a live, DOM-less (detached) piece of
  template **forever** — exactly "Detached `<span>`/`<div>`/Text" growth in a
  heap snapshot. That's already a (slowly growing, per-open) leak on its own,
  but it becomes an **active, ever-faster growing** problem as soon as an
  orphan binding depends **not only** on the discarded `ms` but **also** on
  **global, continuously changing** state: such a binding stays registered
  against that global property after closing and therefore re-evaluates on
  **every** subsequent, unrelated change — for **every** menu instance ever
  opened. Concretely found: `COMMANDS[0]`'s "Approve …" label (reads
  `curBlock()`/`state.mode`/`state.gran`/`state.change`/`b.approvedRows`/
  `b.approvedCalls`), plus similar labels in `COMPOSE_COMMANDS`/`PR_COMMANDS`
  — exactly the **standard, most-used** Enter palette, and the automatic
  postApprove follow-up menu after **every** group approval
  (`afterApproveAction`). Every open+close cycle left behind an ever more
  expensive ghost that recalculated on every subsequent
  navigation/approve step — a Playwright-measured, reproducible ~3.6×
  slowdown of 60 `f`/`s` keystrokes after 200 open/close cycles on the
  unpatched code (0.9–1.0× — flat, no growth — after the fix), which in
  practice manifested as "the tab eventually freezes" after enough
  approve+navigate cycles.
  **Fix (applied, low risk):** never let a `label` **function** reach the
  nested, never-cleaned-up `CommandMenu` tree. `resolveLabel`/
  `snapshotCommands` (`home.mjs`) call such a function **once** from
  ordinary, non-reactive code (`openMenu`, i.e. outside any arrow.js
  `Te()/Ae()` tracking bracket) and fix the result as a plain string on
  `ms.commands`/`ms.sub` — CommandMenu's own `${() => labelOf(c)}` binding
  then never sees anything but a string, so it registers no dependency on
  anything outside `ms`, and an orphan binding stemming from that never fires
  again (just like the existing `ms`-only bindings).
- **Root-cause fix: `Ft` now cascades into nested-mounted reconciler subtrees
  (`LOCAL PATCH 2` in `src/vendor/arrow.js`).** The `CommandMenu` fix above is
  a targeted, app-level band-aid (never let a `label` function reach the
  tree); the same disposal-gap pattern also sat **under** the card re-render
  in `DetailPanel`/`Block.mjs` (every time a block card got a **new key** —
  preview→selected, code just loaded, focus-level switch, see
  `.claude/rules/detail-layout.md` — the old `<article>` was torn down, but
  its nested `${() => codeDiff(...)}` subtree, with its
  `b.approvedRows`/`state.diffViewMode`-reading `.innerHTML` bindings,
  hung around in the same way). That already happened on **plain
  navigation** (not just approving) and was the single biggest contributor
  to unbounded memory growth during a review session (measured with
  Playwright/CDP heap snapshots: +4600 detached DOM nodes per 60 card
  re-renders before the patch, vs. ±30 — noise — after; a second,
  timing-based experiment showed a ~7-8× slowdown of a bounded
  `b.approvedRows` mutation after 60 re-renders before the patch, vs.
  ~0.85-0.93× — flat — after). Instead of continuing to patch this per
  component (every new nested `${() => componentCall(...)}` embedding would
  reintroduce the same leak), the actual root cause was patched in arrow.js
  itself: `re(t)` (upstream `createRenderFn`, the reconciler factory that
  `Ve`/upstream `createNodeBinding` uses for **every** nested
  component/array/template value — `CommandMenu`'s rows, `Block.mjs`'s
  `${() => codeDiff(...)}`, `RelatedPanel`'s `.map()` lists, …) now
  registers, via its first parameter (upstream the SSR `capture` flag, dead
  in this build — esbuild tree-shook every `if(capture)` branch away,
  confirmed by grepping the whole function body for a standalone `t` token
  before it was reused), one cleanup on the **owner** node: as soon as that
  owner is torn down via `Ft`, this cleanup also cleans up whatever the
  reconciler is currently keeping mounted, via the **same** existing dispatch
  (`qt`/upstream `removeUnmounted` — cache-for-reuse vs. fully destroy,
  chunk-or-array) that top-level content already got. Purely additive (3
  small insertions, no existing line changed) and **automatically recursive:
  correct**: a nested reconciler that itself nests something else registers
  its own cleanup on its own owner the same way. Verified against the real,
  non-minified upstream source (`@arrow-js/core@1.0.6`,
  `dist/index.mjs` + `dist/chunks/internal-*.mjs` via jsDelivr) to trace the
  minified names (`re`=`createRenderFn`, `Ve`=`createNodeBinding`,
  `Ft`=`destroyChunk`, `qt`=`removeUnmounted`, `n.u`=`chunk.u`) with certainty
  rather than guessing from minified text — see the `LOCAL PATCH 2` comment
  block in `vendor/arrow.js` for the full mechanism and the exact restore
  instructions on an arrow.js upgrade.
- **`Element.scrollIntoView({block: 'nearest'|'center'})` also moves the
  horizontal axis if you omit `inline`** — that's the DOM default, not an
  arrow.js quirk, but it bit here because a vertical "keep this row in view"
  scroll (Underlying-code card, chips, Tasks, comment reactions) happens to
  sit inside `<main>`'s horizontally scrolling column flow: every ↓/↑/→ step
  in such a list could unintentionally shift `<main>`'s own `scrollLeft` and
  push the card holding keyboard focus (to the left of the panel) out of
  view — exactly the complaint "after → and then ← the selection is no
  longer fully in view". **Solution:** `scrollIntoViewVertical`
  (`RelatedPanel.mjs`, exported) walks up from the element to the first
  ancestor that actually scrolls vertically
  (`scrollHeight > clientHeight` — a horizontally scrolling `<main>` never
  matches that, so the walk naturally stops one level before it) and sets
  only its `scrollTop` — never call `scrollIntoView()` itself for a
  "stay-in-view-while-navigating-a-list" scroll. Used by
  `scrollCodeIntoView`/`scrollChipIntoView`/`scrollTaskIntoView`/
  `scrollReactionIntoView` (`RelatedPanel.mjs`) and the `scrollChangeIntoView`
  fallback (`home.mjs`). `scrollFocusIntoView` (which deliberately **does**
  align the focused column left with `inline:'start'` on a `←`/`→` focus
  switch) stays unchanged — that's the one place where a horizontal scroll
  is actually wanted. See `tests/scroll-focus-vertical-only.spec.mjs`.
- **Syntax highlighting:** Prism 1.29.0 is vendored as a single ES module in
  `src/vendor/prism.js` (core + markup + clike + markup-templating + php,
  with `window.Prism={manual:true}` so it doesn't auto-highlight the whole
  page). The code panes in `Block.mjs` highlight PHP with
  `Prism.highlight(...)` and show the result via the `.innerHTML` binding.
  Prism's own container CSS is deliberately omitted; only the token colors
  live in the `<style>` of `index.html`, **scoped to the `.language-php`
  class** that every code fragment carries — so not just the diff panes but
  also the Underlying-code cards + the comment hint (`RelatedPanel.mjs`) and
  the footer get the same colors. (Was previously scoped to
  `[data-testid=code-diff]`, which left everything outside the diff panes
  colorless.)
- **Markdown rendering:** `snarkdown` (v2.0.0, MIT, ~1kb) is vendored as an ES
  module in `src/vendor/snarkdown.js` (verbatim upstream algorithm, only a
  vendoring header comment added) — used exactly as it comes out of the box:
  headings, lists, bold/italic/strike, blockquotes, inline code, links,
  images, `---`. `src/markdown.mjs` is a thin wrapper
  (`renderMarkdown(text) -> safeHtmlString`) that adds two things around it:
  (1) fenced code blocks are extracted **before** anything else and rendered
  with the same Prism `highlight()` as the diff panes (`Block.mjs`) instead
  of snarkdown's own bare `<pre><code>` — hence also the `.language-php`
  class on every code fragment (same CSS scope as above); (2) an XSS safety
  layer: the **entire** raw Markdown text is first fully HTML-escaped
  (`escapeHtml`, `&<>"`) before it goes to snarkdown — snarkdown itself does
  **not** escape loose HTML in the source text, only the attribute values it
  builds itself (link/image URLs) — and link/image URLs then also pass
  through `sanitizeUrls`, which neutralizes a `javascript:`/`vbscript:`/
  `data:text/html` scheme as an extra layer (snarkdown's own `encodeAttr`
  already escapes the quote in a URL, so an `<img src>` can't inject a loose
  `onerror=` attribute anyway). Used in `prInfoCard` (`home.mjs`) for the PR
  summary/description/Jira description via the `.innerHTML` binding; a small
  `.markdown-body` style block in `index.html`
  (headings/lists/links/blockquote/code/images) is the hand-written
  typography layer — Tailwind Play CDN has no typography plugin without a
  build step. **No** GFM tables or task checklists (`- [ ]`) — deliberately
  kept out of scope, snarkdown doesn't support them and no extension has been
  built for them.
  **Comment bodies also render as Markdown** (`RelatedPanel.mjs`):
  `commentBody(c)` is the **only** place that renders a comment body
  (`() => renderMarkdown(c.body)`, `.innerHTML` binding) — reused by
  `commentRow` (the comment-row preview), `reactionBubble` (every thread
  bubble, both the block-scoped comment panel and the PR-wide `prWideItem`),
  and therefore automatically also a future fourth render point. The input
  (composer `<textarea>`/`<input>`) is a bare text field with no
  restriction — "supporting markdown input" was thus already free, only the
  display was missing `renderMarkdown`. **Deliberately kept outside
  `commentBody`:** the single-line, `truncate`/`line-clamp` title contexts
  where formatted structure adds little and a half-cut-off `**`/code fence
  looks uglier than plain text — the thread-header title
  (`selComment().body`) and `workflowNote`'s Tasks snippet therefore stay
  plain text.
  **Long words/URLs break within the word (`[overflow-wrap:anywhere]`):**
  each of the three `.innerHTML="${commentBody(...)}"` containers
  (`commentRow`'s preview span, `reactionBubble`'s bubble `<div>`,
  `prWideItem`'s body span) carries this arbitrary-value Tailwind class next
  to its existing `truncate`/`line-clamp`/no-wrap class. Without this class,
  text only breaks at word boundaries (`break-words`/browser default), so a
  long, spaceless token (URL, hash, concatenated path) can stick out of the
  card/bubble; `overflow-wrap:anywhere` only breaks such a word on overflow,
  mid-word, without wrapping normal text any differently.
- **Shared avatar helper (`src/avatar.mjs`), author+avatar on every
  comment/reply.** `avatarHTML(name, avatarUrl, sizeCls, extraCls)` is
  extracted from `overview.mjs`'s `reviewerAvatar` (the reviewer avatars in
  the PR list): an `<img>` if there's an `avatarUrl`, otherwise an initials
  circle (first two letters, uppercase) — exactly the same colors/shape as
  the PR list. `reviewerAvatar` now calls it itself for its own circle (the
  approved/changes-requested badge around it stays local to `overview.mjs`).
  An `<img>` falls back to the same initials circle on a load error via a
  static `onerror` attribute string (no reactive binding needed — that's not
  an arrow.js pitfall, `onerror` is never set by arrow.js itself here) so
  that an unreachable/offline image (e.g. `SLASH_GITHUB=off` tests) never
  leaves a broken-image icon behind. `RelatedPanel.mjs` uses it in
  `commentRow` (comment row, `h-4 w-4`), `reactionBubble` (every thread
  bubble — the synthetic opening and every reaction, both already carry an
  `author`, see `threadMessages`) and `prWideItem` (the PR-wide comments):
  author name + avatar on their own line above the body/kind badge
  (`data-testid=comment-author`/`reaction-author`/`pr-wide-author`, plus the
  corresponding `*-author-line` wrapper). **Data-model note:**
  comments/reactions (`modules/comments`) do carry an `author` login
  (`Comment.Author`/`Reaction.Author`, also filled for GitHub-imported
  comments/replies, see `comment_import.go`), but **no avatar URL** — the
  GitHub fetch (`modules/github`) only threads `user.login` through, never
  `user.avatar_url`. Every comment/reply avatar therefore always renders as
  an initials circle today; a later backend extension (carrying an avatar
  URL through `ghComment`/`Reply`/`ReviewComment`/`GeneralComment` + a new
  column in `comments.db`) would make the real GitHub profile picture appear
  without needing to change the frontend (`avatarHTML` already supports it).
  See `tests/comment-author-avatar.spec.mjs`.
- **Theme: system/light/dark, with a manual cycle button
  (`src/theme.mjs`).** The theme once followed **exclusively** the system
  setting (`prefers-color-scheme`, Tailwind `darkMode:'media'`, no own
  toggle); that choice has been reverted — a reviewer sometimes wants to
  deliberately force light/dark, independent of the OS setting.
  `src/theme.mjs` is the shared (not a component, a pure utility, like
  `urlState.mjs`) module for both pages:
  - **Three states**, not a binary on/off: `theme.pref` ∈
    `'system'|'light'|'dark'` (default `'system'`). A binary toggle would
    give a reviewer who clicked "light" while the OS is on dark no way back
    to "follow system" without changing the OS setting itself.
  - **Tailwind runs on `darkMode: 'selector'`** (no longer `'media'`, in the
    same `tailwind.config` `<script>` before the CDN styles) — every
    existing `dark:` utility keeps working unchanged, only the trigger
    changes from the media query to the **presence of a `.dark` class** on
    `<html>`.
  - `theme.mjs`'s `applyTheme(pref)` sets that `.dark` class **plus** a
    `data-theme="light"|"dark"` attribute on `<html>` (for the separate CSS
    below, which can't read a class), computed as
    `pref==='system' ? matchMedia(...).matches : pref==='dark'`.
    `initTheme()` (called as a module side effect from both `home.mjs` and
    `overview.mjs`) applies it initially, subscribes a
    `watch(() => theme.pref, applyTheme)` (the toggle) and a
    `matchMedia('(prefers-color-scheme: dark)')` `'change'` listener that
    only intervenes as long as `pref === 'system'` — so "system" also keeps
    following **live** if the OS setting changes while the page is open.
  - **Anti-flash:** before the Tailwind CDN `<script>`, both shells
    (`index.html`/`overview.html`) have an **inline** `<script>` that
    duplicates the same localStorage-read + class/attribute-set logic (not
    imported — ES modules load async, and this has to run before the first
    paint). `theme.mjs`'s `initTheme()` then simply takes over reactively;
    no visible flash of the wrong theme at page load.
  - **The button** (`themeToggleButton(cls)`, `data-testid=theme-toggle`, one
    shared component function that both pages import): a click cycles
    `system → light → dark → system` (`cycleTheme()`, persists immediately to
    `localStorage`) and shows a monitor/sun/moon icon for the current state.
    Location on `/pr/<id>`: a **narrow row in `prInfoCard`** (`home.mjs`,
    `data-testid=pr-info-theme-row`), directly before the PR summary
    (`data-testid=pr-info-summary`) — **no longer** its own, always-visible
    `position:fixed` corner element (the older `ThemeToggleCorner`,
    `bottom-6 left-6 z-30`, has been removed) and also not in `Footer.mjs`
    (that footer has recently only shown itself when there's actually
    something to preview, `state.footerVisible`, see "Footer" in
    `.claude/rules/keyboard-navigation.md` — no reliable place for a
    permanently reachable button). Deliberate consequence: `prInfoCard` only
    exists while `state.showDescription` is true (stop 1 of the
    left→right navigation chain, see `detail-layout.md`), so the button is
    **no longer** visible by default — that has been explicitly agreed here,
    unlike the earlier `ThemeToggleCorner` solution, which was introduced
    precisely to make the button *always* reachable (the button used to sit
    in the top-right corner of the footer strip and was therefore
    unreachable in list mode — see `tests/theme.spec.mjs`, which now
    conversely presses `←` to stop 1 first before expecting the button). On
    `/pr-overview` (no footer, no `state.mode`) the button stays unchanged in
    the **overview header** (`overview.mjs`'s `headerBlock`, next to the
    existing PR-count pill) — that page has no `showDescription` gating.
  - **Persistence:** `localStorage.getItem/setItem('theme', ...)` —
    deliberately **outside** `bindUrlState`/the query string (not a
    navigation position, doesn't belong in a shareable link) but also not
    ephemeral like `state.showApproved` (a theme choice is something you want
    remembered across a refresh).
  `overview.html` once had a **forced** dark mode (`<html class="dark">` +
  `darkMode:'class'`, and `overview.mjs` used bare `zinc-*` classes without
  any `dark:` variant); that has been removed — `overview.mjs` got a light
  base class before every previously bare dark class (the latter got a
  `dark:` prefix), symmetric with how `index.html`/`home.mjs`/`Block.mjs`/
  `BlockList.mjs`/`RelatedPanel.mjs`/`CommandMenu.mjs`/`Footer.mjs`
  (previously light-only) got a `dark:` variant behind every existing color
  class.
  **Color palette:** neutrals map 1-to-1 between the two families that
  already existed in the codebase — light `slate-*`
  (`bg-white`/`bg-slate-50/100/200`, `text-slate-900..400`,
  `border-slate-100/200/300`) ↔ dark `zinc-*`
  (`bg-zinc-900/950/800/700`, `text-zinc-100..500`, `border-zinc-800/700`,
  usually with a `/NN` opacity suffix for a subtler card tint than the solid
  `overview.mjs` dark tints). Semantic accent colors (emerald/rose/amber/sky/
  red/the category-badge hues in `BlockList.mjs`'s `CATEGORY_STYLE`) keep
  their hue but get a contrast-appropriate shade per mode: a light card tint
  (`bg-emerald-50`/`text-emerald-700`) becomes
  `dark:bg-emerald-500/15 dark:text-emerald-300`, and vice versa
  (`overview.mjs`'s `text-emerald-300`-on-dark becomes light
  `text-emerald-700`). Solid, saturated accent buttons/badges (`bg-indigo-500`,
  `bg-emerald-600` with `text-white`) and low-opacity rings
  (`ring-emerald-500/30` etc.) work in both modes without change and are
  deliberately left untouched — only backgrounds/text areas that sit *on the
  page or card background* need a separate light/dark shading.
  **What can't use a Tailwind `dark:` variant** (separate CSS, not a utility
  class): the Prism token colors and the `.markdown-body` typography in
  `index.html`'s `<style>` block. Those live in **two** matching blocks: the
  existing `@media (prefers-color-scheme: dark) { … }` block (fallback for
  the moment before `theme.mjs` has run) and a
  **`:root[data-theme="dark"] …` mirror** next to it (every selector
  literally duplicated with that attribute prefix — deliberately **no** CSS
  nesting, for maximum browser compatibility) that actually wins once the
  manual toggle overrides the OS setting. Both share the same palette: a
  GitHub-dark-inspired Prism palette + the zinc/indigo colors of the rest of
  dark mode.
  **Diff-row backgrounds** (`Block.mjs`, `paneHTML`) are arbitrary-value hex
  classes (`bg-[#fed7dc]` etc., "20% toward white" mixed with the
  Tailwind rose/emerald shade — see `blocks-and-ingest.md`); those got a
  `dark:bg-{color}-500/{opacity}` counterpart (e.g. `dark:bg-rose-500/25` for
  the active del row, `dark:bg-rose-500/10` for the filler tint) instead of a
  second hardcoded hex — simpler and consistent with the rest of the dark
  palette.
  **arrow.js-compliant:** wherever a class string runs through a reactive
  `class="${() => ...}"` function binding, the `dark:` class simply sits **in
  the same template string** as the rest of that value (no separate loose
  binding) — so no new pitfall on top of the existing
  "whole-value-in-one-binding" rule further down this file.
- Go: `net/http` `ServeMux`, handlers per feature. The `/api/` bridge shells
  out to `gh`/`claude` via `os/exec` — always validate input before handing
  it to a subprocess.
- **Code (Go + JS) is English** — comments, log messages, and identifiers. The
  docs in `.claude/` and `CLAUDE.md` are also English.
- **Git worktrees are allowed** — Claude/agents are welcome to set up a git
  worktree to work isolated or in parallel on a task (e.g. the Agent tool
  with `isolation: worktree`). An earlier agreement forbade this; that is
  hereby withdrawn. (Not to be confused with the **app's own** base/head
  worktrees under `data/worktrees/` from the ingest pipeline — those stay as
  described in `.claude/rules/blocks-and-ingest.md`.)

## Playwright test infra (per-worker isolated server)

- The Go binary is built **once** in `globalSetup` (`tests/_setup.mjs` →
  `go build -o tests/.tmp/slash .`), never per test.
- There is **no shared `webServer`** anymore. Each Playwright worker gets its
  **own** seeded SQLite DB and its **own** server on
  **port `4200 + workerIndex`** via the worker-scoped fixture in
  **`tests/_fixtures.mjs`**. Because `newTasks` places **all** module DBs
  (comments/workflows/relations/callresolve/inbox/prmeta) **next to** the
  `-db` path (`filepath.Dir`), one `-db tests/.tmp/w<n>/test.db` immediately
  isolates **all write state** per worker. The read-only base/head worktrees
  under `data/` stay shared (server `dataDir` is hardcoded `"data"`). This
  removes both the cross-worker **write races** (comment/workflow SQLite
  contention previously gave an empty `runId`) and the page-load contention
  that made the suite flaky.
- **Spec imports:** every spec imports `{ test, expect }` from
  **`./_fixtures.mjs`** (not `@playwright/test`), so `page.goto('/pr/…')` hits
  its own worker server (the fixture overrides `baseURL`).
- **Workers = 4** on this 8-core box: each worker runs a Go server **plus** a
  Chromium, so higher (6+) saturates the machine and gave flaky assertion
  timeouts. The `expect` timeout is set to **15s** (room for a slow render
  during a startup spike; passing tests stay under 1s) and `retries: 1`
  catches the remaining cold-start **mount race** (a few specs mount a
  component via a dynamic `import()` inside `page.evaluate()` against the
  live app page — needed for `index.html`'s Tailwind/Prism CSS — and the
  app's `history.replaceState` burst during load can briefly disturb that
  mount). A real failure fails both attempts.
- **Data note:** the diff content (`/api/code`) comes from the **gitignored**
  `data/worktrees/pr-<n>-{base,head}` — not a committed fixture. If those
  have locally drifted to a different commit (e.g. base+head on two adjacent
  commits instead of base=merge-base), most blocks show **no** changes and
  diff-content-dependent tests fail. So anchor diff-navigation tests on a
  block that reliably carries a change (block 0 of PR 12903).
- **A new fixture PR that really needs diff content** (not just
  child-listing/drill mechanics like PR 90/91/92/93/94, which deliberately
  have **no** worktree on disk) can **materialize its own small
  `data/worktrees/pr-<n>-{base,head}` programmatically in `globalSetup`**
  (`tests/_setup.mjs`) instead of relying on a real, locally present
  `gh`/`git` ingest (which isn't reproducible on another machine/CI) — see
  `materializeTreeWorktrees` (PR 95, `tests/postapprove-tree.spec.mjs`): a
  few hand-written PHP files with one genuinely changed line, written before
  each worker starts (shared, read-only, just like the existing worktrees),
  with the corresponding `blocks.json`/`relations.json` added to `seed()` in
  `tests/_fixtures.mjs`.
- **The harness always forces offline, regardless of the shell environment:**
  the worker fixture (`tests/_fixtures.mjs`) starts every server with
  **both `SLASH_GITHUB=off` and `SLASH_CLAUDE=off`** hardcoded in the
  `spawn` `env` (`{ ...process.env, SLASH_GITHUB:'off', SLASH_CLAUDE:'off', … }`)
  — it does spread the rest of `process.env`, but these two are fixed.
  Without the hardcoded `SLASH_CLAUDE=off`, a worker started from a shell
  without that var would really shell out to the `claude` CLI for the
  automatic call-resolution search (`resolve_call`); that stalls/times out
  and made comment-flow specs (e.g. `repro-live-comment.spec.mjs`)
  non-deterministically fail, depending on how the suite happened to be
  invoked. No spec expects a real (non-Fake) `claude` client — the
  LLM-resolved paths are tested via seed fixtures
  (`tests/fixtures/callresolve.json`) — so forcing the Fake everywhere is
  safe. **So never run the suite with loose `SLASH_GITHUB`/`SLASH_CLAUDE` env
  vars to get it offline** — the harness already does that; those vars are
  only still relevant for `go run .`/`slash` outside Playwright.
