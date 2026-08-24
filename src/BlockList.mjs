// BlockList — the fixed left sidebar listing every touched block of a PR.
// A component: takes reactive() state and returns an arrow.js template. The
// parent (home.mjs) mounts it and owns the keyboard navigation.

import { html } from './vendor/arrow.js'
import { movedLabel, removedLabel } from './Block.mjs'
import { avatarHTML, identityOf } from './avatar.mjs'
import { paletteClass } from './blockPath.mjs'
import { batch, batchItemFor, BATCH_STATE_LABEL, isBatchEligible } from './commentBatch.mjs'
import { claudeStatusText } from './ClaudeChat.mjs'
import { claudeTurnFor } from './claudeTurns.mjs'

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

// An unlisted category falls back to the shared rotating palette
// (blockPath.mjs's paletteClass), NOT to OTHER's grey. classify.go's
// type-directory table produces a much wider set of tags than the hand-picked
// list above (FEATURE, WORKFLOW, COMMAND, DTO, …), and Reindert's call was to
// "just start over with the colours" rather than let every new tag land on the
// same neutral pill. The hue is deterministic per tag, so one category always
// looks the same; the WORD still carries the meaning, so two tags sharing a
// hue is fine (the colourblind rule). "OTHER" itself is in the table above and
// keeps its deliberate grey — it means "we don't know", which should look
// unremarkable.
export function categoryClass(cat) {
  return CATEGORY_STYLE[cat] || (cat ? paletteClass(cat) : CATEGORY_STYLE.OTHER)
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
        // A real flex sibling of PrInfoPanel/<main> now (mounted together
        // inside one fixed row wrapper, see AppColumns in home.mjs) — no more
        // fixed left-6/top-6/bottom-6 of its own, and no more translate-x
        // trick to make way for PrInfoPanel: since that column sits BEFORE
        // this one in the same flex row, the row itself pushes this aside
        // right whenever it's open. No footer reservation here either — the
        // pr-index is only meaningfully visible in list mode (it collapses to
        // width 0 in diff mode, see the ternary below), and the footer only
        // ever shows content in diff mode (state.footerVisible, see
        // Footer.mjs), so there is nothing for it to reserve space for.
        'flex h-full shrink-0 flex-col overflow-hidden rounded-xl bg-white dark:bg-zinc-900 transition-all duration-200 ease-out ' +
        ((state.mode === 'diff' && !state.keepIndexInDiff) ||
        (state.mode !== 'diff' && state.testColumnFocused) ||
        isPrWideComposing() ||
        state.commentAnchorEntered
          ? // Collapses to width 0 (not just hidden via translate/opacity) so
            // it genuinely gives its space back to <main> instead of merely
            // sliding out of view while still claiming a flex slot — the fix
            // for a diff/comment column rendering PARTLY BEHIND this index
            // (a real, screenshot-reported bug from the old translate-based
            // hide: a position:fixed/translated box never gives up its own
            // layout space, so <main>'s own manually-synced offset was the
            // ONLY thing keeping the two apart, and any state where that sync
            // drifted showed content sliding in behind this aside). Collapses
            // in diff mode (see keepIndexInDiff below), and — ONLY while
            // still in list mode — equally once the methodes-kolom (stop 2b)
            // owns the keyboard: stepping right past this index hides it
            // either way. testColumnFocused itself survives the diff→list
            // transition (so ← from a method's diff lands on the
            // methodes-kolom), but it deliberately no longer forces the
            // collapse once state.mode is 'diff' — inside a test method's
            // diff the pr-index is governed by the same keepIndexInDiff fit
            // check as an ordinary block's diff (see below), not by
            // testColumnFocused; without the `state.mode !== 'diff'` guard a
            // mouse click into a test method's diff always collapsed this
            // index even on a wide viewport with room to spare (bug report:
            // "een click op een test index laat blokken index nog wel
            // inklappen"), because testColumnFocused stayed true straight
            // through the click. Third case: while an "algemene" (PR-wide)
            // comment is being written, so the composer isn't squeezed in
            // beside an index and a diff it has nothing to do with — ←
            // closes the composer and brings this straight back (see
            // comments-panel.md/detail-layout.md).
            //
            // Fourth case: state.commentAnchorEntered — an anchored
            // comment-index item whose own column the reviewer has stepped
            // into with the first → (or reached with a mouse click, see the
            // state.indexHandedOff watch in home.mjs). Reviewer request:
            // "als ik naar rechts ga uit een comment op regel blokken index
            // lijst, dan mag je eerste blok wegschuiven net zoals je doet als
            // je een code blok selecteert uit de blokken index" — that view
            // deliberately stays in list mode (openCommentAnchorDrill), so
            // the diff-mode case above never fires for it and this index used
            // to stay put where ordinary code navigation slides it away. ←
            // flips the flag back and brings this straight back, exactly like
            // the PR-wide compose case above. Accepted consequence (explicit
            // reviewer call): ↑/↓ keep walking this now zero-width index
            // until the second → hands the keyboard on.
            //
            // state.keepIndexInDiff is the one exception to the diff-mode
            // collapse: after a MOUSE click into a diff (an ordinary block's
            // OR a test class's active method's — both funnel through the
            // same ensureTopLevelDiffFocus, see home.mjs) this index stays
            // put as long as it still fits beside <main>'s own columns — a
            // click is not a step through the nav chain, so nothing is given
            // up for free. The keyboard path never sets it (enterDiff resets
            // it), so → out of the list keeps collapsing this exactly as
            // before. See applyDiffColumnFit in home.mjs / detail-layout.md.
            'w-0 border-0 opacity-0 pointer-events-none'
          : 'w-[26rem] border opacity-100 ' +
            // Light-blue border while the keyboard drives stop 2 (list-mode,
            // not showing the description) — mirrors diffActive on the
            // block-diff card and the stop-1 border above, so all three
            // stops highlight the same way.
            (state.mode === 'list' && !state.showDescription
              ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
              : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5'))}"
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
            state.staleRowFocused = false
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
  // An empty tree is exactly when the notice matters most (nothing was ingested
  // yet at page load, the commits landed afterwards), so it survives this early
  // return instead of only appearing next to a populated list.
  if (state.blocks.length === 0) {
    return state.blocksStale ? [staleTreeRow(state), emptyState(state).key('empty')] : [emptyState(state).key('empty')]
  }
  const approvedCount = state.blocks.filter((b) => isFullyApproved(state, b)).length
  const ignoredCount = state.blocks.filter((b) => isIgnoredComment(state, b)).length
  const items = []
  // The stale-tree notice goes ABOVE everything, including the comment items:
  // it says the whole list below it is out of date, so it must not sit inside
  // one of the sections it invalidates.
  if (state.blocksStale) items.push(staleTreeRow(state))
  let commentHeadingDone = false
  let lineCommentHeadingDone = false
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
    // A revealed (state.showIgnored) ignored comment gets its own "Verborgen
    // comments" heading regardless of its mentioned/line-anchored status — a
    // SEPARATE, separately toggled section from every other comment section
    // below, not a continuation of any of them. Checked before those, which is
    // why each of them excludes an ignored comment in turn.
    if (b.kind === 'comment' && isIgnoredComment(state, b)) {
      if (!hiddenCommentHeadingDone) {
        items.push(hiddenCommentHeading().key('hidden-comment-heading'))
        hiddenCommentHeadingDone = true
      }
      items.push(row(state, b, i))
      return
    }
    // A comment item that hangs on a real source line (b.lineAnchored, see
    // commentBlockItem in home.mjs) sorts UNDER the changed-files categories
    // (recomputeLeftList's rank 2.5) under its own "Comments op regels"
    // heading — including a mentioned one (reviewer request: it moves into
    // this section too, no longer kept at the very top just for that).
    // Collapsible, shown expanded by default (state.lineCommentsCollapsed).
    if (b.kind === 'comment' && b.lineAnchored) {
      if (!lineCommentHeadingDone) {
        items.push(lineCommentHeading(state).key('line-comment-heading'))
        lineCommentHeadingDone = true
      }
      if (state.lineCommentsCollapsed) return
      items.push(row(state, b, i))
      return
    }
    // Comment-index items with NO regel at all (PR-wide/orphan feedback) sort
    // right above the "Comments op regels" section (recomputeLeftList's rank
    // 2.4, just under 2.5 — reviewer request: "gooi algemene pr comments net
    // boven Comments op regels", moved down from the very top of the list) —
    // the first VISIBLE one gets its own "PR-comments" heading, mirroring
    // underlyingHeading below.
    // A comment that @-mentions the local reviewer (b.mentioned, see
    // commentBlockItem/mentions.mjs) is the one exception that STAYS at the
    // very top (rank -2, above every category) and gets its OWN heading —
    // checked before the "PR-comments" one below, which is why that one
    // excludes b.mentioned.
    if (!mentionHeadingDone && b.kind === 'comment' && b.mentioned) {
      items.push(mentionHeading().key('mention-heading'))
      mentionHeadingDone = true
    }
    if (!commentHeadingDone && b.kind === 'comment' && !b.mentioned) {
      items.push(commentHeading().key('comment-heading'))
      commentHeadingDone = true
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
  // The batch action row sits below both toggle rows but above the push-todo
  // section: it acts on comments that ARE in this list (see
  // batchEligibleRows below), so it belongs with the rest of the comment
  // machinery rather than with the branch-level push todo.
  if (batchEligibleRows(state).length > 0) items.push(batchActionRow(state))
  // The push todo goes LAST, below both toggle rows: it is not about a block at
  // all but about the branch, and it is deliberately a thing for the end of the
  // review — see pushTodoRow.
  if (hasPendingPush(state)) items.push(pushTodoHeading().key('push-todo-heading'), pushTodoRow(state))
  return items
}

// batchEligibleRows is the set of comment-index items comment_batch may work
// on — every row already IN this list (see "Every UNRESOLVED comment gets
// such a row too" in comments-panel.md) whose own comment passes
// isBatchEligible, EXCLUDING one the reviewer explicitly ignored
// (isIgnoredComment): an ignored row is hidden from the sidebar by default, so
// it must not silently carry a checkbox (or count toward the action row) that
// nobody can see without first revealing the "Verborgen comments" section.
// Deliberately scoped to state.blocks rather than the whole PR-wide cs.list
// (which is what the removed bulkComments palette read): the batch-selection
// checkbox lives on the row itself, so a comment with no row (e.g. its block
// isn't in this tree) simply can't be checked — a deliberate narrowing that
// came with moving the list into the index, not an oversight.
export function batchEligibleRows(state) {
  return state.blocks.filter(
    (b) => b.kind === 'comment' && isBatchEligible(b.comment) && !isIgnoredComment(state, b),
  )
}

// checkedBatchComments is the subset of batchEligibleRows the reviewer hasn't
// unchecked (state.batchChecked, see home.mjs) — every eligible row starts
// checked, mirroring the removed palette's "hand over everything" default.
export function checkedBatchComments(state) {
  return batchEligibleRows(state)
    .filter((b) => state.batchChecked[b.comment.id] !== false)
    .map((b) => b.comment)
}

// hasPendingPush reports whether this PR has landed-but-unpushed Claude commits
// (state.pendingPush, fed by GET /api/pending-push — see loadPendingPush in
// home.mjs). Mirrors pushTodoRowVisible there; both must agree, since that one
// decides whether the keyboard has a stop here.
export function hasPendingPush(state) {
  return !!(state.pendingPush && state.pendingPush.ahead > 0)
}

// staleTreeRow is the notice at the very top of the index: the server ingested
// new commits (someone else pushed, or a chat edit landed) while this tab was
// open, so everything below it is one version behind. See eventBlocksChanged
// (eventbus.go) and the blocks.changed handler in home.mjs.
//
// Deliberately a NOTICE the reviewer clicks, not an automatic refresh: swapping
// the blocks under an active cursor would move the selection, drop the loaded
// diff of the block being read, and reset a half-finished approve pass. The
// reviewer decides when it is a good moment.
//
// Clicking reloads the page rather than refetching in place. That is the neat
// option here precisely BECAUSE of the URL-state mechanism (see "URL state" in
// CLAUDE.md): ?sel=/?drill=/?gran= already encode the navigation position, so a
// reload returns to the same block with a guaranteed-consistent tree, instead of
// threading a second "load but don't navigate" mode through loadBlocks.
//
// Also a stop of the sidebar's ↑/↓ loop (state.staleRowFocused, see
// stepListSelection in home.mjs) — reviewer request: "als ik hier naarboven
// key druk, wil ik duidelijk deze row selecteren en daarop enter kunnen doen".
// `Enter` runs the exact same reload as the click. The always-present 1px
// border (amber in both states, so focusing never shifts row height) gains an
// indigo border/ring on top while focused — the same two-state border every
// other row/trailing-row in this index uses (see "Focus highlight per stop" in
// keyboard-navigation.md) — so the SHAPE of the border, not merely the amber
// tint, says the keyboard is here.
//
// The ↻ glyph and the WORDS carry the "there's a notice" meaning; the amber
// tint is decoration only (the colour-blind rule, see pushTodoStatusWord).
function staleTreeRow(state) {
  return html`
    <button
      data-testid="blocks-stale"
      class="${() =>
        'w-full border px-3 py-2 text-left bg-amber-50 dark:bg-amber-500/15 ' +
        (state.staleRowFocused
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-amber-200 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/25')}"
      @click="${() => window.location.reload()}"
    >
      <span class="flex items-center gap-2 text-xs font-medium text-amber-800 dark:text-amber-200">
        <span aria-hidden="true">↻</span>
        <span data-testid="blocks-stale-title">Nieuwe commits in deze PR</span>
      </span>
      <span class="mt-0.5 block text-[11px] text-amber-700 dark:text-amber-300"
        >herlaad de boom om ze te zien</span
      >
    </button>
  `.key('blocks-stale')
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

// lineCommentHeading titles the "Comments op regels" section — genuinely
// block-anchored (not PR-wide/orphan) comment-index items, sorted UNDER the
// changed-files categories (recomputeLeftList's rank 2.5, home.mjs's
// commentBlockItem/b.lineAnchored) instead of above everything, including a
// mentioned one: reviewer request, "comments die gekoppeld zijn aan een
// regel code moeten in de blokken index onder de aangepaste bestanden staan
// met een kopje erboven". Shown expanded by default; the chevron button
// collapses/reveals the section (state.lineCommentsCollapsed — ephemeral,
// like state.showApproved, not persisted/URL-bound: "laat het by default
// zien, behalve als je het inklapt"). Mouse-only for now, unlike
// toggleRow/ignoreToggleRow — a dedicated ↑/↓ sidebar-loop stop felt like
// more plumbing than this one request asked for.
function lineCommentHeading(state) {
  return html`
    <div
      data-testid="line-comment-heading"
      class="flex items-center justify-between border-b border-t border-slate-100 dark:border-zinc-800/60 bg-slate-50 dark:bg-zinc-800/40 px-3 py-1.5"
    >
      <span class="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-zinc-500">Comments op regels</span>
      <button
        data-testid="line-comment-toggle"
        class="text-[11px] font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300"
        title="${() => (state.lineCommentsCollapsed ? 'Toon comments op regels' : 'Verberg comments op regels')}"
        @click="${() => {
          state.lineCommentsCollapsed = !state.lineCommentsCollapsed
        }}"
      >
        ${() => (state.lineCommentsCollapsed ? '▸' : '▾')}
      </button>
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
      @contextmenu="${(e) => {
        e.preventDefault()
        state.onPushTodo && state.onPushTodo({ native: true, x: e.clientX, y: e.clientY })
      }}"
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
// local while walking the index. A glyph plus a word, never colour alone —
// but in this INDEX ROW the word is deliberately dropped from the visible
// text (reviewer report: with the editing/refreshing pills alongside it, the
// full "⇧ ongepusht" label ate too much of the row's width) and moved into
// `title`/`aria-label` instead, so the meaning survives for a screen reader
// and on hover — the glyph itself already carries a distinct SHAPE (not just
// colour, per the colourblind rule). The full "⇧ ongepusht" label stays
// exactly as before on the block card itself (Block.mjs), where there's room.
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
      title="Ongepusht — deze wijziging staat lokaal op de PR-branch, maar is nog niet gepusht"
      aria-label="Ongepusht — deze wijziging staat lokaal op de PR-branch, maar is nog niet gepusht"
      class="shrink-0 rounded bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      >⇧</span
    >
  `
}

// editingPill marks a row whose file is currently being touched by a
// not-yet-landed Claude edit (state.checkout.pendingFiles, chat_edit_pending.go
// via GET /api/chat/checkout — see loadCheckout in home.mjs) — reviewer
// request: "wil alle lokale aanpassingen gelijk zichtbaar zien in de tree,
// met een status dat het bezig is met een aanpassing, die weer weg moet
// zodra het is aangepast". A pencil glyph plus the word "wordt aangepast",
// never colour alone (the colourblind rule) — deliberately a DIFFERENT glyph
// and colour from unpushedPill's ⇧, so a block that is BOTH mid-edit (this
// turn) AND separately unpushed (an earlier landed-but-unpushed commit) shows
// two distinguishable pills rather than one ambiguous one.
//
// Per FILE, not per block, same accepted trade-off as unpushedPill: this is
// cleared as a whole for the PR the moment ANY landing succeeds
// (chat_merge.go), which is exactly when the block's own diff catches up via
// the ordinary ingest-refresh — so the pill's lifetime tracks "not yet
// visible in the diff", not merely "the turn is still running".
function editingPill(state, b) {
  const files =
    state.checkout && Array.isArray(state.checkout.pendingFiles) ? state.checkout.pendingFiles : []
  if (!b.file || !files.includes(b.file)) return ''
  return html`
    <span
      data-testid="row-editing"
      title="Claude past dit bestand nu aan; nog niet geland in de review-tree"
      class="shrink-0 rounded bg-sky-50 dark:bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300"
      >✎ wordt aangepast</span
    >
  `
}

// refreshingPill marks a row whose file was just LANDED by a Claude edit but
// the review tree hasn't re-ingested it yet (state.checkout.refreshingFiles,
// chat_refresh_pending.go via GET /api/chat/checkout — see loadCheckout in
// home.mjs). Reviewer request: "als claude net een aanpassing heeft gedaan...
// dan wil ik dat gelijk zien (of juist dat het weg is)" — the existing
// `ongepusht` pill only says "not on GitHub yet", nothing about whether the
// CODE shown has caught up. A cycling-arrow glyph plus the word, never colour
// alone, and a THIRD distinguishable colour/glyph from unpushedPill's ⇧ and
// editingPill's ✎ — a block can carry all three at once (mid-edit, landed but
// not yet re-ingested, and unpushed) and each must read on its own.
//
// Per FILE, not per block, same accepted trade-off as unpushedPill/
// editingPill. Deliberately short-lived: home.mjs's own `blocks.changed`
// handler auto-reloads the tree the moment the server clears this set (see
// refreshBlocksAfterOwnLanding), so this pill is normally only visible for as
// long as the ingest-refresh itself takes — a colleague's own push instead
// keeps going through the existing staleTreeRow, never through this pill.
function refreshingPill(state, b) {
  const files =
    state.checkout && Array.isArray(state.checkout.refreshingFiles) ? state.checkout.refreshingFiles : []
  if (!b.file || !files.includes(b.file)) return ''
  return html`
    <span
      data-testid="row-refreshing"
      title="Deze wijziging is geland; de review-tree werkt de code nu bij"
      class="shrink-0 rounded bg-violet-50 dark:bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300"
      >⟳ wordt bijgewerkt</span
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
        state.staleRowFocused = false
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
        state.staleRowFocused = false
      }}"
    >
      ${() =>
        state.showIgnored
          ? `Verberg ${count} verborgen ${count === 1 ? 'comment' : 'comments'}`
          : `Toon ${count} verborgen ${count === 1 ? 'comment' : 'comments'}`}
    </button>
  `.key('toggle-ignored')
}

// batchActionRow is the bottom action that replaces the removed 'bulkComments'
// palette entry: hand every CHECKED comment (checkedBatchComments) to ONE
// Claude agent (comment_batch.go). A stop of the sidebar's ↑/↓ loop like the
// two toggle rows above it (state.batchRowFocused, see stepListSelection in
// home.mjs) — Enter/click run the batch directly, no confirm submenu, because
// the checkboxes above already are the deliberate curation step (contrast the
// push-todo row, which DOES open a confirm menu because pushing writes to a
// branch other people work on).
function batchActionRow(state) {
  const n = checkedBatchComments(state).length
  const running = !!batch.running
  return html`
    <button
      data-testid="batch-action-row"
      class="${() =>
        'w-full border px-3 py-2 text-left text-xs font-medium ' +
        (state.batchRowFocused
          ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30 text-indigo-700 dark:text-indigo-300'
          : 'border-slate-300 dark:border-zinc-700 text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      disabled="${() => running || n === 0}"
      @click="${() => state.onBatchRow && state.onBatchRow()}"
    >
      ${() =>
        running
          ? batchRunningLines(state)
          : 'Verwerk ' + n + (n === 1 ? ' comment' : ' comments') + ' met Claude (Opus 5)'}
    </button>
  `.key('batch-action-row-' + (running ? 'busy' : 'idle') + '-' + n)
}

// batchRunningLines is what that row says WHILE a run is in flight. Reviewer
// request ("geef meer feedback als claude bezig is, bijvoorbeeld met welke
// comment hij bezig is en hoeveel van de hoeveel hij heeft verwerkt"): the old
// single sentence "Claude bezig met de comments…" stood still for minutes and
// named neither the comment nor the progress. Three lines instead, all from the
// volatile PR-wide snapshot (commentBatch.mjs):
//
//   1. the counter — handled (done + skipped) of total, plus the skipped count
//      when there is one;
//   2. WHICH comment Claude announced it is on ([slash:start], batch.current),
//      named by the very label its own index row carries;
//   3. WHAT it is doing right now, formatted by claudeStatusText — the SAME
//      formatter the chat turn and the comment footer use, so there is no
//      second wording of "Claude leest src/Foo.php". Deliberately repeated here
//      even though the footer of the selected comment may show the same
//      sentence: the reviewer must see the run is alive without standing on the
//      exact comment it is working on.
//
// Every line is a plain STRING in an always-present element (never a
// template↔'' slot), so no keyed/static-interpolation pitfall applies — see
// .claude/rules/arrowjs-pitfalls.md. Elapsed seconds are deliberately 0, like
// RelatedPanel.mjs's own batch call: no ticker for a decoration line.
function batchRunningLines(state) {
  const total = batch.total
  const handled = batch.done + batch.skipped
  let counter = 'Claude verwerkt comments · ' + handled + ' van ' + total
  if (batch.skipped > 0) counter += ' · ' + batch.skipped + ' overgeslagen'
  const current = batchCurrentLabel(state)
  // An error replaces the activity line: a run that could not start says why
  // instead of pretending Claude is still thinking.
  const activity = batch.error
    ? batch.error
    : claudeStatusText(
        { running: true, phase: batch.phase || 'starting', tool: batch.tool, detail: batch.detail },
        0,
      )
  return html`
    <span class="block">
      <span class="block tabular-nums">${counter}</span>
      <span class="block truncate font-normal text-[11px] text-slate-500 dark:text-zinc-400"
        >${current ? 'Bezig met: ' + current : ''}</span
      >
      <span class="block truncate font-normal text-[11px] text-slate-500 dark:text-zinc-400"
        >${activity}</span
      >
    </span>
  `
}

// batchCurrentLabel names the comment batch.current points at, reusing the
// label its own index row already shows (the 60-char body snippet built by
// commentBlockItem in home.mjs) — so the action row and the row it refers to
// can never word the same comment differently. '' when the run has no current
// comment yet (the preparing phase) or when that comment has no row in this
// tree; the counter and activity lines then carry the feedback on their own.
function batchCurrentLabel(state) {
  const id = batch.current
  if (!id) return ''
  for (const b of state.blocks || []) {
    if (b.kind !== 'comment') continue
    const group = b.comments || (b.comment ? [b.comment] : [])
    for (const c of group) if (c && c.id === id) return b.label || ''
  }
  return ''
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
// ignoreToggleFocused), nor while the stale-tree notice above the list does
// (state.staleRowFocused) — only one row/notice ever reads as selected at a
// time. Deliberately independent of state.searchActive: a row
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
  return rowIsCursor(state, i) || rowInListRange(state, i)
}

// rowHandedOff — this row is still the selection, but the arrows have moved on
// to the right-hand panel (state.indexHandedOff mirrors relatedActive(), see
// its own comment in home.mjs). Only reachable while the index is even visible
// next to a focused panel, i.e. an anchored comment-index item whose column is
// open — every other → hides the index outright by entering diff mode.
//
// Reviewer request: "als ik een comment op regel naar rechts druk, dan moet in
// de blokken index de selectie op gray selected zijn". The tint alone is not
// the signal (the reviewer is colourblind, see conventions.md): the `›` cursor
// marker goes transparent at the same time, so the difference between "the
// arrows are here" and "the arrows have moved on" is a SHAPE — the arrow is
// present or it isn't — with the grey/indigo tint only reinforcing it.
function rowHandedOff(state, i) {
  return !!state.indexHandedOff && rowFocused(state, i)
}

// rowIsCursor is the strict "this row IS the cursor" half of rowFocused —
// used on its own for the `›` marker, so that with a Shift+arrow multi-row
// selection (rowInListRange below) the reviewer can still see WHICH row the
// arrows will move from. Shape vs. tint, never two shades of the same colour
// (the reviewer is colourblind, see conventions.md).
function rowIsCursor(state, i) {
  if (state.showDescription && !state.blockIndexEntered) return false
  return (
    i === state.selected && !state.toggleFocused && !state.ignoreToggleFocused && !state.staleRowFocused
  )
}

// rowInListRange reports whether row i falls inside an active Shift+arrow
// multi-row selection (state.listAnchor..state.selected, see extendListRange
// in home.mjs). Such a row gets the same selected tint as the cursor itself,
// so the selection reads as one block of rows.
function rowInListRange(state, i) {
  if (state.listAnchor == null) return false
  if (state.showDescription && !state.blockIndexEntered) return false
  if (state.toggleFocused || state.ignoreToggleFocused || state.staleRowFocused) return false
  const lo = Math.min(state.listAnchor, state.selected)
  const hi = Math.max(state.listAnchor, state.selected)
  return i >= lo && i <= hi
}

// isLocalAiWarning reports whether `c` is an automated code_warning finding
// (source 'ai') that has NOT been put on GitHub yet (githubId 0/absent, the
// same signal needsPublishChoice reads in RelatedPanel.mjs). Both halves
// matter: the warning icon below says "a machine wrote this, it is not a
// human's comment yet", which stops being true the moment the reviewer
// publishes the finding as a real GitHub comment ("later aanpassen als het is
// omgezet naar een comment op github geplaatst") — from then on it is an
// ordinary comment and gets the ordinary author avatar again. A "Comment
// hiervan maken" conversion needs no special case here: it creates a brand-new
// comment without source 'ai' and deletes the finding.
//
// Exported so RelatedPanel.mjs's commentActivitySummary (the diff's per-line
// "onderliggende code" badge) can flag the same finding with its own warning
// triangle instead of duplicating this rule — see the diff-badge doc comment
// there and lineSummaryParts in Block.mjs.
export function isLocalAiWarning(c) {
  return !!c && c.source === 'ai' && !c.githubId
}

// aiWarningIcon is the leading badge of such a finding: the same
// warning-triangle glyph the panels already use (aiWarningBadge/
// related-covers-warning, RelatedPanel.mjs), replacing the author avatar —
// an "AI" initials circle looked like a person and read as just another
// commenter. The SHAPE carries the meaning (colorblind rule, see MEMORY.md);
// the amber tint is decoration, and the title/aria-label spells it out in
// words for anyone who can't tell the glyph apart at 16px.
function aiWarningIcon() {
  return html`
    <span
      data-testid="block-row-ai-warning"
      class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
      title="AI-risicowaarschuwing"
      aria-label="AI-risicowaarschuwing"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-3 w-3"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    </span>
  `
}

// toggleBatchChecked flips one comment's inclusion in the batch — shared by
// the checkbox's own click handler and home.mjs's `spaceKey`, so mouse and
// keyboard do the exact same thing (see .claude/docs/mouse-navigation.md).
export function toggleBatchChecked(state, id) {
  const checkedNow = state.batchChecked[id] !== false
  state.batchChecked = { ...state.batchChecked, [id]: !checkedNow }
}

// batchCheckbox — the per-row selection box for comment_batch (see
// isBatchEligible, commentBatch.mjs): '' for every real PR block and for a
// comment the batch may never touch (an AI finding, or one already resolved).
// Checked by default (state.batchChecked only ever records an explicit
// UNcheck, mirroring state.ignoredComments' shape) — reproducing the removed
// bulkComments palette's "hand over everything" default. Reachable by mouse
// (its own click, stopPropagation FIRST per the nested-@click rule in
// arrowjs-pitfalls.md, so it never also re-selects/deselects the row via the
// row's own @click) AND by keyboard: `Space` on the SELECTED row (spaceKey,
// home.mjs) toggles this same checkbox — see "Generic input-focus guard" in
// keyboard-navigation.md for why the click handler below ALSO blurs the
// input immediately.
function batchCheckbox(state, b) {
  // Mirrors batchEligibleRows exactly (kind + isBatchEligible + not ignored) —
  // an ignored row, once revealed via "Toon N verborgen comments", must not
  // show a checkbox that the action row's own count silently ignores.
  if (b.kind !== 'comment' || !isBatchEligible(b.comment) || isIgnoredComment(state, b)) return ''
  const id = b.comment.id
  return html`
    <input
      type="checkbox"
      data-testid="batch-checkbox"
      class="h-3.5 w-3.5 shrink-0 accent-indigo-600"
      checked="${() => state.batchChecked[id] !== false}"
      @click="${(e) => {
        e.stopPropagation()
        toggleBatchChecked(state, id)
        // A checkbox that keeps real DOM focus after a click poisons every
        // later keydown app-wide: isEditableFocused() (home.mjs) treats ANY
        // focused INPUT/TEXTAREA as "typing, let it flow through" and swallows
        // Enter/Space/etc. — reproduced as a real bug (Enter on the row
        // stopped opening its menu at all after clicking this checkbox).
        // Blurring immediately hands keyboard control straight back to the
        // document-level handler, which is where the checkbox's OWN Space
        // toggle lives anyway (see keyboard-navigation.md's "Generic
        // input-focus guard").
        e.target.blur()
      }}"
    />
  `
}

// categoryOrAvatar renders the leading badge of a row: for a synthetic
// comment-index item (kind:'comment', see commentBlockItem in home.mjs) the
// author's avatar (avatarHTML, shared with RelatedPanel.mjs's comment/reply
// rows) instead of the generic red "COMMENT" category pill — the avatar names
// *who* left the comment, which reads better than a category label that's
// the same for every comment row — except for a not-yet-published AI risk
// finding, which gets the warning triangle instead (isLocalAiWarning above).
// Every real PR block keeps the ordinary
// category pill. A nested `${() => …}` slot (like removedPill/approvalPill
// below), so both branches are whole templates — no partial-interpolation or
// static template↔string pitfall (see conventions.md).
function categoryOrAvatar(b) {
  if (b.kind === 'comment') {
    const c = b.comment || {}
    if (isLocalAiWarning(c)) return aiWarningIcon()
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
        (rowHandedOff(state, i)
          ? 'border-slate-400 dark:border-zinc-600 bg-slate-100 dark:bg-zinc-800/70 ring-1 ring-inset ring-slate-300 dark:ring-zinc-600'
          : rowFocused(state, i)
            ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30'
            : 'border-slate-300 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => {
        state.selected = i
        // A click is a plain, single-row choice: it supersedes a Shift+arrow
        // multi-row selection (mirrors home.mjs's selectRow/clearListAnchor,
        // which this handler deliberately duplicates rather than imports).
        state.listAnchor = null
        state.methodAnchor = null
        state.toggleFocused = false
        state.ignoreToggleFocused = false
        state.pushTodoFocused = false
        state.batchRowFocused = false
        state.staleRowFocused = false
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
      @contextmenu="${(e) => {
        // Right-click lands the cursor here exactly like the @click above,
        // then opens whatever menu Enter would open at this row (an ordinary
        // block's own COMMANDS, or the PR-comment menu for a comment-index
        // row — resolved by state.onRowContextMenu, threaded down from
        // home.mjs's rightClickMenuMode/handleContextMenu, same shape as
        // onPushTodo/onBatchRow above). See "The right-click context menu" in
        // command-palette.md.
        state.selected = i
        state.listAnchor = null
        state.methodAnchor = null
        state.toggleFocused = false
        state.ignoreToggleFocused = false
        state.pushTodoFocused = false
        state.batchRowFocused = false
        state.staleRowFocused = false
        state.classMethodSel = 0
        state.testColumnFocused = false
        state.blockIndexEntered = true
        state.onRowContextMenu && state.onRowContextMenu(e)
      }}"
    >
      <span
        class="${() =>
          rowIsCursor(state, i) && !state.indexHandedOff ? 'text-indigo-500 dark:text-indigo-400' : 'text-transparent'}"
        >›</span
      >
      ${() => batchCheckbox(state, b)}
      ${() => categoryOrAvatar(b)}
      <span
        class="flex-1 truncate font-mono text-[13px] text-slate-800 dark:text-zinc-200"
        title="${b.label}"
        >${b.label}</span
      >
      ${() => removedPill(b)} ${() => movedPill(b)}
      ${() => unpushedPill(state, b)}
      ${() => editingPill(state, b)}
      ${() => refreshingPill(state, b)}
      ${() => batchPill(b)} ${() => claudeChatPill(b)}
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

// movedPill is removedPill's sibling for a block the PR RENAMED or MOVED
// (blockmove.go merged the old and new symbol into one block): the reviewer
// sees "Hernoemd"/"Verplaatst" while scanning the startpoints, without having
// to open the card. The WORD carries it — the pill colour is decoration (see
// conventions.md). '' for everything else, same nested-slot shape as the pills
// around it.
function movedPill(b) {
  const label = movedLabel(b)
  if (!label) return ''
  return html`
    <span
      data-testid="block-row-moved"
      class="shrink-0 rounded bg-sky-100 dark:bg-sky-500/20 px-1 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300"
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

// batchPill marks a comment index row that a comment_batch run
// (comment_batch.go) is working on or has already handled: the WORD says which
// ("Claude bezig" / "verwerkt" / "overgeslagen", BATCH_STATE_LABEL), a pulsing
// dot is decoration on top for the one row currently in flight (never
// colour/animation alone — the reviewer is colourblind, see conventions.md).
// '' for every non-comment row and for every comment no batch ever touched, so
// the ordinary index is unchanged. Same nested-slot shape as the pills above.
function batchPill(b) {
  if (!b || b.kind !== 'comment' || !b.comment) return ''
  const it = batchItemFor(b.comment.id)
  if (!it || it.state === 'open') return ''
  const busy = it.state === 'busy'
  return html`
    <span
      class="${'shrink-0 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold ' +
      (busy
        ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300'
        : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400')}"
      data-testid="block-row-batch"
      title="${it.note || BATCH_STATE_LABEL[it.state] || it.state}"
    >
      ${() =>
        busy
          ? html`<span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-500"></span>`
          : ''}
      <span>${it.state === 'done' ? '✓ ' : ''}${BATCH_STATE_LABEL[it.state] || it.state}</span>
    </span>
  `
}

// claudeChatPill marks the code a Claude CHAT turn is happening on — the one
// place a conversation the reviewer navigated away from is still visible. The
// chat column itself only ever shows the conversation of the SELECTED code
// (deliberately, see "The chat column is a function of the selected code" in
// .claude/docs/claude-chat-panel.md), so without this a turn started on other
// code would be running with nothing on screen saying so.
//
// 'busy'     — a turn is running for a conversation on this row's code,
// 'answered' — a turn FINISHED while the reviewer was looking elsewhere, so
//              there is something new to go read.
//
// The WORD carries the meaning and the shape differs too (a pulsing dot only
// while busy, a ✓ once answered); the colour is decoration (the reviewer is
// colourblind, see conventions.md). Same nested-slot shape as the pills above.
// Reads claudeTurns.mjs directly rather than a state.* rollup, so it needs no
// watch of its own: this slot is reactive and that store is reactive.
function claudeChatPill(b) {
  const st = claudeTurnFor(b)
  if (!st) return ''
  const busy = st === 'busy'
  return html`
    <span
      class="${'shrink-0 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold ' +
      (busy
        ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300'
        : 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300')}"
      data-testid="block-row-claude-chat"
      title="${busy
        ? 'Claude werkt aan een gesprek over deze code'
        : 'Claude antwoordde in een gesprek over deze code'}"
    >
      ${() =>
        busy
          ? html`<span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-500"></span>`
          : ''}
      <span>${busy ? 'Claude bezig' : '✓ Claude antwoordde'}</span>
    </span>
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
