// BlockList — the fixed left sidebar listing every touched block of a PR.
// A component: takes reactive() state and returns an arrow.js template. The
// parent (home.mjs) mounts it and owns the keyboard navigation.

import { html } from './vendor/arrow.js'
import { removedLabel } from './Block.mjs'
import { avatarHTML, identityOf } from './avatar.mjs'

// Tailwind classes per category tag, so the pills read like the screenshot.
const CATEGORY_STYLE = {
  ACTION: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300',
  CONTROLLER: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300',
  REQUEST: 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
  RESOURCE: 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-300',
  MODEL: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300',
  ENUM: 'bg-fuchsia-100 dark:bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300',
  JOB: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300',
  EVENT: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
  LISTENER: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
  SERVICE: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300',
  REPOSITORY: 'bg-lime-100 dark:bg-lime-500/20 text-lime-700 dark:text-lime-300',
  BUILDER: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  // Both plain "teal" (already RESOURCE) and plain "cyan" (already REQUEST)
  // are taken, so INTERFACE uses a noticeably darker/more saturated cyan
  // shade — still the requested teal/cyan-blue family, but visually
  // distinguishable from REQUEST's lighter cyan-100 pill at a glance.
  INTERFACE: 'bg-cyan-200 dark:bg-cyan-600/30 text-cyan-900 dark:text-cyan-200',
  MIGRATION: 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300',
  FACTORY: 'bg-pink-100 dark:bg-pink-500/20 text-pink-700 dark:text-pink-300',
  TEST: 'bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400',
  MODULE: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300',
  ROUTE: 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300',
  TRANSLATION: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-300',
  CONFIG: 'bg-stone-200 dark:bg-stone-500/20 text-stone-600 dark:text-stone-400',
  // Every hue in the palette below is already claimed, and a color-blind
  // user can't reliably tell TRAIT apart from OTHER/TEST by hue alone — so
  // this deliberately uses the separate "gray" family (distinct from the
  // slate/zinc/stone already in use) at a noticeably darker/higher-contrast
  // shade than OTHER's very light slate-100/zinc-800 or TEST's slate-200/
  // zinc-700, so the difference reads by LIGHTNESS, not hue. The word in
  // the pill ("TRAIT" vs "OTHER") still carries the meaning — color only
  // reinforces it.
  TRAIT: 'bg-gray-300 dark:bg-gray-600/40 text-gray-900 dark:text-gray-100',
  OTHER: 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400',
  // Synthetic comment-index items (kind:'comment', see commentBlockItem in
  // home.mjs) — a PR-wide comment turned into a navigable "Start" row. `red`
  // isn't used by any real block category above, so it reads distinctly from
  // the code-derived pills.
  COMMENT: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300',
}

// Colour + glyph per change status: + new, - gone, -/+ changed.
const STATUS_STYLE = {
  added: { cls: 'text-emerald-600 dark:text-emerald-400', mark: '+' },
  modified: { cls: 'text-amber-600 dark:text-amber-400', mark: '-/+' },
  removed: { cls: 'text-rose-600 dark:text-rose-400', mark: '-' },
}

export function categoryClass(cat) {
  return CATEGORY_STYLE[cat] || CATEGORY_STYLE.OTHER
}

export function statusInfo(status) {
  return STATUS_STYLE[status] || { cls: 'text-slate-500 dark:text-zinc-500', mark: status }
}

// `isPrWideComposing` is handed in by home.mjs rather than imported from
// RelatedPanel.mjs: RelatedPanel already imports THIS module (statusInfo/
// categoryClass), so importing it back would make the two modules circular for
// one boolean. Optional, so every existing caller/test keeps working.
export default function BlockList(state, isPrWideComposing = () => false) {
  return html`
    <aside
      data-testid="pr-index"
      class="${() =>
        // No footer reservation here — the pr-index is only meaningfully
        // visible in list mode (it slides fully off-screen in diff mode, see
        // the translate-x ternary below), and the footer only ever shows
        // content in diff mode (state.footerVisible, see Footer.mjs), so
        // there is nothing for it to reserve space for.
        'fixed bottom-6 left-6 top-6 flex w-[26rem] flex-col overflow-hidden rounded-xl border bg-white dark:bg-zinc-900 transition-all duration-200 ease-out ' +
        // Light-blue border while the keyboard drives stop 2 (list-mode, not
        // showing the description) — mirrors diffActive on the block-diff card
        // and the stop-1 border above, so all three stops highlight the same way.
        (state.mode === 'list' && !state.showDescription
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5') +
        ' ' +
        (state.mode === 'diff' || state.testColumnFocused || isPrWideComposing()
          ? // Slides fully away in diff mode, and equally once the
            // methodes-kolom (stop 2b) owns the keyboard in list mode —
            // stepping right past this index hides it either way;
            // testColumnFocused survives the diff→list transition, so ←
            // from a method's diff lands on the methodes-kolom with this
            // index still hidden, and only a second ← brings it back.
            // Third case: while an "algemene" (PR-wide) comment is being
            // written, so the composer isn't squeezed in beside an index and
            // a diff it has nothing to do with — ← closes the composer and
            // brings this straight back (see comments-panel.md/detail-layout.md).
            '-translate-x-[28rem] opacity-0 pointer-events-none'
          : // showDescription (stop 1, list-mode only) slides this pr-index one
            // column-width right so the PR-description panel can take its usual
            // left-6 spot instead of appearing after it — see PrInfoPanel/
            // detail-layout.md. 40.5rem = the description panel's own width
            // (39rem, 1.5x the original 26rem) plus the 1.5rem gap it leaves
            // before the pr-index, so the two sit flush next to each other
            // exactly like pr-index/<main> do.
            state.showDescription
            ? 'translate-x-[40.5rem] opacity-100'
            : 'translate-x-0 opacity-100')}"
    >
      <header class="shrink-0 border-b border-slate-200 dark:border-zinc-800 px-4 py-3">
        <div class="flex items-center gap-2">
          <span
            class="rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold tracking-wide text-white"
            >START</span
          >
          <h1 class="text-sm font-semibold text-slate-800 dark:text-zinc-200">
            Start — waar wil je beginnen?
          </h1>
        </div>
        <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">
          <span class="font-medium text-slate-700 dark:text-zinc-300"
            >${() => state.blocks.length}</span
          >
          startpunten &nbsp;·&nbsp; ↑ ↓ om te kiezen · → om de diff in te stappen ·
          ← om te zoeken
        </p>
        ${() => approvalSummaryLine(state)}
        <input
          id="block-search"
          data-testid="block-search"
          type="text"
          placeholder="Zoek startpunten…"
          autocomplete="off"
          spellcheck="false"
          class="${() =>
            'mt-2 w-full rounded-lg border bg-slate-50 dark:bg-zinc-800/60 px-3 py-1.5 text-sm text-slate-800 dark:text-zinc-200 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none ' +
            (state.searchActive
              ? 'border-indigo-300 dark:border-indigo-500 bg-white dark:bg-zinc-900 ring-2 ring-indigo-200 dark:ring-indigo-500/30'
              : 'border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-600')}"
          @input="${(e) => state.onSearch && state.onSearch(e.target.value)}"
          @focus="${() => {
            state.searchActive = true
            state.toggleFocused = false
            state.ignoreToggleFocused = false
          }}"
          @blur="${() => (state.searchActive = false)}"
        />
      </header>

      <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto" id="block-scroll">
        ${() => renderList(state)}
      </div>
    </aside>
  `
}

// isFullyApproved reports whether a top-level block (and its whole subtree) is
// completely approved — the same green ✓ state the row pill shows. Driven by the
// server-backed combined-approval summary (state.approvalSummaries), so it's right
// even before a block's code has lazily loaded.
export function isFullyApproved(state, b) {
  const s = state.approvalSummaries && state.approvalSummaries[b.id]
  return !!s && s.total > 0 && s.done === s.total
}

// isIgnoredComment reports whether a PR-comment index item (kind:'comment', see
// commentBlockItem in home.mjs) was explicitly hidden via the "Ignore" action in
// its action menu (prCommentCommandsFor). A SEPARATE, ephemeral flag from
// approval/resolve — a comment can be ignored without being resolved, and vice
// versa (see "Comment-index items" in detail-layout.md for the full mechanism
// and the deliberate not-persisted trade-off).
export function isIgnoredComment(state, b) {
  return b.kind === 'comment' && !!(state.ignoredComments && state.ignoredComments[b.id])
}

// renderList builds the starting-points list. Fully-approved blocks are hidden by
// default (state.showApproved === false) and revealed by a toggle row at the
// bottom. ONE exception: the block state.pinnedApprovedId names stays visible
// while it's also the current selection (i === state.selected) — set by
// home.mjs's revealSelectedIfHidden when a restored ?sel=file:line lands on an
// already fully-approved block, so that link works without unfolding every
// OTHER approved block PR-wide. Deliberately narrower than "the selected row is
// always shown": the live approve flow (fully approving the block you're
// currently looking at) never sets pinnedApprovedId, so that row still hides
// immediately, unchanged — see tests/selected-reveal-hidden.spec.mjs. It
// ALWAYS returns a keyed array (never a bare element), so arrow.js never
// freezes on a single↔array slot-shape switch (see conventions.md): the empty
// state is wrapped as an array of one keyed element.
function renderList(state) {
  if (state.blocks.length === 0) return [emptyState(state).key('empty')]
  const approvedCount = state.blocks.filter((b) => isFullyApproved(state, b)).length
  const ignoredCount = state.blocks.filter((b) => isIgnoredComment(state, b)).length
  const items = []
  let commentHeadingDone = false
  let underlyingHeadingDone = false
  let hiddenCommentHeadingDone = false
  let mentionHeadingDone = false
  state.blocks.forEach((b, i) => {
    // An ignored comment (see isIgnoredComment) is its own, SEPARATE hidden
    // section from the approved-blocks one below — checked first: an ignored
    // comment stays hidden regardless of its resolved status, and vice versa.
    if (!state.showIgnored && isIgnoredComment(state, b)) return
    const pinnedVisible = i === state.selected && b.id === state.pinnedApprovedId
    if (!state.showApproved && !pinnedVisible && isFullyApproved(state, b)) return
    // Comment-index items (kind:'comment', see commentBlockItem in home.mjs)
    // sort to the very top of state.blocks (recomputeLeftList's rank -1) —
    // the first VISIBLE one gets its own "PR-comments" heading, mirroring
    // underlyingHeading below.
    // A comment that @-mentions the local reviewer (b.mentioned, see
    // commentBlockItem/mentions.mjs) sorts above every other comment item
    // (rank -2) and gets its OWN heading — checked before the "PR-comments" one
    // below, which is why that one excludes b.mentioned. Gated on
    // !isIgnoredComment for the same reason the PR-comments heading is: a
    // revealed ignored comment belongs under "Verborgen comments" above, even
    // when it mentions me.
    if (!mentionHeadingDone && b.kind === 'comment' && b.mentioned && !isIgnoredComment(state, b)) {
      items.push(mentionHeading().key('mention-heading'))
      mentionHeadingDone = true
    }
    if (!commentHeadingDone && b.kind === 'comment' && !b.mentioned && !isIgnoredComment(state, b)) {
      items.push(commentHeading().key('comment-heading'))
      commentHeadingDone = true
    }
    // A revealed (state.showIgnored) ignored comment gets its own "Verborgen
    // comments" heading, distinct from the "PR-comments" one above — it's a
    // separately toggled section, not merely a continuation of the PR-comments
    // list.
    if (!hiddenCommentHeadingDone && isIgnoredComment(state, b)) {
      items.push(hiddenCommentHeading().key('hidden-comment-heading'))
      hiddenCommentHeadingDone = true
    }
    // Relation children sort to the bottom of state.blocks (recomputeLeftList,
    // home.mjs); the first VISIBLE one gets the "Onderliggende code" heading
    // above it — its own keyed item, so the list stays one flat keyed array.
    if (!underlyingHeadingDone && state.underlyingIds && state.underlyingIds[b.id]) {
      items.push(underlyingHeading().key('underlying-heading'))
      underlyingHeadingDone = true
    }
    items.push(row(state, b, i))
  })
  if (approvedCount > 0) items.push(toggleRow(state, approvedCount))
  if (ignoredCount > 0) items.push(ignoreToggleRow(state, ignoredCount))
  // The push todo goes LAST, below both toggle rows: it is not about a block at
  // all but about the branch, and it is deliberately a thing for the end of the
  // review — see pushTodoRow.
  if (hasPendingPush(state)) items.push(pushTodoHeading().key('push-todo-heading'), pushTodoRow(state))
  return items
}

// hasPendingPush reports whether this PR has landed-but-unpushed Claude commits
// (state.pendingPush, fed by GET /api/pending-push — see loadPendingPush in
// home.mjs). Mirrors pushTodoRowVisible there; both must agree, since that one
// decides whether the keyboard has a stop here.
export function hasPendingPush(state) {
  return !!(state.pendingPush && state.pendingPush.ahead > 0)
}

// commentHeading titles the comment-index-items section at the top of the
// index (see recomputeLeftList/commentBlockItem in home.mjs) — PR-wide
// comments (issue/review/review_summary/ai_warning) turned into ordinary,
// navigable "Start" rows instead of their own separate card.
function commentHeading() {
  return html`
    <div
      data-testid="comment-heading"
      class="border-b border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-zinc-500"
    >
      PR-comments
    </div>
  `
}

// mentionHeading titles the very first section of the index: comments that
// @-mention the local reviewer (see mentions.mjs / settings.json for who that
// is). Includes block-anchored comments, which have no index row otherwise —
// so a mention buried in a thread on a block you haven't opened yet still
// surfaces. Same styling as the other section headings; the WORD carries the
// meaning, not a colour (see the colorblind rule in conventions.md).
function mentionHeading() {
  return html`
    <div
      data-testid="mention-heading"
      class="border-b border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-zinc-500"
    >
      Mentioned
    </div>
  `
}

// hiddenCommentHeading titles the section of comment-index items the reviewer
// explicitly ignored (see isIgnoredComment/toggleIgnoreComment in home.mjs),
// revealed via ignoreToggleRow below — a SEPARATE section from the ordinary
// "PR-comments" one (commentHeading above), independent of resolved status.
function hiddenCommentHeading() {
  return html`
    <div
      data-testid="hidden-comment-heading"
      class="border-b border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-zinc-500"
    >
      Verborgen comments
    </div>
  `
}

// underlyingHeading titles the relation-children section at the bottom of the
// index (the rows recomputeLeftList marks in state.underlyingIds) — the same
// blocks that also appear as children in the Onderliggende-code panel, kept
// navigable here as ordinary rows.
function underlyingHeading() {
  return html`
    <div
      data-testid="underlying-heading"
      class="border-b border-t border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-zinc-500"
    >
      Onderliggende code
    </div>
  `
}

// pushTodoHeading titles the push-todo section at the very bottom of the index.
// A section of its own, not a continuation of the toggle rows above it: those
// fold rows away, this one is a task the reviewer still has to do.
function pushTodoHeading() {
  return html`
    <div
      data-testid="push-todo-heading"
      class="border-b border-t border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-zinc-500"
    >
      Aan het einde
    </div>
  `
}

// pushTodoStatusWord is the row's state in WORDS — never colour alone, so it
// reads the same for a colour-blind reviewer (see the CATEGORY_STYLE.TRAIT note
// above for the same reasoning). The ⇧ glyph in the row's title carries the
// "there is something to send upstream" meaning next to it.
function pushTodoStatusWord(p) {
  if (p.state === 'pushing') return 'pushen…'
  if (p.state === 'failed') return 'push mislukt — Enter probeert opnieuw'
  return 'klaar om te pushen — Enter'
}

// pushTodoRow is the todo at the very bottom of the index: Claude's landed
// commits are already part of the PR's branch locally (and therefore already
// visible in this tree), but they are not on GitHub yet. It is deliberately NOT
// a comment on a block — it belongs to no block, it belongs to the end of the
// review — and deliberately a stop of the sidebar's ↑/↓ loop like the two
// toggle rows above (state.pushTodoFocused, see stepListSelection in home.mjs),
// so it is reachable without the mouse.
//
// Enter/click never push directly: both open the same one-more-step confirm menu
// (state.onPushTodo → openMenu('pushTodo'), see pushTodoCommandsFor).
//
// The key encodes the row's STATE and count, not just its identity: everything
// but the focus class is interpolated statically (a plain string, read from a
// non-reactive snapshot of state.pendingPush), and arrow.js reuses a keyed node
// without re-running its bindings — so ready → pushen… → mislukt has to arrive
// as a fresh node (see the keyed-node pitfall in arrowjs-pitfalls.md).
function pushTodoRow(state) {
  const p = state.pendingPush || {}
  const n = p.ahead || 0
  return html`
    <button
      data-testid="push-todo"
      class="${() =>
        // Same always-present 1px border as toggleRow, so gaining focus only
        // changes colour and never the row height.
        'w-full border px-3 py-2 text-left ' +
        (state.pushTodoFocused
          ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => state.onPushTodo && state.onPushTodo()}"
    >
      <span class="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-zinc-300">
        <span aria-hidden="true">⇧</span>
        <span data-testid="push-todo-title"
          >${n} commit${n === 1 ? '' : 's'} nog niet gepusht naar
          ${p.headRef || 'de PR-branch'}</span
        >
      </span>
      <span
        data-testid="push-todo-status"
        class="mt-0.5 block text-[11px] text-slate-500 dark:text-zinc-500"
        >${pushTodoStatusWord(p)}</span
      >
    </button>
  `.key(`push-todo-${p.state || 'ready'}-${n}`)
}

// unpushedPill marks a row whose file is part of a commit that landed on the
// PR's branch locally but isn't on GitHub yet (state.pendingPush.files, see
// loadPendingPush in home.mjs) — the same thing the push-todo row at the bottom
// is about, but per block, so the reviewer can see WHICH code is still only
// local while walking the index. A glyph plus a word, never colour alone.
//
// Per FILE, not per block: the read model reports the changed paths of the
// pending commits, which is as fine-grained as a git diff gets without
// re-deriving blocks for an unpushed commit — an accepted trade-off (a file
// with several changed blocks marks all of them).
//
// A nested `${() => …}` slot like removedPill/approvalPill, so both branches are
// whole templates and a push landing repaints only this pill.
function unpushedPill(state, b) {
  const files = state.pendingPush && Array.isArray(state.pendingPush.files) ? state.pendingPush.files : []
  if (!b.file || !files.includes(b.file)) return ''
  return html`
    <span
      data-testid="row-unpushed"
      title="Deze wijziging staat lokaal op de PR-branch, maar is nog niet gepusht"
      class="shrink-0 rounded bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      >⇧ ongepusht</span
    >
  `
}

// toggleRow is the bottom button that hides/shows the fully-approved blocks.
// It's also a stop of the sidebar's keyboard ↑/↓ loop (see stepListSelection/
// searchStepSelection in home.mjs, which also runs through toggleRow's own
// sibling ignoreToggleRow and the search box): state.toggleFocused gives it
// the same indigo highlight as a selected row (data-idx rows above) while the
// keyboard sits on it, rather than on any block.
//
// Deliberately NOT gated on state.showDescription/blockIndexEntered like
// rowFocused above: a genuinely fresh, fully-approved-PR open can land
// state.toggleFocused here (applyDefaultUnapprovedSelection, home.mjs) while
// state.showDescription is still true (stop 1). Suppressing this highlight
// the same way rowFocused does would make it stay invisible until the
// reviewer actually crosses into the index — hiding a real, reachable
// selection, worse than the rare visual overlap this would have prevented.
// See tests/fresh-open-default-selection.spec.mjs's "everything approved"
// case and the corrected account of the (now-fixed) related keyboard bug in
// .claude/docs/keyboard-navigation.md — state.blocks.length never actually
// hits 0 here (approved blocks stay in state.blocks; only this render's own
// display loop below hides them), so that guard was never the culprit; the
// toggle-row ArrowRight-exclusion guard in onKeydown was.
function toggleRow(state, count) {
  return html`
    <button
      data-testid="toggle-approved"
      class="${() =>
        // A full border (always present at 1px, in both branches, so toggling
        // focus never shifts the row height — only its colour changes) mirrors
        // the same indigo/slate border logic every other block/card uses;
        // the existing bg-indigo-50 + ring-inset stays as an extra signal on
        // top, since ~30 Playwright specs already assert bg-indigo-50 on a
        // selected row (see block-row assertions across the suite).
        'w-full border px-3 py-2 text-left text-xs font-medium ' +
        (state.toggleFocused
          ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30 text-indigo-700 dark:text-indigo-300'
          : 'border-slate-300 dark:border-zinc-700 text-slate-500 dark:text-zinc-500 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => {
        state.showApproved = !state.showApproved
        state.toggleFocused = true
        state.ignoreToggleFocused = false
        state.blockIndexEntered = true
      }}"
    >
      ${() =>
        state.showApproved
          ? `Verberg ${count} goedgekeurde ${count === 1 ? 'block' : 'blocks'}`
          : `Toon ${count} goedgekeurde ${count === 1 ? 'block' : 'blocks'}`}
    </button>
  `.key('toggle-approved')
}

// ignoreToggleRow is the bottom button that hides/shows ignored PR-comment
// index items — a mirror of toggleRow above, but for a SEPARATE section
// (state.showIgnored, not state.showApproved). Also a stop of the sidebar's
// keyboard ↑/↓ loop, exactly like toggleRow: state.ignoreToggleFocused gives
// it the same indigo highlight while the keyboard sits on it.
function ignoreToggleRow(state, count) {
  return html`
    <button
      data-testid="toggle-ignored"
      class="${() =>
        // Same full-border treatment as toggleRow above (see its comment).
        'w-full border px-3 py-2 text-left text-xs font-medium ' +
        (state.ignoreToggleFocused
          ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30 text-indigo-700 dark:text-indigo-300'
          : 'border-slate-300 dark:border-zinc-700 text-slate-500 dark:text-zinc-500 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => {
        state.showIgnored = !state.showIgnored
        state.ignoreToggleFocused = true
        state.toggleFocused = false
      }}"
    >
      ${() =>
        state.showIgnored
          ? `Verberg ${count} verborgen ${count === 1 ? 'comment' : 'comments'}`
          : `Toon ${count} verborgen ${count === 1 ? 'comment' : 'comments'}`}
    </button>
  `.key('toggle-ignored')
}

// approvalSummaryLine is the PR-wide combined-approval counter in the header,
// fed by the server-backed total (state.approvalTotal). Hidden until there's
// anything to approve.
function approvalSummaryLine(state) {
  const t = state.approvalTotal
  if (!t || t.total === 0) return ''
  const done = t.done === t.total
  const remaining = t.total - t.done
  return html`
    <p class="mt-1 text-xs" data-testid="approval-summary">
      <span
        class="${'rounded px-1.5 py-0.5 font-semibold tabular-nums ' +
        (done ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400')}"
        >${done ? '✓ ' : ''}${t.done}/${t.total} goedgekeurd</span
      >
      ${() =>
        done
          ? ''
          : html`<span class="ml-1 text-slate-500 dark:text-zinc-500"
              >· ${remaining} nog te reviewen</span
            >`}
    </p>
  `
}

// rowFocused reports whether row i currently owns the sidebar's keyboard
// highlight — not while a toggle row has it (state.toggleFocused/
// ignoreToggleFocused). Deliberately independent of state.searchActive: a row
// keeps its highlight while the search box also holds real DOM focus,
// exactly like the existing "browse the filtered matches while still typing"
// feature already did before the toggle-ignored/search loop existed (see
// stepListSelection/searchStepSelection in home.mjs) — the search box gets
// its own, separate ring for that.
//
// While state.showDescription is true AND state.blockIndexEntered is still
// false, no row reads as focused at all — a genuinely fresh open (no ?sel=)
// lands on stop 1 (the PR summary) with state.selected sitting on its
// just-loaded default (or applyDefaultUnapprovedSelection's automatic pick,
// home.mjs), and the reviewer never actually looked at the block index yet.
// Showing an indigo row there would read as "I already picked this block",
// which isn't true — see CLAUDE.md's URL-state note and
// .claude/docs/keyboard-navigation.md. blockIndexEntered flips to true at the
// first real stop-1<->block-index crossing (ArrowRight/ArrowLeft around
// showDescription, or a direct row click below) and then stays true for the
// rest of the session, so a restored `?sel=`/later revisit of stop 1 is
// unaffected.
function rowFocused(state, i) {
  if (state.showDescription && !state.blockIndexEntered) return false
  return i === state.selected && !state.toggleFocused && !state.ignoreToggleFocused
}

// categoryOrAvatar renders the leading badge of a row: for a synthetic
// comment-index item (kind:'comment', see commentBlockItem in home.mjs) the
// author's avatar (avatarHTML, shared with RelatedPanel.mjs's comment/reply
// rows) instead of the generic red "COMMENT" category pill — the avatar names
// *who* left the comment, which reads better than a category label that's
// the same for every comment row. Every real PR block keeps the ordinary
// category pill. A nested `${() => …}` slot (like removedPill/approvalPill
// below), so both branches are whole templates — no partial-interpolation or
// static template↔string pitfall (see conventions.md).
function categoryOrAvatar(b) {
  if (b.kind === 'comment') {
    const c = b.comment || {}
    // Through identityOf, like every other author avatar: an own (ui-placed)
    // comment shows the local reviewer, and a GitHub author shows their real
    // first name in the title (see avatar.mjs).
    const who = identityOf(c.source, c.author, c.avatarUrl)
    return avatarHTML(who.name, who.avatarUrl, 'h-5 w-5')
  }
  return html`
    <span
      class="${'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' + categoryClass(b.category)}"
      >${b.category}</span
    >
  `
}

function row(state, b, i) {
  const st = statusInfo(b.status)
  return html`
    <div
      data-idx="${i}"
      data-testid="block-row"
      class="${() =>
        // A full border (always present at 1px in both branches, so selecting
        // a row never shifts its height) mirrors the same indigo/slate border
        // logic every other block/card uses — replacing the previous
        // border-b-only hairline divider. The existing bg-indigo-50 + ring
        // stays as an extra signal on a selected row, since a large chunk of
        // the Playwright suite already asserts bg-indigo-50 there.
        'flex cursor-default items-center gap-2 border px-3 py-2 text-sm ' +
        (rowFocused(state, i)
          ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => {
        state.selected = i
        state.toggleFocused = false
        state.ignoreToggleFocused = false
        state.pushTodoFocused = false
        // A stale "which method"/"is the methodes-kolom focused" from a
        // PREVIOUSLY selected test_class row (see testClassRowItem in
        // home.mjs) must never leak onto whatever gets clicked next — mirrors
        // home.mjs's own selectRow helper for the keyboard paths.
        state.classMethodSel = 0
        state.testColumnFocused = false
        // A direct click IS a real choice, even while stop 1 (the PR
        // summary) is still showing next to the shifted-right index — see
        // rowFocused's own comment above.
        state.blockIndexEntered = true
      }}"
    >
      <span
        class="${() => (rowFocused(state, i) ? 'text-indigo-500 dark:text-indigo-400' : 'text-transparent')}"
        >›</span
      >
      ${() => categoryOrAvatar(b)}
      <span
        class="flex-1 truncate font-mono text-[13px] text-slate-800 dark:text-zinc-200"
        title="${b.label}"
        >${b.label}</span
      >
      ${() => removedPill(b)}
      ${() => unpushedPill(state, b)}
      ${() => commentActivityPill(state, b)}
      ${() => approvalPill(state, b)}
      <span class="${() => 'shrink-0 text-xs font-medium ' + st.cls}"
        >${st.mark}</span
      >
    </div>
  `.key(b.file + ':' + b.label + ':' + b.side)
}

// removedPill marks deleted code prominently in the sidebar: a rose pill
// "Verwijderd bestand" for a block whose whole file was deleted by the PR
// (b.fileDeleted, the reliable backend signal), or "Verwijderd" for a loose
// removed block. '' for everything else — same nested-slot shape as
// approvalPill below, so no keyed-list pitfall applies (see conventions.md).
function removedPill(b) {
  const label = removedLabel(b)
  if (!label) return ''
  return html`
    <span
      data-testid="block-row-removed"
      class="shrink-0 rounded bg-rose-100 dark:bg-rose-500/20 px-1 py-0.5 text-[10px] font-bold text-rose-700 dark:text-rose-300"
      >${label}</span
    >
  `
}

// approvalPill shows the combined approval progress of a block *and every block
// nested under it* (the count home.mjs rolls up into state.approvalSummaries):
// "done/total", green with a ✓ once everything is approved, neutral while
// partial. Hidden only when there's nothing to approve yet (total 0 — e.g. code
// still loading); the done state is always shown, never hidden.
function approvalPill(state, b) {
  const s = state.approvalSummaries && state.approvalSummaries[b.id]
  if (!s || s.total === 0) return ''
  const done = s.done === s.total
  return html`
    <span
      class="${'shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums ' +
      (done ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500')}"
      data-testid="block-approval"
      title="Goedgekeurde regels (dit block + onderliggende code)"
      >${done ? '✓ ' : ''}${s.done}/${s.total}</span
    >
  `
}

// commentActivityPill shows that there's an open comment thread somewhere in
// this row's own code or its underlying-code subtree (state.commentActivity,
// filled by home.mjs's decoupled watch — see nestedPrBlocks/
// commentScopeKeys): the avatar of whoever posted the most recent message
// across those threads, plus a "+N" text badge (never color-only — the
// reviewer is colorblind, see conventions.md) for how many OTHER open
// threads exist besides the one the avatar already represents
// (s.count - 1) — the avatar itself already visually stands for one thread,
// so the badge must count the rest, not the total (a total would read as
// "avatar plus N more" and overcount by one). Hidden entirely once nothing
// is open (a resolved thread stops counting — see commentActivitySummary),
// same disappear-once-done behavior as the 💬 row marker in the diff. Same
// nested-slot shape as removedPill/approvalPill above — a whole template, no
// partial interpolation, so no keyed-list pitfall (conventions.md). Exported
// so TestMethodsColumn.mjs can reuse it verbatim for a per-method row instead
// of a parallel implementation (state.commentActivity is keyed by both a
// state.blocks row's own id AND, for a test_class row, each of its methods'
// own id — see the commentScopeKeys/watch in home.mjs).
export function commentActivityPill(state, b) {
  const s = state.commentActivity && state.commentActivity[b.id]
  if (!s) return ''
  return html`
    <span
      class="shrink-0 flex items-center gap-0.5"
      data-testid="block-comment-activity"
      title="${s.count + (s.count === 1 ? ' open reactie' : ' open reacties') + ' (dit block + onderliggende code)'}"
    >
      ${avatarHTML(s.last.name, s.last.avatarUrl, 'h-4 w-4')}
      ${() =>
        s.count > 1
          ? html`<span
              data-testid="block-comment-activity-count"
              class="text-[9px] font-semibold text-slate-500 dark:text-zinc-500"
              >+${s.count - 1}</span
            >`
          : ''}
    </span>
  `
}

function emptyState(state) {
  return html`
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="text-sm text-slate-500 dark:text-zinc-500">No blocks ingested yet.</p>
      <button
        data-testid="ingest-btn"
        class="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        @click="${() => state.onIngest && state.onIngest()}"
        disabled="${() => state.ingesting}"
      >
        ${() => (state.ingesting ? 'Ingesting…' : 'Ingest #' + state.pr)}
      </button>
      ${() =>
        state.error
          ? html`<p class="max-w-xs text-xs text-rose-600 dark:text-rose-400">${state.error}</p>`
          : ''}
    </div>
  `
}
