// home.mjs — page module for the PR Review Tree dashboard.
// Fetches the blocks of a PR, mounts the BlockList sidebar, and owns the global
// up/down keyboard navigation through the flat list.

import { reactive, html, watch } from './vendor/arrow.js'
import BlockList, { isFullyApproved } from './BlockList.mjs'
import Footer from './Footer.mjs'
import Block, {
  blockRows,
  changeGroups,
  changedRows,
  diffStat,
  approvedRowSet,
  approvedCallSet,
  callKey,
  callUnitApproved,
  rowCallSegments,
  unitsFor,
  updateHints,
  blockLabel,
} from './Block.mjs'
import RelatedPanel, {
  CommentsSidebar,
  startComment,
  createComment,
  placeComment,
  isComposeOpen,
  composeHasText,
  isNewFocused,
  openComposer,
  relatedActive,
  enterRelated,
  leaveRelated,
  handleRelatedKey,
  isCodeFocused,
  isCommentFocused,
  commentReplyEmpty,
  commentSelIndex,
  deleteFocusedComment,
  resolveFocusedComment,
  commentRowSet,
  setCommentScope,
  setRelated,
  focusedRelatedChild,
  focusedChipChain,
  selectComment,
  isTaskFocused,
  focusedTaskRun,
  taskRuns,
  toggleSidebar,
  sidebarOpen,
  PrWideComments,
  handlePrWideKey,
  isPrWideFocused,
  scrollIntoViewVertical,
} from './RelatedPanel.mjs'
import CommandMenu, { filterCommands } from './CommandMenu.mjs'
import { CallArrowsHost, setCallArrows, resettleCallArrows } from './callArrows.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { renderMarkdown } from './markdown.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'

initTheme()

// The PR under review comes from the path: /pr/<id>. Without one there's nothing
// to show, so bounce to the overview page that lists the ingested PRs.
function prFromPath() {
  const m = location.pathname.match(/^\/pr\/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}
const PR = prFromPath()
if (PR == null) {
  location.replace('/pr-overview')
}
// Show the PR number in the tab immediately; loadPRMeta swaps this for the
// real PR title once the prmeta read-model has it.
if (PR != null) {
  document.title = `PR #${PR} · PR Review Tree`
}

// JIRA_BASE mirrors the overview page — used to build the "Openen in nieuw tab"
// link in the `/` PR menu when the PR title carries a KEY-123-style ticket key.
const JIRA_BASE = 'https://plugandpaybv.atlassian.net/browse/'
// GITHUB_PR is the fallback PR URL, used until the prmeta read-model loads.
const GITHUB_PR = `https://github.com/plug-and-pay/plug-and-pay/pull/${PR}`

const state = reactive({
  pr: PR,
  // PR metadata from the prmeta read-model (GET /api/pr), filled by the pr_status
  // workflow at start: the title, its GitHub URL, and the Jira key derived from
  // the title (KEY-123). Feeds the `/` PR menu's GitHub/Jira deep-links.
  title: '',
  prUrl: '',
  jiraKey: '',
  // prMeta — the full prmeta read-model payload (GET /api/pr), reassigned wholesale
  // on every poll so arrow.js re-renders the PR-info column. Fills progressively
  // as the pr_status workflow completes its 3 stages (basics, summary, statuses) —
  // see loadPRMeta/pollPRMeta and prInfoCard below.
  prMeta: {},
  // workflows — the read-only list of workflow runs for this PR (GET
  // /api/workflows?pr=N), reassigned wholesale on every poll so arrow.js
  // re-renders the "Taken" column in RelatedPanel. See pollWorkflows below.
  workflows: [],
  // blocks — the top-level blocks shown in the sidebar and walked by the
  // navigation: the full set minus any block that is a child in a relation
  // (those are nested under their parent in the RelatedPanel instead). allBlocks
  // keeps the full set for id→block lookup + rendering children. relations are
  // the parent→child edges (GET /api/relations), built by the build_relations
  // workflow.
  blocks: [],
  allBlocks: [],
  relations: [],
  // callResolve — the call-resolution read-model (GET /api/callresolve): per
  // (caller block, called method) rows. status resolved (Go) / found (LLM) become
  // children in the Onderliggende-code panel; unresolved/searching drive the
  // "Zoek" button + spinner.
  callResolve: [],
  // testCovers — the test-coverage read-model (GET /api/testcovers): per test
  // block, which method(s) it covers. status resolved (method-level annotation)
  // / found (LLM, class-level-only annotation) become children in the
  // Onderliggende-code panel (both directions — test→covered method and
  // covered method→test); unannotated/notfound drive the warning icon;
  // unresolved/searching drive the automatic LLM search.
  testCovers: [],
  // approveRunId — the Run ID of this PR's `approve` workflow (durable approval
  // tracker), filled by loadApprovals via POST /api/workflows/approve. Every
  // approve/un-approve toggle signals the new full state for that block to this
  // Run ID (.../signals/set). Empty until the ensure-call returns (offline: stays
  // empty and approval is then session-only).
  approveRunId: '',
  // prStatusRunId — the Run ID of this PR's `pr_status` tracker, filled by
  // loadPRMeta via POST /api/workflows/pr_status. The ingest-refresh heartbeat
  // loop (see startPRStatusHeartbeat below) pings this Run ID while the PR page
  // is genuinely active, so pollIngestRefresh keeps its fast cadence even when
  // no comment thread is open (the only other heartbeat source).
  prStatusRunId: '',
  // drill — the stack of "drilled-into" children the reviewer has stepped into
  // from the Onderliggende-code panel (Enter on a resolved child). Each entry is
  // either a real block object reused straight from allBlocks (its own relations/
  // callResolve/approvedRows already work, so its own Onderliggende-code panel
  // falls out for free) or a minimal synthetic frame for a call target with no PR
  // block of its own (an unchanged file — see drillIntoChild). Each entry renders
  // as its own shrink-0 column to the right of the block column, a full diff of
  // its own — see focusLevel below for which one currently owns the keyboard.
  drill: [],
  // drillCursor — parallel to `drill`: each drilled column's own navigation
  // cursor ({change, gran}, mirroring state.change/state.gran) — a drilled
  // column zooms with f/d/s (group → line → call) exactly like the top-level
  // block, it just never flows into a same-file neighbour at the ends (it's a
  // single self-contained diff). Populated in drillIntoChild (gran defaults to
  // 'group'), walked by drillNextChange/drillPrevChange/setDrillGran.
  drillCursor: [],
  // drillRef — the URL-facing identity of the whole drill path: each entry's
  // stable `.id` (a real block id, or a synthetic call-frame's caller-scoped
  // id — see resolveChildBlock), joined by `>` (never appears inside an id).
  // Mirrors state.drill the same way blockRef mirrors state.selected — an
  // array index would be meaningless across a reload, the id path survives
  // it. Mirrored to `?drill=` (see bindUrlState below) by a watch, and walked
  // back into real drilled columns once loadBlocks' data has landed (see the
  // drillRefPending/applyDrillRefRestore note further down).
  drillRef: '',
  // drillGran / drillChange — the URL-facing mirror of the DEEPEST (focused)
  // drilled column's own {gran, change} cursor — state.drillCursor's last
  // entry — analogous to state.gran/state.change for the top-level cursor.
  // Only the deepest level is worth restoring: every ancestor (non-focused)
  // drilled column collapses to a narrow rail anyway (see "Niet-gefocuste
  // kolommen klappen in tot een smalle rail" in detail-layout.md), so its own
  // exact change/gran is never visible. Mirrored to `?dgran=`/`?dchg=` by a
  // watch below; restored via drillCursorPending/applyDrillCursorRestore,
  // mirroring how gran/change themselves need no restore-time resolution
  // (they're already the raw cursor) but a drilled column's cursor only
  // exists once the drill path itself has been walked back in.
  drillGran: 'group',
  drillChange: 0,
  // focusLevel — which column currently owns the diff keyboard (↑/↓ walk its
  // changes, → opens its Onderliggende-code panel): 0 is the top-level selected
  // block (state.change/state.gran), 1..drill.length indexes drill[level-1] /
  // drillCursor[level-1]. Drilling in (drillIntoChild) jumps focus to the fresh
  // (deepest) column; ← steps focus back one column at a time without closing
  // any of them, until level 0, where ← falls through to the existing
  // diff→list transition. focusedBlock() follows this, not always the deepest
  // entry, so the Onderliggende-code panel + tasks slide along with the focus.
  focusLevel: 0,
  // drillPreviewChild — the Onderliggende-code descriptor of the NEXT sibling
  // after the currently focused drilled column (or null), used to render a
  // look-ahead preview column next to it (see drillPreviewColumns/DetailPanel) —
  // mirrors the top-level block-column's own look-ahead preview of the next
  // sidebar block. Populated by the setRelated watch (which already computes
  // relatedChildren() for the Onderliggende-code panel and can derive the
  // sibling-after-current from the same data) — identity-guarded there (only
  // reassigned when the actual next-sibling target changes) so reading this
  // field from the drilled-columns render closure stays cheap and doesn't
  // rebuild the real drilled Block() cards on an unrelated relatedChildren()
  // recompute (an approve-toggle elsewhere, a callresolve poll, …) — see
  // .claude/rules/conventions.md.
  drillPreviewChild: null,
  // testsExpanded — whether the Onderliggende-code panel's grouped covering
  // tests (the horizontal "tests bar", see groupTestChildren) are expanded
  // into ordinary child cards below the bar. Ephemeral (never in the URL,
  // like showDescription/diffViewMode) and reset to collapsed whenever the
  // panel moves to another block (see the setRelated watch below).
  testsExpanded: false,
  selected: 0,
  // blockRef — the URL-facing identity of the selected block: `${file}:${line}`
  // instead of its raw index into state.blocks. An index shifts whenever the
  // left list is filtered/reordered (search, a relation/call-resolve reload
  // pulling a block out into "Onderliggende code"), so it made a poor, unstable
  // URL anchor; file+line survives all of that. Mirrored to `?sel=` (see
  // bindUrlState below) by a watch that re-derives it from state.selected, and
  // resolved back to an index once after loadBlocks (see the blockRef-restore
  // note further down) — never read directly by the navigation, which still
  // works purely in terms of `selected`.
  blockRef: '',
  // mode: 'list' — up/down move between blocks in the sidebar; → steps into the
  // selected block's diff. 'diff' — up/down move between change groups inside the
  // block, and once past the last/first change they flow straight into the
  // next/previous block's diff; ← steps back out to the list. `change` is the
  // active group index.
  mode: 'list',
  change: 0,
  // gran — the granularity of a diff-mode selection. f zooms in (group → line →
  // call) and s zooms out (call → line → group): 'group' selects a whole run of
  // changed lines (the default when you step in), 'line' one changed line at a
  // time, 'call' one call-chain segment within a line (split on ->/./; — its
  // chars get the indigo underline). On the finest 'call' level f/d step to the
  // next/previous call (flowing across same-file blocks like ↓/↑; see fKey/dKey).
  // `change` indexes into the unit list of the current granularity (unitsFor).
  gran: 'group',
  // rangeAnchor — the unit index a Shift+ArrowDown/ArrowUp multi-line selection
  // started from, or null when no such range is active. Only meaningful while
  // gran === 'line': extendRange is the only place that sets it, and every
  // plain (non-shift) navigation/zoom/block-switch path clears it back to null
  // (see clearRangeAnchor). rangeUnit() merges it with the current `change`
  // into the { start, end } row range that approve/comment/highlighting act on.
  // The drilled-column equivalent lives per-entry on state.drillCursor[i]
  // (see drillExtendRange) rather than here.
  rangeAnchor: null,
  // codeVersion bumps every time a block's lazily-loaded `b.code` is filled in
  // (see ensureCode). It is the reliable "code arrived" signal the DetailPanel
  // binding subscribes to so it re-runs and rebuilds the affected card. Why not
  // rely on the diff card's own `b.code` binding: the setCommentScope/setRelated
  // watches also read `b.code` (they must, to follow the cursor), and with more
  // than one reactive consumer on the same `b.code` arrow.js intermittently drops
  // the diff card's null→loaded re-render, leaving it stuck on "loading code…".
  // So the card is rebuilt from the outside instead: on a codeVersion bump the
  // DetailPanel re-runs and its key (which encodes the code-loaded state — see the
  // key comment) flips, yielding a fresh diff binding that reads the loaded code.
  codeVersion: 0,
  // approvalSummaries — per top-level block id → { done, total } combined
  // approval count of the block *and every PR block nested under it* (its
  // relation children + resolved-call definitions). Computed off-render in a
  // watch (see below) and read by the sidebar, so the sidebar never subscribes
  // to each block's reactive b.code (which would re-trigger the diff
  // "stuck on loading" race). Reassigned wholesale so arrow.js re-renders.
  approvalSummaries: {},
  // approvalTotal — the PR-wide { done, total } combined-approval count shown in
  // the "Start" header. Summed over every top-level block's subtree count in the
  // same off-render watch that fills approvalSummaries (a plain snapshot, so the
  // header never co-subscribes to any block's b.code).
  approvalTotal: { done: 0, total: 0 },
  // blockTotals — per block id → the number of changed rows a reviewer must
  // approve (the "total"), computed server-side (GET /api/blockstats). Authoritative
  // and known immediately, so done/total is right before a block's code lazily
  // loads; blockApproveCount prefers it and falls back to the client-side count.
  blockTotals: {},
  // showApproved — when false (default) fully-approved top-level blocks are hidden
  // from the starting-points list, revealed by the "Toon N goedgekeurde blokken"
  // button at the bottom. Ephemeral UI state, not bound to the URL.
  showApproved: false,
  // toggleFocused — true once ↓ has walked the list-mode keyboard cursor past
  // the last visible block onto the toggle-approved button itself (see
  // stepListSelection). Not a block, so `state.selected` stays put underneath
  // it — this is purely an extra, final stop in the ↑/↓ chain. Ephemeral, not
  // bound to the URL, like showApproved above.
  toggleFocused: false,
  ingesting: false,
  error: '',
  onIngest: ingest,
  // search — the free-text filter over the starting-points list. `search` is the
  // query (matched against each block's label + category in recomputeLeftList);
  // `searchActive` is true while the search box holds the keyboard, so onKeydown
  // routes typing into it and keeps ↑/↓ moving the (filtered) selection without
  // stealing focus. Reached by ← from the list, left by → / Enter / Escape.
  search: '',
  searchActive: false,
  onSearch: setSearch,
  // showDescription — stop 1 of the left→right nav chain (see
  // keyboard-navigation.md): the PR-info/description column, hidden by default so
  // it doesn't eat width. Only reachable from stop 2 (the block-index, ← ) and
  // only ever toggled while state.mode === 'list' (it sits to the left of the
  // sidebar, which itself only shows in list mode). Deliberately NOT bound to the
  // URL — ephemeral UI state, like `menu`/`ui.task`, not a navigation position a
  // refresh needs to restore.
  showDescription: false,
  // descriptionExpanded — whether the PR description (Omschrijving) in the
  // PR-info column is shown in full or truncated (the default). Toggled by both
  // the "Toon volledige omschrijving"/"Omschrijving inklappen" PR-menu item and
  // the in-card "meer…"/"Inklappen" affordance — one flag, so they stay in
  // lockstep. Ephemeral UI state, NOT bound to the URL (like showDescription).
  descriptionExpanded: false,
  // diffViewMode — the global diff-pane preference, toggled everywhere with `a`
  // (onKeydown): 'split' (default, old+new side by side) or 'new' (only the
  // new/right pane, full width). Read by every visible Block() card (the
  // selected/preview cards and every open drilled column) via its viewMode opt
  // — see Block.mjs's codeDiff. Ephemeral UI state, not bound to the URL, like
  // showDescription/showApproved above.
  diffViewMode: 'split',
  // explanations — the AI unit-explanation read-model (GET /api/explanations):
  // per `${blockId}|${unitKey}` an entry { codeHash, status, text }, generated
  // by the explain_code workflow for a line/group unit containing an
  // if-statement. Reassigned wholesale on every load so the footer watch
  // re-fires. See the footer-explanation block below.
  explanations: {},
  // footerUnit / footerExplain — plain snapshots the footer renders, pushed by
  // the decoupled footer watch below (the setRelated/setCommentScope pattern):
  // the footer never reads blockRows/b.code itself, so it can't become a
  // co-subscriber on the focused block's code and re-trigger the diff
  // "stuck on loading" race — and it follows the *focused* column (a drilled
  // column's own cursor included), which plain state.selected/gran/change
  // reads could not. footerUnit is the array of aligned rows spanned by the
  // active unit — one row for line/call (always single-row), one row per
  // changed line for a multi-row group — or null when the unit has no rows
  // (kept explicitly null rather than an empty array, both to keep the
  // truthiness check in updateFooter correct and to avoid the arrow.js
  // single↔array slot pitfall in Footer.mjs, see conventions.md).
  // footerExplain is the AI description of the unit's if-statement
  // ({ status: 'searching'|'done', text }, null when the unit has no if / the
  // generation failed / not in diff mode). Both are ephemeral (never in the URL).
  footerUnit: null,
  footerExplain: null,
  // footerVisible — derived by updateFooter(): true once footerUnit or
  // footerExplain has something to show. The footer bar (Footer.mjs) and
  // every bottom-reservation binding (DetailPanel, RelatedPanel's sidebar/
  // rail) read this instead of state.mode, so the bar + its reserved space
  // disappear entirely rather than showing an empty balk.
  footerVisible: false,
})

// toggleDiffView flips the global diff-pane preference between full side-by-side
// and new-only (see state.diffViewMode above). The reactive re-render rebuilds
// every visible pane's HTML (Block.mjs's codeDiff, .innerHTML) from scratch,
// which resets each pane's scrollTop to 0 — without re-centring, the diff jumps
// to the top of the function instead of staying on the active change. Not a
// navigation step, so no glide (mirrors ensureCode's `false` for a cached/
// already-loaded re-render, see detail-layout.md).
// This resizes every visible card to 60% width (narrowed(), Block.mjs) without
// touching state.selected/mode/gran/change, so the setRelated watch that
// normally drives the call-arrow overlay never fires — resettleCallArrows
// redraws the existing pairs at the new (narrower) geometry, with the same
// immediate + 250ms-settle schedule callArrowPairs pushes use for the 200ms
// width transition (see detail-layout.md's "Call-pijl-overlay").
function toggleDiffView() {
  state.diffViewMode = state.diffViewMode === 'new' ? 'split' : 'new'
  scrollChangeIntoView(false)
  resettleCallArrows()
}

// isEditableFocused reports whether DOM focus currently sits on a text input —
// used to keep the `a` shortcut (a real letter a reviewer might type) from
// firing while typing into a field that isn't otherwise guarded by cs.focus
// (see the `a` handler in onKeydown for why that guard alone isn't enough).
function isEditableFocused() {
  const el = document.activeElement
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
}

// editableCaretCanMoveLeft reports whether a focused text field's caret sits
// strictly past the very start (there's a character — or a selection — to its
// left), meaning a plain/Option ArrowLeft has somewhere to go *within* the
// field. Used to decide whether ArrowLeft should move/word-jump the caret
// (leave it to the browser) or fall through to the existing "exit the
// field/panel" shortcuts below (isPrWideFocused/relatedActive's ArrowLeft
// branches) — a caret already at position 0 (e.g. a freshly opened, still
// empty composer/reply field) has nothing to move left into, so ArrowLeft
// there keeps its long-standing "step back out" meaning instead.
function editableCaretCanMoveLeft() {
  const el = document.activeElement
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false
  try {
    return el.selectionStart > 0 || el.selectionEnd > 0
  } catch {
    return false
  }
}

// Persist the navigation position in the URL so a refresh (or a shared link)
// reopens the same selected block, mode and change. The PR itself lives in the
// path (/pr/<id>), not the query string. Bare params are the main navigation;
// future extra windows bind their own state with their own `ns` so their params
// sit alongside these in the same query string. Do this before the first render
// so restored values are already in `state`.
bindUrlState(state, [
  { key: 'blockRef', param: 'sel', default: '' },
  { key: 'mode', param: 'mode', default: 'list' },
  { key: 'change', param: 'chg', parse: num(0), default: 0 },
  { key: 'gran', param: 'gran', default: 'group' },
  { key: 'drillRef', param: 'drill', default: '' },
  { key: 'drillGran', param: 'dgran', default: 'group' },
  { key: 'drillChange', param: 'dchg', parse: num(0), default: 0 },
])

// restoredBlockRef snapshots whatever bindUrlState just restored into
// state.blockRef from `?sel=` *before* the write-back watch below (which runs
// once immediately, per arrow.js' watch semantics) can clobber it: at this
// point state.blocks is still empty, so that first run recomputes blockRef as
// '' — see the async-clobber pitfall in CLAUDE.md/the url-state skill.
// blockRefPending carries the still-unresolved reference through to
// applyBlockRefRestore, called once after the first loadBlocks() (see below);
// null once applied (or if there was nothing to restore) so it never hijacks
// later navigation.
let blockRefPending = state.blockRef || null

// drillRefPending mirrors blockRefPending for the drill path restored from
// `?drill=id1>id2>...` — snapshotted before the state.drill mirror watch below
// (which also runs once immediately against the still-empty state.drill) can
// recompute it back to ''. Split on load into an array of target ids, walked
// back into real drilled columns by applyDrillRefRestore once loadBlocks' data
// (blocks + relations + callresolve + testcovers) has landed.
let drillRefPending = state.drillRef ? state.drillRef.split('>') : null

// drillCursorPending mirrors the same restore-before-clobber idea for the
// deepest drilled column's own {gran, change} cursor (`?dgran=`/`?dchg=`) — see
// state.drillGran/drillChange's own comment above. Applied once the deepest
// resolved column's rows are actually known (a synthetic frame's code is ready
// synchronously; a real PR block's code may still be an in-flight /api/code
// fetch — see applyDrillCursorRestore, called from both applyDrillRefRestore
// and ensureCode's "drilled column's code arrived" branch).
let drillCursorPending =
  state.drillGran !== 'group' || state.drillChange !== 0
    ? { gran: state.drillGran, change: state.drillChange }
    : null

// Keep blockRef mirroring the selected block (by file:line, not index) so a
// refresh/shared link restores the same block regardless of how the left
// list has since been filtered/reordered. Reads state.blocks/selected inline
// (the watch-getter convention — see conventions.md) so it reliably re-runs
// on every selection change.
watch(
  () => [state.selected, state.blocks],
  () => {
    const b = state.blocks[state.selected]
    state.blockRef = b ? `${b.file}:${b.line}` : ''
  },
)

// Keep drillRef/drillGran/drillChange mirroring state.drill/drillCursor — see
// their own comments on `state` above. Only state.drillCursor's LAST entry
// (the focused, deepest column — always drillCursor[drillCursor.length - 1],
// since focusLevel always equals drill.length whenever drilling is active)
// feeds drillGran/drillChange; every entry's id feeds the drillRef path.
watch(
  () => [state.drill, state.drillCursor],
  () => {
    state.drillRef = state.drill.map((b) => b.id).join('>')
    const last = state.drillCursor[state.drillCursor.length - 1]
    state.drillGran = last ? last.gran : 'group'
    state.drillChange = last ? last.change : 0
  },
)

// applyBlockRefRestore resolves the `?sel=file:line` restored at load time
// into a real state.selected index, once state.blocks is populated (called at
// the end of loadBlocks — the same "resolve after the data push" pattern as
// RelatedPanel's applyRelRestore). Not found (stale/shared link, or the block
// got filtered out) → leave whatever recomputeLeftList already clamped
// state.selected to.
function applyBlockRefRestore() {
  if (blockRefPending == null) return
  const ref = blockRefPending
  blockRefPending = null
  const idx = state.blocks.findIndex((b) => `${b.file}:${b.line}` === ref)
  if (idx >= 0) state.selected = idx
}

// applyDrillRefRestore resolves the `?drill=id1>id2>...` path restored at load
// time into real drilled columns, once state.selected (applyBlockRefRestore)
// AND the call-resolve/test-covers read-models have landed (relatedChildren's
// own dependencies — see loadBlocks, which only awaits those before calling
// this when a drill restore is actually pending). Walks the path exactly like
// a live Enter/click drill would — relatedChildren(parent) → match by id →
// drillIntoChild — reusing drillIntoChild itself so every side effect
// (ensureCode, focusLevel, scroll-into-view, the entrance animation marker) is
// identical to a real drill. Stops at the first id that no longer resolves (a
// removed relation, a resolver rerun, a stale/shared link) — mirrors
// applyBlockRefRestore's own not-found fallback: whatever was drilled so far
// stays, the rest of the path is silently dropped. Requires an actual diff
// session (mode==='diff') — drilling only has meaning inside one, see
// detail-layout.md.
function applyDrillRefRestore() {
  if (!drillRefPending) return
  const path = drillRefPending
  drillRefPending = null
  if (state.mode !== 'diff') {
    drillCursorPending = null
    return
  }
  let parent = curBlock()
  for (const targetId of path) {
    if (!parent) break
    const match = relatedChildren(parent).find((c) => (c.blockId || c.id) === targetId)
    if (!match) break
    drillIntoChild(match)
    parent = state.drill[state.drill.length - 1]
  }
  if (state.drill.length) applyDrillCursorRestore(state.drill[state.drill.length - 1])
  else drillCursorPending = null
}

// applyDrillCursorRestore re-applies the URL-restored {gran, change} cursor
// (drillCursorPending) onto the deepest drilled column `b` — one-shot, and a
// no-op once already applied (drillCursorPending is nulled on success) or
// while `b`'s rows aren't known yet: a synthetic call-frame's code is ready
// synchronously (drillIntoChild builds it inline), but a real PR block's code
// may still be an in-flight /api/code fetch — in that case this simply no-ops
// here and is called again from ensureCode's own "drilled column's code
// arrived" branch once b.code lands. Clamps `change` into the restored gran's
// actual unit count, mirroring ensureCode's own top-level change/gran clamp.
function applyDrillCursorRestore(b) {
  if (!drillCursorPending || !b) return
  if (!b.synthetic && !b.code) return
  const { gran, change } = drillCursorPending
  drillCursorPending = null
  const level = state.focusLevel
  if (level < 1 || state.drill[level - 1] !== b) return
  const units = unitsFor(blockRows(b), gran)
  state.drillCursor = state.drillCursor.map((c, i) =>
    i === level - 1 ? { ...c, gran, change: units.length ? Math.min(Math.max(change, 0), units.length - 1) : 0 } : c,
  )
}

// overviewExitUrl — shared by both nav-chain exits to /pr-overview (the ←
// handler in onKeydown and the "Naar PR-overzicht" PR_COMMANDS item below).
// Carries `sel` alongside `pr` so /pr-overview can hand the same block
// reference back when the reviewer returns to this PR (see the
// originPr/originSel round-trip in overview.mjs, and the "?pr=<id> auto-
// selecteert…" section in .claude/rules/pages-and-routing.md). Only appended
// when there's a current selection to remember — a block-less PR (still
// loading) shouldn't force an empty `sel=` onto the URL. `drill`/`dgran`/`dchg`
// piggyback on the same round-trip, only when there's an actual drilled
// column to remember — see treeUrl's origin* counterpart in overview.mjs.
// Also carries `mode=diff` in that case: a drill path only has meaning inside
// a diff session (applyDrillRefRestore requires it), and without it the
// returned-to page would restore in list mode and the app's own URL-mirror
// watch would immediately strip drill/dgran/dchg back out again.
function overviewExitUrl() {
  let url = '/pr-overview?pr=' + state.pr
  if (state.blockRef) {
    url += '&sel=' + encodeURIComponent(state.blockRef)
    if (state.drillRef) {
      url += '&mode=diff'
      url += '&drill=' + encodeURIComponent(state.drillRef)
      url += '&dgran=' + encodeURIComponent(state.drillGran)
      url += '&dchg=' + encodeURIComponent(String(state.drillChange))
    }
  }
  return url
}

// groupsFor returns the group-granularity change runs of a block (empty until its
// code has loaded). Used for the list-mode preview, which always previews the
// first *group* regardless of the diff-mode granularity.
function groupsFor(b) {
  return b ? changeGroups(blockRows(b)) : []
}

// unitsOf returns the navigation units of a block at the *current* granularity
// (empty until its code has loaded). This is what all diff-mode navigation walks.
function unitsOf(b) {
  return b ? unitsFor(blockRows(b), state.gran) : []
}

// GRANS orders the granularities coarse → fine so f steps one finer and d one
// coarser (clamped at the ends).
const GRANS = ['group', 'line', 'call']

// unitAtRow finds the index of the unit whose row range contains `row`; failing
// that (e.g. a granularity with no unit exactly there) the nearest unit by start.
// Used to keep the selection anchored to the same place when the granularity
// changes: the finer/coarser unit covering the current row.
function unitAtRow(units, row) {
  let idx = units.findIndex((u) => u.start <= row && row <= u.end)
  if (idx >= 0) return idx
  let best = Infinity
  units.forEach((u, i) => {
    const d = Math.abs(u.start - row)
    if (d < best) {
      best = d
      idx = i
    }
  })
  return idx < 0 ? 0 : idx
}

// rangeUnit merges the current unit (`change`) with a Shift+arrow range's
// starting unit (`anchor`) into the { start, end } row range both should act
// on — or just returns the current unit when there's no active anchor. Only
// ever meaningful for gran==='line' (the only granularity extendRange/
// drillExtendRange set an anchor at, see below), where every unit is a single
// row, so merging is just a min/max of two row pairs.
function rangeUnit(units, change, anchor) {
  const cur = units[change]
  if (!cur) return null
  if (anchor == null || anchor === change) return cur
  const anchorUnit = units[anchor]
  if (!anchorUnit) return cur
  return { start: Math.min(cur.start, anchorUnit.start), end: Math.max(cur.end, anchorUnit.end) }
}

// clearRangeAnchor drops an active Shift+arrow multi-line selection at the
// given focus level (default: whichever column currently owns the keyboard).
// Called from every plain (non-shift) navigation path — stepping to another
// unit/block, zooming (f/d/s), or leaving the column (←/→) — so a range never
// survives past the action that superseded it. extendRange/drillExtendRange
// are the only two places that ever set one.
function clearRangeAnchor(level = state.focusLevel) {
  if (level > 0) {
    state.drillCursor = state.drillCursor.map((c, i) => (i === level - 1 ? { ...c, rangeAnchor: null } : c))
  } else {
    state.rangeAnchor = null
  }
}

// setGran changes the selection granularity by `delta` (+1 finer with f, -1
// coarser with d) and re-anchors `change` onto the unit covering the row we were
// on, so refining a group lands on its first line, refining a line on its first
// call segment, and coarsening walks back up the same rows. Always operates on
// the top-level cursor (fKey/dKey/sKey route a focused drilled column to
// setDrillGran instead) — clears any active line-range selection, since a
// range only has meaning within the granularity it was made at.
function setGran(delta) {
  if (state.mode !== 'diff') return
  const b = state.blocks[state.selected]
  const rows = blockRows(b)
  const from = GRANS.indexOf(state.gran)
  const cur = unitsFor(rows, state.gran)[state.change]
  const anchorRow = cur ? cur.start : 0
  let to = Math.min(GRANS.length - 1, Math.max(0, from + delta))
  // Refining a group that already spans a single row has no meaningful 'line'
  // step (line == the whole run), so skip straight to 'call'.
  if (delta > 0 && state.gran === 'group' && cur && cur.end === cur.start) {
    to = GRANS.indexOf('call')
  }
  if (to === from) return
  clearRangeAnchor(0)
  state.gran = GRANS[to]
  const units = unitsFor(rows, state.gran)
  state.change = units.length ? unitAtRow(units, anchorRow) : 0
  scrollChangeIntoView()
}

// extendRange starts (if not already active) or moves a Shift+ArrowDown/
// ArrowUp multi-line selection of the top-level cursor by `delta` units. Only
// meaningful at gran==='line'; clamps at the block's own first/last line unit
// — unlike nextChange/prevChange a range never flows into a same-file
// neighbour, since approve/comment act on rows of a single block.
function extendRange(delta) {
  if (state.mode !== 'diff' || state.gran !== 'line') return
  const units = unitsOf(state.blocks[state.selected])
  if (!units.length) return
  const anchor = state.rangeAnchor != null ? state.rangeAnchor : state.change
  state.rangeAnchor = anchor
  state.change = Math.min(units.length - 1, Math.max(0, state.change + delta))
  scrollChangeIntoView()
}

// sameFileNeighbour reports whether the block `delta` away from the selected one
// exists and belongs to the same file — i.e. whether stepping there is allowed.
function sameFileNeighbour(delta) {
  const next = state.selected + delta
  return (
    next >= 0 &&
    next < state.blocks.length &&
    state.blocks[next].file === state.blocks[state.selected].file
  )
}

// pendingLast records that we stepped *up* into a block whose code hasn't loaded
// yet, so we want to land on its last change group once its rows are known.
// ensureCode resolves it after the fetch. Kept outside reactive state.
let pendingLast = false

// stepBlock moves the selection to the neighbouring block while staying in diff
// mode, so navigating past the last/first change of a block flows straight into
// the next/previous one instead of stopping. Stepping down lands on the first
// change; stepping up lands on the last (deferred via pendingLast when that
// block's code is still loading). Only steps to a block of the *same file* (the
// two are then linked by the dashed connector); returns false otherwise and at
// the ends of the list.
function stepBlock(delta) {
  if (!sameFileNeighbour(delta)) return false
  const next = state.selected + delta
  state.selected = next
  clearRangeAnchor(0)
  const groups = unitsOf(state.blocks[next])
  if (delta < 0) {
    if (groups.length) {
      state.change = groups.length - 1
    } else {
      state.change = 0
      pendingLast = true
    }
  } else {
    state.change = 0
  }
  scrollSelectedIntoView()
  scrollChangeIntoView()
  return true
}

// nextChange / prevChange move to the next / previous navigation unit at the
// current granularity, flowing into the neighbouring same-file block when we run
// off the end / start of this one (see stepBlock). Shared by the ↓/↑ arrows and
// by f/d on the 'call' level, so both walk the diff the same way.
function nextChange() {
  const groups = unitsOf(state.blocks[state.selected])
  if (state.change >= groups.length - 1) {
    stepBlock(1)
  } else {
    clearRangeAnchor(0)
    state.change = state.change + 1
    scrollChangeIntoView()
  }
}

function prevChange() {
  if (state.change <= 0) {
    stepBlock(-1)
  } else {
    clearRangeAnchor(0)
    state.change = state.change - 1
    scrollChangeIntoView()
  }
}

// fKey — zoom in. From the list it steps into the diff first. Inside the diff it
// refines the granularity one level (group → line → call); once on the finest
// 'call' level it steps to the next call instead (flowing into the next same-file
// block, like ↓). While a drilled column owns the keyboard (focusLevel > 0) this
// mirrors the exact same group→line→call zoom, but scoped to that column's own
// drillCursor (setDrillGran/drillNextChange) — it never flows into a same-file
// neighbour, since a drilled column is self-contained.
function fKey() {
  if (state.mode !== 'diff') {
    enterDiff()
    return
  }
  const level = state.focusLevel
  if (level > 0) {
    const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
    if (cur.gran === 'call') drillNextChange()
    else setDrillGran(level, 1)
    return
  }
  if (state.gran === 'call') nextChange()
  else setGran(1)
}

// dKey — go back. On 'call' it steps to the previous call (flowing back into the
// previous same-file block like ↑); at the very first call, with nowhere to flow,
// it zooms back out to 'line'. On the coarser levels it just zooms out one step.
// For a focused drilled column it does the same, scoped to its own drillCursor —
// including flowing back into the previous sibling at the very first call
// (hasPrevDrillSibling, mirroring the top level's sameFileNeighbour(-1) check);
// only with no previous sibling does it zoom out to 'line' instead.
function dKey() {
  if (state.mode !== 'diff') return
  const level = state.focusLevel
  if (level > 0) {
    const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
    if (cur.gran === 'call' && (cur.change > 0 || hasPrevDrillSibling())) drillPrevChange()
    else setDrillGran(level, -1)
    return
  }
  if (state.gran === 'call' && (state.change > 0 || sameFileNeighbour(-1))) prevChange()
  else setGran(-1)
}

// sKey — always zoom out one level (call → line → group), clamped at 'group'.
// For a focused drilled column this zooms out its own drillCursor instead.
function sKey() {
  if (state.mode !== 'diff') return
  const level = state.focusLevel
  if (level > 0) setDrillGran(level, -1)
  else setGran(-1)
}

async function loadBlocks() {
  const res = await fetch(`/api/blocks?pr=${state.pr}`)
  if (!res.ok) {
    state.error = `load failed: ${res.status}`
    return
  }
  const blocks = await res.json()
  const all = Array.isArray(blocks) ? blocks : []
  // Fetch the relations; recomputeLeftList pulls any nested child out of the
  // left list — it is shown under its parent in the RelatedPanel instead.
  const rels = await loadRelations()
  state.allBlocks = all
  state.relations = rels
  recomputeLeftList()
  applyBlockRefRestore()
  const callResolvePromise = loadCallResolve()
  const testCoversPromise = loadTestCovers()
  loadExplanations()
  // Hidden-ness (a fully-approved block while state.showApproved is false) only
  // becomes knowable once BOTH the approvals and the server-side totals are in
  // — isFullyApproved reads state.approvalSummaries, which the decoupled
  // approval-rollup watch recomputes from exactly those inputs. Await them,
  // give arrow.js a couple of microtask turns to flush that watch (the same
  // openTask precedent as selectComment's scope wait), then reveal a selection
  // that landed on a hidden block by unfolding the approved section (the
  // reviewer keeps their own selection). Deliberately AFTER
  // applyBlockRefRestore: a restored ?sel= pointing at a visible block is a
  // no-op, only a hidden outcome triggers the reveal.
  await Promise.all([loadApprovals(), loadBlockStats()])
  await Promise.resolve()
  await Promise.resolve()
  revealSelectedIfHidden()
  // A pending ?drill= restore needs relatedChildren's own dependencies —
  // callresolve/testcovers — to have landed first (a method_call/covers child
  // wouldn't otherwise be findable yet); both are already in flight above
  // (fire-and-forget for the common no-restore case), so only await them here,
  // gated on there actually being something to restore.
  if (drillRefPending) {
    await Promise.all([callResolvePromise, testCoversPromise])
    applyDrillRefRestore()
  }
}

// loadBlockStats fetches the server-computed per-block approval totals (the number
// of changed rows to approve, GET /api/blockstats) into state.blockTotals. This is
// the authoritative "total" — known immediately, before a block's code lazily
// loads, and in the same row-index space as the approved rows. Best-effort:
// offline, blockApproveCount just falls back to the client-side row count.
async function loadBlockStats() {
  try {
    const res = await fetch(`/api/blockstats?pr=${state.pr}`)
    if (!res.ok) return
    const data = await res.json()
    if (data && data.totals && typeof data.totals === 'object') {
      state.blockTotals = data.totals
    }
  } catch (_) {
    /* offline — fall back to client-side counts */
  }
}

// loadApprovals ensures the per-PR `approve` tracker is running (its Run ID is
// what every approve toggle signals to) and restores each block's approved state
// from the read-model into b.approvedRows/b.approvedCalls. Both steps are
// best-effort — offline, approveRunId stays empty and approval is session-only.
// Reassigns the arrays (never mutates in place) so arrow.js re-renders the
// checkbox + pane indicators. Applied against allBlocks (state.blocks shares the
// same objects), keyed by block id.
async function loadApprovals() {
  try {
    const res = await fetch('/api/workflows/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr }),
    })
    if (res.ok) {
      const { runId } = await res.json()
      if (runId) state.approveRunId = runId
    }
  } catch (_) {
    /* offline — approval stays session-only */
  }
  try {
    const res = await fetch(`/api/approvals?pr=${state.pr}`)
    if (!res.ok) return
    const rows = await res.json()
    if (!Array.isArray(rows)) return
    const byId = new Map(state.allBlocks.map((b) => [b.id, b]))
    for (const a of rows) {
      const b = byId.get(a.blockId)
      if (!b) continue
      b.approvedRows = Array.isArray(a.rows) ? [...a.rows] : []
      b.approvedCalls = Array.isArray(a.calls) ? [...a.calls] : []
    }
    // Nudge the reactive summaries/panes to recompute now that approvals landed.
    state.allBlocks = [...state.allBlocks]
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// persistApproval signals a block's full approved state to the durable approve
// tracker — the ONLY write path (the UI never writes a read-model directly). A
// no-op until approveRunId is known (offline); fire-and-forget, best-effort.
function persistApproval(b) {
  if (!b || !state.approveRunId) return
  fetch(`/api/workflows/${state.approveRunId}/signals/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blockId: b.id,
      rows: b.approvedRows || [],
      calls: b.approvedCalls || [],
    }),
  }).catch(() => {
    /* best-effort — the local state is already updated */
  })
  syncViewedFiles()
}

// syncViewedFiles keeps GitHub's per-file "Viewed" checkbox in sync with
// per-file approval: a file is "done" once every one of its top-level blocks
// has fully loaded code and is fully approved. Only fires on transitions (a
// file becoming newly-complete, or falling out of complete) so repeated calls
// are cheap no-ops. Fire-and-forget, same write path as persistApproval — the
// UI never writes a read-model directly, only signals the approve tracker.
function syncViewedFiles() {
  if (!state.approveRunId) return
  const byFile = new Map()
  for (const b of state.blocks) {
    if (!byFile.has(b.file)) byFile.set(b.file, [])
    byFile.get(b.file).push(b)
  }
  for (const [file, blocks] of byFile) {
    let total = 0
    let complete = true
    for (const b of blocks) {
      if (!b.code) {
        complete = false
        break
      }
      const c = blockApproveCount(b)
      total += c.total
      if (c.done !== c.total) {
        complete = false
        break
      }
    }
    const isComplete = complete && total > 0
    const wasViewed = viewedFiles.has(file)
    if (isComplete && !wasViewed) {
      viewedFiles.add(file)
      signalFileViewed(file, true)
    } else if (!isComplete && wasViewed) {
      viewedFiles.delete(file)
      signalFileViewed(file, false)
    }
  }
}

// viewedFiles — files we've told GitHub are fully approved (marked "Viewed" in
// Files changed). Kept in sync by syncViewedFiles. It lives at module scope, not
// on the reactive `state`: arrow.js wraps reactive values in a Proxy, and a
// proxied Set throws "Method Set.prototype.has called on incompatible receiver".
// It's never rendered, so it needs no reactivity anyway.
const viewedFiles = new Set()

function signalFileViewed(file, viewed) {
  fetch(`/api/workflows/${state.approveRunId}/signals/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, viewed }),
  }).catch(() => {
    /* best-effort */
  })
}

// recomputeLeftList derives state.blocks from allBlocks: everything except the
// blocks that are nested under a parent in the RelatedPanel — the relation
// children and the PR blocks that are the definition of a resolved method call
// (both already shown in "Onderliggende code"). A called-and-shown function
// shouldn't also sit in the left list; those targets often live in files the PR
// didn't change (pure reference code shown for context). Test coverage is
// DELIBERATELY exempt: a test must never make another (changed, reviewable)
// block vanish from the tree. Unlike a call-target or a listener, a covered
// method that testCoverTargetIds would return is ALWAYS a changed PR block —
// primary reviewable code (e.g. a brand-new controller the PR adds) — so it
// stays in the left list, and merely ALSO appears as a "covers" child under the
// covering test. That mirrors how the test itself already appears both in the
// list and as a "covered_by" child under the method: test coverage hides
// neither side. Selection is preserved by block id so a callResolve/testCovers
// reload (poll after a search) doesn't jump the cursor.
//
// categoryRank orders the left list by Laravel-hierarchy priority: ROUTE first
// (the tree's root), then CONTROLLER, then everything else — used as a stable
// sort key below. Blocks that share a category always come from files
// classified the same way (classify.go derives category from the file path),
// so blocks from the same file always land in the same rank and — because
// Array.prototype.sort is a stable sort in modern engines — stay adjacent to
// each other in their original (ingest/source) order within that rank. That
// adjacency matters: sameFileNeighbour/stepBlock (the same-file connector
// hint + ↑/↓ block-to-block flow, see keyboard-navigation.md) only look at
// the immediate index neighbour, so splitting a file's blocks apart would
// silently break that navigation.
function categoryRank(cat) {
  if (cat === 'ROUTE') return 0
  if (cat === 'CONTROLLER') return 1
  return 2
}
function recomputeLeftList() {
  const hidden = new Set(state.relations.map((r) => r.childId))
  for (const id of resolvedCallTargetIds()) hidden.add(id)
  const selId = state.blocks[state.selected] && state.blocks[state.selected].id
  const q = (state.search || '').trim().toLowerCase()
  state.blocks = state.allBlocks
    .filter((b) => !hidden.has(b.id))
    .filter((b) => !q || (b.label + ' ' + b.category).toLowerCase().includes(q))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))
  const at = state.blocks.findIndex((b) => b.id === selId)
  state.selected = at >= 0 ? at : Math.min(state.selected, Math.max(0, state.blocks.length - 1))
}

// stepVisibleSelected walks state.selected one raw state.blocks index at a time
// in the direction of dir (+1 down, -1 up), skipping any index BlockList's
// renderList would hide (a fully-approved block while state.showApproved is
// false — see isFullyApproved). Plain ArrowDown/ArrowUp used to do
// `state.selected = clamp(state.selected + dir, 0, length-1)`, a raw index step
// that ignores which indices actually have a rendered row: landing on a hidden
// one leaves the sidebar with NO row highlighted (state.selected points past
// the DOM), which reads as "this block won't select" and, with enough
// approved-and-hidden blocks stacked together deep in a review session,
// can take several presses to visibly move at all. If nothing selectable
// remains in that direction, stays put on the current (already-visible)
// selection rather than jumping into a trailing run of hidden blocks.
function stepVisibleSelected(dir) {
  const last = state.blocks.length - 1
  let i = state.selected
  let candidate = i
  for (;;) {
    candidate += dir
    if (candidate < 0 || candidate > last) return i
    if (state.showApproved || !isFullyApproved(state, state.blocks[candidate])) return candidate
  }
}

// toggleRowVisible mirrors BlockList's renderList: the toggle-approved button
// only exists once at least one top-level block is fully approved — regardless
// of whether state.showApproved currently reveals or folds it away.
function toggleRowVisible() {
  return state.blocks.some((b) => isFullyApproved(state, b))
}

// stepListSelection is the list-mode ↑/↓ step (dir=+1 down, -1 up), extending
// stepVisibleSelected with one extra, final stop: the toggle-approved button
// at the very bottom of the sidebar. Stepping ↓ past the last visible block
// used to just stay put (stepVisibleSelected's "nothing further" behaviour) —
// now, if the button is actually rendered, the keyboard cursor moves onto it
// instead (state.toggleFocused), which BlockList highlights with the same
// indigo ring as a selected row. ↑ from there simply drops the flag and lands
// back on the (unchanged) last block — state.selected never moved.
function stepListSelection(dir) {
  if (dir > 0) {
    if (state.toggleFocused) return // already the bottom-most stop
    const next = stepVisibleSelected(1)
    if (next === state.selected && toggleRowVisible()) {
      state.toggleFocused = true
      return
    }
    state.selected = next
    return
  }
  if (state.toggleFocused) {
    state.toggleFocused = false
    return
  }
  state.selected = stepVisibleSelected(-1)
}

// revealSelectedIfHidden unfolds the approved section (state.showApproved =
// true) when state.selected points at a block BlockList's renderList doesn't
// render (fully approved while state.showApproved is false — the exact same
// isFullyApproved criterion). A selection restored from the URL
// (?sel=file:line via applyBlockRefRestore) is the reviewer's OWN position:
// moving it away to the first visible block (the earlier
// clampSelectedToVisible behaviour) read as a lost selection — instead the
// hidden block is revealed and highlights. Visible already (or no block at
// all) → no-op. Called ONLY from the load path — never from the live approve
// flow (approving the block you're looking at keeps it selected and visible;
// stepVisibleSelected handles walking off it), and deliberately NOT from
// setSearch (see clampSelectedToVisible below).
function revealSelectedIfHidden() {
  const b = state.blocks[state.selected]
  if (!b) return
  if (state.showApproved || !isFullyApproved(state, b)) return
  state.showApproved = true
  scrollSelectedIntoView()
}

// clampSelectedToVisible moves state.selected off a hidden (fully-approved,
// !showApproved) block onto the FIRST visible one. Only used by setSearch:
// its `selected = 0` reset is a synthetic landing, not the reviewer's own
// position, so typing a query must never suddenly unfold every approved block
// PR-wide (and there is no way to fold it back by typing on) — clamping to
// the first visible match is the least surprising outcome there. The search
// filter itself needs no separate check here — recomputeLeftList removes
// filtered-out blocks from state.blocks entirely and clamps the index, so only
// the hidden-approved case can remain. No visible block at all → leave the
// selection alone (mirrors stepVisibleSelected's stay-put behaviour).
function clampSelectedToVisible() {
  const b = state.blocks[state.selected]
  if (!b) return
  if (state.showApproved || !isFullyApproved(state, b)) return
  const idx = state.blocks.findIndex((x) => !isFullyApproved(state, x))
  if (idx >= 0) {
    state.selected = idx
    scrollSelectedIntoView()
  }
}

// setSearch is the search box's input handler: refilter the left list and jump
// the selection to the top match so ↑/↓ walk the results from the first hit.
function setSearch(q) {
  state.search = q
  recomputeLeftList()
  state.selected = 0
  // Typing is a fresh navigation reset — never leave the keyboard cursor
  // parked on the toggle-approved row from a previous, now-irrelevant walk.
  state.toggleFocused = false
  // The top match can be a hidden (fully-approved) block — land on the first
  // visible one instead so a row always highlights (see clampSelectedToVisible;
  // deliberately a clamp, not a reveal — see the comments above).
  clampSelectedToVisible()
  scrollSelectedIntoView()
}

// activateSearch / exitSearch move the keyboard in and out of the search box.
// They flip state.searchActive AND drive real DOM focus (the box's @focus/@blur
// mirror the flag back, so a mouse click stays in sync). Reached by ← from the
// list; left by → / Enter (step into the diff) or Escape (back to the list).
function activateSearch() {
  state.searchActive = true
  const el = document.getElementById('block-search')
  if (el) el.focus()
}

function exitSearch() {
  state.searchActive = false
  const el = document.getElementById('block-search')
  if (el) el.blur()
}

// resolvedCallTargetIds returns the ids of PR blocks that are the definition of
// some resolved/found method call — the blocks that surface in a RelatedPanel's
// "Onderliggende code" (prio 0 in resolvedCallChildren). Those are pulled from
// the left list, like relation children.
function resolvedCallTargetIds() {
  const prBlockIds = new Set(state.allBlocks.map((x) => x.id))
  const ids = new Set()
  for (const r of state.callResolve || []) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    const childId =
      state.pr + ':' + r.childFile + ':' + (r.childClass ? r.childClass + '::' + r.childMethod : r.childMethod)
    if (prBlockIds.has(childId)) ids.add(childId)
  }
  return ids
}

// loadCallResolve fetches the PR's call-resolution rows into state. Best-effort:
// a transient failure just yields no rows. Reassigns the array so arrow.js
// re-renders the Onderliggende-code panel when a search completes.
async function loadCallResolve() {
  try {
    const res = await fetch(`/api/callresolve?pr=${state.pr}`)
    if (!res.ok) return
    const rows = await res.json()
    state.callResolve = Array.isArray(rows) ? rows : []
    // A resolved call whose definition is a PR block now shows in "Onderliggende
    // code", so drop it from the left list (recompute preserves the selection).
    recomputeLeftList()
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// loadExplanations fetches the PR's AI unit-explanations into state (keyed
// `${blockId}|${unitKey}`). Best-effort: a transient failure just yields no
// rows. Reassigns the map wholesale so the footer watch re-fires when a
// generation completes.
async function loadExplanations() {
  try {
    const res = await fetch(`/api/explanations?pr=${state.pr}`)
    if (!res.ok) return
    const rows = await res.json()
    if (!Array.isArray(rows)) return
    const map = {}
    for (const e of rows) map[`${e.blockId}|${e.unitKey}`] = e
    state.explanations = map
    explanationsLoaded = true
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// explanationsLoaded gates the auto-launched explain requests until the
// read-model has been fetched at least once: without it, landing on an
// if-unit right after page load could fire a fresh explain_code run for a
// unit whose (possibly seeded/cached) explanation simply hadn't arrived yet —
// and that run's searching/failed row would overwrite the good one.
let explanationsLoaded = false

// testCoverTargetIds returns the ids of PR blocks that are the covered-method
// target of some resolved/found test-coverage row — mirrors
// resolvedCallTargetIds (pulled from the left list, shown instead under the
// covering test in "Onderliggende code").
function testCoverTargetIds() {
  const prBlockIds = new Set(state.allBlocks.map((x) => x.id))
  const ids = new Set()
  for (const r of state.testCovers || []) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    const id = coveredChildId(r)
    if (prBlockIds.has(id)) ids.add(id)
  }
  return ids
}

// loadTestCovers fetches the PR's test-coverage rows into state. Best-effort:
// a transient failure just yields no rows. Reassigns the array so arrow.js
// re-renders the Onderliggende-code panel when a search completes.
async function loadTestCovers() {
  try {
    const res = await fetch(`/api/testcovers?pr=${state.pr}`)
    if (!res.ok) return
    const rows = await res.json()
    state.testCovers = Array.isArray(rows) ? rows : []
    recomputeLeftList()
  } catch (_) {
    /* offline — keep whatever we have */
  }
}

// loadRelations fetches the PR's block relations (parent→child edges). A
// transient failure just yields no relations, so every block stays on the left.
async function loadRelations() {
  try {
    const res = await fetch(`/api/relations?pr=${state.pr}`)
    if (!res.ok) return []
    const rels = await res.json()
    return Array.isArray(rels) ? rels : []
  } catch (_) {
    return []
  }
}

// PR_META_POLL_MS / PR_META_MAX_POLLS — the pr_status workflow fills the
// prmeta read-model in 3 stages (basics, then the Claude summary, then review/
// checks statuses); a single fetch after starting it would show nothing for the
// ~10s it takes to run all 3 stages. Instead we poll every 1.5s and stop once
// the statuses stage has landed (or after this many polls, so an offline/never-
// finishing tracker doesn't poll forever).
const PR_META_POLL_MS = 1500
const PR_META_MAX_POLLS = 20

// loadPRMeta ensures the per-PR pr_status tracker is running (its start fetches
// the PR's title/summary/statuses into the prmeta read-model, in 3 stages) and
// starts polling that read-model into state.prMeta so the PR-info column reveals
// progressively. Both steps are best-effort — offline/no-gh runs simply leave the
// column on whatever partial data it got (and the menu's links on their
// fallbacks). Starting the tracker is a sanctioned UI write path (an Execution
// start, fire-and-forget — awaiting it would block on all 3 stages); everything
// else here is a read. Also captures the tracker's Run ID so the heartbeat loop
// below can keep its ingest-refresh poller on the fast cadence.
function loadPRMeta() {
  fetch('/api/workflows/pr_status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr: state.pr }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body && body.runId) {
        state.prStatusRunId = body.runId
        startPRStatusHeartbeat()
      }
    })
    .catch(() => {
      /* offline — the poll below still reads whatever the read-model already has */
    })
  pollPRMeta(0)
}

// startPRStatusHeartbeat pings the pr_status tracker's Run ID every 60s while
// this PR page is genuinely active (visible + focused), so its ingest-refresh
// poller (pollIngestRefresh, server-side) keeps checking the PR's head SHA on
// the fast cadence — the per-comment-thread heartbeat only fires while a
// thread is open, which isn't always the case just from viewing the PR. A
// heartbeat mutates no durable state (in-memory poll timing only), so this is
// the same operational-ping exception the comment/inbox heartbeats already use
// — never a workflow start/signal. Started once loadPRMeta has a Run ID.
const PR_STATUS_HEARTBEAT_MS = 60_000
let prStatusHeartbeatStarted = false

function prStatusPageActive() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function sendPRStatusHeartbeat() {
  if (!state.prStatusRunId || !prStatusPageActive()) return
  fetch('/api/workflows/' + encodeURIComponent(state.prStatusRunId) + '/heartbeat', { method: 'POST' }).catch(() => {
    /* best-effort — the poller falls back to its idle cadence regardless */
  })
}

function startPRStatusHeartbeat() {
  if (prStatusHeartbeatStarted) return
  prStatusHeartbeatStarted = true
  sendPRStatusHeartbeat()
  setInterval(sendPRStatusHeartbeat, PR_STATUS_HEARTBEAT_MS)
  document.addEventListener('visibilitychange', sendPRStatusHeartbeat)
}

async function pollPRMeta(count) {
  try {
    const res = await fetch(`/api/pr?pr=${state.pr}`)
    if (res.ok) {
      const meta = await res.json()
      if (meta && meta.ok) {
        state.prMeta = meta
        state.title = meta.title || ''
        if (state.title) {
          document.title = `${state.title} · PR Review Tree`
        }
        state.prUrl = meta.url || ''
        const m = state.title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)
        state.jiraKey = m ? m[1] : ''
        const statusesIn =
          meta.reviewDecision !== '' || (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) || meta.checksTotal > 0
        if (statusesIn) return
      }
    }
  } catch (_) {
    /* transient — keep polling until PR_META_MAX_POLLS */
  }
  if (count + 1 < PR_META_MAX_POLLS) {
    setTimeout(() => pollPRMeta(count + 1), PR_META_POLL_MS)
  }
}

const WORKFLOWS_POLL_MS = 2500

// pollWorkflows refreshes state.workflows from the read-only GET
// /api/workflows?pr=N endpoint (the "Taken" column in RelatedPanel). Runs keep
// changing status over time (running → waiting → completed), so — unlike
// pollPRMeta — this just keeps polling on a plain interval for the life of the
// page. Read-only; best-effort (offline just leaves the last-known list).
async function pollWorkflows() {
  try {
    const res = await fetch(`/api/workflows?pr=${state.pr}`)
    if (res.ok) {
      const data = await res.json()
      if (data && data.ok) {
        state.workflows = data.runs || []
      }
    }
  } catch (_) {
    /* offline/transient — keep the last-known list, try again next tick */
  }
}

// childrenOf returns parent block b's related children as { block, kind, line }
// triples (the blocks it is linked to, e.g. the Listener::handle for an event it
// dispatches, or the controller under a route). The kind is carried through so
// the panel badge names the child's role (listener/controller/request/…). line
// is the absolute source line, within b's own text, where the backend detector
// found this relation's trigger (relations.Relation.Line, see relations.go's
// matchLine) — used by relatedChildren's group-level reordering below.
function childrenOf(b) {
  if (!b || !state.relations || state.relations.length === 0) return []
  return state.relations
    .filter((r) => r.parentId === b.id)
    .map((r) => {
      const block = state.allBlocks.find((x) => x.id === r.childId)
      return block ? { block, kind: r.kind, line: r.line } : null
    })
    .filter(Boolean)
}

// findCallSites locates, in a block's aligned diff rows, every place method
// `name` is called on the *new* side — returning the row index and the call
// *segment* (segStart, same key changeCalls/rowCallSegments use) that call sits
// in. This is what couples a resolved-call child to the exact call in the diff:
// at 'call' granularity we match the active segment, and for ordering we ask
// whether any of a call's sites lands on a changed row. Method names are plain
// `[A-Za-z_]\w*`, so no regex escaping is needed. We match a call (`name(`), a
// bare `->name` property access — how an Eloquent magic property
// ($order->billingAddress) reaches its relationship method — and a `::name`
// static reference — how an enum case (AddressType::BILLING) reaches its enum.
function findCallSites(rows, name) {
  const sites = []
  // An artisan command key (accounting:import, foo-bar) carries characters no PHP
  // identifier has (':', '-'), so it can never be a method/property/enum name — it
  // appears only as the string literal of a ->command('name …') scheduler call.
  // Match that literal instead of the identifier forms.
  const isCommand = /[^\w]/.test(name)
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = isCommand
    ? new RegExp("command\\s*\\(\\s*['\"]" + esc + "(?=[\\s'\"])", 'g')
    : new RegExp('->\\s*' + name + '\\b|::\\s*' + name + '\\b|\\b' + name + '\\s*\\(', 'g')
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i].right
    if (text == null) continue
    re.lastIndex = 0
    let segs = null
    let m
    while ((m = re.exec(text)) !== null) {
      if (!segs) segs = rowCallSegments(rows, i)
      const seg = segs.find((s) => m.index >= s.start && m.index < s.end)
      sites.push({ row: i, segStart: seg ? seg.start : 0 })
    }
  }
  return sites
}

// callScopeMethods returns the set of method names the underlying-code panel is
// scoped to right now, or null for "no narrowing" (show them all). It narrows to
// whatever the cursor covers in *diff* mode: at the finest granularity
// (gran === 'call') it matches exactly the one call segment under the cursor —
// land on ->billingAddress and you see billingAddress(); at group/line it matches
// every call whose site sits on a row *inside the selected unit's range*, so the
// panel only shows the calls made by the lines you actually selected (not every
// call in the block). In list mode it returns null → the block's full (ordered)
// list of calls.
function callScopeMethods(b, rows) {
  if (state.mode !== 'diff') return null
  // Cursor-based scoping only makes sense for whichever column the reviewer is
  // actually stepping through with the keyboard right now — the top-level
  // selected block OR the focused drilled column, using ITS OWN
  // state.drillCursor[level-1] cursor (focusedGranCursor), not always
  // state.gran/state.change. A block that isn't focused (top-level while
  // drilled, or an unfocused drilled column) has no active cursor to scope
  // by, so it always shows its full call list, like list mode.
  if (b !== focusedBlock()) return null
  const cur = focusedGranCursor()
  const unit = unitsFor(rows, cur.gran)[cur.change]
  if (!unit) return null
  const methods = new Set()
  for (const r of callRows(b)) {
    const sites = findCallSites(rows, r.callKey)
    const inScope =
      cur.gran === 'call'
        ? sites.some((s) => s.row === unit.start && s.segStart === unit.segStart)
        : sites.some((s) => s.row >= unit.start && s.row <= unit.end)
    if (inScope) methods.add(r.callKey)
  }
  return methods
}

// groupLineRange returns the absolute new-side source line range the
// reviewer's currently selected *group* unit covers, or null when group-level
// reordering doesn't apply (not diff mode, the focused cursor isn't on gran
// 'group', a non-focused block, or the unit/code isn't available yet —
// mirrors callScopeMethods' own guards, incl. using focusedGranCursor so a
// focused DRILLED column's own gran/change is what's checked, not always the
// top-level state.gran/state.change). relatedChildren uses this to decide
// whether a relation/testcovers row's recorded site line (see childrenOf/
// resolvedTestCoverChildren) sits "inside" the reviewer's current selection —
// unlike callScopeMethods (row-index based, for method-call children), a
// relation/testcovers row only carries an absolute *source* line
// (relations.Relation.Line / testcovers.Entry.Line), so this reuses
// unitLineRange's row→line mapping instead.
function groupLineRange(b, rows) {
  if (state.mode !== 'diff') return null
  if (b !== focusedBlock()) return null
  const cur = focusedGranCursor()
  if (cur.gran !== 'group') return null
  const unit = unitsFor(rows, 'group')[cur.change]
  if (!unit) return null
  const { startLine, endLine, side } = unitLineRange(b, rows, unit)
  if (side !== 'RIGHT' || !startLine) return null
  return { startLine, endLine }
}

// relatedChildren describes the selected block's children for the RelatedPanel:
// the resolved method calls it makes (coupled to the call in the diff) plus the
// event listeners it is linked to. It lazily loads any child block's code and
// returns a small descriptor per child. Reactive — reading state.selected/mode/
// gran/change/relations/callResolve + each child's code — so the panel follows
// the cursor and re-renders as child code arrives.
//
// Scoping/ordering by the reviewer's current selection, from finest to
// coarsest granularity:
//  - 'call'/'line': HIDDEN outright — only children whose site sits under the
//    active call/line remain (see callScopeMethods for method-call children;
//    a relation/covers child has no site *within* that fine a unit at all, so
//    it drops out entirely — "onderliggende code van die line/call", not the
//    whole block's).
//  - 'group': NOT hidden, only REORDERED — a child whose site (childrenOf's
//    line / a `covers` row's testcovers.Entry.Line) falls inside the selected
//    group's line range sorts first (groupTier 0); everything else (out of
//    range, or with no site to compare at all — `covered_by`, which the test
//    file itself carries the annotation for, and a `found` covers row that
//    didn't carry a Line forward, see testcovers.Entry.Line) keeps its
//    existing prio-based order below that (groupTier 1) — "onderaan, maar
//    boven ongewijzigd" for `covered_by` falls out for free, since its prio 0
//    already outranks an unchanged (prio 2) call within that tier.
//  - 'group' in list mode, or no active unit: groupTier is a uniform 0 for
//    everyone (groupLineRange returns null), so ordering is unaffected — the
//    existing prio/size sort, exactly as before this feature.
// codeSize counts the non-blank lines of a child's source — a rough "how much
// code changed here" measure used to order same-priority children in the
// Onderliggende-code panel (substantial methods above one-line accessors).
function codeSize(code) {
  if (!code) return 0
  return code.split('\n').filter((l) => l.trim()).length
}

function relatedChildren(b) {
  // Both the hide (line/call) and the reorder (group) scoping only apply to
  // whichever column currently owns the keyboard — the top-level selected
  // block OR the focused drilled column, using ITS OWN drillCursor entry
  // (focusedGranCursor) — never a block that isn't focused right now (see
  // callScopeMethods/groupLineRange, which resolve the same cursor).
  const isFocusedCursor = b === focusedBlock()
  const scoped =
    isFocusedCursor && state.mode === 'diff' && (focusedGranCursor().gran === 'call' || focusedGranCursor().gran === 'line')
  const rows = blockRows(b)
  const range = isFocusedCursor ? groupLineRange(b, rows) : null
  const inRange = (line) => range != null && line != null && line >= range.startLine && line <= range.endLine
  const evt = scoped
    ? []
    : childrenOf(b).map(({ block: kid, kind, line: siteLine }) => {
        ensureCode(kid)
        const c = kid.code && !kid.code.error ? kid.code : null
        const code = (c && ((c.new && c.new.text) || (c.old && c.old.text))) || ''
        // The child's own changed grandchildren — the drill-hint chips the
        // panel shows to the right of this card (see nestedChangedKids) —
        // plus their recursive key-signature for fullCard's card key.
        const nested = nestedChangedKids(kid, b.id)
        // A relation child is by definition a changed child block, so it sorts to
        // the top (within its groupTier). `kind` names the edge
        // (event_listener / route_controller / …).
        return {
          id: kid.id,
          label: kid.label,
          file: kid.file,
          line: kid.line,
          kind,
          code,
          // True only while the lazy /api/code fetch is still in flight
          // (ensureCode sets kid.code to an object — even { error } — once it
          // completes). Lets the panel tell "code laden…" apart from a finished
          // load that turned out empty ("geen code gevonden").
          loading: !kid.code,
          size: codeSize(code),
          prio: 0,
          approve: blockApproveCount(kid),
          groupTier: range ? (inRange(siteLine) ? 0 : 1) : 0,
          nested,
          nestedSig: nestedSigOf(nested),
        }
      })
  // Resolved/found method calls (Go statically or LLM). Their code + descriptor
  // ride along in the callresolve row (unchanged file → no /api/code fetch).
  const calls = resolvedCallChildren(b)
  // Test-coverage children — block-level like event listeners, not tied to a
  // diff line/call, so they're dropped at the same line/call scoping as the
  // listeners: b → the method(s) it covers (if b is a test), and the test(s)
  // that cover b (if b is a production method).
  const covers = scoped ? [] : resolvedTestCoverChildren(b, range)
  const coveredBy = scoped ? [] : coveredByChildren(b, range)
  // Sort by groupTier first (see the scoping doc above — a no-op 0 for
  // everyone outside 'group' diff-mode), then priority (0 = also-changed
  // child block, 1 = call on a changed line, 2 = unchanged call), then —
  // within a priority — biggest child first, so the substantial modified code
  // the reviewer cares about leads while trivial one-liners (e.g. Eloquent
  // relation accessors, which are also `added` PR blocks and thus tie at prio
  // 0) drop below it. `size` is the child's line count (embedded childCode
  // for calls, loaded code for listeners); a child whose code hasn't arrived
  // yet is size 0 and sinks until it loads. Ties keep the resolver-emit
  // (source) order (Array.prototype.sort is stable).
  const sorted = evt
    .concat(covers)
    .concat(coveredBy)
    .concat(calls)
    .sort((x, y) => (x.groupTier || 0) - (y.groupTier || 0) || x.prio - y.prio || y.size - x.size)
  return groupTestChildren(b, sorted)
}

// groupTestChildren collapses the covering tests (kind covered_by — the tests
// that cover this production block) into ONE horizontal "tests bar" descriptor
// when the panel ALSO shows other (non-test) children, so the tests don't push
// the actual underlying code down the list. Clicking/Enter on the bar toggles
// state.testsExpanded (both land in drillIntoChild, which branches on the
// kind); expanded, the test cards render as ordinary children directly below
// the bar, which stays put as the collapse toggle. With no other children (or
// no tests at all) this is a no-op — the tests render as plain cards, exactly
// as before. The bar rides along IN the children list itself (at the position
// the first test sorted to), so the panel cursor stays 1:1 with the visible
// rows (cs.codeSel indexes rc.children) without any special casing in
// RelatedPanel's keyboard walk.
function groupTestChildren(b, sorted) {
  const tests = sorted.filter((c) => c.kind === 'covered_by')
  if (tests.length === 0 || tests.length === sorted.length) return sorted
  const others = sorted.filter((c) => c.kind !== 'covered_by')
  // The bar takes the slot of the first test in the sorted order: count the
  // non-test children ahead of it (relative order within both partitions is
  // preserved, sorted is never mutated).
  let at = 0
  for (const c of sorted) {
    if (c.kind === 'covered_by') break
    at++
  }
  const group = {
    id: 'tests-group:' + b.id,
    kind: 'tests_group',
    count: tests.length,
    tests,
    expanded: state.testsExpanded,
  }
  return others
    .slice(0, at)
    .concat([group], state.testsExpanded ? tests : [], others.slice(at))
}

// resolvedCallChildren maps the caller block's resolved/found call rows to child
// descriptors for the Onderliggende-code panel — tagged with an ordering
// priority, and scoped to the reviewer's current selection: HIDDEN outright at
// 'line'/'call' (only the calls under the active line/call segment remain —
// see callScopeMethods), REORDERED (not hidden) at 'group' — an in-scope call
// sorts first (groupTier 0 via relatedChildren's sort), the rest keep their
// existing prio-based order below it (groupTier 1). `source` names the LLM
// model when it was resolved by one (status found); Go-resolved rows leave it
// empty.
function resolvedCallChildren(b) {
  if (!b) return []
  const resolved = callRows(b).filter((r) => r.status === 'resolved' || r.status === 'found')
  if (resolved.length === 0) return []
  const rows = blockRows(b)
  const scope = callScopeMethods(b, rows)
  // callScopeMethods scopes at every diff granularity (group/line/call) — only
  // hide outright at line/call; at group, keep everything and let groupTier
  // (below) reorder instead. Reads the FOCUSED cursor's own gran (top-level or
  // a drilled column's drillCursor entry, see focusedGranCursor) rather than
  // always state.gran — scope is only ever non-null when b === focusedBlock()
  // anyway (callScopeMethods' own guard), so this only matters in exactly the
  // case where it needs to.
  const hideOutOfScope = state.mode === 'diff' && focusedGranCursor().gran !== 'group'
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  const changed = new Set(changedRows(rows))
  return resolved
    .filter((r) => scope == null || !hideOutOfScope || scope.has(r.callKey))
    .map((r) => {
      const childId = callChildId(r)
      const prBlock = byId.get(childId)
      // Lazily load the called definition's code so its diff-stat can be counted
      // (mirrors relatedChildren loading a listener's code).
      if (prBlock) ensureCode(prBlock)
      const onChangedLine = findCallSites(rows, r.callKey).some((s) => changed.has(s.row))
      // Drill-hint chips: only a call whose definition is itself a PR block
      // can have changed grandchildren — an unchanged ("Ongewijzigd") or
      // synthetic target never gets a chip (see nestedChangedKids).
      const nested = prBlock ? nestedChangedKids(prBlock, b.id) : []
      return {
        id: b.id + '::' + r.callKey,
        // The PR-block id this call resolves to, when its definition is itself
        // changed in this PR (prBlock). Distinct from `id` (which is caller-scoped
        // so each call-site stays its own panel row); drillIntoChild uses this to
        // reuse the real block object — with its own diff, approval and recursive
        // Onderliggende-code panel — instead of a code-only synthetic frame.
        blockId: prBlock ? prBlock.id : '',
        // A class-level resolution (model_usage/migration_model — childMethod
        // empty, the whole class is the child, never one of its methods) shows
        // the bare model name, not the "Class::" produced by the method-call
        // template below (see .claude/rules/tembed-workflows.md).
        label: r.childMethod
          ? `${r.childClass}::${r.childMethod}`
          : r.childClass || r.callKey,
        file: r.childFile,
        line: r.childLine,
        kind: r.kind || 'method_call',
        code: r.childCode || '',
        // The code rides embedded in the callresolve row (no lazy fetch), so an
        // empty childCode is a final state — "geen code gevonden", never loading.
        loading: false,
        // Line count of the child definition — the secondary sort key in
        // relatedChildren (bigger modified methods lead their prio group).
        size: codeSize(r.childCode || ''),
        source: r.status === 'found' ? r.model : '',
        // Approval count only for a call whose definition is itself a PR block
        // (it has changed rows to approve); a call into an unchanged file has none.
        approve: prBlock ? blockApproveCount(prBlock) : null,
        // Added/removed line counts of the called definition, shown instead of an
        // "aanroep" badge. null → the call targets an unchanged file (no diff) →
        // renders a grey "Ongewijzigd" badge. Fills in as prBlock's code loads.
        diff: prBlock ? diffStat(blockRows(prBlock)) : null,
        // 0 = the called method is itself changed in this PR (a real child block),
        // 1 = the call sits on a changed line, 2 = an unchanged call. Drives the
        // panel ordering (see relatedChildren).
        prio: prBlock ? 0 : onChangedLine ? 1 : 2,
        // 0 = this call's site sits inside the reviewer's selected group (see
        // relatedChildren's sort); a no-op 0 outside group-diff-mode (scope is
        // null in list mode, or the filter above already dropped anything out
        // of scope at line/call).
        groupTier: scope == null || hideOutOfScope ? 0 : scope.has(r.callKey) ? 0 : 1,
        nested,
        nestedSig: nestedSigOf(nested),
      }
    })
}

// callArrowPairs computes the arrow start/end pairs for the call-arrow overlay
// (src/callArrows.mjs): one flowing arrow per *changed* method_call child (its
// definition is itself a PR block — an unchanged "Ongewijzigd" target never
// gets one). Scope mirrors the panel's own VISIBILITY exactly
// (resolvedCallChildren's hideOutOfScope), not callScopeMethods' raw unit-range
// check for every granularity: at 'call'/'line' the panel HIDES an
// out-of-active-unit child outright, so the arrow only draws for the one
// segment/row under the cursor. At 'group' the panel does NOT hide anything —
// every changed-target call stays visible, just reordered (groupTier) — so an
// arrow must reach every one of them, not only the ones inside the active
// group: prefer a site inside the active unit (keeps the arrow anchored near
// the cursor when possible), falling back to the child's first known call
// site anywhere in the block so an out-of-group (groupTier-1) card that the
// panel still shows gets an arrow too. One pair per child, diff mode only,
// for whichever column currently owns the keyboard — the top-level selected
// block (focusLevel 0) OR the focused drilled column (focusLevel > 0, using
// ITS OWN state.drillCursor[level-1] cursor, not the top-level state.gran/
// change) — mirroring approveContext()'s own top-level/drilled split. Every
// drilled column is a full navigable diff with its own cursor (see
// "Kolom-navigatie" in detail-layout.md), so there's no reason for the arrow
// to go dark just because the reviewer drilled in; callArrows.mjs' DOM lookup
// (main.querySelector('[data-pane="new"]')/panel.querySelector('[data-child-
// id]')) already resolves to whichever column is focused — a non-focused
// column (top-level or drilled) always collapses to a railless rail with no
// [data-pane] — so no change is needed there. Called from the setRelated
// watch CALLBACK (untracked) — never from a render binding, so it can't
// co-subscribe on b.code with the diff render (conventions.md); b is always
// focusedBlock() (the watch's own `b`), so the guard below is a defensive
// self-check, not a new dependency.
function callArrowPairs(b) {
  if (!b || state.mode !== 'diff' || b !== focusedBlock()) return []
  const level = state.focusLevel
  const cur = level > 0 ? state.drillCursor[level - 1] || { change: 0, gran: 'group' } : { gran: state.gran, change: state.change }
  const rows = blockRows(b)
  const unit = unitsFor(rows, cur.gran)[cur.change]
  if (!unit) return []
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  const pairs = []
  for (const r of callRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (!byId.has(callChildId(r))) continue // only a changed target (a real PR block)
    const sites = findCallSites(rows, r.callKey)
    const site =
      cur.gran === 'call'
        ? sites.find((s) => s.row === unit.start && s.segStart === unit.segStart)
        : cur.gran === 'group'
          ? sites.find((s) => s.row >= unit.start && s.row <= unit.end) || sites[0]
          : sites.find((s) => s.row >= unit.start && s.row <= unit.end)
    if (!site) continue
    // childId matches relatedCard's data-child-id (the caller-scoped panel
    // descriptor id, see resolvedCallChildren).
    pairs.push({ row: site.row, childId: b.id + '::' + r.callKey })
  }
  return pairs
}

// callRows returns the call-resolution rows whose caller is block b.
function callRows(b) {
  if (!b || !state.callResolve) return []
  return state.callResolve.filter((r) => r.callerId === b.id)
}

// callChildId builds the PR-block id a call-resolution row points at (empty
// class → free function). Matches the id scheme in model.go (Block.ID).
function callChildId(r) {
  return (
    state.pr + ':' + r.childFile + ':' + (r.childClass ? r.childClass + '::' + r.childMethod : r.childMethod)
  )
}

// testCoverRows returns the test-coverage rows whose test is block b.
function testCoverRows(b) {
  if (!b || !state.testCovers) return []
  return state.testCovers.filter((r) => r.testId === b.id)
}

// coveredChildId builds the PR-block id a test-coverage row's covered method
// points at (empty class → free function) — mirrors callChildId.
function coveredChildId(r) {
  return (
    state.pr +
    ':' +
    r.coveredFile +
    ':' +
    (r.coveredClass ? r.coveredClass + '::' + r.coveredMethod : r.coveredMethod)
  )
}

// resolvedTestCoverChildren maps block b's own resolved/found test-coverage
// rows to child descriptors — direction 1 (test → geteste methode): b must be
// the covering test. Its code + descriptor ride along in the testcovers row
// (unchanged file → no /api/code fetch), mirroring resolvedCallChildren.
// range (relatedChildren's groupLineRange result, or null outside group-diff
// mode) scores each row's groupTier: r.line is the absolute line — within b's
// own test file — the annotation sits on (testcovers.Entry.Line, only ever
// set on a Go-resolved row, see modules/testcovers/testcovers.go); an
// LLM-`found` row that escalated from a class-level-only annotation never
// carries a Line, so it falls through to groupTier 1 like anything else with
// no site to compare.
function resolvedTestCoverChildren(b, range) {
  if (!b) return []
  const resolved = testCoverRows(b).filter((r) => r.status === 'resolved' || r.status === 'found')
  if (resolved.length === 0) return []
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  return resolved.map((r) => {
    const prBlock = byId.get(coveredChildId(r))
    if (prBlock) ensureCode(prBlock)
    // Drill-hint chips — same rule as method calls: only a covered method
    // that is itself a PR block can carry changed grandchildren.
    const nested = prBlock ? nestedChangedKids(prBlock, b.id) : []
    return {
      id: b.id + '::' + r.targetKey,
      blockId: prBlock ? prBlock.id : '',
      label: r.coveredClass ? `${r.coveredClass}::${r.coveredMethod}` : r.coveredMethod,
      file: r.coveredFile,
      line: r.coveredLine,
      kind: 'covers',
      code: r.coveredCode || '',
      // Embedded in the testcovers row (no lazy fetch) — empty means final,
      // mirroring resolvedCallChildren.
      loading: false,
      size: codeSize(r.coveredCode || ''),
      source: r.status === 'found' ? r.model : '',
      approve: prBlock ? blockApproveCount(prBlock) : null,
      diff: prBlock ? diffStat(blockRows(prBlock)) : null,
      // A covered method isn't tied to a specific diff line the way a method
      // call is (the annotation covers the whole test), so there's no
      // "on a changed line" middle tier — just changed-in-this-PR (0) or not (2).
      prio: prBlock ? 0 : 2,
      groupTier: range && r.line ? (r.line >= range.startLine && r.line <= range.endLine ? 0 : 1) : 0,
      nested,
      nestedSig: nestedSigOf(nested),
    }
  })
}

// coveredByChildren maps every test that covers block b to a child descriptor —
// direction 2 (geteste productiemethode → dekkende test): b must itself be a
// changed PR block (the covered method), and the covering test must also be a
// PR block (guaranteed: a test_covers row only exists for a test the PR
// changed). Always prio 0 — the test is by definition a changed block.
// The annotation lives in the *test's* own file, never in b's, so there is no
// site within b to compare against range at all — a covered_by child always
// sorts into the "not in scope" groupTier 1 at 'group' granularity, same as
// any other child with nothing to anchor on. Its prio 0 still keeps it above
// an unchanged (prio 2) call within that shared tier ("onderaan, maar boven
// ongewijzigd" — see relatedChildren's scoping doc).
function coveredByChildren(b, range) {
  if (!b || !state.testCovers) return []
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  const seen = new Set()
  const out = []
  for (const r of state.testCovers) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (r.coveredClass !== (b.class || '') || r.coveredMethod !== b.name) continue
    const test = byId.get(r.testId)
    if (!test || seen.has(test.id)) continue
    seen.add(test.id)
    ensureCode(test)
    const c = test.code && !test.code.error ? test.code : null
    const code = (c && ((c.new && c.new.text) || (c.old && c.old.text))) || ''
    // Drill-hint chips: the covering test is a real PR block, so it can have
    // changed grandchildren of its own (e.g. the methods it covers).
    const nested = nestedChangedKids(test, b.id)
    out.push({
      id: test.id,
      blockId: test.id,
      label: test.label,
      file: test.file,
      line: test.line,
      kind: 'covered_by',
      code,
      // Lazy PR-block code, same rule as the relation children above: loading
      // only while ensureCode's fetch is still in flight.
      loading: !test.code,
      size: codeSize(code),
      source: r.status === 'found' ? r.model : '',
      approve: blockApproveCount(test),
      diff: diffStat(blockRows(test)),
      prio: 0,
      // No site within b to compare against range — always "not in scope" at
      // 'group' granularity (a no-op 0 outside it, when range is null). See
      // this function's doc comment.
      groupTier: range ? 1 : 0,
      nested,
      nestedSig: nestedSigOf(nested),
    })
  }
  return out
}

// unresolvedTestCovers returns block b's test-coverage targets the Go analyzer
// could not resolve statically (status unresolved) plus any currently
// searching — feeding the "zoeken…" indicator, mirroring unresolvedCalls.
// Unlike calls, coverage is a whole-test concept (not tied to a diff line/
// call), so this is never scoped to the selected navigation unit.
function unresolvedTestCovers(b) {
  return testCoverRows(b).filter((r) => r.status === 'unresolved' || r.status === 'searching')
}

// testCoverWarning reports the "dekking niet te bepalen" warning for block b,
// or null when there's nothing to warn about. `unannotated` (no coverage
// annotation at all) NEVER triggers the LLM — it is a permanent warning.
// `notfound` means a class-level-only annotation's LLM search gave up.
function testCoverWarning(b) {
  const rows = testCoverRows(b)
  if (rows.some((r) => r.targetKey === 'none' && r.status === 'unannotated')) return 'unannotated'
  if (rows.length > 0 && rows.every((r) => r.status === 'notfound')) return 'notfound'
  return null
}

// testCoverSearchRequested dedups auto-launched test-coverage searches per
// test+targetKey, mirroring searchRequested for resolve_call.
const testCoverSearchRequested = new Set()

// startTestCoverSearch auto-launches the LLM resolve_test_covers workflow for
// every class-level-only coverage target the Go analyzer could not turn into
// a method (status unresolved) — no button, mirrors startCallSearch. Never
// runs for an `unannotated` test (no annotation at all never reaches the LLM).
async function startTestCoverSearch(b) {
  if (!b) return
  const classes = testCoverRows(b)
    .filter((r) => r.status === 'unresolved')
    .map((r) => r.coveredClass)
    .filter((c) => c && !testCoverSearchRequested.has(b.id + '|' + c))
  if (classes.length === 0) return
  classes.forEach((c) => testCoverSearchRequested.add(b.id + '|' + c))
  try {
    await fetch('/api/workflows/resolve_test_covers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pr: state.pr,
        testId: b.id,
        testFile: b.file,
        testClass: b.class || '',
        testName: b.name,
        classes,
      }),
    })
  } catch (_) {
    return
  }
  let tries = 0
  const tick = async () => {
    await loadTestCovers()
    const stillSearching = testCoverRows(b).some((r) => r.status === 'searching')
    if (stillSearching && tries++ < 20) setTimeout(tick, 3000)
  }
  setTimeout(tick, 1500)
}

// directChildBlocks returns the immediate PR-block children of b — the blocks
// pulled out of the left list and shown under it in the RelatedPanel: its
// relation children plus the resolved/found method calls AND resolved/found
// test-coverage targets whose definition is itself a PR block. Method calls
// (or covered methods) into unchanged files aren't PR blocks (no approval
// concept), so they're excluded. Deliberately one-directional: the covering
// test of a production method is NOT folded in here (only used for the
// sidebar's combined-approval rollup, via nestedPrBlocks) — doing so would
// create a method↔test cycle in that recursive rollup.
function directChildBlocks(b) {
  if (!b) return []
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  const ids = new Set()
  for (const r of state.relations || []) if (r.parentId === b.id) ids.add(r.childId)
  for (const r of callRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (byId.has(callChildId(r))) ids.add(callChildId(r))
  }
  for (const r of testCoverRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (byId.has(coveredChildId(r))) ids.add(coveredChildId(r))
  }
  return [...ids].map((id) => byId.get(id)).filter(Boolean)
}

// NESTED_DEPTH caps how many chip levels render under a card: 1 (the direct
// drill-hint chips) plus their own recursive sub-chips, no deeper — the panel
// column is narrow and each level multiplies ensureCode fetches, and looking
// deeper than that is what drilling itself is for.
const NESTED_DEPTH = 2

// nestedChangedKids maps a panel child's own PR-block children to the small,
// plain chip descriptors the Onderliggende-code panel renders as drill hints
// next to that child's card (`r.nested` → relatedCard's connector + chips in
// RelatedPanel.mjs, recursively via `k.nested`): per child card/chip the
// reviewer sees there is *more changed code underneath* before drilling into
// it. Only changed blocks qualify: directChildBlocks already returns nothing
// but PR blocks — a call/covered method into a file this PR doesn't touch is
// never a PR block, so an "Ongewijzigd"/synthetic target never gets a chip —
// and a block with nothing reviewable left (no approval total AND no change
// status) is dropped too. `parentId` guards the direct A↔B cycle: a
// grandchild that IS the block whose card/chip we're rendering isn't "more
// underneath", it's where the reviewer already is. `seen` is a single Set
// shared across the WHOLE recursive call (the nestedPrBlocks pattern) so a
// longer cycle (A→B→C→A) can't loop either — depth is additionally hard-capped
// at NESTED_DEPTH regardless. Each descriptor precomputes its own diff-stat
// (ensureCode + diffStat, lazily filled in as the chip target's code loads —
// same pattern resolvedCallChildren already uses for a method-call target)
// and its approval text/class as plain, always-safe strings (`approveText`/
// `approveCls` — see the "i=>je(n,i)" fix-vorm-1 note in conventions.md and
// nestedChip's own doc comment in RelatedPanel.mjs). Flat plain objects on
// purpose: RelatedPanel receives these via setRelated's push and must never
// read live block state itself (the same decoupling as the rest of the
// descriptor — see the setRelated watch).
function nestedChangedKids(prBlock, parentId, seen = new Set(), depth = 0) {
  if (!prBlock || depth >= NESTED_DEPTH) return []
  seen.add(prBlock.id)
  const out = []
  for (const kid of directChildBlocks(prBlock)) {
    if (kid.id === parentId || seen.has(kid.id)) continue
    const approve = blockApproveCount(kid)
    if (!approve.total && kid.status === 'unchanged') continue
    ensureCode(kid)
    const loaded = kid.code && !kid.code.error
    const done = approve.done === approve.total
    out.push({
      id: kid.id,
      label: kid.label,
      file: kid.file,
      line: kid.line,
      status: kid.status,
      approve,
      // Precomputed strings, not a conditional template — always the same
      // rendered shape, hidden via class rather than omitted.
      approveText: approve.total > 0 ? (done ? '✓ ' : '') + approve.done + '/' + approve.total : '',
      approveCls:
        approve.total > 0
          ? 'ml-auto shrink-0 rounded-full px-1 py-px text-[9px] font-semibold tabular-nums ' +
            (done
              ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
              : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500')
          : 'hidden',
      loading: !loaded,
      diff: loaded ? diffStat(blockRows(kid)) : null,
      nested: nestedChangedKids(kid, prBlock.id, seen, depth + 1),
    })
  }
  return out
}

// nestedSigOf builds the recursive key-signature for a chip subtree (id +
// status + diff + approval, at every depth) so relatedCard's key (fullCard,
// RelatedPanel.mjs) can flip on ANY change anywhere in the tree — not just
// the direct children — forcing a fresh node instead of a reused one whose
// function bindings wouldn't rerun (see the block-card key precedent in
// conventions.md).
function nestedSigOf(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return list
    .map(
      (k) =>
        k.id +
        ':' +
        k.status +
        ':' +
        (k.diff ? k.diff.add + '-' + k.diff.del : k.loading ? 'L' : '0-0') +
        ':' +
        (k.approve ? k.approve.done + '/' + k.approve.total : '0/0') +
        (k.nested && k.nested.length ? '[' + nestedSigOf(k.nested) + ']' : ''),
    )
    .join('|')
}

// orderedChildBlocks sorts directChildBlocks(b) into the same order the
// Onderliggende-code panel actually shows them in (relatedChildren's own
// groupTier/prio/size sort) — used by the postApprove tree-walk
// (findNextUnapproved) so "Ga door" descends into the same child a reviewer
// would land on first if they pressed →/Enter themselves, rather than the
// unsorted relations→calls→testcovers insertion order directChildBlocks
// returns. Excludes `covered_by` (relatedChildren shows both directions, but
// directChildBlocks deliberately never includes covered_by — see its own
// comment — so this filters it back out of relatedChildren's list rather than
// reintroducing the method↔test cycle). Anything relatedChildren scoped out
// (e.g. b is the live cursor at gran 'line'/'call', which hides most children
// outright) still keeps its directChildBlocks entry — just sorted last
// (fallback rank) — so a child is never silently dropped from the walk, only
// mis-ordered in that edge case.
function orderedChildBlocks(b) {
  const kids = directChildBlocks(b)
  if (kids.length < 2) return kids
  const order = relatedChildren(b)
    // tests_group is the collapsed covering-tests bar (groupTestChildren) —
    // pure presentation, never a walkable child block, so drop it alongside
    // the covered_by entries it wraps.
    .filter((c) => c.kind !== 'covered_by' && c.kind !== 'tests_group')
    .map((c) => c.blockId || c.id)
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...kids].sort((x, y) => {
    const rx = rank.has(x.id) ? rank.get(x.id) : Number.MAX_SAFE_INTEGER
    const ry = rank.has(y.id) ? rank.get(y.id) : Number.MAX_SAFE_INTEGER
    return rx - ry
  })
}

// nestedPrBlocks returns every PR block nested under b, transitively (children,
// their children, …), cycle-guarded by id — the full set whose approval rolls
// up into b's combined sidebar count.
function nestedPrBlocks(b, seen = new Set()) {
  const out = []
  for (const kid of directChildBlocks(b)) {
    if (seen.has(kid.id)) continue
    seen.add(kid.id)
    out.push(kid, ...nestedPrBlocks(kid, seen))
  }
  return out
}

// blockApproveCount returns { done, total } for a single block: how many of its
// changed rows the reviewer has approved out of the total. The total prefers the
// server-computed count (state.blockTotals, GET /api/blockstats) so it is right
// immediately — even before the block's code has lazily loaded; it falls back to
// the client-side row count when stats aren't in yet. `done` counts approved
// changed rows: exact once code is loaded (intersect with the changed rows),
// otherwise the size of approvedRows (which only ever holds changed-row indices).
function blockApproveCount(b) {
  const backendTotal =
    state.blockTotals && typeof state.blockTotals[b.id] === 'number'
      ? state.blockTotals[b.id]
      : null
  const all = changedRows(blockRows(b))
  const set = approvedRowSet(b)
  if (all.length) {
    const done = all.filter((i) => set.has(i)).length
    return { done, total: backendTotal !== null ? backendTotal : all.length }
  }
  // Code not loaded yet — lean on the backend total, count approved rows directly.
  if (backendTotal === null) return { done: 0, total: 0 }
  return { done: Math.min(set.size, backendTotal), total: backendTotal }
}

// subtreeApproveCount aggregates blockApproveCount over b and every PR block
// nested under it — the combined approval progress the sidebar shows.
function subtreeApproveCount(b) {
  let done = 0
  let total = 0
  for (const x of [b, ...nestedPrBlocks(b)]) {
    const c = blockApproveCount(x)
    done += c.done
    total += c.total
  }
  return { done, total }
}

// unresolvedCalls returns the selected block's calls the Go resolver could not
// pin (status unresolved) plus any currently searching — feeding the "Zoek"
// button + spinner in the panel. Scoped like relatedChildren (see
// callScopeMethods): in diff mode only the calls under the selected unit
// (group/line/call), so "Zoek" is coupled to what you selected; in list mode the
// block's whole set.
function unresolvedCalls(b) {
  const all = callRows(b).filter((r) => r.status === 'unresolved' || r.status === 'searching')
  if (all.length === 0) return all
  const rows = blockRows(b)
  const scope = callScopeMethods(b, rows)
  return scope == null ? all : all.filter((r) => scope.has(r.callKey))
}

// searchRequested dedups auto-launched searches per caller+callKey, so the
// resolve_call workflow fires once for a given unresolved call and doesn't
// re-POST as the cursor moves or the poll re-runs the panel watch. Kept outside
// reactive state so reading it never creates a dependency.
const searchRequested = new Set()

// startCallSearch auto-launches the LLM resolve_call workflow for every call in
// the block the Go resolver could not pin (status unresolved) — no button, it
// runs whenever the panel shows a block with unresolved calls (see the setRelated
// watch). It resolves the block's *whole* unresolved set (not scoped to the
// selected unit) so navigating isn't required to trigger it, then polls the
// read-model until the search settles. Starting an Execution is the sanctioned
// UI write path; searchRequested guards against re-firing.
async function startCallSearch(b) {
  if (!b) return
  const calls = callRows(b)
    .filter((r) => r.status === 'unresolved')
    .map((r) => r.callKey)
    .filter((k) => !searchRequested.has(b.id + '|' + k))
  if (calls.length === 0) return
  calls.forEach((k) => searchRequested.add(b.id + '|' + k))
  try {
    await fetch('/api/workflows/resolve_call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pr: state.pr,
        callerId: b.id,
        callerFile: b.file,
        callerClass: b.class || '',
        callerName: b.name,
        calls,
      }),
    })
  } catch (_) {
    return
  }
  // Poll the read-model until nothing is 'searching' for this caller (or we give
  // up after a bounded number of reloads).
  let tries = 0
  const tick = async () => {
    await loadCallResolve()
    const stillSearching = callRows(b).some((r) => r.status === 'searching')
    if (stillSearching && tries++ < 20) setTimeout(tick, 3000)
  }
  setTimeout(tick, 1500)
}

// codeRequested guards against re-fetching the source of a block we've already
// asked for. Kept outside the reactive state so reading it never creates a
// dependency (which would loop with the b.code writes below).
const codeRequested = new Set()

// ensureCode lazily fetches the old/new source of a block and stashes it on the
// block as `b.code` (reactive → the Block card re-renders). `b.code` is null
// while loading, then { file, old, new } or { error }.
async function ensureCode(b) {
  // A synthetic drill frame (a call into a file this PR doesn't change) already
  // carries its source inline (built in drillIntoChild from the call-row's
  // childCode); there's no stored PR block to fetch, so never hit /api/code for it
  // — that would clobber the inline code with null and hang on "loading".
  if (b.synthetic) return
  const key = b.file + '|' + b.label + '|' + b.side
  if (codeRequested.has(key)) return
  codeRequested.add(key)
  b.code = null
  try {
    const params = new URLSearchParams({ pr: state.pr, file: b.file, name: b.name })
    if (b.class) params.set('class', b.class)
    // A renamed file's OLD source lives at its pre-rename path in the base
    // worktree — tell the server so the old diff side is read from there.
    if (b.oldFile && b.oldFile !== b.file) params.set('oldFile', b.oldFile)
    const res = await fetch(`/api/code?${params}`)
    if (!res.ok) {
      b.code = { error: `code load failed: ${res.status}` }
      state.codeVersion++
      return
    }
    b.code = await res.json()
    // Signal that this block's code arrived so the DetailPanel rebuilds its card
    // (keyed on the code-loaded state) — a reliable re-render path that doesn't
    // depend on the diff's own `b.code` binding re-firing (see the codeVersion
    // note on `state`).
    state.codeVersion++
    // A file whose blocks were already fully approved may only just now have
    // this block's code (and thus its real done/total) available — recheck so
    // it doesn't stay un-marked as Viewed after a refresh.
    syncViewedFiles()
    // If this is the selected block, centre its active change now that the rows
    // (and their anchor) can be rendered — both when we've stepped into the diff
    // and when it's merely selected in the list (previewing the first change).
    if (state.blocks[state.selected] === b) {
      const groups = unitsOf(b)
      // We stepped up into this block before its code loaded — now that its
      // change groups are known, land on the last one.
      if (pendingLast) {
        state.change = Math.max(0, groups.length - 1)
        pendingLast = false
      } else if (state.change >= groups.length) {
        // A change index restored from the URL can outrun this block's groups
        // (stale/shared link) — clamp it back into range.
        state.change = Math.max(0, groups.length - 1)
      }
      // A block with 0 own groups no longer flips diff mode back to the list —
      // enterDiff() now deliberately allows stepping into such a block's diff
      // (its only reviewable content is its Onderliggende code, see enterDiff's
      // own comment): the reviewer sees its plain, unhighlighted code and can
      // still → into the Onderliggende-code panel from there. This used to
      // bounce back to 'list' at the rest position (no drilled column open),
      // which — now that entering diff this way is an intentional, keyboard-
      // reachable state (a plain ArrowRight in the list) rather than only a
      // stale ?mode=diff URL restore or a postApprove drill-in-flight race —
      // would immediately undo the reviewer's own → keypress. See
      // tests/drill-mode-flip.spec.mjs for the drilled case (focusLevel > 0),
      // which was already exempt from this and is unaffected.
      scrollChangeIntoView(state.mode === 'diff')
    } else if (state.drill[state.focusLevel - 1] === b) {
      // A restored ?dgran=/?dchg= cursor (see applyDrillCursorRestore) can
      // only be applied once this column's rows are actually known — do that
      // first so the scroll below centres the RESTORED unit, not the default
      // first one.
      applyDrillCursorRestore(b)
      // A focused drilled column's code just arrived (a real PR block whose
      // source wasn't fetched yet — see drillIntoChild) — jump straight to its
      // first change group now that the rows/anchor can be rendered, mirroring
      // the top-level scroll-on-load above. Without this the reviewer lands on
      // the top of the (often large) function body with the actual diff hunk
      // scrolled out of view, looking as if the red/green formatting is simply
      // missing.
      scrollChangeIntoView(false)
    }
    // Show the out-of-view hints for this freshly-rendered diff (its own card and
    // the look-ahead preview both land here). scrollChangeIntoView only fires for
    // the selected card, and only when a scroll actually happens.
    refreshHints()
  } catch (e) {
    b.code = { error: String(e) }
    state.codeVersion++
  }
}

async function ingest() {
  state.error = ''
  state.ingesting = true
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      state.error = body.error || `ingest failed: ${res.status}`
      return
    }
    await loadBlocks()
  } catch (e) {
    state.error = String(e)
  } finally {
    state.ingesting = false
  }
}

// refreshHints re-evaluates the up/down scroll hints of every rendered diff. A
// scroll fires syncScroll (which updates hints) on its own, so this only covers
// the cases where nothing scrolls: right after a lazy code fetch renders, and on
// window resize (which changes what fits in view). Deferred a frame so layout is
// settled before we measure.
function refreshHints() {
  requestAnimationFrame(() => {
    document.querySelectorAll('[data-testid="code-diff"]').forEach(updateHints)
  })
}

window.addEventListener('resize', refreshHints)

// scrollSelectedIntoView keeps the highlighted row visible. Deferred so the DOM
// has the new highlight class before we measure.
function scrollSelectedIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(
      state.toggleFocused ? '[data-testid="toggle-approved"]' : `[data-idx="${state.selected}"]`
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// animateScrollTop tweens a scroll container's scrollTop to `to` over a short,
// snappy ease — navigation between changes glides instead of teleporting, so the
// eye can follow the diff moving, without the sluggishness of the browser's native
// smooth-scroll. A fresh call cancels the running tween so rapid ↑/↓ presses don't
// fight each other. Setting scrollTop fires a scroll event, which syncScroll
// (Block.mjs) mirrors to the other pane, so both sides animate in lockstep.
let scrollAnim = 0
const SCROLL_MS = 160 // fast, but still a visible glide
function animateScrollTop(container, to) {
  cancelAnimationFrame(scrollAnim)
  const from = container.scrollTop
  const dist = to - from
  if (Math.abs(dist) < 1) {
    container.scrollTop = to
    return
  }
  const start = performance.now()
  const ease = (t) => 1 - Math.pow(1 - t, 3) // easeOutCubic: leaves fast, settles soft
  const step = (now) => {
    const t = Math.min(1, (now - start) / SCROLL_MS)
    container.scrollTop = from + dist * ease(t)
    if (t < 1) scrollAnim = requestAnimationFrame(step)
  }
  scrollAnim = requestAnimationFrame(step)
}

// scrollChangeIntoView centres the active change group in the diff viewport with a
// short glide. The anchor is rendered by Block once the code has loaded and the
// highlight is drawn; we retry a few frames so it still lands after a lazy code
// fetch resolves.
// `animate` glides only when the reviewer is actually navigating inside a block
// (diff mode). When merely selecting blocks in the list, the block isn't active
// yet, so we jump straight to its first change with no animation.
function scrollChangeIntoView(animate = true, tries = 10) {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-change-active]')
    if (!el) {
      if (tries > 0) scrollChangeIntoView(animate, tries - 1)
      return
    }
    const container = el.closest('[data-scrollsync]')
    if (!container) {
      // No scrollsync pane found (defensive fallback) — scroll only the
      // nearest vertical container, never <main>'s horizontal scroll (see
      // scrollIntoViewVertical in RelatedPanel.mjs for why a bare
      // el.scrollIntoView({block:'center'}) is unsafe here: its omitted
      // `inline` defaults to 'nearest' and would nudge <main> sideways,
      // pushing the keyboard-focused diff column out of view).
      scrollIntoViewVertical(el)
      return
    }
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const to =
      container.scrollTop +
      (eRect.top - cRect.top) -
      (container.clientHeight - eRect.height) / 2
    if (animate) {
      animateScrollTop(container, to)
    } else {
      cancelAnimationFrame(scrollAnim) // kill any running glide
      container.scrollTop = to
    }
    // If `to` equalled the current scrollTop no scroll event fires, so refresh the
    // hints explicitly (a real scroll would have gone through syncScroll).
    refreshHints()
  })
}

// enterDiff steps from the sidebar into the selected block's diff, selecting its
// first change (added, removed or modified line). → should always progress
// forward — exactly like → in the PR-summary card (stop 1) always steps to
// the block index (stop 2), unconditionally — so this no longer bails out for
// a block with 0 own navigable change groups (a real PR block whose own body
// is unchanged and only serves as the parent of Onderliggende-code children,
// e.g. CreatePaymentAction::findOrCreateCustomer in the PR 12903 fixture): it
// still enters diff mode, showing the block's (unhighlighted) plain code, and
// the reviewer can → from there into Onderliggende code. Block/setGran/
// unitAtRow/scrollChangeIntoView all already tolerate an empty units list
// (activeGroup falls back to null, no crash) — this combination was already a
// supported state via drilling (see tests/drill-mode-flip.spec.mjs), just not
// yet reachable by a plain list-mode →. See tests/enter-diff-zero-groups.spec.mjs.
function enterDiff() {
  const b = state.blocks[state.selected]
  if (!b) return
  state.mode = 'diff'
  // Stepping in from the list always starts at the coarsest granularity (a whole
  // change run); the reviewer refines from there with f.
  state.gran = 'group'
  state.change = 0
  state.rangeAnchor = null
  // Defensive: a fresh diff session starts with no drilled columns and the
  // keyboard on the top-level block itself (drill/focusLevel should already be
  // empty/0 here — the diff→list transition clears them — but reset in case
  // this is ever reached some other way, e.g. a future URL restore).
  state.drill = []
  state.drillCursor = []
  state.focusLevel = 0
  resetMainScroll()
  scrollChangeIntoView()
}

// openTask jumps to what a "Taken" row (RelatedPanel's workflows section)
// points at — currently only meaningful for a task_code_comment run that
// carries a resolved `comment` reference (see WorkflowRunView.comment in
// tasks_api.go): it selects the comment's block, steps into its diff on the
// comment's exact unit (gran + row range), and finally selects the comment's
// own thread in the panel. Every other run type is purely informational, so
// this is a no-op for them. Fails silently at every step (block not found,
// comment not yet loaded) rather than throwing — a stale/racy click should
// just do nothing.
async function openTask(run) {
  const c = run && run.comment
  if (!c) return
  const idx = state.blocks.findIndex((b) => b.file === c.file && b.label === c.label)
  if (idx < 0) return
  state.selected = idx
  state.mode = 'diff'
  state.drill = []
  state.drillCursor = []
  state.focusLevel = 0
  state.rangeAnchor = null
  resetMainScroll()
  const b = state.blocks[idx]
  await ensureCode(b)
  const rows = blockRows(b)
  const gran = c.gran || 'group'
  state.gran = gran
  const units = unitsFor(rows, gran)
  state.change = units.length ? unitAtRow(units, c.rowStart >= 0 ? c.rowStart : 0) : 0
  scrollChangeIntoView()
  // Give arrow.js a couple of microtask turns to flush the setCommentScope
  // watch that the navigation change above just queued, so RelatedPanel's
  // comment index (cs.view) is scoped to this unit before we select the
  // comment within it — selectComment looks the id up in cs.view, not the
  // full unfiltered list.
  await Promise.resolve()
  await Promise.resolve()
  selectComment(run.runId)
}

// ── Command palette (`/`) ─────────────────────────────────────────────────────
// The `/` key opens a searchable command menu overlaid on the next-block preview
// slot (see DetailPanel). The state is split across two reactives on purpose:
//
//   `menu`  — only `open`. Stable for the app's lifetime, so the top-level
//             `${() => menu.open ? menuOverlay() : ''}` binding keeps working.
//   `ms`    — the volatile per-open state (query/sel/sub/mode). openMenu REPLACES
//             it with a fresh reactive object each time the palette opens.
//
// Why the split: when the overlay is torn down on close, arrow.js does not fully
// dispose CommandMenu's reactive expressions — its list/row bindings stay
// subscribed to the state object they were built against. If that object is later
// mutated (a cross-mode reopen changing mode, or entering a submenu changing sub),
// those orphaned bindings fire against freed expression slots → the "W[t] is not a
// function" use-after-free. By handing each open a *brand-new* `ms`, the orphans
// from a previous open point at an object we never touch again, so they never
// fire; only the live menu's bindings (built against the current `ms`) run.
// Both stay out of the URL (not in bindUrlState) since they're ephemeral.
//
// That `ms`-swap avoids the *crash*, but on its own it does NOT stop a much
// quieter problem: arrow.js never disposes CommandMenu's nested row/list
// bindings at all (there's no cascading teardown for a component embedded via
// `${CommandMenu(...)}` — see the "disposal gap" note in conventions.md). An
// orphaned binding that reads only `ms` is harmless (nothing ever mutates a
// discarded `ms` again, so it never re-fires). But a command whose `label` is a
// *function* reading GLOBAL state (`state.mode`, `b.approvedRows`,
// `state.jiraKey`, …) registers that binding's dependency against those global
// properties, not against `ms` — and those keep changing for the rest of the
// session. Every past palette-open's orphaned label binding then re-evaluates
// on every future, unrelated navigation/approve step: a permanently growing
// amount of dead work per keystroke, which is what made the tab "loopt vast"
// after enough approve+navigate cycles (the automatic postApprove follow-up
// menu, see afterApproveAction, opens one of these on every group approval).
// `commands`/`sub` below hold a *snapshot* (see snapshotCommands) with every
// function label already resolved to a plain string, precisely so nothing
// left over in the (never-disposed) CommandMenu tree ever reads live global
// state again — see resolveLabel/snapshotCommands/rootCommandsFor.
//
// `sub` holds a parent command's (already-snapshotted) children while a
// submenu is open (null at the root). Choosing a command with `children` (e.g.
// "Open GitHub") swaps the list to those children instead of running; Esc
// backs out to the root.
// `mode` selects which command list resolveCommands shows: 'block' (the
// default, the block palette opened by Enter), 'comment' (opened by Enter on a
// focused, not-yet-replied-to comment row — see COMMENT_COMMANDS), 'pr' (the
// general PR-wide tree menu opened by `/` — see PR_COMMANDS), 'compose' (the
// comment-kind menu opened on a filled composer — see COMPOSE_COMMANDS),
// 'postApprove' (opened right after a palette approve action that still leaves
// a not-yet-approved unit ahead — see afterApproveAction/POSTAPPROVE_COMMANDS),
// or one of the three review-submit follow-ups opened when that action
// instead leaves NOTHING ahead (afterApproveAction again): 'reviewApprove'
// (the whole PR is fully approved — see REVIEW_APPROVE_COMMANDS),
// 'reviewChoice' (it isn't — see REVIEW_CHOICE_COMMANDS) or 'reviewReject'
// (the free-text rejection-reason step "Wijs de PR af" opens).
const menu = reactive({ open: false })
let ms = reactive({ query: '', sel: 0, sub: null, mode: 'block', commands: [] })

// withClose prepends a "Sluit menu" item to any command list — every root
// list (COMMANDS, PR_COMMANDS, ...) and every submenu's `children` alike, so
// every small menu offers an explicit, always-first way out. `onClose` lets a
// mode run its own cleanup on close (postApprove clears postApproveTarget);
// every other caller gets a no-op. This runs over the raw (function-labelled)
// lists, so snapshotCommands/resolveLabel still processes it like any other
// command — no special-casing needed elsewhere. Deliberately NOT applied to
// the reviewReject mode's dynamic 0/1-item list or the "no match" make-a-
// comment fallback in resolveCommands — both are single, dynamically built
// actions where a pinned close item (plus defaultSel below skipping to a
// non-existent 2nd item) would break "type, Enter" straight through.
function withClose(list, onClose) {
  return [{ id: 'close-menu', label: 'Sluit menu', hint: 'sluit', run: onClose || (() => {}) }, ...list]
}

// defaultSel picks the initial selection for a freshly opened menu/submenu:
// the 2nd item (index 1), so the pinned "Sluit menu" is never itself the
// default Enter action — but never past the end, so a list with 0 or 1 real
// item still gets a valid index instead of pointing at nothing.
function defaultSel(list) {
  return Math.min(1, Math.max(0, list.length - 1))
}

// COMMENT_COMMANDS — shown when Enter is pressed on a focused comment row
// (not mid-reply): resolving or deleting it. Kept separate from COMMANDS
// (block actions) since a comment isn't tied to the selected block/diff.
// "Resolve comment" also resolves the conversation on GitHub (for a review-diff
// thread) — see resolveFocusedComment (RelatedPanel.mjs) and the reply-loop's
// resolveGithubThread Activity (workflows.go). "Sluit menu" is pinned first
// (withClose); the menu opens on the 2nd item (defaultSel), so "Resolve
// comment" stays the default Enter action.
const COMMENT_COMMANDS = withClose([
  {
    id: 'resolve-comment',
    label: 'Resolve comment',
    hint: 'resolve',
    run: () => resolveFocusedComment(),
  },
  {
    id: 'delete-comment',
    label: 'Verwijder comment',
    hint: 'delete',
    run: () => deleteFocusedComment(),
  },
])

// COMPOSE_COMMANDS — shown when Enter (or the composer button) is pressed on a
// filled new-comment composer (menu mode 'compose'): choose what to do with the
// typed text. "Sluit menu" is pinned first (withClose); the menu opens on the
// 2nd item (defaultSel), where "Plaats comment" (the default action) posts a
// normal, public comment (the same placeComment path as ever, without
// opts.local) so the plain "type, Enter, Enter" flow still places a real
// comment. "Alleen voor mijzelf" places a private note instead (createComment
// with local:true → the workflow skips the GitHub post). The Claude/Git/Jira
// items are placeholders (like the Jira items in PR_COMMANDS). Both real-
// placing items refresh the Taken column right after (pollWorkflows) —
// task_code_comment starts a new workflow run per comment, and this is more
// immediate than waiting for the next WORKFLOWS_POLL_MS tick. The Git label
// names the current selection unit (groep/regel/call) via granNoun.
const COMPOSE_COMMANDS = withClose([
  {
    id: 'compose-post',
    label: 'Plaats comment',
    hint: 'post',
    run: async () => {
      await placeComment(state, commentTarget)
      pollWorkflows()
      // placeComment (RelatedPanel.mjs) already handed the keyboard back to
      // the diff (exitRelated) — re-align <main> on it, mirroring the same
      // scrollFocusIntoView() call onKeydown makes right after an ← exit out
      // of the sidebar (see the relatedActive() branch above).
      scrollFocusIntoView()
    },
  },
  {
    id: 'compose-claude',
    label: 'Claude commando',
    hint: 'todo',
    // Placeholder — no Claude command integration yet.
    run: () => {},
  },
  {
    id: 'compose-commit',
    label: () => `Laat Claude dit implementeren (${granNoun()})`,
    hint: 'commit',
    // Placeholder — no git-commit/implement integration yet. The label refers to
    // the unit (group/line/call) the comment is scoped to.
    run: () => {},
  },
  {
    id: 'compose-self',
    label: 'Alleen voor mijzelf',
    hint: 'privé',
    run: async () => {
      await placeComment(state, commentTarget, { local: true })
      pollWorkflows()
      scrollFocusIntoView()
    },
  },
  {
    id: 'compose-jira',
    label: 'Jira',
    hint: 'jira',
    // A submenu (see runCommand). All three are placeholders — no Jira write yet.
    children: withClose([
      { id: 'compose-jira-comment', label: 'Comment op ticket', hint: 'todo', run: () => {} },
      { id: 'compose-jira-subtask', label: 'Subtaak aanmaken', hint: 'todo', run: () => {} },
      { id: 'compose-jira-task', label: 'Nieuwe taak aanmaken', hint: 'todo', run: () => {} },
    ]),
  },
])

// POSTAPPROVE_COMMANDS — shown right after a palette approve action (menu mode
// 'postApprove', see afterApproveAction) when there's a next not-yet-approved
// unit still ahead: continue straight to it, or just close. Only reached from
// the command-palette approve action — the top checkbox in Block.mjs stays a
// direct toggle and never opens this menu. "Sluit menu" is pinned first
// (withClose, with its own onClose so closing also drops the stashed
// postApproveTarget — mirrors the old dedicated close item's cleanup); the
// menu opens on the 2nd item (defaultSel), so "Ga door…" stays the default
// Enter action.
const POSTAPPROVE_COMMANDS = withClose(
  [
    {
      id: 'postapprove-next',
      // A function label so it can name what "next" actually means: the next
      // *block* when the triggering approve ran from the blokken-index
      // (postApproveTarget.keepList, see applyNextUnapproved), else the usual
      // next changed code. Resolved once, at snapshot time (openMenu →
      // snapshotCommands), right after afterApproveAction sets postApproveTarget
      // — same safe, non-reactive read as the 'approve' command's own label.
      label: () =>
        postApproveTarget && postApproveTarget.keepList
          ? 'Ga door naar het volgende niet-goedgekeurde block'
          : 'Ga door naar de volgende niet-goedgekeurde code',
      hint: 'volgende',
      run: () => {
        if (postApproveTarget) applyNextUnapproved(postApproveTarget)
        postApproveTarget = null
      },
    },
  ],
  // Nothing else to do on close — runCommand already closed the palette. Just
  // drop the stashed target so a later unrelated navigation can't reuse it.
  () => {
    postApproveTarget = null
  }
)

// submitReview posts a real GitHub PR-level review via the submit_review
// Workflow (POST /api/workflows/submit_review — the sanctioned write path,
// see .claude/rules/workflows-write-boundary.md; the backend itself is out
// of frontend scope, this is only the call site). `event` is 'APPROVE' or
// 'REQUEST_CHANGES'; `body` is required non-empty for REQUEST_CHANGES —
// GitHub (and the backend's own validateSubmitReview, returning 400) reject
// a bodyless one, so callers must never invoke this with an empty body for
// that event (see the 'reviewReject' menu mode below, which only ever offers
// its run once the typed reason is non-blank).
// Error handling is deliberately minimal: this app has no toast/error-surface
// convention anywhere yet (see conventions.md — even createComment doesn't
// check res.ok), so a 400/502 or network failure just logs — the reviewer can
// see nothing landed (no new "Review" run in Taken) and retry via `/`.
// On success this is itself a fresh workflow run, so pollWorkflows() refreshes
// the Taken column sooner than the next WORKFLOWS_POLL_MS tick — the same
// courtesy call compose-post/compose-self already make after placing a comment.
async function submitReview(event, body = '') {
  try {
    const res = await fetch('/api/workflows/submit_review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, event, body }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('submit_review failed:', res.status, text)
      return
    }
    pollWorkflows()
  } catch (err) {
    console.error('submit_review network error:', err)
  }
}

// checkPRWarnings starts a code_warning Execution: an agentic Sonnet review
// of every changed file in the whole PR for risks (security/style/
// consistency with connected code — callers, callees, tests, listeners),
// creating one AI-authored comment per finding (block-scoped when it anchors
// to a line, PR-wide otherwise — see .claude/rules/tembed-workflows.md).
// POST /api/workflows/code_warning is the sanctioned write path (starting an
// Execution); this is only the call site. Files is omitted — a full baseline
// run. Same minimal error handling as submitReview (no toast convention in
// this app, see conventions.md); on success it's itself a fresh workflow run,
// so pollWorkflows() refreshes the Taken column sooner than the next tick.
async function checkPRWarnings() {
  try {
    const res = await fetch('/api/workflows/code_warning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('code_warning failed:', res.status, text)
      return
    }
    pollWorkflows()
  } catch (err) {
    console.error('code_warning network error:', err)
  }
}

// REVIEW_APPROVE_COMMANDS — shown right after a palette approve action leaves
// the WHOLE PR fully approved (state.approvalTotal.done === total, over every
// top-level block plus its nested/drilled PR-block children — see
// afterApproveAction): there's nothing left to review anywhere, so offer to
// submit a real "approve" GitHub review, or just close. "Sluit menu" is
// pinned first (withClose); the menu opens on the 2nd item (defaultSel), so
// "Keur de PR goed" stays the default Enter action.
const REVIEW_APPROVE_COMMANDS = withClose([
  {
    id: 'review-approve-pr',
    label: 'Keur de PR goed',
    hint: 'approve',
    run: () => submitReview('APPROVE'),
  },
])

// REVIEW_CHOICE_COMMANDS — shown right after a palette approve action leaves
// nothing ahead to navigate to (findNextUnapproved()===null — the reviewer
// just approved the last unit reachable from here) while the PR is NOT yet
// fully approved overall (something else — earlier, or elsewhere in the tree
// — is still open). Offers the same "Keur de PR goed" as above, or "Wijs de
// PR af": that doesn't submit straight away (a REQUEST_CHANGES review needs a
// non-empty reason, see submitReview) but opens the dedicated free-text
// follow-up step instead (menu mode 'reviewReject' below). "Sluit menu" is
// pinned first (withClose); the menu opens on the 2nd item (defaultSel), so
// "Keur de PR goed" stays the default Enter action.
const REVIEW_CHOICE_COMMANDS = withClose([
  {
    id: 'review-choice-approve',
    label: 'Keur de PR goed',
    hint: 'approve',
    run: () => submitReview('APPROVE'),
  },
  {
    id: 'review-choice-reject',
    label: 'Wijs de PR af',
    hint: 'reject',
    run: () => openMenu('reviewReject'),
  },
])

// resolveLabel/snapshotCommands materialize a command list's labels into plain
// strings, calling any function label RIGHT NOW instead of leaving it as a live
// `${() => labelOf(c)}` binding inside CommandMenu's tree. This must run from
// plain, non-reactive code (openMenu/enterSubmenu/the Escape-to-root branch in
// onKeydown — never from inside an arrow.js reactive callback) so the read of
// whatever global state the label function touches (state.mode, b.approvedRows,
// state.jiraKey, …) never registers as a tracked dependency in the first place.
// See the menu/ms comment above and the "disposal gap" note in conventions.md
// for why that matters: CommandMenu's nested bindings are never disposed when
// the palette closes, so a *live* dependency there would silently keep
// re-evaluating forever, on every future unrelated state change. A plain string
// has nothing to depend on, so an orphaned binding built from one simply never
// fires again — harmless, exactly like the existing ms-only bindings.
function resolveLabel(c) {
  return typeof c.label === 'function' ? c.label() : c.label
}
function snapshotCommands(list) {
  return list.map((c) => ({
    ...c,
    label: resolveLabel(c),
    children: c.children ? snapshotCommands(c.children) : undefined,
  }))
}

// granNoun names the current comment target's granularity for the compose menu's
// "implementeren" label — the group/line/call the comment attaches to.
function granNoun() {
  const t = commentTarget()
  const g = t ? t.gran : 'group'
  return g === 'line' ? 'regel' : g === 'call' ? 'call' : 'groep'
}

function curBlock() {
  return state.blocks[state.selected]
}

// focusedBlock is whichever block the active Onderliggende-code panel (and its
// keyboard focus) currently belongs to: state.focusLevel indexes the virtual
// column list [top-level selected block, ...state.drill] — not always the
// deepest drilled child. Stepping ← back through the drilled columns slides
// this (and the panel + tasks it drives) along with the focus.
// relatedChildren/unresolvedCalls/startCallSearch all take this so the panel
// and its actions follow wherever the keyboard currently is.
function focusedBlock() {
  return state.focusLevel === 0 ? curBlock() : state.drill[state.focusLevel - 1]
}

// focusedGranCursor resolves the {gran, change} of whichever column currently
// owns the keyboard — the top-level state.gran/state.change (focusLevel 0), or
// the focused drilled column's own state.drillCursor[level-1] entry
// (focusLevel > 0). Mirrors callArrowPairs' inline `cur` resolution and
// approveContext's level-branch; callScopeMethods/groupLineRange/
// relatedChildren/resolvedCallChildren use it so the Onderliggende-code panel
// scopes/reorders on whichever column is actually focused, not always the
// top-level block (see .claude/rules/detail-layout.md, "Kolom-navigatie").
function focusedGranCursor() {
  const level = state.focusLevel
  if (level > 0) return state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  return { change: state.change, gran: state.gran }
}

// drillSiblingContext locates, for the drilled column at `level` (1-based,
// matching state.drill's indexing), its PARENT block plus its own position in
// that parent's Onderliggende-code list — the sibling list drillNextChange/
// drillPrevChange walk once the column's own diff is exhausted (see below).
// The parent is curBlock() for the first drill layer, or the previous drilled
// column for anything deeper — so this works at any drill depth. Siblings are
// exactly relatedChildren(parent) (the same list/order the panel shows when the
// parent is focused), minus the tests_group toggle-bar (not a real drillable
// child — see drillIntoChild). The current entry is matched back into that list
// via blockId-or-id, mirroring how drillIntoChild itself resolves a descriptor
// into a real block (existing.id) or a synthetic frame (frame.id = child.id).
// Returns null if there's no parent, no relations loaded yet, or (defensively)
// no match — any of which just means "nowhere to walk sideways".
function drillSiblingContext() {
  const level = state.focusLevel
  if (level < 1) return null
  const parent = level === 1 ? curBlock() : state.drill[level - 2]
  if (!parent) return null
  const siblings = relatedChildren(parent).filter((c) => c.kind !== 'tests_group')
  const cur = state.drill[level - 1]
  if (!cur) return null
  const idx = siblings.findIndex((s) => (s.blockId && s.blockId === cur.id) || s.id === cur.id)
  if (idx === -1) return null
  return { siblings, idx }
}

// drillToSibling replaces the drilled column at the CURRENT focus level with
// `sibling` — pop this level's entry, then drillIntoChild(sibling), which
// pushes a fresh entry right back at the same depth (drill.length ends up
// unchanged). This is a sideways walk between siblings, not a step deeper.
// `atEnd` lands the fresh column on its last 'group' unit instead of the
// default first one (drillIntoChild always starts at {change:0, gran:'group'})
// — used when arriving via ↑/d from the top of the next column, mirroring the
// existing stepBlock convention ("stepping up lands on the last change"). Best
// effort/synchronous: if the sibling's rows aren't available yet (rare — every
// sibling shown in relatedChildren already has ensureCode in flight, but a
// slow fetch could still be pending), it falls back to landing on the first
// unit rather than deferring like stepBlock's pendingLast — kept simple on
// purpose, since a fresh drill always shows the diff needed to keep navigating.
function drillToSibling(sibling, atEnd) {
  const level = state.focusLevel
  state.drill = state.drill.slice(0, level - 1)
  state.drillCursor = state.drillCursor.slice(0, level - 1)
  state.focusLevel = level - 1
  drillIntoChild(sibling)
  if (atEnd) {
    const b = state.drill[state.drill.length - 1]
    const units = unitsFor(blockRows(b), 'group')
    if (units.length > 1) setDrillChange(state.focusLevel, units.length - 1)
  }
}

// drillNextChange / drillPrevChange walk the *drilled* column that currently
// owns the diff keyboard (state.focusLevel > 0) through the units of its own
// current granularity (drillCursor.gran) — the same unitsFor walk as the
// top-level nextChange/prevChange, just scoped to that column's rows. A
// drilled column never flows into a same-file neighbour (that concept doesn't
// exist for it — see sameFileNeighbour/stepBlock, top-level only), but running
// off its last/first unit DOES flow sideways into the next/previous sibling in
// the parent's Onderliggende-code list (drillSiblingContext/drillToSibling) —
// the reviewer walks the whole "onderliggende code" tree top to bottom instead
// of getting stuck at the edge of one child. No wrap-around: at the last/first
// sibling this still just clamps, exactly as before this feature.
function drillNextChange() {
  const level = state.focusLevel
  const b = state.drill[level - 1]
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  const units = unitsFor(blockRows(b), cur.gran)
  if (cur.change < units.length - 1) {
    setDrillChange(level, cur.change + 1)
    scrollChangeIntoView()
    return
  }
  const ctx = drillSiblingContext()
  const next = ctx && ctx.siblings[ctx.idx + 1]
  if (next) drillToSibling(next, false)
}

function drillPrevChange() {
  const level = state.focusLevel
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  if (cur.change > 0) {
    setDrillChange(level, cur.change - 1)
    scrollChangeIntoView()
    return
  }
  const ctx = drillSiblingContext()
  const prev = ctx && ctx.siblings[ctx.idx - 1]
  if (prev) drillToSibling(prev, true)
}

// hasPrevDrillSibling reports whether the drilled column at the current focus
// level has a previous sibling to flow back into — used by dKey's 'call'-level
// guard below, mirroring the top-level dKey's `sameFileNeighbour(-1)` check.
function hasPrevDrillSibling() {
  const ctx = drillSiblingContext()
  return !!(ctx && ctx.idx > 0)
}

// setDrillChange reassigns state.drillCursor wholesale (never mutates an entry
// in place) so arrow.js's reactive activeGroup binding on that drilled column's
// card re-fires — the same "always reassign, never mutate" rule as
// b.approvedRows elsewhere in this file. Keeps the entry's current `gran`, and
// always clears any active line-range selection (only drillNextChange/
// drillPrevChange call this, both plain — non-shift — steps; drillExtendRange
// below sets rangeAnchor directly instead of going through here).
function setDrillChange(level, change) {
  state.drillCursor = state.drillCursor.map((c, i) =>
    i === level - 1 ? { ...(c || { gran: 'group' }), change, rangeAnchor: null } : c,
  )
}

// setDrillGran mirrors setGran, but for the drilled column at `level` (its own
// drillCursor entry instead of state.gran/state.change): +1 refines
// (group → line → call) via f, -1 coarsens via d/s. Re-anchors `change` onto
// the unit covering the row we were on, exactly like the top-level version.
function setDrillGran(level, delta) {
  const b = state.drill[level - 1]
  if (!b) return
  const rows = blockRows(b)
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  const from = GRANS.indexOf(cur.gran)
  const curUnit = unitsFor(rows, cur.gran)[cur.change]
  const anchorRow = curUnit ? curUnit.start : 0
  let to = Math.min(GRANS.length - 1, Math.max(0, from + delta))
  // Same single-row-group shortcut as setGran: skip 'line' straight to 'call'.
  if (delta > 0 && cur.gran === 'group' && curUnit && curUnit.end === curUnit.start) {
    to = GRANS.indexOf('call')
  }
  if (to === from) return
  const gran = GRANS[to]
  const units = unitsFor(rows, gran)
  const change = units.length ? unitAtRow(units, anchorRow) : 0
  state.drillCursor = state.drillCursor.map((c, i) => (i === level - 1 ? { gran, change } : c))
  scrollChangeIntoView()
}

// drillExtendRange mirrors extendRange, but for the drilled column at `level`
// (its own drillCursor entry instead of state.gran/state.change/
// state.rangeAnchor). Only meaningful at gran==='line'; clamps at the
// column's own first/last line unit — a range never flows sideways into a
// sibling (drillNextChange/drillPrevChange's sibling walk), since approve/
// comment act on rows of a single block.
function drillExtendRange(level, delta) {
  const b = state.drill[level - 1]
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  if (!b || cur.gran !== 'line') return
  const units = unitsFor(blockRows(b), 'line')
  if (!units.length) return
  const anchor = cur.rangeAnchor != null ? cur.rangeAnchor : cur.change
  const change = Math.min(units.length - 1, Math.max(0, cur.change + delta))
  state.drillCursor = state.drillCursor.map((c, i) => (i === level - 1 ? { ...c, change, rangeAnchor: anchor } : c))
  scrollChangeIntoView()
}

// scrollFocusIntoView scrolls whichever column now owns the diff keyboard into
// view — <main> scrolls horizontally, so stepping across drilled columns (or
// back to the original block) could otherwise land off-screen. Deferred a
// frame so a freshly-pushed drill column exists in the DOM first.
function scrollFocusIntoView(level = state.focusLevel) {
  requestAnimationFrame(() => {
    const el =
      level === 0
        ? document.querySelector('[data-testid="block-column"]')
        : document.querySelectorAll('[data-testid="drill-column"]')[level - 1]
    // Always align to the *left* edge of the viewport: the top-level block
    // column is the leftmost column, and a freshly-focused drilled column
    // should land flush against <main>'s left edge too (rather than its right
    // edge) so the columns it was drilled from stay hinted-at via the
    // left-edge chevron below instead of scrolling fully out of reach.
    if (el) el.scrollIntoView({ inline: 'start', block: 'nearest' })
  })
}

// resetMainScroll snaps <main>'s horizontal scroll hard back to 0. Called only
// at the "rest position" transitions — entering list-mode, or popping all the
// way back out of every drilled column (focusLevel===0 && drill.length===0) —
// never while a drilled column is focused/being entered: that's
// scrollFocusIntoView's territory, and it deliberately leaves earlier columns
// scrolled off the left edge (with a chevron hint) while drilling, see its own
// comment above. Without this, a stray manual horizontal scroll (trackpad/
// scrollbar drag) on <main> would otherwise persist across a transition back
// to the rest position, since scrollFocusIntoView's `inline:'start'` only
// re-aligns relative to the block-column element — usually equivalent to 0
// once it's the sole/leftmost child, but this makes the rest position exactly
// 0 unconditionally rather than relying on that alignment. Deferred a frame
// like the other scroll helpers so it runs after the fresh render.
function resetMainScroll() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="detail-panel"]')
    if (el) el.scrollLeft = 0
  })
}

// expandColumn refocuses the keyboard on an earlier column that's currently
// collapsed to a rail (see collapsedColumnHTML) — the top-level block (level 0)
// or a previously drilled-into column (level 1..drill.length). It's a direct
// jump to the same end state as pressing ← repeatedly from the current focus
// down to `level`: any columns drilled further right than `level` are
// discarded (same single-focus-owner model as the ← handler in onKeydown), so
// clicking a rail never leaves two columns "open" at once.
function expandColumn(level) {
  if (level >= state.focusLevel) return
  state.drill = state.drill.slice(0, level)
  state.drillCursor = state.drillCursor.slice(0, level)
  state.focusLevel = level
  markDrillReturn(level)
  scrollFocusIntoView()
  // Same rekey-resets-scrollTop issue as the ← handler in onKeydown (a rail
  // click is the same focus-transition, just triggered by mouse) — re-centre
  // the now-focused column's active change instead of leaving it scrolled to
  // the top of its pane.
  scrollChangeIntoView(false)
}

// collapsedColumnHTML renders the narrow rail a non-focused column shrinks to
// once drilling has opened a column further right (see DetailPanel) — it
// reclaims horizontal room for the focused column. `level` is the column's own
// index in the virtual [top-level block, ...state.drill] list; clicking it
// calls expandColumn(level) to bring the keyboard focus back onto it.
// `drillIdx` (drilled columns only, null for the top-level rail) is exposed as
// data-drill-idx so it lines up with the open drill-column's own attribute.
function collapsedColumnHTML(b, level, testid, drillIdx = null) {
  const label = blockLabel(b)
  return html`
    <button
      type="button"
      class="flex h-full w-14 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 ring-1 ring-black/5 text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800/60 hover:text-indigo-500 dark:hover:text-indigo-400"
      data-testid="${testid}"
      data-drill-idx="${drillIdx === null ? '' : drillIdx}"
      title="${b.label || ''}"
      @click="${() => expandColumn(level)}"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-4 w-4 shrink-0"
      ><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
      <span class="max-h-40 overflow-hidden text-ellipsis text-[10px] font-medium [writing-mode:vertical-rl]"
        >${label}</span
      >
    </button>
  `
}

// resolveChildBlock turns an Onderliggende-code child descriptor into the
// block-like object drillIntoChild pushes onto state.drill — extracted so the
// look-ahead preview (see drillPreviewColumns below) can resolve the SAME
// object for a sibling it only wants to render, without touching state.drill/
// drillCursor/focusLevel/codeVersion at all (a preview must never mutate
// navigation state). If the child is itself a real PR block (already in
// state.allBlocks) this returns that exact object: its relations/callResolve/
// approvedRows already work, so its own Onderliggende-code panel falls out for
// free (relatedChildren/resolvedCallChildren/callRows are generic over any
// block id). Otherwise (a resolved call into an unchanged file, with no PR
// block of its own) it builds a minimal, non-interactive synthetic frame with
// its code assembled inline (the call row already carries the called
// definition's source text) — the same frame shape drillIntoChild used to
// build in place. Returns null for the tests_group toggle-bar (not a real
// block, caller must handle that case itself — only drillIntoChild does).
function resolveChildBlock(child) {
  if (!child || child.kind === 'tests_group') return null
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  // A method-call child's own `id` is caller-scoped (b.id + '::' + callKey), so it
  // never matches a real block; its `blockId` points at the definition's PR block
  // when that definition is itself changed here. Relation children carry their real
  // block id directly in `id`. Try both, preferring the explicit target block id.
  const existing = byId.get(child.blockId) || byId.get(child.id)
  if (existing) return existing
  const hasClass = !!(child.label && child.label.includes('::'))
  // The call-row already carries the called definition's source text
  // (r.childCode → child.code). The file is unchanged by this PR, so /api/code
  // has no stored block for it (the fetch would never yield a diff and the card
  // would hang on "loading"). Build the code inline instead: old === new (nothing
  // changed here), so alignRows renders all-equal rows — the plain source, no
  // diff highlight. Only fall back to a fetch if we somehow have no text.
  const src = child.code || ''
  const start = child.line || 1
  return {
    id: child.id,
    label: child.label,
    file: child.file,
    class: hasClass ? child.label.split('::')[0] : '',
    name: hasClass ? child.label.split('::')[1] : child.label,
    line: child.line,
    // The PR doesn't touch this file (that's why there's no stored block), so
    // old === new below and the diff is all-equal — the frame is 'unchanged',
    // not 'modified' (which would show a misleading amber badge, see Block.mjs).
    status: 'unchanged',
    // Ready synchronously; if the row somehow carried no code, mark it as such
    // rather than hang on "loading" (there's no stored block to fetch).
    code: src
      ? { file: child.file, old: { start, text: src }, new: { start, text: src } }
      : { error: 'geen broncode beschikbaar' },
    synthetic: true,
  }
}

// Set right when drillIntoChild opens/replaces a drilled column — {level, id}
// identifying which fresh column just got created. The drill-column render
// pass below reads it once (to add a one-shot CSS entrance animation) and
// clears it immediately, so the animation plays exactly on a real "open" and
// never replays on a later, unrelated rebuild of the same column (code
// arriving, a foc/unfoc focus flip — see the drill-column .key(...) comment).
// Deliberately a plain module-level variable, not reactive state — mirrors
// other one-shot bookkeeping like searchRequested/lastSidebarFocus.
let drillOpenMarker = null

// drillReturnMarker mirrors drillOpenMarker but for the REVERSE transition:
// stepping back out of a drilled column so an earlier column regains the
// keyboard focus — ← peeling back one level (onKeydown), a collapsed-rail
// click jumping back several levels at once (expandColumn), or
// applyNextUnapproved trimming state.drill back onto an already-open
// ancestor with nothing further left to drill. {level, id} identifies which
// column just regained focus: level 0 is the top-level block (curBlock()),
// 1..drill.length is state.drill[level-1]. Consumed once by the same two
// render passes that consume drillOpenMarker (the top-level block-column
// closure and the drilled-columns map below), so it never replays on an
// unrelated rebuild of that column (code arriving, another focus flip).
let drillReturnMarker = null

// markDrillReturn stamps drillReturnMarker for the column about to regain
// focus at `level` — call this right after state.focusLevel is reassigned to
// its new (lower) value, at each of the three call sites listed above.
function markDrillReturn(level) {
  const id = level === 0 ? curBlock().id : state.drill[level - 1].id
  drillReturnMarker = { level, id }
}

// drillIntoChild opens a child from the Onderliggende-code panel as its own diff
// column, appended to the right of the current drill stack (Enter on a resolved
// child in the panel — see the Enter handling in onKeydown). Resolves the child
// via resolveChildBlock (real PR block reused as-is, or a synthetic frame for a
// resolved call into an unchanged file) and pushes it.
function drillIntoChild(child) {
  if (!child) return
  // The tests-group bar (the grouped covering tests, see groupTestChildren) is
  // not a drillable child: activating it — click and Enter both land here —
  // toggles the expansion instead. The setRelated watch lists
  // state.testsExpanded as an inline dep, so the panel re-renders with the
  // test cards inserted below (or removed from under) the bar.
  if (child.kind === 'tests_group') {
    state.testsExpanded = !state.testsExpanded
    return
  }
  const resolved = resolveChildBlock(child)
  state.drill = [...state.drill, resolved]
  // Mark this as a genuine "open" for the small entrance animation — see
  // drillOpenMarker's own comment above. drillToSibling (the sideways walk at
  // the edge of a drilled column's units) pops the current entry and calls
  // back into drillIntoChild, so a sibling swap correctly re-triggers this too
  // (it's a real column replacement, not a mere navigation step).
  drillOpenMarker = { level: state.drill.length, id: resolved.id }
  if (!resolved.synthetic) {
    // A relation-child gets its code lazily loaded elsewhere (relatedChildren);
    // a method-call child's PR-block definition might not have its own diff
    // fetched yet (its row only carries the plain code text) — ensure it here.
    ensureCode(resolved)
  } else {
    // Bump codeVersion so the DetailPanel rebuilds its keyed card on the loaded
    // state (see ensureCode's own bump); ensureCode itself no-ops for synthetic
    // frames, so this is the only "code arrived" signal it gets.
    state.codeVersion++
  }
  state.drillCursor = [...state.drillCursor, { change: 0, gran: 'group' }]
  // Hand the keyboard to the fresh column's own diff (not its Onderliggende-code
  // panel — the reviewer lands on its first change group and steps ↑/↓ through
  // it directly; → still opens its panel same as any other diff, see onKeydown).
  // Drop any related-panel focus the previous column left behind first.
  state.focusLevel = state.drill.length
  leaveRelated()
  scrollFocusIntoView()
  // Jump straight to the new column's first change group (same red/green diff
  // as the top-level block card — see Block.mjs codeDiff, reused as-is here).
  // Its code is often already cached (a synthetic frame builds it inline; a
  // real PR block's code has usually already been fetched for the
  // Onderliggende-code panel), in which case this fires immediately; otherwise
  // the ensureCode "code arrived" branch above does the same once it loads.
  scrollChangeIntoView(false)
}

// commentTarget describes what a comment started *right now* would attach to —
// the current navigation unit at the current granularity: a whole change 'group',
// one 'line', or one 'call' segment (with the block's class::method and the unit's
// source as a concrete example). RelatedPanel's composer reads this (via home.mjs)
// so the reviewer sees exactly what they're commenting on before they finish
// typing. Falls back to 'group' info in list mode, where there's no active unit.
// Follows focusedBlock() (the column that currently owns the diff keyboard), not
// always the top-level curBlock() — a comment started while a drilled column
// (state.focusLevel > 0) is focused must anchor on *that* column's block + its
// own drillCursor[focusLevel-1].{gran,change}, mirroring drillNextChange/
// setDrillGran. A drilled column has no list-mode equivalent (it's always a
// self-contained diff), so no mode==='diff' guard is needed for that branch.
// An active Shift+arrow line-range selection (see rangeUnit) widens the unit
// to the whole selected range, so a comment posted on it becomes a real
// multi-line range comment (unitLineRange/startLine/endLine below already
// support that — GitHub's own multi-line review comments).
function commentTarget() {
  const b = focusedBlock()
  if (!b) return null
  const rows = blockRows(b)
  const level = state.focusLevel
  const cur = level > 0 ? state.drillCursor[level - 1] || { change: 0, gran: 'group' } : null
  const gran = level > 0 ? cur.gran : state.mode === 'diff' ? state.gran : 'group'
  const idx = level > 0 ? cur.change : state.mode === 'diff' ? state.change : 0
  const anchor = level > 0 ? cur.rangeAnchor : state.mode === 'diff' ? state.rangeAnchor : null
  const units = unitsFor(rows, gran)
  const unit = gran === 'line' ? rangeUnit(units, idx, anchor) : units[idx]
  // No unit (block with no navigable changes): a block-level target with an
  // unknown row range (rowStart -1) — the index then shows all block comments.
  // startLine/endLine stay 0 so the backend falls back to the block's own line.
  if (!unit)
    return {
      gran,
      label: b.label,
      file: b.file,
      line: b.line,
      code: '',
      rowStart: -1,
      rowEnd: -1,
      seg: '',
      startLine: 0,
      endLine: 0,
      side: 'RIGHT',
      segment: '',
    }
  let code = ''
  for (let i = unit.start; i <= unit.end; i++) {
    const r = rows[i]
    const text = r && (r.right != null ? r.right : r.left)
    if (text != null) code += (code ? '\n' : '') + text
  }
  const { startLine, endLine, side } = unitLineRange(b, rows, unit)
  return {
    gran,
    label: b.label,
    file: b.file,
    line: b.line,
    code,
    // The unit's aligned-row range + (for a call) its segment key, so a placed
    // comment records exactly which unit it hangs on and the index can filter by
    // containment (call ⊂ line ⊂ group). See RelatedPanel.commentUnder.
    rowStart: unit.start,
    rowEnd: unit.end,
    seg: segKey(unit),
    // The real source line range/side this unit maps to (for GitHub anchoring —
    // see createComment/placeComment) plus, for a 'call' unit, its segment text.
    startLine,
    endLine,
    side,
    segment: unitSegment(rows, unit),
  }
}

// unitLineRange maps a navigation unit (an aligned-row range, see unitsFor) to
// the real source line range GitHub needs: which side ('RIGHT' new / 'LEFT'
// old) the comment should anchor on, and the first/last source line number of
// that side within the unit. Aligned rows carry no line numbers themselves, so
// this counts them off from the block's known source start
// (b.code.new.start/b.code.old.start — see ensureCode/GET /api/code), advancing
// a running line counter per row that carries content on that side (a filler
// row for the other side doesn't advance it). side is RIGHT unless every row in
// the unit is a pure deletion (no `right` anywhere), matching what a reviewer
// would actually see change. Returns a RIGHT/line-0 fallback when the code
// isn't loaded yet — the backend then falls back to the block's own line.
function unitLineRange(b, rows, unit) {
  const c = b && b.code
  if (!c || !c.new || !c.old || !unit) return { startLine: 0, endLine: 0, side: 'RIGHT' }
  let hasRight = false
  for (let i = unit.start; i <= unit.end; i++) {
    if (rows[i] && rows[i].right != null) {
      hasRight = true
      break
    }
  }
  const side = hasRight ? 'RIGHT' : 'LEFT'
  let newNo = c.new.start
  let oldNo = c.old.start
  let startLine = 0
  let endLine = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    const hasContent = side === 'RIGHT' ? r.right != null : r.left != null
    if (i >= unit.start && i <= unit.end && hasContent) {
      const no = side === 'RIGHT' ? newNo : oldNo
      if (!startLine) startLine = no
      endLine = no
    }
    if (r.right != null) newNo++
    if (r.left != null) oldNo++
  }
  return { startLine, endLine, side }
}

// unitSegment returns the source text of a 'call' unit's underlined segment —
// the substring of the row's active-side text between the segment's char
// bounds (see changeCalls/segKey, the same underline Sets Block.mjs renders).
// Coarser units (group/line, no `char`) or an empty segment (a blank added
// line) yield ''.
function unitSegment(rows, unit) {
  if (!unit || !unit.char) return ''
  const r = rows[unit.start]
  if (!r) return ''
  const hasRight = unit.right && unit.right.size
  const text = hasRight ? r.right : r.left
  const set = hasRight ? unit.right : unit.left
  if (!set || !set.size || text == null) return ''
  const arr = [...set]
  return text.slice(Math.min(...arr), Math.max(...arr) + 1)
}

// segKey canonicalises a 'call'-unit's segment into a stable string identity so
// two calls on the same line stay distinguishable: the side ('r'/'l') plus the
// underlined char range on that side (min-max). Coarser units (group/line) carry
// no segment, so they get ''. A blank added line (empty set) yields just the side
// prefix. The char range comes from the same underline Sets Block.mjs renders, so
// it matches the segment the reviewer saw when commenting.
function segKey(unit) {
  if (!unit || !unit.char) return ''
  const hasRight = unit.right && unit.right.size
  const set = hasRight ? unit.right : unit.left
  const side = hasRight ? 'r' : 'l'
  if (!set || !set.size) return side + ':'
  const arr = [...set]
  return side + ':' + Math.min(...arr) + '-' + Math.max(...arr)
}

// commentScope is what the comment index filters by: the selected block plus the
// current navigation unit (mode/gran + the unit's row range/segment). It reuses
// commentTarget (so it reads the same reactive navigation state) and adds the
// mode. The watch below reads it and pushes it into RelatedPanel — the index
// can't observe home.mjs' `state` across the module boundary from inside its own
// list binding, so home.mjs re-keys the whole panel by the scope signature (see
// the RelatedPanel binding in DetailPanel) and hands the scope down as an arg.
function commentScope() {
  const t = commentTarget()
  if (!t) return null
  return {
    file: t.file,
    label: t.label,
    mode: state.mode,
    gran: t.gran,
    rowStart: t.rowStart,
    rowEnd: t.rowEnd,
    seg: t.seg,
  }
}

// Bridge state → RelatedPanel's comment index. An arrow.js `watch` reliably
// re-runs on a selection move when its reader lists the navigation state *inline*
// (reads buried in commentScope/commentTarget aren't tracked, and a binding that
// returns the keyed panel doesn't re-run either), so this is what pushes the
// fresh scope into RelatedPanel (setCommentScope → cs.view) as the reviewer moves.
// state.focusLevel/state.drill/state.drillCursor are listed too — commentScope
// (via commentTarget) now follows focusedBlock() and, at focusLevel > 0, that
// column's own drillCursor entry, so drilling into (or back out of) a child, or
// zooming its granularity with f/d/s, must re-fire this the same way a
// top-level selection/gran/change move already does — otherwise the comment
// index stays scoped to whichever block owned the cursor before the drill.
watch(
  () => [
    state.selected,
    state.mode,
    state.change,
    state.gran,
    state.blocks,
    state.focusLevel,
    state.drill,
    state.drillCursor,
    focusedBlock() && focusedBlock().code,
  ],
  () => setCommentScope(commentScope()),
)

// lastRelatedBlockId tracks which block the underlying-code panel showed on
// the previous watch run — plain module state (not reactive; only used to
// detect a block switch inside the callback below, which then collapses the
// tests bar again).
let lastRelatedBlockId = null

// Bridge state → RelatedPanel's underlying-code card. Same reasoning as the
// comment-scope watch above, and the getter must follow the *same* rule: list the
// navigation state INLINE. Burying every reactive read inside relatedChildren()/
// unresolvedCalls() (as this watch used to) does NOT reliably re-subscribe the
// watch — its early-returns (b undefined at first load, `resolved.length === 0`,
// scope short-circuits) mean the settled run reads a different, smaller dep set,
// and the panel then freezes on whatever block was selected at load: it never
// re-fires as the cursor moves to another block. Listing state.selected/mode/
// change/gran (+ the block lists, callResolve, relations, and the selected block's
// lazily-loaded code) inline guarantees the re-fire; the children are then computed
// in the *callback* (untracked), which also keeps it off the panel's render binding
// — computing them there would subscribe that binding to `b.code` and race with
// home.mjs' own diff render over the same `b.code`, leaving the diff stuck on
// "loading". setRelated pushes the fresh list into the panel. `state.drill` is
// listed too so drilling into (or back out of) a child re-fires this: the panel
// is always scoped to focusedBlock() — the deepest drilled child, or the
// top-level selected block once the stack is empty — not always curBlock().
watch(
  () => [
    state.selected,
    state.mode,
    state.change,
    state.gran,
    state.blocks,
    state.allBlocks,
    state.relations,
    state.callResolve,
    state.testCovers,
    // codeVersion so a child block's lazily-loaded code (and thus its approval
    // count + code excerpt) refreshes the panel; approvalSummaries so a change
    // in approval re-renders the per-child badges.
    state.codeVersion,
    state.approvalSummaries,
    state.blockTotals,
    state.drill,
    // focusLevel + drillCursor so a step (f/d/s/↑/↓) WITHIN an already-drilled
    // column re-fires this watch too — callArrowPairs AND relatedChildren
    // (via callScopeMethods/groupLineRange/resolvedCallChildren, all reading
    // focusedGranCursor) now read the focused column's own drillCursor entry,
    // so without these the overlay/panel would only redraw on a top-level
    // cursor move or a drill/undrill, never on a granularity/change step
    // taken while already drilled.
    state.focusLevel,
    state.drillCursor,
    // testsExpanded so toggling the grouped covering-tests bar (see
    // groupTestChildren/drillIntoChild) re-pushes the children list with the
    // test cards inserted/removed.
    state.testsExpanded,
    focusedBlock() && focusedBlock().code,
  ],
  () => {
    const b = focusedBlock()
    // A block switch collapses the tests bar again (ephemeral cursor state,
    // like showDescription): the expansion belongs to the block it was opened
    // on. Guarded assignment — testsExpanded is a dep of this watch, so only
    // write when it actually changes (one extra settle-fire, then stable).
    const bid = b ? b.id : null
    if (bid !== lastRelatedBlockId) {
      lastRelatedBlockId = bid
      if (state.testsExpanded) state.testsExpanded = false
    }
    setRelated(relatedChildren(b), unresolvedCalls(b).concat(unresolvedTestCovers(b)), testCoverWarning(b))
    // Push the call→child arrow pairs for the overlay (same untracked-callback
    // decoupling as setRelated itself — see callArrowPairs / callArrows.mjs).
    setCallArrows(callArrowPairs(b))
    // Auto-run the LLM fallback for any calls/test-coverage targets the Go
    // resolver couldn't pin — no button (deduped per caller+callKey resp.
    // test+class, so this is cheap on every panel re-fire).
    startCallSearch(b)
    startTestCoverSearch(b)
    // state.drillPreviewChild — the look-ahead preview target for the drilled
    // column's sibling-walk (see the field's own comment + drillPreviewColumns).
    // drillSiblingContext() needs the identical inputs relatedChildren(b) just
    // used above (just applied to the PARENT one level up instead of b
    // itself), so this piggybacks on the same watch rather than a second,
    // separately-triggered one. Identity-guarded: only reassign when the
    // actual next-sibling id changes, so a relatedChildren() recompute that
    // doesn't move the sibling pointer (most of them — an approve-toggle,
    // a callresolve poll landing new but same-order data, …) leaves this
    // field's reference untouched, and the drilled-columns render closure
    // (a cheap reader of this field) doesn't rebuild the real Block() cards.
    const ctx = drillSiblingContext()
    const next = ctx ? ctx.siblings[ctx.idx + 1] || null : null
    const nextId = next ? next.blockId || next.id : null
    const prevId = state.drillPreviewChild ? state.drillPreviewChild.blockId || state.drillPreviewChild.id : null
    if (nextId !== prevId) state.drillPreviewChild = next
  },
)

// ── Footer: focused unit + AI if-statement description ─────────────────────
// The footer shows (1) the inline diff of the focused single-row unit and
// (2) a short Dutch AI description whenever the focused line/group unit
// contains an if-statement (the explain_code workflow). Both follow the
// column that owns the diff keyboard — the top-level block on focusLevel 0
// (state.gran/state.change) or a drilled column's own drillCursor entry — and
// are pushed into plain state.footerUnit/state.footerExplain by the decoupled
// watch below, so Footer.mjs never reads blockRows/b.code itself (the
// co-subscriber pitfall, see conventions.md).

// reIfStatement detects an if/elseif/else-if statement in the raw unit text.
// Deliberately a plain regex on the line text — a parser is overkill for a
// cosmetic hint, so an "if(" inside a string/comment is an accepted false
// positive.
const reIfStatement = /(?:^|[^\w$])(?:else\s+)?(?:if|elseif)\s*\(/

// fnv1a is a tiny 32-bit content hash for the explain request's code+context.
// It only has to be stable between the frontend and the stored read-model row
// (the backend stores whatever hash the frontend sent), not cryptographic.
function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// EXPLAIN_CONTEXT_LINES caps how much surrounding block source travels in the
// explain prompt — enough for Haiku to understand the condition, small enough
// to keep the prompt (and the workflow input in the event history) bounded.
const EXPLAIN_CONTEXT_LINES = 120

// explainContext returns the focused block's new-side source (old side for a
// pure removal), truncated, as prompt context for the LLM.
function explainContext(b) {
  const c = b && b.code
  const text = (c && ((c.new && c.new.text) || (c.old && c.old.text))) || ''
  return text.split('\n').slice(0, EXPLAIN_CONTEXT_LINES).join('\n')
}

// footerUnitInfo computes everything the footer needs about the focused unit:
// the aligned rows spanned by the unit for the inline diff — one row for a
// line/call unit (always single-row), one row per changed line for a
// multi-row group, so the footer can show a per-line breakdown of "what
// changed" for the whole selected block/group, not just a one-liner — and,
// for a line/group unit whose text contains an if-statement, the
// explain-request descriptor (blockId + unitKey in the commentPath codeRef
// shape + code/context + hash). Follows focusedBlock() and the focused
// column's own cursor, so a drilled column previews its own unit.
function footerUnitInfo() {
  if (state.mode !== 'diff') return null
  const b = focusedBlock()
  if (!b) return null
  const level = state.focusLevel
  const cur =
    level > 0
      ? state.drillCursor[level - 1] || { change: 0, gran: 'group' }
      : { change: state.change, gran: state.gran }
  const rows = blockRows(b)
  const unit = unitsFor(rows, cur.gran)[cur.change]
  if (!unit) return null
  // unit.left/right (the char-underline Sets) only exist for a 'call' unit,
  // which is always single-row — so reading them inside this loop naturally
  // stays null for every row of a multi-row group without a separate check.
  const unitRows = []
  for (let i = unit.start; i <= unit.end; i++) {
    const r = rows[i]
    if (!r) continue
    unitRows.push({
      left: r.left,
      right: r.right,
      // Sets don't survive a reactive proxy reliably — carry plain arrays,
      // Footer.mjs rebuilds the Sets it feeds to markChars.
      ulLeft: unit.left ? [...unit.left] : null,
      ulRight: unit.right ? [...unit.right] : null,
    })
  }
  const info = {
    unitRows,
    explain: null,
  }
  // Only line/group units get an AI description ('call' and list mode don't).
  if (cur.gran !== 'group' && cur.gran !== 'line') return info
  let code = ''
  for (let i = unit.start; i <= unit.end; i++) {
    const r = rows[i]
    const t = r && (r.right != null ? r.right : r.left)
    if (t != null) code += (code ? '\n' : '') + t
  }
  if (!reIfStatement.test(code)) return info
  const context = explainContext(b)
  info.explain = {
    blockId: b.id,
    file: b.file,
    label: b.label,
    gran: cur.gran,
    unitKey: cur.gran === 'group' ? `group-${unit.start}-${unit.end}` : `line-${unit.start}`,
    code,
    context,
    codeHash: fnv1a(code + '\n ' + context),
  }
  return info
}

// explainRequested dedups auto-launched explain runs per blockId+unitKey+hash
// (mirrors searchRequested for resolve_call) — on top of the server-side
// idempotent StartWorkflowID, so a re-selection never even re-POSTs.
const explainRequested = new Set()

// EXPLAIN_DEBOUNCE_MS delays the explain request until the cursor rests on the
// unit, so arrowing through a block doesn't fire a request per stop.
const EXPLAIN_DEBOUNCE_MS = 600
let explainTimer = null
let explainPendingKey = ''

// scheduleExplain arms the debounced explain request for the focused unit; a
// cursor move before the timer fires re-arms it for the new unit instead.
function scheduleExplain(req) {
  const key = `${req.blockId}|${req.unitKey}|${req.codeHash}`
  explainPendingKey = key
  if (explainRequested.has(key)) return // already fired — the poll loop finishes it
  clearTimeout(explainTimer)
  explainTimer = setTimeout(() => {
    if (explainPendingKey !== key || explainRequested.has(key)) return
    explainRequested.add(key)
    requestExplain(req)
  }, EXPLAIN_DEBOUNCE_MS)
}

// requestExplain starts the explain_code workflow (the sanctioned write path —
// POST a workflow start; the workflow's Activities do the LLM call and the
// read-model write) and then polls the read-model until the entry lands.
// Best-effort: offline, the row simply never appears and the footer's
// "genereren…" resolves to nothing on the failed row (or stays absent).
async function requestExplain(req) {
  try {
    await fetch('/api/workflows/explain_code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, ...req }),
    })
  } catch (_) {
    /* offline — leave the read-model untouched */
  }
  // The POST usually returns only after the workflow completed (no signals),
  // so the first reload already lands the row; the bounded loop covers an
  // idempotent reuse of a still-running Execution.
  for (let i = 0; i < 20; i++) {
    await loadExplanations()
    const e = state.explanations[`${req.blockId}|${req.unitKey}`]
    if (e && e.status !== 'searching') return
    await new Promise((r) => setTimeout(r, 1500))
  }
}

// updateFooter pushes the focused unit's snapshots into state.footerUnit/
// state.footerExplain and auto-schedules the AI generation for an if-containing
// line/group unit that has no (matching-hash) explanation yet. A stored row
// with an empty codeHash matches any hash (seeded test fixtures). It also
// derives state.footerVisible = !!(footerUnit || footerExplain) — the single
// source of truth Footer.mjs and every bottom-reservation binding read (see
// the "Footer" section in keyboard-navigation.md): the footer bar + its
// reserved space disappear entirely once neither snapshot has anything to
// show (no unit at all — e.g. list mode, or a unit with zero rows), rather
// than staying visible-but-empty for the whole diff-mode session as before.
function updateFooter() {
  computeFooterSnapshots()
  state.footerVisible = !!(state.footerUnit || state.footerExplain)
}

function computeFooterSnapshots() {
  const info = footerUnitInfo()
  // Kept explicitly null (not an empty array) when there's nothing to show —
  // both for the updateFooter() truthiness check above and to dodge the
  // arrow.js single↔array slot pitfall in Footer.mjs (see conventions.md).
  state.footerUnit = info && info.unitRows.length ? info.unitRows : null
  const req = info && info.explain
  if (!req) {
    state.footerExplain = null
    explainPendingKey = ''
    return
  }
  const e = state.explanations[`${req.blockId}|${req.unitKey}`]
  const hashOk = e && (e.codeHash === req.codeHash || e.codeHash === '')
  if (hashOk && e.status === 'done' && e.text) {
    state.footerExplain = { status: 'done', text: e.text }
    return
  }
  if (hashOk && e.status === 'failed') {
    // Terminal: the LLM had nothing (offline/hiccup) — show nothing, and don't
    // re-request (the deterministic Run ID would no-op anyway).
    state.footerExplain = null
    return
  }
  state.footerExplain = { status: 'searching', text: '' }
  if (explanationsLoaded) scheduleExplain(req)
}

// Bridge state → the footer. Same decoupling as setCommentScope/setRelated,
// and the getter follows the same rule: list the navigation state INLINE —
// including state.drillCursor (a drilled column's own gran/change move must
// re-fire this) and the focused block's lazily-loaded code.
watch(
  () => [
    state.selected,
    state.mode,
    state.change,
    state.gran,
    state.blocks,
    state.focusLevel,
    state.drill,
    state.drillCursor,
    state.codeVersion,
    state.explanations,
    focusedBlock() && focusedBlock().code,
  ],
  () => updateFooter(),
)

// Bridge approval + code state → per-block combined-approval summaries the
// sidebar reads (state.approvalSummaries). Decoupled from the render for the
// same reason as setCommentScope/setRelated: the sidebar reads a plain snapshot
// instead of each block's reactive b.code, so it never becomes a co-subscriber
// on the selected block's b.code and re-triggers the diff "stuck on loading"
// race. The getter lists its deps INLINE (the arrow.js watch rule): the block
// lists, the relation/call structure, the code-loaded counter (covers every
// block's code arriving), and every block's approval arrays — so it re-fires on
// any approve or code load. The count itself is computed in the callback.
watch(
  () => {
    const deps = [
      state.blocks,
      state.allBlocks,
      state.relations,
      state.callResolve,
      state.testCovers,
      state.codeVersion,
      state.blockTotals,
    ]
    for (const b of state.allBlocks) {
      deps.push(b.approvedRows)
      deps.push(b.approvedCalls)
    }
    return deps
  },
  () => {
    const map = {}
    let done = 0
    let total = 0
    for (const b of state.blocks) {
      const c = subtreeApproveCount(b)
      map[b.id] = c
      done += c.done
      total += c.total
    }
    state.approvalSummaries = map
    state.approvalTotal = { done, total }
  },
)

// approveContext resolves which block + granularity/unit-index an approve
// action right now targets: mirrors findNextUnapproved's own level-branch
// (and fKey/dKey/sKey's setDrillGran branch) — a focused DRILLED column
// (state.focusLevel > 0) approves against ITS OWN block + its own
// drillCursor unit, not the top-level curBlock()/state.gran/state.change.
// A drilled column is always "in diff" (it has no list mode of its own), so
// `mode` is hardcoded 'diff' in that branch. `anchor` carries an active
// Shift+arrow line-range selection (see rangeUnit) — null when there is none.
function approveContext() {
  const level = state.focusLevel
  if (level > 0) {
    const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
    return { b: state.drill[level - 1], mode: 'diff', gran: cur.gran, change: cur.change, anchor: cur.rangeAnchor }
  }
  return { b: curBlock(), mode: state.mode, gran: state.gran, change: state.change, anchor: state.rangeAnchor }
}

// approveNoun names what an approve action *right now* covers, for the label: the
// whole block in list mode, else the current navigation unit at the active
// granularity (a run of lines / one line / one call) — or, with an active
// Shift+arrow line-range selection, "these N lines". Takes an explicit ctx
// (default approveContext()) so a caller that already resolved one (e.g. the
// COMMANDS label, which also needs it for the done/undone check) doesn't
// re-derive it.
function approveNoun(ctx = approveContext()) {
  if (ctx.mode !== 'diff') return 'dit block'
  if (ctx.gran === 'call') return 'deze call'
  if (ctx.gran === 'line') {
    if (ctx.anchor != null && ctx.anchor !== ctx.change) return `deze ${Math.abs(ctx.change - ctx.anchor) + 1} regels`
    return 'deze regel'
  }
  return 'deze regels'
}

// approveTargetRows returns the changed row indices an approve action covers now:
// the current navigation unit's rows in diff mode (merged with an active
// Shift+arrow line-range selection, see rangeUnit), or the whole block in list
// mode (where there's no active unit). Takes an explicit ctx (default
// approveContext()), same reason as approveNoun.
function approveTargetRows(ctx = approveContext()) {
  const b = ctx.b
  if (!b) return []
  const rows = blockRows(b)
  const all = changedRows(rows)
  if (ctx.mode !== 'diff') return all
  const units = unitsFor(rows, ctx.gran)
  const unit = ctx.gran === 'line' ? rangeUnit(units, ctx.change, ctx.anchor) : units[ctx.change]
  if (!unit) return all
  return all.filter((i) => i >= unit.start && i <= unit.end)
}

// toggleApprove approves (or, if already fully approved, un-approves) exactly the
// rows the current unit covers. Approving every changed row of the block flips its
// derived top-level `approved` on; un-approving any flips it back off. Always
// reassigns b.approvedRows so arrow.js re-renders the checkbox and the pane bars.
// At call granularity a row can hold several call segments, so that case defers
// to toggleCallApprove, which approves just the one segment instead of the whole
// row. Only called from the command palette (COMMANDS' 'approve' item) — the top
// checkbox in Block.mjs calls toggleBlockApproval directly and doesn't run
// afterApproveAction, per the postApprove-menu scope decision below. Resolves
// approveContext() ONCE up front so the whole action (including the call-
// granularity fast path) targets a focused drilled column's own block/unit
// instead of the top-level curBlock()/state.gran/state.change.
function toggleApprove() {
  const ctx = approveContext()
  const b = ctx.b
  if (!b) return
  if (ctx.mode === 'diff' && ctx.gran === 'call') {
    toggleCallApprove(b, ctx.change)
    return
  }
  const target = approveTargetRows(ctx)
  if (!target.length) return
  const set = approvedRowSet(b)
  const allIn = target.every((i) => set.has(i))
  target.forEach((i) => (allIn ? set.delete(i) : set.add(i)))
  b.approvedRows = [...set].sort((x, y) => x - y)
  persistApproval(b)
  // allIn was false → this action just ADDED approval (not revoked it).
  afterApproveAction(!allIn)
}

// toggleCallApprove flips approval of exactly the one call segment the
// keyboard is currently on, tracked at sub-row granularity in b.approvedCalls
// (see callKey). `change` is the call-granularity unit index to act on —
// state.change for the top-level block, or a focused drilled column's own
// drillCursor.change (see approveContext/toggleApprove) — defaulting to
// state.change for any other caller. A row that was fully approved is first
// expanded into its individual segment keys so unapproving one doesn't lose
// the others; conversely, once every segment of a row ends up approved, it
// graduates into b.approvedRows (and its approvedCalls entries are dropped)
// so the coarser group/line approval and the checkbox summary see it too.
// Both arrays are always reassigned, never mutated in place, so arrow.js
// re-renders the checkmark/circle indicators.
function toggleCallApprove(b, change = state.change) {
  const rows = blockRows(b)
  const unit = unitsFor(rows, 'call')[change]
  if (!unit) return
  const row = unit.start
  const segs = rowCallSegments(rows, row)
  const rowSet = approvedRowSet(b)
  const callSet = approvedCallSet(b)
  const wasFullRow = rowSet.has(row)
  const keys = new Set(
    wasFullRow
      ? segs.map((s) => callKey(row, s.start))
      : [...callSet].filter((k) => k.startsWith(row + ':')),
  )
  const key = callKey(row, unit.segStart)
  // Not yet in `keys` → this action is ADDING the segment (approving), not
  // removing it.
  const approving = !keys.has(key)
  if (keys.has(key)) keys.delete(key)
  else keys.add(key)

  const others = [...callSet].filter((k) => !k.startsWith(row + ':'))
  if (keys.size === segs.length) {
    rowSet.add(row)
    b.approvedCalls = others
  } else {
    rowSet.delete(row)
    b.approvedCalls = [...others, ...keys]
  }
  b.approvedRows = [...rowSet].sort((x, y) => x - y)
  persistApproval(b)
  afterApproveAction(approving)
}

// unitFullyApproved reports whether every changed row (or, at gran==='call', the
// one call segment) a navigation unit covers is approved — the same scoping
// approveTargetRows uses, so "next not-approved" agrees with what an approve
// action would actually cover. `all` is the block's changedRows, passed in so
// callers that already have it don't recompute it per unit.
function unitFullyApproved(b, unit, gran, all) {
  if (gran === 'call') return callUnitApproved(b, unit)
  const rowsInUnit = all.filter((i) => i >= unit.start && i <= unit.end)
  if (!rowsInUnit.length) return true
  const set = approvedRowSet(b)
  return rowsInUnit.every((i) => set.has(i))
}

// firstUnapprovedOwnUnit finds the first not-yet-approved unit within b's own
// rows only (no descent into its Onderliggende-code children), searching
// forward from afterIndex + 1 at granularity gran. Pass afterIndex -1 to
// search from the very start (used when a subtree walk visits a block for the
// first time). Returns the unit index, or null if nothing ahead in b itself.
function firstUnapprovedOwnUnit(b, gran, afterIndex) {
  const rows = blockRows(b)
  const all = changedRows(rows)
  const units = unitsFor(rows, gran)
  for (let i = afterIndex + 1; i < units.length; i++) {
    if (!unitFullyApproved(b, units[i], gran, all)) return i
  }
  return null
}

// firstUnapprovedInSubtree depth-first searches b's own changes first
// (always at 'group' granularity — a fresh visit has no finer cursor to
// resume), then — only once b itself reads as fully approved (or has nothing
// to approve) — its Onderliggende-code children, in panel order
// (orderedChildBlocks), recursively. Returns a landing plan relative to b:
// { path, gran, change }, where `path` is the chain of child PR blocks to
// drill through from b down to (and including) the block owning the found
// unit — empty when it's b itself. null once b's whole subtree (itself +
// every nested child) is fully approved / has nothing to approve. `seen`
// cycle-guards by id, mirroring nestedPrBlocks (a diamond-shaped relation
// graph must not infinite-loop this walk). Awaits ensureCode per visited
// block, same as the existing look-ahead-preview fetches.
async function firstUnapprovedInSubtree(b, seen = new Set()) {
  if (!b || seen.has(b.id)) return null
  seen.add(b.id)
  await ensureCode(b)
  const change = firstUnapprovedOwnUnit(b, 'group', -1)
  if (change !== null) return { path: [], gran: 'group', change }
  for (const kid of orderedChildBlocks(b)) {
    const found = await firstUnapprovedInSubtree(kid, seen)
    if (found) return { path: [kid, ...found.path], gran: found.gran, change: found.change }
  }
  return null
}

// findNextUnapproved locates the next navigation unit that isn't (fully)
// approved yet, walking the review TREE depth-first rather than just the flat
// sidebar list:
//  1. Forward within whichever column currently owns the keyboard (the
//     top-level block, or — via state.focusLevel/drillCursor — a drilled
//     column), at its own current granularity/position.
//  2. Failing that, DOWN into that column's own Onderliggende-code children
//     (orderedChildBlocks, panel order), depth-first (firstUnapprovedInSubtree).
//  3. Failing that (the focused column's whole subtree is exhausted), UP
//     through the current drill stack's ancestors, trying each one's next
//     not-yet-tried sibling child.
//  4. Failing that (the entire current top-level block's subtree is done, or
//     we weren't even in its diff), ACROSS the rest of state.blocks in
//     sidebar order — subtree-aware too (firstUnapprovedInSubtree), so a
//     top-level block whose own rows are done but whose Onderliggende-code
//     still has an open child no longer gets skipped.
// Returns a landing plan { root, path, gran, change } — root is the top-level
// index to select, path the chain of PR-block children to drill through from
// there down to (and including) the block owning the found unit (empty = the
// top-level block itself) — or null once nothing not-yet-approved remains
// ahead anywhere in the tree. Async because a not-yet-visited block's code
// may still need fetching.
async function findNextUnapproved() {
  const level = state.focusLevel
  const focused = level > 0 ? state.drill[level - 1] : curBlock()
  const cur = level > 0 ? state.drillCursor[level - 1] || { change: 0, gran: 'group' } : { gran: state.gran, change: state.change }
  const inDiff = level > 0 || state.mode === 'diff'

  if (focused && inDiff) {
    const change = firstUnapprovedOwnUnit(focused, cur.gran, cur.change)
    if (change !== null) {
      return { root: state.selected, path: state.drill.slice(0, level), gran: cur.gran, change }
    }
    for (const kid of orderedChildBlocks(focused)) {
      const found = await firstUnapprovedInSubtree(kid)
      if (found) {
        return {
          root: state.selected,
          path: [...state.drill.slice(0, level), kid, ...found.path],
          gran: found.gran,
          change: found.change,
        }
      }
    }
    for (let lvl = level; lvl > 0; lvl--) {
      const parent = lvl > 1 ? state.drill[lvl - 2] : curBlock()
      const current = state.drill[lvl - 1]
      const siblings = orderedChildBlocks(parent)
      const idx = siblings.findIndex((s) => s.id === current.id)
      for (let j = idx + 1; j < siblings.length; j++) {
        const found = await firstUnapprovedInSubtree(siblings[j])
        if (found) {
          return {
            root: state.selected,
            path: [...state.drill.slice(0, lvl - 1), siblings[j], ...found.path],
            gran: found.gran,
            change: found.change,
          }
        }
      }
    }
  }

  for (let idx = state.selected + 1; idx < state.blocks.length; idx++) {
    const found = await firstUnapprovedInSubtree(state.blocks[idx])
    if (found) return { root: idx, path: found.path, gran: found.gran, change: found.change }
  }
  return null
}

// applyNextUnapproved jumps the keyboard cursor to a plan findNextUnapproved
// found — driven by the postApprove menu's "Ga door" command. `target.root`
// is the top-level block index to select; `target.path` is the chain of
// Onderliggende-code PR-block children to drill through from there (empty =
// land directly on the top-level block's own diff). The current state.drill
// is reconciled against `target.path` by trimming to their common prefix
// (mirrors expandColumn's trim) and then drilling only the remainder via
// drillIntoChild, rather than always tearing the whole stack down — so
// continuing within (or backtracking one sibling up from) an already-drilled
// subtree doesn't lose context needlessly. `target.keepList` (stashed by
// afterApproveAction) means the approve that triggered this ran from the
// blokken-index (state.mode was 'list', not 'diff'): stay there — only move
// the sidebar selection forward, ignoring `path` entirely — never step into
// the diff/drill, so approving from the index keeps you in the index instead
// of dropping you into a block's diff or a drilled child.
function applyNextUnapproved(target) {
  if (target.keepList) {
    state.selected = target.root
    scrollSelectedIntoView()
    return
  }
  const sameRoot = target.root === state.selected
  if (!sameRoot) {
    state.selected = target.root
    state.drill = []
    state.drillCursor = []
    state.focusLevel = 0
  }
  let common = 0
  while (
    common < state.drill.length &&
    common < target.path.length &&
    state.drill[common].id === target.path[common].id
  ) {
    common++
  }
  state.drill = state.drill.slice(0, common)
  state.drillCursor = state.drillCursor.slice(0, common)
  state.focusLevel = common
  // Landing directly back on an already-open ancestor — nothing left to
  // drill further — is a genuine "return" transition (mirrors ← and
  // expandColumn above): mark it for the short entrance-from-the-left
  // animation. Only when staying on the same root: jumping to a brand-new
  // top-level block isn't "returning" to anything, it's a fresh selection.
  if (sameRoot && common === target.path.length) markDrillReturn(common)
  for (let i = common; i < target.path.length; i++) {
    const kid = target.path[i]
    drillIntoChild({ blockId: kid.id, id: kid.id, label: kid.label, file: kid.file, code: '', line: kid.line })
  }
  state.mode = 'diff'
  if (target.path.length > 0) {
    const lvl = target.path.length
    state.drillCursor = state.drillCursor.map((c, i) =>
      i === lvl - 1 ? { gran: target.gran, change: target.change } : c,
    )
  } else {
    state.gran = target.gran
    state.change = target.change
    // A fresh landing plan supersedes any active Shift+arrow line-range
    // selection, same as every other plain-navigation path (clearRangeAnchor).
    state.rangeAnchor = null
    // No drilling happened (empty path) — this lands squarely on the rest
    // position (top-level block, no drilled column), so snap <main> back to
    // flush-left rather than leaving it wherever a prior drilled column (or a
    // stray manual scroll) left it.
    resetMainScroll()
  }
  scrollChangeIntoView()
}

// postApproveTarget stashes the landing plan findNextUnapproved found right
// after an approving action, for the postApprove menu's "Ga door" command to
// jump to without recomputing — safe because the palette owns the keyboard
// while it's open, so the navigation state can't have moved in the meantime.
let postApproveTarget = null

// afterApproveAction runs once a palette approve command has just ADDED
// approval (`approving`, see toggleApprove/toggleCallApprove — un-approving
// never reaches here). If there's a next not-yet-approved unit ahead, stash it
// and open the postApprove follow-up menu (continue / close). If NOTHING is
// left ahead — findNextUnapproved searches forward-only from the current
// position, see its own doc comment — that either means the whole PR is done
// (state.approvalTotal, the PR-wide combined-approval count over every
// top-level block plus its nested/drilled children, is fully done) or that
// something else remains open elsewhere (behind the current position, or a
// spot the forward walk never reached) — the reviewer just approved the last
// unit reachable from here, but "alles" isn't done yet. Either way, offer to
// submit a real GitHub PR-level review (see submitReview/REVIEW_APPROVE_
// COMMANDS/REVIEW_CHOICE_COMMANDS): fully done → just "Keur de PR goed"; not
// yet fully done → the extra choice "Wijs de PR af" (which itself needs a
// non-empty reason, see the 'reviewReject' menu mode).
// `keepList` is captured synchronously, right here — before the async
// findNextUnapproved gap — so it reflects the mode the reviewer was actually
// in when they ran the approve action, not whatever state.mode happens to be
// once the promise resolves.
// EXCEPTION — next unit stays in the SAME block, no menu: when the plan's
// `path` is empty and its `root` is still the current top-level block, this is
// exactly findNextUnapproved's step-1 branch ("forward within whichever
// column currently owns the keyboard") — no drill, no block change, just the
// next unapproved line/call/group in the block the reviewer is already
// looking at. Asking "ga door of niet" there is pure friction, so this jumps
// straight there via applyNextUnapproved instead of opening the postApprove
// menu. Any other outcome (down into a child's subtree, up to a sibling, or
// across to a different top-level block) still opens the menu, unchanged.
// `!keepList` guards this from ever firing off a list-mode block-approve
// (approving a whole block from the index leaves nothing else inside it to
// jump to in that same block anyway, but this keeps the two paths cleanly
// separated).
function afterApproveAction(approving) {
  if (!approving) return
  const keepList = state.mode !== 'diff'
  findNextUnapproved().then(async (target) => {
    if (!target) {
      // b.approvedRows/approvedCalls were just reassigned synchronously above
      // (toggleApprove/toggleCallApprove), but state.approvalTotal is filled
      // by a DECOUPLED watch (see its comment near state.approvalSummaries)
      // whose callback runs as a microtask, not synchronously — give it a
      // couple of turns to flush before reading it, same as loadBlocks'
      // identical wait for the same watch.
      await Promise.resolve()
      await Promise.resolve()
      const allDone = state.approvalTotal.total > 0 && state.approvalTotal.done === state.approvalTotal.total
      openMenu(allDone ? 'reviewApprove' : 'reviewChoice')
      return
    }
    const sameBlock = !keepList && target.path.length === 0 && target.root === state.selected
    if (sameBlock) {
      applyNextUnapproved(target)
      return
    }
    postApproveTarget = { ...target, keepList }
    openMenu('postApprove')
  })
}

// "Sluit menu" is pinned first (withClose); the menu opens on the 2nd item
// (defaultSel), so "Keur ... goed" stays the default Enter action.
const COMMANDS = withClose([
  {
    id: 'approve',
    label: () => {
      const ctx = approveContext()
      const b = ctx.b
      const noun = approveNoun(ctx)
      let done
      if (b && ctx.mode === 'diff' && ctx.gran === 'call') {
        const unit = unitsFor(blockRows(b), 'call')[ctx.change]
        done = callUnitApproved(b, unit)
      } else {
        const set = b ? approvedRowSet(b) : new Set()
        const target = approveTargetRows(ctx)
        done = target.length > 0 && target.every((i) => set.has(i))
      }
      return done ? `Trek goedkeuring van ${noun} in` : `Keur ${noun} goed`
    },
    hint: 'approve',
    run: () => toggleApprove(),
  },
  {
    id: 'comment',
    label: 'Comment op deze regel',
    hint: 'task',
    run: () => startComment(),
  },
  {
    id: 'github',
    label: 'Open GitHub',
    hint: 'github',
    // A parent command: choosing it opens a submenu of the two targets rather
    // than acting directly (see runCommand). "Sluit menu" is pinned first
    // there too (withClose), same as every other submenu.
    children: withClose([
      {
        id: 'github-line',
        label: 'Regel in Files changed',
        hint: 'github',
        run: () => openGithubLine(),
      },
      {
        id: 'github-pr',
        label: 'PR-pagina',
        hint: 'github',
        run: () => window.open(state.prUrl || GITHUB_PR, '_blank'),
      },
    ]),
  },
])

// PR_COMMANDS — the general, PR-wide tree menu opened with `/` (menu mode 'pr').
// Unlike COMMANDS (which acts on the selected block/diff), these are actions on
// the whole PR: jump to the overview, and GitHub/Jira with their own submenus.
// The Jira comment + subtask items are placeholders for now (no Jira write
// integration yet). GitHub "comment plaatsen" reuses the line-comment composer
// (startComment), same as the block menu. See the `/` handler in onKeydown.
// "Sluit menu" is pinned first (withClose); the menu opens on the 2nd item
// (defaultSel), so "Naar PR-overzicht" stays the default Enter action.
const PR_COMMANDS = withClose([
  {
    id: 'pr-overview',
    label: 'Naar PR-overzicht',
    hint: 'overzicht',
    // `?pr=`/`?sel=` let /pr-overview auto-select this PR — and hand back the
    // same block reference when we return (see overviewExitUrl above) — same
    // destination + params as the ← nav-chain exit below.
    run: () => window.location.assign(overviewExitUrl()),
  },
  {
    id: 'pr-github',
    label: 'GitHub',
    hint: 'github',
    children: withClose([
      {
        id: 'pr-github-open',
        label: 'Open op GitHub',
        hint: 'github',
        run: () => window.open(state.prUrl || GITHUB_PR, '_blank'),
      },
      {
        id: 'pr-github-comment',
        label: 'Comment plaatsen',
        hint: 'comment',
        run: () => startComment(),
      },
    ]),
  },
  {
    id: 'pr-jira',
    label: 'Jira',
    hint: 'jira',
    children: withClose([
      {
        id: 'pr-jira-open',
        // Label names the ticket once we know it (title carried a KEY-123).
        label: () => (state.jiraKey ? `Openen in nieuw tab (${state.jiraKey})` : 'Openen in nieuw tab'),
        hint: 'jira',
        run: () => window.open(state.jiraKey ? JIRA_BASE + state.jiraKey : JIRA_BASE, '_blank'),
      },
      {
        id: 'pr-jira-comment',
        label: 'Comment plaatsen',
        hint: 'todo',
        // Placeholder — no Jira write integration yet (see CLAUDE.md).
        run: () => {},
      },
      {
        id: 'pr-jira-subtask',
        label: 'Subtask maken',
        hint: 'todo',
        // Placeholder — no Jira subtask creation yet.
        run: () => {},
      },
    ]),
  },
  {
    id: 'pr-check-warnings',
    label: "Controleer de hele PR op risico's",
    hint: 'risicocontrole',
    // Starts an agentic Sonnet review of the whole PR (code_warning); see
    // checkPRWarnings above. Re-running supersedes the previous run's
    // findings, so this is a plain, repeatable "refresh the risk check".
    run: () => checkPRWarnings(),
  },
  {
    id: 'pr-toggle-description',
    // Label is a function so it names the current action; snapshotCommands reads
    // it once (non-reactively) at open, so it never leaks a reactive binding into
    // the CommandMenu tree (see the label-function note in conventions.md).
    label: () => (state.descriptionExpanded ? 'Omschrijving inklappen' : 'Toon volledige omschrijving'),
    hint: 'omschrijving',
    run: () => {
      state.descriptionExpanded = !state.descriptionExpanded
    },
  },
])

// githubFileLine describes the exact file line the active change sits on, so we
// can deep-link into GitHub's Files-changed diff. It prefers the new (head) side
// (`R`), except for a removed block, which only exists on the old side (`L`). The
// line is the code side's `start` (from /api/code) plus the number of rows present
// on that side up to the active unit's first row. Falls back to the block's start
// line when the code (and thus the side's `start`) hasn't loaded yet.
function githubFileLine() {
  const b = curBlock()
  if (!b) return null
  const useOld = b.status === 'removed'
  const sideKey = useOld ? 'left' : 'right'
  const gutter = useOld ? 'L' : 'R'
  const c = b.code
  const cs = c && c[useOld ? 'old' : 'new']
  if (!cs || !cs.start) return { file: b.file, line: b.line, side: gutter }
  const rows = blockRows(b)
  const gran = state.mode === 'diff' ? state.gran : 'group'
  const idx = state.mode === 'diff' ? state.change : 0
  const unit = unitsFor(rows, gran)[idx]
  const startRow = unit ? unit.start : 0
  let seen = 0
  for (let i = 0; i <= startRow && i < rows.length; i++) {
    if (rows[i][sideKey] != null) seen++
  }
  return { file: b.file, line: cs.start + Math.max(seen - 1, 0), side: gutter }
}

// openGithubLine opens the PR's Files-changed tab anchored on the active line.
// GitHub anchors a file diff by `diff-<sha256(path)>` and a line by `R<n>`/`L<n>`;
// the SHA-256 is async (crypto.subtle), so we open the tab up front (about:blank)
// and set its location once the digest is ready — this keeps the popup tied to the
// user gesture instead of being blocked as a late async open.
async function openGithubLine() {
  const w = window.open('about:blank', '_blank')
  const repo = 'plug-and-pay/plug-and-pay'
  const t = githubFileLine()
  let anchor = ''
  if (t && window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.file))
    const hex = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('')
    anchor = `#diff-${hex}${t.side}${t.line}`
  }
  const url = `https://github.com/${repo}/pull/${state.pr}/files${anchor}`
  if (w) w.location = url
  else window.open(url, '_blank')
}

// rootCommandsFor returns the *raw* (function-labelled) command list for a
// palette mode — the input to snapshotCommands. Only ever called from openMenu
// (plain, non-reactive code), never from resolveCommands itself: resolveCommands
// filters the already-snapshotted `ms.commands`/`ms.sub`, never these raw lists,
// so a live label function never reaches CommandMenu's reactive tree — see the
// menu/ms comment above.
function rootCommandsFor(mode) {
  if (mode === 'comment') return COMMENT_COMMANDS
  if (mode === 'postApprove') return POSTAPPROVE_COMMANDS
  if (mode === 'reviewApprove') return REVIEW_APPROVE_COMMANDS
  if (mode === 'reviewChoice') return REVIEW_CHOICE_COMMANDS
  // reviewReject has no static list — resolveCommands builds its one command
  // straight from the typed reason (see there); nothing to snapshot up front.
  if (mode === 'reviewReject') return []
  if (mode === 'pr') return PR_COMMANDS
  if (mode === 'compose') return COMPOSE_COMMANDS
  return COMMANDS
}

// resolveCommands returns the commands to show for `query`: the fuzzy-matched
// `ms.commands` (a plain-string-label snapshot of the current mode's root list,
// built by openMenu/rootCommandsFor+snapshotCommands), or — when nothing
// matches a non-empty query in the default 'block' mode — a single fallback
// that opens the composer with the typed text pre-filled, so the reviewer can
// continue typing ("Maak hiermee een comment"). Shared by the menu render and
// the keyboard handler so both walk the same list.
function resolveCommands(query) {
  // The comment-scoped menu (Enter on a focused comment row) is just its own
  // small list — no submenu, no make-a-comment fallback.
  if (ms.mode === 'comment') return filterCommands(ms.commands, query)
  // The postApprove follow-up (opened right after an approve action finds a
  // next not-yet-approved unit ahead): just its two choices, no submenu, no
  // make-a-comment fallback.
  if (ms.mode === 'postApprove') return filterCommands(ms.commands, query)
  // The two review-submit follow-ups (opened right after an approve action
  // finds NOTHING left ahead — see afterApproveAction): same shape as
  // postApprove, a plain list, no submenu, no make-a-comment fallback.
  if (ms.mode === 'reviewApprove') return filterCommands(ms.commands, query)
  if (ms.mode === 'reviewChoice') return filterCommands(ms.commands, query)
  // reviewReject — the free-text rejection-reason step opened by "Wijs de PR
  // af" above. GitHub (and the backend) reject an empty REQUEST_CHANGES body,
  // so this mode has no static command list: build ONE command straight from
  // the typed query, and only once it's non-blank. An empty query resolves to
  // an empty list, which — via onKeydown's `if (list[ms.sel]) runCommand(...)`
  // guard — makes Enter a no-op instead of silently closing the menu with
  // nothing submitted; CommandMenu's own "Geen commando's." empty state plus
  // this mode's placeholder (see CommandMenu.mjs) double as the "type a
  // reason" hint.
  if (ms.mode === 'reviewReject') {
    const reason = (query || '').trim()
    if (!reason) return []
    return [
      {
        id: 'review-reject-submit',
        label: 'Wijs de PR af met deze reden',
        hint: 'verstuur',
        run: () => submitReview('REQUEST_CHANGES', reason),
      },
    ]
  }
  // In a submenu we only show (and filter) that parent's already-snapshotted
  // children — no make-a-comment fallback, since the submenu is a plain
  // choice list.
  if (ms.sub) return filterCommands(ms.sub, query)
  // The PR-wide tree menu (opened with `/`) is a plain command list too — no
  // block actions, no comment fallback.
  if (ms.mode === 'pr') return filterCommands(ms.commands, query)
  // The comment-kind menu (Enter/button on a filled composer): choose Claude /
  // Git / private / Jira. The ms.sub check above already handles its Jira
  // submenu, so we only reach here at the root list.
  if (ms.mode === 'compose') return filterCommands(ms.commands, query)
  const list = filterCommands(ms.commands, query)
  const q = (query || '').trim()
  if (list.length === 0 && q) {
    return [
      {
        id: 'make-comment',
        label: 'Maak hiermee een comment',
        hint: 'comment',
        run: () => {
          startComment()
          requestAnimationFrame(() => {
            const el = document.querySelector('[data-testid=comment-compose]')
            if (el) {
              el.value = q
              el.focus()
            }
          })
        },
      },
    ]
  }
  return list
}

// repositionMenu keeps the open palette anchored under the selection as the page
// resizes or scrolls beneath it. A no-op while the menu is closed.
function repositionMenu() {
  if (menu.open) positionMenu()
}
window.addEventListener('resize', repositionMenu)
window.addEventListener('scroll', repositionMenu, true) // capture: catch inner scrollers too

// openMenu opens the palette, then a frame later (once it's rendered and its size
// is known) focuses the input and positions it just beneath the current selection.
// `mode` picks the command list (see resolveCommands): 'block' (default),
// 'comment', 'pr', 'compose', 'postApprove', 'reviewApprove', 'reviewChoice' or
// 'reviewReject'. It installs a FRESH `ms` reactive so the previous
// open's (undisposed) CommandMenu bindings can't fire when this menu mutates its
// state — see the note on the menu/ms split. `commands` is filled here, in this
// plain (non-reactive) function, by resolving rootCommandsFor(mode) through
// snapshotCommands — see those for why that must happen from ordinary code and
// never from inside CommandMenu's own render/filter path.
function openMenu(mode = 'block') {
  // Reset the cached index-row anchor on every fresh open except a follow-up
  // menu itself (isReviewFollowup — postApprove, or one of the review-submit
  // modes, see lastIndexRowRect) — this keeps the cache from ever leaking a
  // stale position into an unrelated later session; a 'block'/'pr'/etc. open
  // re-populates it immediately via positionMenu() below as long as its own
  // anchor row is visible.
  if (!isReviewFollowup(mode)) lastIndexRowRect = null
  const commands = snapshotCommands(rootCommandsFor(mode))
  // defaultSel starts the selection on the 2nd item — the pinned "Sluit
  // menu" (withClose) is never itself the default Enter action — falling
  // back to 0 for a mode with 0-1 real items (reviewReject's dynamic list,
  // which never gets a close item, see withClose's doc comment).
  ms = reactive({ query: '', sel: defaultSel(commands), sub: null, mode, commands })
  menu.open = true
  requestAnimationFrame(() => {
    // Position first — the palette starts visibility:hidden, and a hidden element
    // can't take focus, so make it visible before focusing the input.
    positionMenu()
    const el = document.querySelector('[data-testid="command-input"]')
    if (el) el.focus()
  })
  // Stepping into the diff animates the panel width (200ms). If `/` is pressed
  // mid-transition the region is measured too narrow, so re-place once it settles.
  setTimeout(() => menu.open && positionMenu(), 220)
}

function closeMenu() {
  // Only flip `open`; the volatile state is replaced wholesale on the next
  // openMenu, and leaving this (now orphaned) `ms` untouched is exactly what keeps
  // the torn-down menu's bindings from firing against freed slots.
  menu.open = false
}

// enterSubmenu swaps the visible list to a parent command's children without
// closing the palette, resetting the query/selection and repositioning (the list
// height changes). Esc later backs out via the keyboard handler.
function enterSubmenu(children) {
  ms.sub = children
  ms.query = ''
  // Same "open on the 2nd item" convention as openMenu — every submenu gets
  // its own pinned "Sluit menu" first (withClose), so start past it.
  ms.sel = defaultSel(children)
  requestAnimationFrame(() => {
    positionMenu()
    const el = document.querySelector('[data-testid="command-input"]')
    if (el) el.focus()
  })
}

// runCommand closes the menu first, then runs the command — so an action that
// itself moves focus/selection isn't fighting the just-closed overlay. The run
// is deferred a frame: closing the menu unmounts its (keyed) row list in the
// same reactive flush, and running the command's state changes in that same
// flush can get dropped if that teardown throws before later-queued effects
// run (e.g. the composer's cs.composing flip never reaching the DOM). Waiting
// a frame lets the close finish and flush on its own first.
function runCommand(cmd) {
  // A parent command opens its submenu instead of acting; keep the palette open.
  if (cmd && cmd.children) {
    enterSubmenu(cmd.children)
    return
  }
  closeMenu()
  if (cmd && cmd.run) requestAnimationFrame(() => cmd.run())
}

function onKeydown(e) {
  // While the command palette is open it owns the keyboard: ↑/↓ move the
  // selection, Enter runs it, Esc closes, and any typed characters flow into the
  // focused input (we don't preventDefault those). Block navigation is suspended.
  // Shift+Enter is left alone so the textarea inserts a newline instead of running.
  if (menu.open) {
    const list = resolveCommands(ms.query)
    if (e.key === 'Escape') {
      e.preventDefault()
      // Esc first backs out of a submenu to the root, then closes the palette.
      if (ms.sub) {
        ms.sub = null
        ms.query = ''
        ms.sel = defaultSel(ms.commands)
      } else {
        closeMenu()
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      ms.sel = Math.min(ms.sel + 1, Math.max(0, list.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      ms.sel = Math.max(ms.sel - 1, 0)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (list[ms.sel]) runCommand(list[ms.sel])
    }
    // Typing filters the list, which changes the palette's height — reposition a
    // frame later (once re-rendered) so it stays snug under the selection, even
    // when flipped above it.
    if (menu.open) requestAnimationFrame(positionMenu)
    return
  }

  // While the search box holds the keyboard it owns typing: letters flow into it
  // (we don't preventDefault them), ↑/↓ still walk the filtered selection but
  // leave focus in the box so the reviewer can keep typing, and → / Enter step
  // into the selected block's diff while Escape drops back to the list. ← used
  // to be swallowed here ("already the leftmost stop") — now it steps one stop
  // further left, into the PR-description column (stop 1 of the nav chain, see
  // keyboard-navigation.md), dropping DOM focus from the box on the way out.
  if (state.searchActive) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      exitSearch()
      state.toggleFocused = false
      state.showDescription = true
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      stepListSelection(1)
      scrollSelectedIntoView()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      stepListSelection(-1)
      scrollSelectedIntoView()
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault()
      if (state.toggleFocused) {
        state.showApproved = !state.showApproved
        return
      }
      exitSearch()
      enterDiff()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      exitSearch()
    }
    return
  }

  // Stop 1's own PR-wide comment block (PrWideComments/handlePrWideKey, see
  // RelatedPanel.mjs) owns arrows/Enter/Escape once the reviewer has stepped
  // into it (↓ from the description) — handled early, mirroring relatedActive()
  // below, so none of the generic Enter-opens-menu/`/`/f-d-s shortcuts steal
  // the keystroke while a PR-wide comment/thread has the keyboard. Typed
  // characters flow into the reply textarea untouched (not preventDefault'd);
  // only the navigation keys below are claimed here.
  if (state.showDescription && isPrWideFocused()) {
    if (
      (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'Escape'].includes(e.key) &&
        // ArrowLeft with the caret mid-text in the reply textarea
        // (pw.focus==='thread') must move/word-jump the caret, not pop the
        // thread focus back — only hijack it when the caret has nowhere left
        // to go (empty/at the start), matching editableCaretCanMoveLeft's own
        // "nothing to move into" carve-out.
        !(e.key === 'ArrowLeft' && editableCaretCanMoveLeft())) ||
      (e.key === 'Enter' && !e.shiftKey)
    ) {
      e.preventDefault()
      handlePrWideKey(e.key)
    }
    return
  }

  // Enter on a filled new-comment composer opens the comment-kind menu (Claude /
  // Git / private / Jira) instead of placing directly. Handled before the
  // relatedActive() branch so it works whether the composer was opened via the
  // keyboard (cs.focus==='new') or the button (focus null). Shift+Enter is left
  // alone (newline for a multi-line comment); an empty composer does nothing.
  if (e.key === 'Enter' && !e.shiftKey && isComposeOpen()) {
    e.preventDefault()
    if (composeHasText()) openMenu('compose')
    return
  }

  // Cmd+ArrowRight toggles the comments/taken sidebar (CommentsSidebar, see
  // detail-layout.md) — globally, in both list and diff mode, and regardless
  // of whether the diff, the inline Onderliggende-code card, or the sidebar
  // itself currently owns the keyboard (toggleSidebar branches on that).
  // Handled before the relatedActive() branch below (which would otherwise eat
  // any key that isn't an arrow/Enter while the sidebar owns the keyboard) so
  // it also closes the sidebar from inside it, and before the plain ArrowRight
  // handling further down so a bare → is untouched (metaKey distinguishes the
  // two). Same isEditableFocused guard as `a`: typing in the composer/reply
  // field must not toggle it, and preventDefault suppresses the browser/OS
  // default (history-forward / cursor-to-end) for Cmd+→.
  if (e.metaKey && e.key === 'ArrowRight' && !isEditableFocused()) {
    e.preventDefault()
    toggleSidebar()
    return
  }

  // Once the reviewer has stepped into either the inline Onderliggende-code
  // card (→ from the diff, cs.focus === 'code') or the comments/taken sidebar
  // (`g`, cs.focus one of 'new'/'comment'/'thread'/'task') it owns the arrows:
  // ↑/↓/←/→ walk it (see handleRelatedKey in RelatedPanel). Handled before
  // Enter/f/d/s so those stay suspended while it's active — but typed
  // characters (letters, Enter) are left alone so they flow into the focused
  // reply field, like the menu.
  if (relatedActive()) {
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key) &&
      // ArrowLeft with the caret mid-text in the composer/reply textarea
      // (cs.focus one of 'new'/'comment'/'thread') must move/word-jump the
      // caret, not exit the sidebar — only hijack it when the caret has
      // nowhere left to go (empty/at the start, e.g. a freshly opened composer
      // — that keeps its long-standing "step back out" meaning). Mirrors the
      // isPrWideFocused() guard above.
      !(e.key === 'ArrowLeft' && editableCaretCanMoveLeft())
    ) {
      e.preventDefault()
      // taskRuns(state).length clamps cs.taskSel while the Taken stop owns
      // the keyboard — see handleRelatedKey/taskRuns in RelatedPanel.mjs.
      handleRelatedKey(e.key, taskRuns(state).length)
      // Exiting the panel (← / Escape from the code card's first block) just
      // hands the keyboard back to the diff of whichever column is currently
      // focused (handleRelatedKey's exitRelated already did that) — it does
      // NOT close the drilled column. Stepping further left through the
      // drilled columns (or back to the list) is the diff-mode ArrowLeft
      // handling below (state.focusLevel), reached once relatedActive() is
      // false again.
      // If that exit just happened, re-align <main> on the now-focused diff
      // column (same call the drill-pop ArrowLeft branch makes below): the
      // panel navigation scrolls <main> horizontally via scrollIntoView, and
      // without this the diff card would stay clipped off-screen to the left.
      if (!relatedActive()) scrollFocusIntoView()
      return
    }
    // Enter on the highlighted "+ Comment op deze regel" row opens the
    // composer (a fresh `g`-open only highlights the row — see enterComments
    // in RelatedPanel.mjs — so a 2nd `g` can toggle the sidebar shut right
    // away instead of typing a literal "g" into an already-focused textarea).
    // Already-open composer is left alone (isComposeOpen guards against
    // re-triggering while typing).
    if (e.key === 'Enter' && isNewFocused() && !isComposeOpen()) {
      e.preventDefault()
      openComposer()
      return
    }
    // Enter on a focused comment row (reply field empty — see commentReplyEmpty)
    // opens the comment-scoped menu (delete, for now) instead of falling through
    // to the reply field. A non-empty reply field is left alone so "type a quick
    // reply, hit Enter" (the reply input's own keydown handler) still works.
    if (e.key === 'Enter' && isCommentFocused() && commentReplyEmpty()) {
      e.preventDefault()
      openMenu('comment')
    }
    // Enter on the Onderliggende-code block drills into the resolved child the
    // cursor is sitting on as its own diff column (see drillIntoChild) — recursing
    // into its Onderliggende code. Unresolved calls no longer need a manual Enter:
    // the LLM search runs automatically (see the setRelated watch / startCallSearch).
    // If the cursor instead sits on a drill-hint chip (cs.chipPath, → descended
    // into it — see RelatedPanel's handleRelatedKey), Enter drills through the
    // WHOLE chain (the card, then every intermediate chip, then the focused
    // chip) in one go — exactly what a click on that chip already does (see
    // nestedChip's own @click), just via the keyboard.
    if (e.key === 'Enter' && isCodeFocused()) {
      e.preventDefault()
      const chain = focusedChipChain()
      if (chain) {
        for (const target of chain) drillIntoChild(target)
      } else {
        const child = focusedRelatedChild()
        if (child) drillIntoChild(child)
      }
    }
    // Enter on the Taken stop (comments/taken sidebar) opens the focused run the
    // same way clicking it does (openTask) — only meaningful for a
    // task_code_comment run with a resolved comment; a purely informational run
    // is a silent no-op there too.
    if (e.key === 'Enter' && isTaskFocused()) {
      e.preventDefault()
      const run = focusedTaskRun(taskRuns(state))
      if (run) openTask(run)
    }
    return
  }

  // Fallback safety net: DOM focus still sits in a real editable field here, but
  // none of the branches above claimed the key (menu/search/compose-Enter/`g`/
  // relatedActive) — e.g. an editable field whose own app-state focus flag
  // (cs.focus/state.searchActive) isn't wired up to match real DOM focus (see
  // the isEditableFocused() note in conventions.md). Don't let any of the
  // remaining global shortcuts (`/`, f/d/s, `a`, arrows, the block-palette Enter)
  // steal the keystroke — let it flow into the field instead. Escape is the
  // explicit "get me out" gesture (mirrors handleRelatedKey's Escape handling
  // above); Tab keeps its native browser behavior (moves DOM focus elsewhere,
  // so the next keydown no longer matches this branch).
  if (isEditableFocused()) {
    if (e.key === 'Escape') {
      e.preventDefault()
      leaveRelated()
    }
    return
  }

  // `/` opens the general PR-wide tree menu (overview / GitHub / Jira). Like
  // Enter it's handled before the empty-blocks guard so it works while loading.
  // A focused input (the comment composer/reply) is already handled by the
  // relatedActive() branch, or by the isEditableFocused() fallback just above,
  // so a typed `/` there never reaches here.
  if (e.key === '/') {
    e.preventDefault()
    openMenu('pr')
    return
  }

  // The toggle-approved row (see stepListSelection) is the extra, final ↓ stop
  // at the bottom of the sidebar — it's not a block, so there's no command
  // palette to open there. Enter just flips state.showApproved, mirroring a
  // click on the button; handled first so it wins over the generic
  // Enter-opens-menu branch right below.
  if (e.key === 'Enter' && state.toggleFocused) {
    e.preventDefault()
    state.showApproved = !state.showApproved
    return
  }

  // Enter opens the palette at the next-block slot. Handled before the empty-blocks
  // guard so it works even while a PR is still loading. On stop 1 (the
  // PR-description column, state.showDescription) there's no block context, so
  // it opens the same PR-wide menu as `/` instead of the block-scoped palette —
  // block 0 in the list is a different stop (showDescription is false there)
  // and keeps the normal block palette.
  if (e.key === 'Enter') {
    e.preventDefault()
    openMenu(state.showDescription ? 'pr' : 'block')
    return
  }

  if (state.blocks.length === 0) return

  // Same trailing-row special case as Enter above: none of these diff-only
  // shortcuts (zoom, view-toggle, step into the diff) mean anything while the
  // toggle-approved row owns the keyboard — state.selected still points at
  // whatever block it did before ↓ walked onto the button, and letting them
  // silently act on it would read as broken ("I'm on the toggle button but
  // ArrowRight opened a diff").
  if (state.toggleFocused && ['f', 'd', 's', 'a', 'ArrowRight'].includes(e.key)) {
    e.preventDefault()
    return
  }

  // f / d / s drive the zoom-based selection: f zooms in (and steps to the next
  // call on the finest level), d goes back, s zooms out. f from the list steps
  // into the diff first; d / s only act inside a diff. See fKey / dKey / sKey.
  if (e.key === 'f') {
    e.preventDefault()
    fKey()
    return
  }
  if (e.key === 'd') {
    e.preventDefault()
    dKey()
    return
  }
  if (e.key === 's') {
    e.preventDefault()
    sKey()
    return
  }

  // `a` toggles the diff-pane view everywhere (every visible Block card: the
  // selected/preview cards and every open drilled column) between full
  // side-by-side (default) and new-only, full width. Placed alongside f/d/s so
  // it's guarded by the same earlier menu/search/related checks above — except
  // those key on cs.focus (relatedActive()), which stays null when the composer
  // is opened via a path that only flips cs.composing (e.g. the command
  // palette's "Maak hiermee een comment" fallback, see startComment in
  // RelatedPanel.mjs) without ever routing through the panel's own keyboard
  // navigation. A literal "a" typed there would otherwise be eaten by this
  // shortcut instead of reaching the textarea, so guard directly on whether an
  // editable field currently holds DOM focus.
  if (e.key === 'a' && !isEditableFocused()) {
    e.preventDefault()
    toggleDiffView()
    return
  }

  if (state.mode === 'diff') {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (e.shiftKey) {
        if (state.focusLevel > 0) drillExtendRange(state.focusLevel, 1)
        else extendRange(1)
      } else if (state.focusLevel > 0) drillNextChange()
      else nextChange()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (e.shiftKey) {
        if (state.focusLevel > 0) drillExtendRange(state.focusLevel, -1)
        else extendRange(-1)
      } else if (state.focusLevel > 0) drillPrevChange()
      else prevChange()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (state.focusLevel > 0) {
        // Close the focused drilled column and step focus back onto the diff
        // of its parent column — the closed child reappears in the parent's
        // Related-code list (that list is driven by focusedBlock() via the
        // setRelated watch, so it updates on its own once focusLevel drops).
        // Repeated ArrowLeft peels back one drilled level at a time.
        state.drill = state.drill.slice(0, state.focusLevel - 1)
        state.drillCursor = state.drillCursor.slice(0, state.focusLevel - 1)
        state.focusLevel -= 1
        markDrillReturn(state.focusLevel)
        scrollFocusIntoView()
        // Popping all the way back out to the top-level block (no drilled
        // column left) reaches the rest position — snap <main> hard back to
        // its flush-left start rather than leaning on scrollFocusIntoView's
        // alignment. A partial pop (focusLevel still > 0) stays untouched:
        // that's still "inside" the drill, where earlier columns are meant to
        // stay scrolled off the left edge (see scrollFocusIntoView's comment).
        if (state.focusLevel === 0) resetMainScroll()
        // The parent column's card gets a fresh key on this foc/unfoc flip
        // (see the block-card .key(...) rekey comment above), so its fresh
        // [data-scrollsync] pane starts at scrollTop 0 — without this, a long
        // parent block (many lines above the active change) would leave the
        // reviewer stranded at the top instead of at the edited row. Mirrors
        // drillIntoChild's own scrollFocusIntoView() + scrollChangeIntoView(false).
        scrollChangeIntoView(false)
      } else {
        // Already on the top-level block's own diff (no drilled column focused):
        // the existing diff→list transition. Also drop any drilled columns —
        // they only make sense in the context of this diff session.
        state.mode = 'list'
        state.drill = []
        state.drillCursor = []
        clearRangeAnchor(0)
        resetMainScroll()
        scrollSelectedIntoView()
        refreshHints() // stepping back to the list hides the hints
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      // Stepping into the Onderliggende-code panel leaves this column's diff —
      // clear any active line-range selection, mirroring every other
      // navigation path that supersedes one (see clearRangeAnchor).
      clearRangeAnchor()
      enterRelated() // step into the right-hand Related panel of the focused column
    }
    return
  }

  // Stop 1 of the nav chain (the PR-description column) sits to the left of the
  // block-index and owns the keyboard while open: → closes it back to stop 2,
  // ← exits the chain entirely to the PR overview (/pr-overview) — there's
  // nothing further left than stop 1. Reached here only while the PR-wide
  // comment sub-block (see above) does NOT itself own the keyboard
  // (isPrWideFocused() false) — ↓ hands it the keyboard instead (entering its
  // first entry) when it has any PR-wide comments; a no-op otherwise. Any
  // other key is a no-op and doesn't move the block selection underneath it.
  // The `?pr=`/`?sel=` params let /pr-overview auto-select the PR — and hand
  // back the same block reference on return — we just came from (see
  // overviewExitUrl above, and trySelectPendingPr()/originPr/originSel in
  // overview.mjs).
  if (state.showDescription) {
    e.preventDefault()
    if (e.key === 'ArrowRight') state.showDescription = false
    else if (e.key === 'ArrowLeft') location.href = overviewExitUrl()
    else if (e.key === 'ArrowDown') handlePrWideKey('ArrowDown')
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    stepListSelection(1)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    stepListSelection(-1)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    enterDiff()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    state.toggleFocused = false
    state.showDescription = true // step left out of the list into stop 1 (the description)
  }
}

window.addEventListener('keydown', onKeydown)

// connector — the dashed vertical line drawn between two stacked cards that come
// from the same file, so a reviewer sees at a glance they belong together.
function connector() {
  return html`
    <div class="flex h-5 pl-8" data-testid="file-connector">
      <div class="border-l-2 border-dashed border-slate-300 dark:border-zinc-700"></div>
    </div>
  `
}

// canStep reports whether ↓ (delta 1) / ↑ (delta -1) would flow out of the
// selected block into its same-file neighbour: we're in diff mode, on the last
// (resp. first) change of the block, and that neighbour exists. This is the cue
// for the grey step-chevron below/above the card (see stepChevron).
function canStep(delta) {
  if (state.mode !== 'diff' || state.focusLevel > 0) return false
  const groups = unitsOf(state.blocks[state.selected])
  if (!groups.length) return false
  const atEdge = delta > 0 ? state.change >= groups.length - 1 : state.change <= 0
  return atEdge && sameFileNeighbour(delta)
}

// stepChevron — the grey chevron that sits *outside* the block card (below it for
// ↓, above it for ↑) once you're at the last/first change and ↓/↑ will carry you
// into the next/previous same-file block. Distinct from the green in-block
// scroll-chevron (Block.scrollHint), which stays inside the card and only means
// "more changes out of view here". Grey + outside = "you're leaving this block".
// Pointer-events-none, purely a cue — the keyboard does the actual stepping.
function stepChevron(dir) {
  const down = dir === 'down'
  const chevron = down
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M6 9l6 6 6-6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M18 15l-6-6-6 6"/></svg>'
  return html`
    <div
      class="pointer-events-none flex shrink-0 justify-center"
      data-testid="step-chevron"
      data-dir="${dir}"
    >
      <span
        class="flex h-5 w-8 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-700 text-slate-500 dark:text-zinc-500 shadow-sm ring-1 ring-black/5"
        .innerHTML="${() => chevron}"
      ></span>
    </div>
  `
}

// stepChevronSlot wraps a step-chevron in its own nested reactive `${() => ...}`
// binding, so the state.change/mode/focusLevel reads inside canStep() are tracked
// by THIS small binding alone rather than by whatever outer closure calls
// stepChevronSlot. Calling canStep() directly inside the DetailPanel block-column
// closure (as this used to) makes that whole closure re-run on every change-step —
// rebuilding every Block() card with fresh activeGroup/hintsEnabled/etc. closures,
// which (see the .key() comment above) forces the diff panes to fully re-render on
// every ↑/↓ press, a visible flicker for what should be just the highlight moving.
// Deferring the read into a nested slot (same pattern as the existing
// `${() => menu.open ? menuOverlay() : ''}` toggle) keeps the outer closure's
// dependency set limited to what it explicitly reads (selected/codeVersion/
// focusLevel), so a plain navigation step only re-runs this one small binding.
//
// The stable <div> root is load-bearing. This used to be a bare-expression
// template (html`${() => canStep(delta) ? stepChevron(dir) : ''}`), which — as
// a keyed item in the block-column list — corrupted arrow.js's keyed
// reconcile: a chunk's DOM boundary (ref.f/ref.l) is only set at hydration,
// so once the nested toggle swapped its content (chevron ↔ ''), the chunk's
// ref pointed at removed nodes. The next same-file block step then anchored
// freshly mounted cards after a detached node — the look-ahead preview card
// vanished — and a follow-up step locked the tab in an infinite reconcile
// loop. Wrapping the toggle inside a permanent element keeps ref valid
// forever. The wrapper's class is a *static* `contents`: display:contents
// removes the wrapper's own box, so while the chevron shows it passes through
// as the flex item, and while it's empty it contributes no flex item at all —
// no gap-3 artifact in either state, and no reactive class attribute that
// would re-set on every change-step (the flicker test asserts zero attribute
// mutations per step). See the "bare single-expression keyed template"
// pitfall in .claude/rules/conventions.md.
function stepChevronSlot(delta, dir) {
  return html`<div class="contents">${() => (canStep(delta) ? stepChevron(dir) : '')}</div>`
}

// drillPreviewColumns builds the (0 or 2) keyed items for a look-ahead preview
// of the NEXT Onderliggende-code sibling, stacked BELOW the currently focused
// drilled column's own card (always the rightmost — state.focusLevel ===
// state.drill.length whenever drill.length > 0, see expandColumn/
// drillIntoChild) — mirroring the top-level block-column's own look-ahead
// preview of the next sidebar block (the `pair`/connector() logic above): the
// reviewer sees what ↓ would drill into once the current column's own changes
// are exhausted (drillNextChange → drillToSibling), before actually stepping
// there. Only the NEXT sibling is previewed (never the previous one) — same
// as the top-level preview — and it's shown unconditionally whenever a next
// sibling exists, not just once the reviewer reaches the last change unit
// (again mirroring the top-level `pair`, which always renders regardless of
// state.change's position within the selected block). Reuses the existing
// vertical connector() — drilled columns stack the preview vertically under
// the focused card, exactly like the top-level block-column does for its own
// next-block preview, not side by side.
//
// Called from a nested `${() => drillPreviewColumns()}` slot INSIDE the
// focused drilled column's own per-item template (see the drilled-columns
// closure below) — a small, independently-reactive array-returning binding,
// not a dependency of the outer state.drill.map() closure. That isolation is
// load-bearing on two fronts: this function reads only the cheap,
// identity-guarded state.drillPreviewChild field — NOT relatedChildren()/
// drillSiblingContext() directly (those are computed once in the setRelated
// watch, which already needs the identical inputs for the real
// Onderliggende-code panel, and only reassign this field when the actual
// next-sibling id changes) — and because the slot is nested rather than a
// top-level sibling in the outer closure's returned array, a preview change
// re-renders only THIS small nested slot, never re-invoking the outer
// closure (so the Block(b) card above it is never rebuilt just because the
// preview changed). See the field's own comment and
// .claude/rules/conventions.md.
function drillPreviewColumns() {
  const next = state.drillPreviewChild
  if (!next) return []
  const previewBlock = resolveChildBlock(next)
  if (!previewBlock) return []
  // Lazily fetch the preview's code the same way the real drilled columns and
  // the top-level look-ahead preview do — visible before the reviewer ever
  // steps onto it.
  ensureCode(previewBlock)
  const codeState =
    previewBlock.code && !previewBlock.code.error ? 'code' : previewBlock.code && previewBlock.code.error ? 'err' : 'load'
  return [
    connector().key('drill-preview-connector'),
    html`
      <div class="relative flex min-h-0 shrink-0 flex-col gap-3" data-testid="drill-preview-column">
        ${Block(previewBlock, {
          // Dimmed like the top-level look-ahead preview; never owns the
          // keyboard, never highlights a change group.
          preview: true,
          activeGroup: () => null,
          hintsEnabled: () => false,
          diffActive: () => false,
          approvedRows: () => approvedRowSet(previewBlock),
          approvedCalls: () => approvedCallSet(previewBlock),
          onApprove: (blk) => persistApproval(blk),
          commentedRows: () => commentRowSet(previewBlock),
          viewMode: () => state.diffViewMode,
        })}
      </div>
    `.key('drill-preview:' + previewBlock.id + ':' + codeState),
  ]
}

// isReviewFollowup — true for any of the follow-up menu modes opened right
// after a palette approve action (see afterApproveAction): the existing
// postApprove ("Ga door"/"Sluit menu") plus the three new review-submit
// modes (reviewApprove/reviewChoice/reviewReject). They all share the same
// anchoring quirk handled below — see isIndexMenu/lastIndexRowRect.
function isReviewFollowup(mode) {
  return mode === 'postApprove' || mode === 'reviewApprove' || mode === 'reviewChoice' || mode === 'reviewReject'
}

// menuAnchor returns the element the command palette floats *beneath* (its
// vertical anchor): in 'comment' mode, the focused comment row; in
// blokken-index mode (state.mode==='list', for the 'block' palette reached
// via Enter from the sidebar, or one of the approve-follow-up modes —
// see the isIndexMenu() guard below) the selected sidebar row, so the menu
// opens right there instead of over the list-mode diff preview; otherwise the
// active change row (present in diff mode) if there is one, else the selected
// block's card, else the sidebar row. Always something on-screen so the menu
// opens under whatever is selected.
function isIndexMenu() {
  return state.mode === 'list' && (ms.mode === 'block' || isReviewFollowup(ms.mode))
}

// lastIndexRowRect caches the selected sidebar row's bounding rect while it's
// still visible — see the isIndexMenu() branch of menuAnchor() below. A
// follow-up menu (postApprove, or one of the review-submit modes) opens right
// after an approve action that can fully-approve (and thus auto-hide, see
// blocks-and-ingest.md) the very row it wants to anchor on; without this cache
// menuAnchor() falls through to the whole `pr-index` aside, whose much taller
// bounding rect throws positionMenu()'s flip-above math to the top of the
// viewport instead of keeping the follow-up menu where the first menu sat.
// Reset whenever a menu opens fresh (see openMenu) so it never carries a
// stale position into an unrelated later session — except for a follow-up
// mode itself (isReviewFollowup), which relies on it, and 'reviewReject',
// which is opened FROM 'reviewChoice' (itself a follow-up) and must keep
// reusing the same cached position through that chain.
let lastIndexRowRect = null

// isDescriptionMenu — the PR-wide menu ('pr' mode, opened with Enter or `/`)
// while stop 1 (the PR-description column, state.showDescription) owns the
// keyboard: anchor it on the description card itself instead of the diff
// region far to the right (mirror of the isIndexMenu exception above). The
// pr-info-column only exists in the DOM while showDescription is true, so the
// selectors below always resolve while this returns true.
function isDescriptionMenu() {
  return state.showDescription && ms.mode === 'pr'
}

function menuAnchor() {
  // The comment-kind menu ('compose') anchors under the composer textarea.
  if (ms.mode === 'compose') {
    return (
      document.querySelector('[data-testid="comment-compose"]') ||
      document.querySelector('[data-testid="comments-panel"]')
    )
  }
  if (ms.mode === 'comment') {
    return (
      document.querySelectorAll('[data-testid="comment-item"]')[commentSelIndex()] ||
      document.querySelector('[data-testid="comments-panel"]')
    )
  }
  // Enter from the blokken-index (list mode): anchor on the selected row
  // itself, not the list-mode diff preview beneath it (see
  // .claude/rules/keyboard-navigation.md).
  if (isIndexMenu()) {
    const row = document.querySelector(`[data-idx="${state.selected}"]`)
    if (row) {
      lastIndexRowRect = row.getBoundingClientRect()
      return row
    }
    // The row just got hidden (e.g. the approve action that opened this
    // postApprove follow-up menu fully approved it) — reuse its last known
    // position instead of the whole `pr-index` aside (see lastIndexRowRect).
    if (lastIndexRowRect) return { getBoundingClientRect: () => lastIndexRowRect }
    return document.querySelector('[data-testid="pr-index"]')
  }
  // The PR-wide menu on stop 1 anchors on the description card (the card is
  // tall, so positionMenu usually flips the palette above/clamps it near the
  // top of the column — still right by the description, which is the point).
  if (isDescriptionMenu()) {
    return (
      document.querySelector('[data-testid="pr-info-card"]') ||
      document.querySelector('[data-testid="pr-info-column"]')
    )
  }
  return (
    document.querySelector('[data-change-active]') ||
    document.querySelector('[data-testid="detail-panel"] article') ||
    document.querySelector(`[data-idx="${state.selected}"]`)
  )
}

// menuRegion returns the element whose left+width the palette takes: in
// 'comment' mode, the comment thread pane (so it sits over the comments panel,
// under the focused row); in blokken-index mode (see isIndexMenu) the whole
// sidebar, so the menu sits over the index instead of the diff pane; otherwise
// the NEW (right) pane of the selected block's diff, so the menu is half the
// diff's width and sits over the right-hand side — the new code you're
// reviewing. Falls back to the OLD pane (a removed block has no new pane),
// then the whole block column.
function menuRegion() {
  // Both comment-scoped menus sit over the comment thread pane.
  if (ms.mode === 'comment' || ms.mode === 'compose') {
    return (
      document.querySelector('[data-testid="comment-thread"]') ||
      document.querySelector('[data-testid="comments-panel"]')
    )
  }
  if (isIndexMenu()) {
    return document.querySelector('[data-testid="pr-index"]')
  }
  // Stop 1: the palette takes the description column's full left+width
  // (39rem) — mirror of how the index menu takes the whole sidebar.
  if (isDescriptionMenu()) {
    return document.querySelector('[data-testid="pr-info-column"]')
  }
  const scope = document.querySelector('[data-testid="detail-panel"]')
  if (!scope) return null
  return (
    scope.querySelector('[data-pane="new"]') ||
    scope.querySelector('[data-pane="old"]') ||
    document.querySelector('[data-testid="block-column"]')
  )
}

// positionMenu sizes the fixed palette to its region (the right/new pane — half
// width, right side) and places it just below the vertical anchor, flipping
// *above* when it wouldn't fit below and clamping into the viewport either way.
// Called after the menu renders (its size is then known) and again on
// resize/scroll while open, since the anchor moves with the page.
function positionMenu() {
  const box = document.querySelector('[data-testid="command-anchor"]')
  const anchor = menuAnchor()
  const region = menuRegion()
  if (!box || !anchor || !region) return
  const reg = region.getBoundingClientRect()
  // Match the region's width/left first (the menu is half-width, over the right
  // pane), then measure the resulting height for the vertical fit.
  box.style.width = reg.width + 'px'
  const a = anchor.getBoundingClientRect()
  const gap = 8
  const vh = window.innerHeight
  const vw = window.innerWidth
  const mh = box.offsetHeight
  const mw = box.offsetWidth
  // Prefer just below the selection; if that runs off the bottom, flip above it.
  let top = a.bottom + gap
  if (top + mh > vh - gap) top = a.top - gap - mh
  top = Math.max(gap, Math.min(top, vh - mh - gap))
  const left = Math.max(gap, Math.min(reg.left, vw - mw - gap))
  box.style.top = top + 'px'
  box.style.left = left + 'px'
  box.style.visibility = 'visible'
}

// menuOverlay — the `/` command palette as a floating popover over the whole page.
// A full-screen catch layer closes it on an outside click; the palette itself is
// fixed-positioned by positionMenu just beneath the current selection (see
// menuAnchor), over everything else. Starts hidden until positioned to avoid a
// top-left flash on the first frame.
function menuOverlay() {
  return html`
    <div class="fixed inset-0 z-40" data-testid="command-overlay" @click="${() => closeMenu()}">
      <div
        class="fixed z-50 max-w-[calc(100vw-1rem)]"
        style="top:0;left:0;visibility:hidden"
        data-testid="command-anchor"
        @click="${(e) => e.stopPropagation()}"
      >
        ${CommandMenu(ms, resolveCommands, runCommand)}
      </div>
    </div>
  `
}

// MenuHost mounts the command-palette overlay at the top level (sibling of
// PrInfoPanel/BlockList/DetailPanel/CommentsSidebar), not nested inside
// <main>. <main> is itself `position:fixed` with an explicit z-index (z-10),
// which makes it a stacking-context root: any `fixed`/z-indexed descendant
// (the overlay was z-40/z-50) only stacks *within* <main>'s own subtree —
// externally the whole thing is capped at <main>'s z-10. That's lower than
// CommentsSidebar's z-20 (see below), so with the overlay still nested inside
// <main> the comments/taken sidebar rendered *on top of* an open command
// menu whenever it overlapped it (the compose-mode menu anchors on the
// composer, which now lives in that sidebar) — clicks meant for a command row
// landed on a workflow row underneath instead. Mounting the overlay as a
// separate top-level element lets its own z-40/z-50 compete directly at the
// root stacking context, where it correctly wins over both <main> and the
// sidebar.
function MenuHost() {
  return html` <div>${() => (menu.open ? menuOverlay().key('command-overlay') : '')}</div> `
}

// ── PR-info column ──────────────────────────────────────────────────────────
// prInfoCard renders the card shown in PrInfoPanel (stop 1 of the nav chain):
// PR title/Jira badge, meta (author/diffstat/branch/GitHub link), the Claude
// summary, the PR description (+ Jira description if any), and review/CI
// pills — each section appearing as soon as its stage of the pr_status
// workflow has landed in state.prMeta. Reads only state.prMeta/state.pr —
// never b.code, so it can't race the diff render (see conventions.md).

const REPO_SLUG = 'plug-and-pay/plug-and-pay'

function prPill(text, cls) {
  return html`<span
    class="${'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ' + cls}"
    >${text}</span
  >`
}

function prReviewPill(meta) {
  const d = meta.reviewDecision
  if (d === 'APPROVED') return prPill('Goedgekeurd', 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30')
  if (d === 'CHANGES_REQUESTED') return prPill('Wijzigingen gevraagd', 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30')
  return prPill('Wacht op review', 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30')
}

function prChecksPill(meta) {
  const total = Number(meta.checksTotal) || 0
  if (!total) return null
  const passed = Number(meta.checksPassed) || 0
  if (passed >= total) return prPill('✓ ' + total + ' checks', 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30')
  return prPill(passed + '/' + total + ' checks', 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-800')
}

function prStatusSlot(meta) {
  const statusesIn = meta.reviewDecision !== '' || (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) || meta.checksTotal > 0
  if (!statusesIn) {
    return [
      html`<span
        class="inline-flex w-24 animate-pulse items-center rounded-full bg-slate-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] ring-1 ring-inset ring-slate-200 dark:ring-zinc-800"
        aria-hidden="true"
        >${' '}</span
      >`.key('status-skeleton'),
    ]
  }
  const pills = [prReviewPill(meta).key('review'), prChecksPill(meta)]
  const reviewers = Array.isArray(meta.reviewers) ? meta.reviewers : []
  if (reviewers.length) {
    pills.push(
      html`<span class="flex flex-wrap items-center gap-1" data-testid="pr-info-reviewers">
        ${reviewers.map((login, i) =>
          html`<span
            class="inline-flex items-center rounded-full bg-slate-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-zinc-400 ring-1 ring-inset ring-slate-200 dark:ring-zinc-800"
            >${login}</span
          >`.key('rev:' + i + ':' + login),
        )}
      </span>`.key('reviewers'),
    )
  }
  return pills.filter(Boolean)
}

// DESC_TRUNCATE_AT is the character length past which the PR description is
// truncated (with a "meer…" affordance) in the PR-info column. A short body
// renders in full — no misleading toggle. Character-count is deliberate: it's
// deterministic and needs no DOM measurement (no reactive layout read).
const DESC_TRUNCATE_AT = 280

function prInfoCard(state) {
  return html`
    <div
      class="${() =>
        'flex min-h-0 flex-col gap-3 overflow-auto rounded-2xl border bg-white dark:bg-zinc-900 p-5 shadow-sm ' +
        // Height: this description card now always takes the small share so
        // the PR-wide comment block below it renders roughly twice as tall as
        // it used to in the normal (description-selected) state — a flat 1/5
        // there (complement of PrWideComments' flex-[4]) and 1/6 while
        // navigating the comment block (complement of flex-[5]); see
        // PrWideComments in RelatedPanel.mjs. flex-grow with a 0 basis (like
        // flex-1), so the ratio is purely the two numbers.
        'flex-1 ' +
        // Light-blue border while the keyboard drives stop 1 (this panel is only
        // ever mounted while showDescription is true, but read it here anyway so
        // the binding stays reactive) — mirrors diffActive on the block-diff card.
        (state.showDescription
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="pr-info-card"
    >
      <div>
        <div class="flex items-start gap-2">
          <h1 class="min-w-0 flex-1 text-lg font-semibold leading-snug text-slate-900 dark:text-zinc-100" data-testid="pr-info-title">
            ${() => state.prMeta.title || `PR #${state.pr}`}
          </h1>
          ${() =>
            state.jiraKey
              ? html`<a
                  href="${() => state.prMeta.jiraUrl || JIRA_BASE + state.jiraKey}"
                  target="_blank"
                  rel="noreferrer"
                  class="shrink-0 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/20"
                  data-testid="pr-info-jira-key"
                  >${state.jiraKey}</a
                >`
              : ''}
        </div>
        <div class="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-zinc-500">${REPO_SLUG}#${state.pr}</div>
      </div>
      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-slate-500 dark:text-zinc-500" data-testid="pr-info-meta">
        ${() => (state.prMeta.author ? html`<span>${state.prMeta.author}</span>` : '')}
        ${() =>
          state.prMeta.author && (state.prMeta.additions || state.prMeta.deletions)
            ? html`<span class="text-slate-300 dark:text-zinc-600">·</span>`
            : ''}
        ${() =>
          state.prMeta.additions || state.prMeta.deletions
            ? html`<span
                ><span class="font-medium text-emerald-600 dark:text-emerald-400">+${state.prMeta.additions || 0}</span>
                <span class="font-medium text-rose-600 dark:text-rose-400">−${state.prMeta.deletions || 0}</span></span
              >`
            : ''}
        ${() => (state.prMeta.changedFiles ? html`<span class="text-slate-300 dark:text-zinc-600">·</span>` : '')}
        ${() => (state.prMeta.changedFiles ? html`<span>${state.prMeta.changedFiles} bestanden</span>` : '')}
        ${() => (state.prMeta.headRef ? html`<span class="text-slate-300 dark:text-zinc-600">·</span>` : '')}
        ${() =>
          state.prMeta.headRef
            ? html`<span class="truncate font-mono text-sky-600 dark:text-sky-400" title="Huidige branch">${state.prMeta.headRef}</span>`
            : ''}
        ${() => (state.prUrl ? html`<span class="text-slate-300 dark:text-zinc-600">·</span>` : '')}
        ${() =>
          state.prUrl
            ? html`<a href="${state.prUrl}" target="_blank" rel="noreferrer" class="text-indigo-600 dark:text-indigo-400 hover:underline"
                >op GitHub ›</a
              >`
            : ''}
      </div>
      <div class="flex items-center justify-between" data-testid="pr-info-theme-row">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">Weergave</span>
        ${themeToggleButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
      </div>
      <div class="rounded-lg bg-emerald-50 dark:bg-emerald-500/15 p-2.5" data-testid="pr-info-summary">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">Doel</div>
        ${() =>
          state.prMeta.summary
            ? html`<div
                class="markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300"
                .innerHTML="${() => renderMarkdown(state.prMeta.summary)}"
              ></div>`
            : html`<p class="text-[13px] italic text-slate-400 dark:text-zinc-500">samenvatting genereren…</p>`}
      </div>
      <div data-testid="pr-info-body">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">Omschrijving</div>
        ${() =>
          state.prMeta.body
            ? state.prMeta.body.length > DESC_TRUNCATE_AT
              ? // Long body: truncate with a fade + clickable "meer…" affordance
                // that toggles state.descriptionExpanded (same flag the PR-menu
                // item drives). The class strings are whole-value function
                // bindings (no partial interpolation — see the arrow.js
                // class-binding pitfall in conventions.md).
                html`<div class="relative" data-testid="pr-info-body-wrap">
                  <div
                    class="${() =>
                      'markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300 ' +
                      (state.descriptionExpanded ? '' : 'max-h-40 overflow-hidden')}"
                    .innerHTML="${() => renderMarkdown(state.prMeta.body)}"
                  ></div>
                  <button
                    type="button"
                    data-testid="pr-info-body-toggle"
                    @click="${() => (state.descriptionExpanded = !state.descriptionExpanded)}"
                    class="${() =>
                      state.descriptionExpanded
                        ? 'mt-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline'
                        : 'absolute inset-x-0 bottom-0 flex h-10 cursor-pointer items-end justify-center bg-gradient-to-t from-white via-white/85 to-transparent text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:from-zinc-900 dark:via-zinc-900/85 dark:text-indigo-400 dark:hover:text-indigo-300'}"
                  >
                    ${() => (state.descriptionExpanded ? 'Inklappen' : 'meer…')}
                  </button>
                </div>`
              : html`<div
                  class="markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300"
                  .innerHTML="${() => renderMarkdown(state.prMeta.body)}"
                ></div>`
            : html`<p class="text-[13px] text-slate-400 dark:text-zinc-500">geen omschrijving</p>`}
        ${() =>
          state.prMeta.jiraTitle
            ? html`<div class="mt-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 p-2.5" data-testid="pr-info-jira">
                <div class="text-[12px] font-medium text-slate-700 dark:text-zinc-300">Jira: ${state.prMeta.jiraTitle}</div>
                ${state.prMeta.jiraDesc
                  ? html`<div
                      class="markdown-body mt-1 text-[12px] leading-relaxed text-slate-600 dark:text-zinc-400"
                      .innerHTML="${() => renderMarkdown(state.prMeta.jiraDesc)}"
                    ></div>`
                  : ''}
              </div>`
            : ''}
      </div>
      <div class="mt-auto flex flex-wrap items-center gap-1.5 pt-1" data-testid="pr-info-statuses">
        ${() => prStatusSlot(state.prMeta)}
      </div>
    </div>
  `
}

// PrInfoPanel — stop 1 of the left→right nav chain: the PR-description column.
// It is its own fixed-position panel (mounted as a sibling of BlockList/
// DetailPanel), NOT a flex child of <main> — the pr-index (<aside> in
// BlockList.mjs) is itself position:fixed and outside <main>'s flex flow, so
// this panel has to live at that same level to sit flush left of it (at the
// pr-index's usual left-6 spot) while BlockList slides itself right
// (translate-x-[40.5rem]) to make room. See the "verplaats pr description naar
// links" note in detail-layout.md for the full rationale/measurements.
// Width is 1.5x the original 26rem (w-[39rem]) — the reviewer wanted more
// room to read the PR title/summary/description/Jira box without truncation.
function PrInfoPanel(state) {
  return html`
    <div>
      ${() =>
        state.showDescription
          ? html`<div
              class="fixed bottom-6 left-6 top-6 z-10 flex min-h-0 w-[39rem] flex-col gap-3"
              data-testid="pr-info-column"
            >
              ${prInfoCard(state)}
              ${PrWideComments(state)}
            </div>`.key('pr-info-column')
          : ''}
    </div>
  `
}

// DetailPanel — the area right of the fixed sidebar. It shows the block card for
// the selected row, and the next row's card already (a look-ahead preview). When
// both cards are from the same file, a dashed connector links them.
function DetailPanel(state) {
  return html`
    <main
      class="${() =>
        'fixed top-6 z-10 flex min-h-0 flex-row gap-4 overflow-x-auto no-scrollbar transition-all duration-200 ease-out ' +
        // Reserve a bottom strip matching the footer's own visibility/height
        // (state.footerVisible/state.footerExplain, see Footer.mjs): none when
        // the footer has nothing to show, 90px for just the inline diff, 140px
        // while it also shows an AI unit description — so the columns never
        // slide in behind it, but don't leave dead space once it's gone either.
        (!state.footerVisible ? 'bottom-6 ' : state.footerExplain ? 'bottom-[140px] ' : 'bottom-[90px] ') +
        // Right margin clears the comments/taken sidebar (RelatedPanel.mjs),
        // which is a separate position:fixed overlay with a higher z-index —
        // without this, <main>'s last column (Onderliggende code, or the
        // rightmost drilled column) scrolls in behind it. Collapsed it's a
        // 3rem hint rail flush against the edge (right-0, w-12); open it's
        // right-6 (1.5rem) + w-[36rem], so its left edge sits 37.5rem in. Both
        // get the same 1.5rem breathing-room gap used elsewhere for this kind
        // of panel-to-panel spacing (see left-[69.5rem] below).
        (sidebarOpen() ? 'right-[39rem] ' : 'right-[4.5rem] ') +
        (state.mode === 'diff'
          ? 'left-6'
          : // showDescription (list-mode only) pushes PrInfoPanel to left-6 and
            // slides the pr-index right by one column-width (40.5rem, see
            // BlockList.mjs) — <main> needs to clear both, so it shifts the same
            // 40.5rem past its usual left-[29rem].
            state.showDescription
            ? 'left-[69.5rem]'
            : 'left-[29rem]')}"
      data-testid="detail-panel"
    >
      <div class="flex min-h-0 shrink-0 flex-col gap-3" data-testid="block-column">
      ${() => {
        const sel = state.selected
        // Subscribe this binding to codeVersion so it re-runs when a block's code
        // loads (ensureCode bumps it). That re-run re-reads b.code for each card's
        // key below — a reliable trigger, since a per-card b.code subscription is
        // dropped when it co-subscribes with the setRelated/setCommentScope watches
        // (see the key comment + the codeVersion note on `state`). Also subscribe
        // to focusLevel: stepping ← out of a drilled column back onto this card
        // (or → into one) toggles whether it's dimmed/owns the keyboard, which
        // the key below must reflect to force a fresh card (see its comment).
        void state.codeVersion
        void state.focusLevel
        const focusedHere = state.focusLevel === 0
        // Once a drilled column owns the keyboard (focusLevel > 0, which only
        // ever happens with at least one open drill column — see
        // expandColumn), this column no longer needs its own diff visible:
        // collapse it to a narrow rail so the focused column gets the freed
        // width. Stays a keyed array of one (not a bare element) so this slot
        // never flips between a scalar and an array shape — see the
        // single↔array arrow.js pitfall in conventions.md.
        if (!focusedHere) {
          const selectedBlock = state.blocks[sel] || {}
          return [collapsedColumnHTML(selectedBlock, 0, 'block-collapsed').key('block-collapsed')]
        }
        const pair = state.blocks
          .map((b, i) => ({ b, i }))
          .filter(({ i }) => i === sel || i === sel + 1)
        const out = []
        // A step-up cue sits *above* the selected card when ↑ would flow into the
        // previous same-file block (which isn't rendered here — it's up the list).
        // canStep reads state.change/mode/focusLevel — calling it directly here
        // (synchronously, inside this outer array-building closure) would make
        // THIS closure depend on state.change, forcing it to rebuild the whole
        // out array — including every Block() card's activeGroup/hintsEnabled/etc.
        // closures — on every single ↑/↓ step, which visibly re-renders (flickers)
        // both diff panes even though only the highlight moved. stepChevronSlot
        // defers the canStep() read into its own nested reactive binding (only
        // mounted once, toggling internally), so a plain change-step never
        // re-triggers this outer closure. See conventions.md / detail-layout.md.
        out.push(stepChevronSlot(-1, 'up').key('step-up'))
        pair.forEach(({ b, i }, idx) => {
          ensureCode(b)
          if (idx > 0 && pair[idx - 1].b.file === b.file) {
            // The step-down cue sits *below* the selected card, just above the
            // dashed connector to the next same-file block ↓ would flow into.
            out.push(stepChevronSlot(1, 'down').key('step-down'))
            out.push(connector().key('conn:' + b.file + ':' + i))
          }
          const inner = Block(b, {
            // Dimmed like the look-ahead preview whenever it isn't the selected
            // card, OR the keyboard focus has stepped off it onto a drilled
            // column (state.focusLevel > 0).
            preview: i !== sel || !focusedHere,
            // Reactive: reads mode/selected/change so the pane re-highlights as
            // the reviewer navigates. Only the selected block, in diff mode,
            // with the keyboard actually on it (not a drilled column), gets a
            // highlighted group.
            activeGroup: () => {
              if (i !== state.selected || state.focusLevel > 0) return null
              // In list mode we preview the first change group (the very run →
              // would step onto). In diff mode we follow state.change into the
              // current granularity's units (a run, a line, or a call segment) —
              // merged with an active Shift+arrow line-range selection, if any
              // (see rangeUnit/extendRange).
              if (state.mode !== 'diff') return groupsFor(b)[0] || null
              const units = unitsOf(b)
              return state.gran === 'line' ? rangeUnit(units, state.change, state.rangeAnchor) : units[state.change] || null
            },
            // Out-of-view change hints belong only to the block being stepped
            // through: the selected card, in diff mode, with the keyboard on it.
            hintsEnabled: () => i === state.selected && state.mode === 'diff' && state.focusLevel === 0,
            // Light-blue border while the keyboard drives this block's diff
            // (selected card, diff mode) — mirrors the selected comment-index row.
            // Drops once the reviewer steps → into the related panel
            // (relatedActive()) or ← into a drilled column (focusLevel > 0).
            diffActive: () =>
              i === state.selected && state.mode === 'diff' && state.focusLevel === 0 && !relatedActive(),
            // Reactive Set of approved row indices → an emerald bar on approved
            // rows. Reads b.approvedRows so the pane re-tints on every approve.
            approvedRows: () => approvedRowSet(b),
            // Reactive Set of approved call-segment keys (finer than
            // approvedRows) → open-circle progress markers on rows with
            // multiple call segments that aren't fully approved yet. Reads
            // b.approvedCalls so the pane re-renders on every call-toggle.
            approvedCalls: () => approvedCallSet(b),
            // Persist a top-checkbox toggle to the durable approve tracker.
            onApprove: (blk) => persistApproval(blk),
            // Reactive Set of rows that carry a comment → a 💬 marker on those
            // rows, so it's visible which units already hold a comment (however
            // many). Reads the comments read-model via RelatedPanel.
            commentedRows: () => commentRowSet(b),
            // Global diff-pane preference (see state.diffViewMode / the `a` key) —
            // read inside Block's own per-card slot, so toggling re-renders this
            // card's diff structure without touching this outer closure.
            viewMode: () => state.diffViewMode,
            // The key encodes (a) whether this card is the *selected* one or the
            // look-ahead *preview*, (b) whether its code has loaded yet, and (c)
            // whether the keyboard is actually focused on it (vs. a drilled
            // column). All three are load-bearing because arrow.js otherwise
            // *reuses* the keyed node across those transitions — it moves +
            // patches the node but does NOT re-run the persisted pane bindings,
            // so a frozen binding never re-fires:
            //  • preview→selected (↓/↑ onto an already-previewed block): the
            //    activeGroup binding stays frozen and the active-change highlight +
            //    its scroll-into-view silently fail to appear.
            //  • loading→loaded: the codeDiff binding's b.code subscription is
            //    dropped (it co-subscribes with the setRelated/setCommentScope
            //    watches, and arrow.js loses one of the updates), leaving the diff
            //    stuck on "loading code…" even though b.code has arrived.
            //  • focused→unfocused (← into a drilled column) and back: the same
            //    frozen-binding issue would leave the dimming/highlight stale.
            // Rekeying on all three forces a fresh card (fresh bindings) the
            // moment any changes. b.code persists on the block, so the rebuild
            // shows the code immediately — no reload flash.
          })
          // One-shot "return" animation when this card regains the keyboard
          // focus after popping back out of a drilled column (← ,a
          // collapsed-rail click, or applyNextUnapproved landing back on an
          // ancestor — see drillReturnMarker/markDrillReturn). Only the
          // selected card can ever be the level-0 return target, hence the
          // `i === sel` guard — the look-ahead preview card never consumes
          // this marker. `inner` (the Block() card) is wrapped in a stable
          // `contents` root purely so there's a non-reactive place to bake
          // this one-shot class string, exactly like drillColumnCls does for
          // a drilled column — see the "stable element root" pitfall in
          // conventions.md. The .key(...) moves from `inner` onto this
          // wrapper: it's the outermost pushed item, so it's the one that
          // must carry the key for the keyed-list reconcile.
          const justReturned =
            i === sel &&
            focusedHere &&
            !!(drillReturnMarker && drillReturnMarker.level === 0 && drillReturnMarker.id === b.id)
          if (justReturned) drillReturnMarker = null
          const cardCls = 'contents' + (justReturned ? ' drill-return' : '')
          const card = html`<div class="${cardCls}" data-testid="detail-card">${inner}</div>`.key(
            'detail:' +
              (i === sel ? 'sel' : 'prev') +
              ':' +
              (b.code && !b.code.error ? 'code' : b.code && b.code.error ? 'err' : 'load') +
              ':' +
              (i === sel && focusedHere ? 'foc' : 'unfoc') +
              ':' +
              b.file +
              ':' +
              b.label +
              ':' +
              b.side,
          )
          out.push(card)
        })
        return out
      }}
      </div>
      ${() => {
        // One extra shrink-0 column per drilled-into child (Enter/click on a
        // resolved Onderliggende-code child — see drillIntoChild), appended to
        // the right of the block column: a full, navigable diff of its own
        // (own change/gran cursor in state.drillCursor). Exactly one column —
        // the one at state.focusLevel — owns the keyboard at a time: ↑/↓ walk
        // its changes, f/d/s zoom its own granularity, → opens its
        // Onderliggende-code panel, ← steps focus back to the previous column
        // (see onKeydown). The others sit dimmed, like the existing look-ahead
        // preview card, but stay open (← never closes a column, it only moves
        // the focus).
        //
        // Deliberately NOT subscribed to state.drillCursor here (mirrors the
        // top-level block-column closure's stepChevronSlot rationale above): a
        // plain change/gran step within the focused column must not rebuild
        // every open drill card (which would re-run Prism highlighting on all
        // of them and flicker). The drillCursor read that matters
        // (activeGroup below) is deferred into Block's own per-card reactive
        // binding, which arrow.js re-invokes on its own without rebuilding the
        // card, exactly like state.change/state.gran for the top-level card.
        void state.codeVersion
        void state.focusLevel
        return state.drill.map((b, i) => {
          ensureCode(b)
          const level = i + 1
          const focusedHere = state.focusLevel === level
          const codeState = b.code && !b.code.error ? 'code' : b.code && b.code.error ? 'err' : 'load'
          // A drilled column that no longer owns the keyboard (a deeper column
          // has been drilled into since) collapses to a rail too — same
          // reasoning as the top-level block-column above. This branch is
          // plain JS inside the .map() callback (not a nested reactive slot),
          // and the whole per-item template is already rebuilt fresh whenever
          // this outer binding re-runs (it's subscribed to focusLevel), so no
          // new keyed-node pitfall is introduced.
          if (!focusedHere) {
            return collapsedColumnHTML(b, level, 'drill-collapsed', i).key(
              'drill-collapsed:' + i + ':' + b.file + ':' + b.label + ':' + b.id,
            )
          }
          // A one-shot entrance animation for a genuine "open" of this column
          // (see drillOpenMarker's own comment) — a plain, non-reactive string
          // baked once per this map() iteration, not a `${() => ...}` binding,
          // so this doesn't fight the "reactive attribute must be the whole
          // value" rule (there's no reactivity here at all). Consuming
          // (clearing) the marker the moment it matches means a later rebuild
          // of this same column — code arriving, a foc/unfoc flip, both of
          // which change this .key(...) and mount a fresh node — never
          // replays it: drillOpenMarker will already be null by then.
          const justOpened = !!(drillOpenMarker && drillOpenMarker.level === level && drillOpenMarker.id === b.id)
          if (justOpened) drillOpenMarker = null
          // Mirrors justOpened above but for the REVERSE transition — this
          // column just regained focus after popping back out of a deeper
          // drilled column (see drillReturnMarker's own comment). Guarded on
          // !justOpened purely for clarity: the two markers are set by
          // disjoint actions (forward drilling vs. stepping back) and are
          // never both set for the same level+id at once.
          const justReturned =
            !justOpened &&
            !!(drillReturnMarker && drillReturnMarker.level === level && drillReturnMarker.id === b.id)
          if (justReturned) drillReturnMarker = null
          // scroll-ml-4 reserves 16px of left scroll-margin on this column so
          // that scrollFocusIntoView's native scrollIntoView({inline:'start'})
          // leaves room for the drill-left-hint chevron rendered just outside
          // this box's own left edge (absolute -left-3, i.e. 12px) — without
          // it, aligning this box flush with <main>'s left edge clips the
          // chevron off-screen (scroll-margin is honored by scrollIntoView per
          // the CSSOM View spec). This div only ever renders while focused
          // (the unfocused branch above returns a collapsed rail instead), so
          // the margin is unconditional, not gated on focusedHere.
          const drillColumnCls =
            'flex min-h-0 shrink-0 flex-col gap-3 scroll-ml-4' +
            (justOpened ? ' drill-enter' : justReturned ? ' drill-return' : '')
          return html`
            <div class="${drillColumnCls}" data-testid="drill-column" data-drill-idx="${i}">
              <div class="relative flex min-h-0 flex-col">
                ${focusedHere
                  ? html`
                      <div
                        class="pointer-events-none absolute -left-3 top-1/2 z-10 -translate-y-1/2"
                        data-testid="drill-left-hint"
                      >
                        <span
                          class="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-700 text-slate-500 dark:text-zinc-500 shadow-sm ring-1 ring-black/5"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="3"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="h-3 w-3"
                          ><path d="M15 18l-6-6 6-6"/></svg>
                        </span>
                      </div>
                    `
                  : ''}
                ${Block(b, {
                  preview: !focusedHere,
                  activeGroup: () => {
                    if (state.focusLevel !== level) return null
                    const cur = state.drillCursor[i] || { change: 0, gran: 'group' }
                    const units = unitsFor(blockRows(b), cur.gran)
                    return cur.gran === 'line' ? rangeUnit(units, cur.change, cur.rangeAnchor) : units[cur.change] || null
                  },
                  hintsEnabled: () => state.focusLevel === level,
                  diffActive: () => state.focusLevel === level && !relatedActive(),
                  approvedRows: () => approvedRowSet(b),
                  approvedCalls: () => approvedCallSet(b),
                  onApprove: (blk) => persistApproval(blk),
                  commentedRows: () => commentRowSet(b),
                  viewMode: () => state.diffViewMode,
                })}
              </div>
              ${
                // The look-ahead preview of the next Onderliggende-code sibling,
                // stacked BELOW this card (mirrors the top-level block-column's
                // own next-block preview) — a nested, independently-reactive
                // array-returning slot (see drillPreviewColumns' own comment):
                // it reads only the cheap, identity-guarded
                // state.drillPreviewChild field, so it reacts to a sibling-walk
                // on its own without requiring THIS per-item template (and thus
                // the Block(b) card above) to rebuild. Only ever rendered for
                // the focused (rightmost) column — we're already inside the
                // focusedHere branch here, never for a collapsed-rail sibling.
                () => drillPreviewColumns()
              }
            </div>
          `.key(
            'drill:' +
              i +
              ':' +
              codeState +
              ':' +
              (focusedHere ? 'foc' : 'unfoc') +
              ':' +
              b.file +
              ':' +
              b.label +
              ':' +
              b.id,
          )
        })
      }}
      ${() =>
        RelatedPanel(state, commentTarget, { drill: (child) => drillIntoChild(child) }).key('related-panel')}
    </main>
  `
}

// Mount the sidebar and the detail panel into #app. PrInfoPanel is mounted
// first so it stacks visually under the pr-index while the latter slides
// right over it during the ~200ms transition (see BlockList.mjs). CommentsSidebar
// is its own fixed right-hand overlay (see detail-layout.md) — mounted
// alongside, not nested inside DetailPanel's <main>, since it's reached via
// `g` rather than <main>'s column flow.
const app = document.getElementById('app')
PrInfoPanel(state)(app)
BlockList(state)(app)
DetailPanel(state)(app)
CommentsSidebar(
  state,
  commentTarget,
  () => {
    if (composeHasText()) openMenu('compose')
  },
  openTask
)(app)
MenuHost()(app)
// The call-arrow overlay: one static fixed <svg> drawn imperatively (see
// src/callArrows.mjs). Top-level like MenuHost — inside <main> its z-index
// would be capped at <main>'s own z-10 stacking context.
CallArrowsHost()(app)
Footer(state)(app)

// Start with the search box already focused so the reviewer can type straight
// away — a frame later, once BlockList has rendered the input into the DOM.
// Only when landing in list mode: a diff deep-link (state.mode restored to
// 'diff' from the URL, see bindUrlState above) must not hijack keyboard focus
// into the search box. Without this guard, state.searchActive ended up true
// while state.mode stayed 'diff', so onKeydown's searchActive branch (which
// assumes list mode) caught a bare ArrowLeft before the diff-mode branch ever
// ran, jumping straight to stop 1 (the description) instead of stop 2 (the
// block index) — and left mode:'diff' + showDescription:true simultaneously
// true, an invalid combination the layout never expects (see the
// state.mode==='diff' ? 'left-6' : ... ternary above), which is what made the
// description render behind the diff card instead of beside it.
if (state.mode === 'list') requestAnimationFrame(activateSearch)

// Kick off the initial load.
loadBlocks()
loadPRMeta()
pollWorkflows()
setInterval(pollWorkflows, WORKFLOWS_POLL_MS)
