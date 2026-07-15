// home.mjs — page module for the PR Review Tree dashboard.
// Fetches the blocks of a PR, mounts the BlockList sidebar, and owns the global
// up/down keyboard navigation through the flat list.

import { reactive, html, watch } from './vendor/arrow.js'
import BlockList from './BlockList.mjs'
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
} from './Block.mjs'
import RelatedPanel, {
  startComment,
  createComment,
  placeComment,
  isComposeOpen,
  composeHasText,
  relatedActive,
  enterRelated,
  leaveRelated,
  handleRelatedKey,
  isCodeFocused,
  isCommentFocused,
  commentReplyEmpty,
  commentSelIndex,
  deleteFocusedComment,
  commentRowSet,
  setCommentScope,
  setRelated,
  focusedRelatedChild,
  selectComment,
  isTaskFocused,
  focusedTaskRun,
  taskRuns,
} from './RelatedPanel.mjs'
import CommandMenu, { filterCommands } from './CommandMenu.mjs'
import { bindUrlState, num } from './urlState.mjs'

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
  // approveRunId — the Run ID of this PR's `approve` workflow (durable approval
  // tracker), filled by loadApprovals via POST /api/workflows/approve. Every
  // approve/un-approve toggle signals the new full state for that block to this
  // Run ID (.../signals/set). Empty until the ensure-call returns (offline: stays
  // empty and approval is then session-only).
  approveRunId: '',
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
  // focusLevel — which column currently owns the diff keyboard (↑/↓ walk its
  // changes, → opens its Onderliggende-code panel): 0 is the top-level selected
  // block (state.change/state.gran), 1..drill.length indexes drill[level-1] /
  // drillCursor[level-1]. Drilling in (drillIntoChild) jumps focus to the fresh
  // (deepest) column; ← steps focus back one column at a time without closing
  // any of them, until level 0, where ← falls through to the existing
  // diff→list transition. focusedBlock() follows this, not always the deepest
  // entry, so the Onderliggende-code panel + tasks slide along with the focus.
  focusLevel: 0,
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
})

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

// setGran changes the selection granularity by `delta` (+1 finer with f, -1
// coarser with d) and re-anchors `change` onto the unit covering the row we were
// on, so refining a group lands on its first line, refining a line on its first
// call segment, and coarsening walks back up the same rows.
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
  state.gran = GRANS[to]
  const units = unitsFor(rows, state.gran)
  state.change = units.length ? unitAtRow(units, anchorRow) : 0
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
    state.change = state.change + 1
    scrollChangeIntoView()
  }
}

function prevChange() {
  if (state.change <= 0) {
    stepBlock(-1)
  } else {
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
// For a focused drilled column it does the same, scoped to its own drillCursor,
// except at the first call it always zooms out (no same-file column to flow into).
function dKey() {
  if (state.mode !== 'diff') return
  const level = state.focusLevel
  if (level > 0) {
    const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
    if (cur.gran === 'call' && cur.change > 0) drillPrevChange()
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
  loadCallResolve()
  loadApprovals()
  loadBlockStats()
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
// children AND PR blocks that are the definition of a resolved method call
// (i.e. already shown in "Onderliggende code"). A called-and-shown function
// shouldn't also sit in the left list. Selection is preserved by block id so a
// callResolve reload (poll after a search) doesn't jump the cursor.
function recomputeLeftList() {
  const hidden = new Set(state.relations.map((r) => r.childId))
  for (const id of resolvedCallTargetIds()) hidden.add(id)
  const selId = state.blocks[state.selected] && state.blocks[state.selected].id
  const q = (state.search || '').trim().toLowerCase()
  state.blocks = state.allBlocks
    .filter((b) => !hidden.has(b.id))
    .filter((b) => !q || (b.label + ' ' + b.category).toLowerCase().includes(q))
  const at = state.blocks.findIndex((b) => b.id === selId)
  state.selected = at >= 0 ? at : Math.min(state.selected, Math.max(0, state.blocks.length - 1))
}

// setSearch is the search box's input handler: refilter the left list and jump
// the selection to the top match so ↑/↓ walk the results from the first hit.
function setSearch(q) {
  state.search = q
  recomputeLeftList()
  state.selected = 0
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
// else here is a read.
function loadPRMeta() {
  fetch('/api/workflows/pr_status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr: state.pr }),
  }).catch(() => {
    /* offline — the poll below still reads whatever the read-model already has */
  })
  pollPRMeta(0)
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

// childrenOf returns the child block objects of parent block b (the blocks it
// is linked to, e.g. the Listener::handle for an event it dispatches).
function childrenOf(b) {
  if (!b || !state.relations || state.relations.length === 0) return []
  return state.relations
    .filter((r) => r.parentId === b.id)
    .map((r) => state.allBlocks.find((x) => x.id === r.childId))
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
  // Cursor-based scoping (state.change/gran) only makes sense for the block the
  // reviewer is actually stepping through with the keyboard — the top-level
  // selected block. A drilled-into child has no navigable cursor of its own (only
  // its Onderliggende-code panel is interactive), so it always shows its full call
  // list, like list mode.
  if (state.drill.length && b !== curBlock()) return null
  const unit = unitsFor(rows, state.gran)[state.change]
  if (!unit) return null
  const methods = new Set()
  for (const r of callRows(b)) {
    const sites = findCallSites(rows, r.callKey)
    const inScope =
      state.gran === 'call'
        ? sites.some((s) => s.row === unit.start && s.segStart === unit.segStart)
        : sites.some((s) => s.row >= unit.start && s.row <= unit.end)
    if (inScope) methods.add(r.callKey)
  }
  return methods
}

// relatedChildren describes the selected block's children for the RelatedPanel:
// the resolved method calls it makes (coupled to the call in the diff) plus the
// event listeners it is linked to. It lazily loads any child block's code and
// returns a small descriptor per child. Reactive — reading state.selected/mode/
// gran/change/relations/callResolve + each child's code — so the panel follows
// the cursor and re-renders as child code arrives.
//
// Ordering (coarser than 'call'; see resolvedCallChildren for the per-item prio):
// a called method whose definition is *also changed in this PR* comes first, then
// calls sitting on a recently-changed diff line, then the rest. At 'call'
// granularity the list is narrowed to just the active call's method, so the event
// listeners (a block-level relation, not this call) are dropped there.
// codeSize counts the non-blank lines of a child's source — a rough "how much
// code changed here" measure used to order same-priority children in the
// Onderliggende-code panel (substantial methods above one-line accessors).
function codeSize(code) {
  if (!code) return 0
  return code.split('\n').filter((l) => l.trim()).length
}

function relatedChildren(b) {
  // Call-level scoping (dropping the block-level event listeners) only applies
  // to the top-level selected block's own cursor — a drilled-into child has no
  // independent gran/change cursor (see callScopeMethods).
  const isTopCursor = b === curBlock() && !state.drill.length
  const scoped = isTopCursor && state.mode === 'diff' && state.gran === 'call'
  const evt = scoped
    ? []
    : childrenOf(b).map((kid) => {
        ensureCode(kid)
        const c = kid.code && !kid.code.error ? kid.code : null
        const code = (c && ((c.new && c.new.text) || (c.old && c.old.text))) || ''
        // A listener is by definition a changed child block, so it sorts to the top.
        return { id: kid.id, label: kid.label, file: kid.file, line: kid.line, kind: 'event_listener', code, size: codeSize(code), prio: 0, approve: blockApproveCount(kid) }
      })
  // Resolved/found method calls (Go statically or LLM). Their code + descriptor
  // ride along in the callresolve row (unchanged file → no /api/code fetch).
  const calls = resolvedCallChildren(b)
  // Sort by priority (0 = also-changed child block, 1 = call on a changed line,
  // 2 = unchanged call), then — within a priority — biggest child first, so the
  // substantial modified code the reviewer cares about leads while trivial
  // one-liners (e.g. Eloquent relation accessors, which are also `added` PR
  // blocks and thus tie at prio 0) drop below it. `size` is the child's line
  // count (embedded childCode for calls, loaded code for listeners); a child
  // whose code hasn't arrived yet is size 0 and sinks until it loads. Ties keep
  // the resolver-emit (source) order (Array.prototype.sort is stable).
  return evt.concat(calls).sort((x, y) => x.prio - y.prio || y.size - x.size)
}

// resolvedCallChildren maps the caller block's resolved/found call rows to child
// descriptors for the Onderliggende-code panel — scoped to the current call (at
// gran 'call') and tagged with an ordering priority. `source` names the LLM model
// when it was resolved by one (status found); Go-resolved rows leave it empty.
function resolvedCallChildren(b) {
  if (!b) return []
  const resolved = callRows(b).filter((r) => r.status === 'resolved' || r.status === 'found')
  if (resolved.length === 0) return []
  const rows = blockRows(b)
  const scope = callScopeMethods(b, rows)
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  const changed = new Set(changedRows(rows))
  return resolved
    .filter((r) => scope == null || scope.has(r.callKey))
    .map((r) => {
      const childId = callChildId(r)
      const prBlock = byId.get(childId)
      // Lazily load the called definition's code so its diff-stat can be counted
      // (mirrors relatedChildren loading a listener's code).
      if (prBlock) ensureCode(prBlock)
      const onChangedLine = findCallSites(rows, r.callKey).some((s) => changed.has(s.row))
      return {
        id: b.id + '::' + r.callKey,
        // The PR-block id this call resolves to, when its definition is itself
        // changed in this PR (prBlock). Distinct from `id` (which is caller-scoped
        // so each call-site stays its own panel row); drillIntoChild uses this to
        // reuse the real block object — with its own diff, approval and recursive
        // Onderliggende-code panel — instead of a code-only synthetic frame.
        blockId: prBlock ? prBlock.id : '',
        label: r.childClass ? `${r.childClass}::${r.childMethod}` : r.childMethod || r.callKey,
        file: r.childFile,
        line: r.childLine,
        kind: 'method_call',
        code: r.childCode || '',
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
      }
    })
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

// directChildBlocks returns the immediate PR-block children of b — the blocks
// pulled out of the left list and shown under it in the RelatedPanel: its
// relation children plus the resolved/found method calls whose definition is
// itself a PR block. Method calls into unchanged files aren't PR blocks (no
// approval concept), so they're excluded.
function directChildBlocks(b) {
  if (!b) return []
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  const ids = new Set()
  for (const r of state.relations || []) if (r.parentId === b.id) ids.add(r.childId)
  for (const r of callRows(b)) {
    if (r.status !== 'resolved' && r.status !== 'found') continue
    if (byId.has(callChildId(r))) ids.add(callChildId(r))
  }
  return [...ids].map((id) => byId.get(id)).filter(Boolean)
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
      // Likewise a restored 'diff' mode is meaningless for a block with no
      // navigable changes; fall back to the list instead of a dead diff view.
      if (state.mode === 'diff' && groups.length === 0) state.mode = 'list'
      scrollChangeIntoView(state.mode === 'diff')
    } else if (state.drill[state.focusLevel - 1] === b) {
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
    const el = document.querySelector(`[data-idx="${state.selected}"]`)
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
      el.scrollIntoView({ block: 'center' })
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
// first change (added, removed or modified line). Does nothing for a block with
// no navigable changes.
function enterDiff() {
  const b = state.blocks[state.selected]
  if (groupsFor(b).length === 0) return
  state.mode = 'diff'
  // Stepping in from the list always starts at the coarsest granularity (a whole
  // change run); the reviewer refines from there with f.
  state.gran = 'group'
  state.change = 0
  // Defensive: a fresh diff session starts with no drilled columns and the
  // keyboard on the top-level block itself (drill/focusLevel should already be
  // empty/0 here — the diff→list transition clears them — but reset in case
  // this is ever reached some other way, e.g. a future URL restore).
  state.drill = []
  state.drillCursor = []
  state.focusLevel = 0
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
// `sub` holds a parent command's children while a submenu is open (null at the
// root). Choosing a command with `children` (e.g. "Open GitHub") swaps the list to
// those children instead of running; Esc backs out to the root.
// `mode` selects which command list resolveCommands shows: 'block' (the
// default, the block palette opened by Enter), 'comment' (opened by Enter on a
// focused, not-yet-replied-to comment row — see COMMENT_COMMANDS), 'pr' (the
// general PR-wide tree menu opened by `/` — see PR_COMMANDS), or 'compose' (the
// comment-kind menu opened on a filled composer — see COMPOSE_COMMANDS).
const menu = reactive({ open: false })
let ms = reactive({ query: '', sel: 0, sub: null, mode: 'block' })

// COMMENT_COMMANDS — shown when Enter is pressed on a focused comment row
// (not mid-reply): currently just deleting it. Kept separate from COMMANDS
// (block actions) since a comment isn't tied to the selected block/diff.
const COMMENT_COMMANDS = [
  {
    id: 'delete-comment',
    label: 'Verwijder comment',
    hint: 'delete',
    run: () => deleteFocusedComment(),
  },
]

// COMPOSE_COMMANDS — shown when Enter (or the composer button) is pressed on a
// filled new-comment composer (menu mode 'compose'): choose what to do with the
// typed text. Only "Alleen voor mijzelf" acts today — it places a private note
// (createComment with local:true → the workflow skips the GitHub post). The
// Claude/Git/Jira items are placeholders (like the Jira items in PR_COMMANDS).
// The Git label names the current selection unit (groep/regel/call) via granNoun.
const COMPOSE_COMMANDS = [
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
    run: () => placeComment(state, commentTarget, { local: true }),
  },
  {
    id: 'compose-jira',
    label: 'Jira',
    hint: 'jira',
    // A submenu (see runCommand). All three are placeholders — no Jira write yet.
    children: [
      { id: 'compose-jira-comment', label: 'Comment op ticket', hint: 'todo', run: () => {} },
      { id: 'compose-jira-subtask', label: 'Subtaak aanmaken', hint: 'todo', run: () => {} },
      { id: 'compose-jira-task', label: 'Nieuwe taak aanmaken', hint: 'todo', run: () => {} },
    ],
  },
]

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

// drillNextChange / drillPrevChange walk the *drilled* column that currently
// owns the diff keyboard (state.focusLevel > 0) through the units of its own
// current granularity (drillCursor.gran) — the same unitsFor walk as the
// top-level nextChange/prevChange, just scoped to that column's rows. Unlike
// the top level, a drilled column never flows into a same-file neighbour — it's
// a single, self-contained diff — so this just clamps at both ends.
function drillNextChange() {
  const level = state.focusLevel
  const b = state.drill[level - 1]
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  const units = unitsFor(blockRows(b), cur.gran)
  if (cur.change < units.length - 1) {
    setDrillChange(level, cur.change + 1)
    scrollChangeIntoView()
  }
}

function drillPrevChange() {
  const level = state.focusLevel
  const cur = state.drillCursor[level - 1] || { change: 0, gran: 'group' }
  if (cur.change > 0) {
    setDrillChange(level, cur.change - 1)
    scrollChangeIntoView()
  }
}

// setDrillChange reassigns state.drillCursor wholesale (never mutates an entry
// in place) so arrow.js's reactive activeGroup binding on that drilled column's
// card re-fires — the same "always reassign, never mutate" rule as
// b.approvedRows elsewhere in this file. Keeps the entry's current `gran`.
function setDrillChange(level, change) {
  state.drillCursor = state.drillCursor.map((c, i) =>
    i === level - 1 ? { ...(c || { gran: 'group' }), change } : c,
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

// drillIntoChild opens a child from the Onderliggende-code panel as its own diff
// column, appended to the right of the current drill stack (Enter on a resolved
// child in the panel — see the Enter handling in onKeydown). If the child is
// itself a real PR block (already in state.allBlocks) we push that exact object:
// its relations/callResolve/approvedRows already work, so its own
// Onderliggende-code panel falls out for free (relatedChildren/resolvedCallChildren/
// callRows are generic over any block id). Otherwise (a resolved call into an
// unchanged file, with no PR block of its own) we build a minimal, non-interactive
// synthetic frame and lazily fetch its code the same way a real block does.
function drillIntoChild(child) {
  if (!child) return
  const byId = new Map(state.allBlocks.map((x) => [x.id, x]))
  // A method-call child's own `id` is caller-scoped (b.id + '::' + callKey), so it
  // never matches a real block; its `blockId` points at the definition's PR block
  // when that definition is itself changed here. Relation children carry their real
  // block id directly in `id`. Try both, preferring the explicit target block id.
  const existing = byId.get(child.blockId) || byId.get(child.id)
  if (existing) {
    state.drill = [...state.drill, existing]
    // A relation-child gets its code lazily loaded elsewhere (relatedChildren);
    // a method-call child's PR-block definition might not have its own diff
    // fetched yet (its row only carries the plain code text) — ensure it here.
    ensureCode(existing)
  } else {
    const hasClass = !!(child.label && child.label.includes('::'))
    // The call-row already carries the called definition's source text
    // (r.childCode → child.code). The file is unchanged by this PR, so /api/code
    // has no stored block for it (the fetch would never yield a diff and the card
    // would hang on "loading"). Build the code inline instead: old === new (nothing
    // changed here), so alignRows renders all-equal rows — the plain source, no
    // diff highlight. Only fall back to a fetch if we somehow have no text.
    const src = child.code || ''
    const start = child.line || 1
    const frame = {
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
    state.drill = [...state.drill, frame]
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
function commentTarget() {
  const b = curBlock()
  if (!b) return null
  const rows = blockRows(b)
  const gran = state.mode === 'diff' ? state.gran : 'group'
  const idx = state.mode === 'diff' ? state.change : 0
  const unit = unitsFor(rows, gran)[idx]
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
watch(
  () => [state.selected, state.mode, state.change, state.gran, state.blocks, curBlock() && curBlock().code],
  () => setCommentScope(commentScope()),
)

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
    // codeVersion so a child block's lazily-loaded code (and thus its approval
    // count + code excerpt) refreshes the panel; approvalSummaries so a change
    // in approval re-renders the per-child badges.
    state.codeVersion,
    state.approvalSummaries,
    state.blockTotals,
    state.drill,
    focusedBlock() && focusedBlock().code,
  ],
  () => {
    const b = focusedBlock()
    setRelated(relatedChildren(b), unresolvedCalls(b))
    // Auto-run the LLM fallback for any calls the Go resolver couldn't pin — no
    // button (deduped per caller+callKey in searchRequested, so this cheap on
    // every panel re-fire).
    startCallSearch(b)
  },
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

// approveNoun names what an approve action *right now* covers, for the label: the
// whole block in list mode, else the current navigation unit at the active
// granularity (a run of lines / one line / one call).
function approveNoun() {
  if (state.mode !== 'diff') return 'dit block'
  if (state.gran === 'line') return 'deze regel'
  if (state.gran === 'call') return 'deze call'
  return 'deze regels'
}

// approveTargetRows returns the changed row indices an approve action covers now:
// the current navigation unit's rows in diff mode, or the whole block in list mode
// (where there's no active unit).
function approveTargetRows() {
  const b = curBlock()
  if (!b) return []
  const rows = blockRows(b)
  const all = changedRows(rows)
  if (state.mode !== 'diff') return all
  const unit = unitsFor(rows, state.gran)[state.change]
  if (!unit) return all
  return all.filter((i) => i >= unit.start && i <= unit.end)
}

// toggleApprove approves (or, if already fully approved, un-approves) exactly the
// rows the current unit covers. Approving every changed row of the block flips its
// derived top-level `approved` on; un-approving any flips it back off. Always
// reassigns b.approvedRows so arrow.js re-renders the checkbox and the pane bars.
// At call granularity a row can hold several call segments, so that case defers
// to toggleCallApprove, which approves just the one segment instead of the whole
// row.
function toggleApprove() {
  const b = curBlock()
  if (!b) return
  if (state.mode === 'diff' && state.gran === 'call') {
    toggleCallApprove(b)
    return
  }
  const target = approveTargetRows()
  if (!target.length) return
  const set = approvedRowSet(b)
  const allIn = target.every((i) => set.has(i))
  target.forEach((i) => (allIn ? set.delete(i) : set.add(i)))
  b.approvedRows = [...set].sort((x, y) => x - y)
  persistApproval(b)
}

// toggleCallApprove flips approval of exactly the one call segment the
// keyboard is currently on (state.change at gran 'call'), tracked at
// sub-row granularity in b.approvedCalls (see callKey). A row that was fully
// approved is first expanded into its individual segment keys so unapproving
// one doesn't lose the others; conversely, once every segment of a row ends up
// approved, it graduates into b.approvedRows (and its approvedCalls entries are
// dropped) so the coarser group/line approval and the checkbox summary see it
// too. Both arrays are always reassigned, never mutated in place, so arrow.js
// re-renders the checkmark/circle indicators.
function toggleCallApprove(b) {
  const rows = blockRows(b)
  const unit = unitsFor(rows, 'call')[state.change]
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
}

const COMMANDS = [
  {
    id: 'approve',
    label: () => {
      const b = curBlock()
      const noun = approveNoun()
      let done
      if (b && state.mode === 'diff' && state.gran === 'call') {
        const unit = unitsFor(blockRows(b), 'call')[state.change]
        done = callUnitApproved(b, unit)
      } else {
        const set = b ? approvedRowSet(b) : new Set()
        const target = approveTargetRows()
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
    // than acting directly (see runCommand).
    children: [
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
    ],
  },
]

// PR_COMMANDS — the general, PR-wide tree menu opened with `/` (menu mode 'pr').
// Unlike COMMANDS (which acts on the selected block/diff), these are actions on
// the whole PR: jump to the overview, and GitHub/Jira with their own submenus.
// The Jira comment + subtask items are placeholders for now (no Jira write
// integration yet). GitHub "comment plaatsen" reuses the line-comment composer
// (startComment), same as the block menu. See the `/` handler in onKeydown.
const PR_COMMANDS = [
  {
    id: 'pr-overview',
    label: 'Naar PR-overzicht',
    hint: 'overzicht',
    run: () => window.location.assign('/pr-overview'),
  },
  {
    id: 'pr-github',
    label: 'GitHub',
    hint: 'github',
    children: [
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
    ],
  },
  {
    id: 'pr-jira',
    label: 'Jira',
    hint: 'jira',
    children: [
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
    ],
  },
]

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

// resolveCommands returns the commands to show for `query`: the fuzzy-matched
// COMMANDS, or — when nothing matches a non-empty query — a single fallback that
// opens the composer with the typed text pre-filled, so the reviewer can continue
// typing ("Maak hiermee een comment"). Shared by the menu render and the keyboard
// handler so both walk the same list.
function resolveCommands(query) {
  // The comment-scoped menu (Enter on a focused comment row) is just its own
  // small list — no submenu, no make-a-comment fallback.
  if (ms.mode === 'comment') return filterCommands(COMMENT_COMMANDS, query)
  // In a submenu we only show (and filter) that parent's children — no
  // make-a-comment fallback, since the submenu is a plain choice list.
  if (ms.sub) return filterCommands(ms.sub, query)
  // The PR-wide tree menu (opened with `/`) is a plain command list too — no
  // block actions, no comment fallback.
  if (ms.mode === 'pr') return filterCommands(PR_COMMANDS, query)
  // The comment-kind menu (Enter/button on a filled composer): choose Claude /
  // Git / private / Jira. The ms.sub check above already handles its Jira
  // submenu, so we only reach here at the root list.
  if (ms.mode === 'compose') return filterCommands(COMPOSE_COMMANDS, query)
  const list = filterCommands(COMMANDS, query)
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
// 'comment', 'pr' or 'compose'. It installs a FRESH `ms` reactive so the previous
// open's (undisposed) CommandMenu bindings can't fire when this menu mutates its
// state — see the note on the menu/ms split.
function openMenu(mode = 'block') {
  ms = reactive({ query: '', sel: 0, sub: null, mode })
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
  ms.sel = 0
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
        ms.sel = 0
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
      state.showDescription = true
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      state.selected = Math.min(state.selected + 1, state.blocks.length - 1)
      scrollSelectedIntoView()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      state.selected = Math.max(state.selected - 1, 0)
      scrollSelectedIntoView()
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault()
      exitSearch()
      enterDiff()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      exitSearch()
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

  // Once the reviewer has stepped into the right-hand Related panel (→ from the
  // diff) it owns the arrows: ↑/↓/←/→ walk the related block, comment index and
  // thread (see handleRelatedKey in RelatedPanel). Handled before Enter/f/d/s so
  // those stay suspended while the panel is active — but typed characters (letters,
  // Enter) are left alone so they flow into the focused reply field, like the menu.
  if (relatedActive()) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) {
      e.preventDefault()
      // taskRuns(state).length clamps cs.taskSel while the Taken stop (7) owns
      // the keyboard — see handleRelatedKey/taskRuns in RelatedPanel.mjs.
      handleRelatedKey(e.key, taskRuns(state).length)
      // Exiting the panel (← / Escape from the code card's first block) just
      // hands the keyboard back to the diff of whichever column is currently
      // focused (handleRelatedKey's exitRelated already did that) — it does
      // NOT close the drilled column. Stepping further left through the
      // drilled columns (or back to the list) is the diff-mode ArrowLeft
      // handling below (state.focusLevel), reached once relatedActive() is
      // false again.
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
    if (e.key === 'Enter' && isCodeFocused()) {
      e.preventDefault()
      const child = focusedRelatedChild()
      if (child) drillIntoChild(child)
    }
    // Enter on the Taken stop (7) opens the focused run the same way clicking it
    // does (openTask) — only meaningful for a task_code_comment run with a
    // resolved comment; a purely informational run is a silent no-op there too.
    if (e.key === 'Enter' && isTaskFocused()) {
      e.preventDefault()
      const run = focusedTaskRun(taskRuns(state))
      if (run) openTask(run)
    }
    return
  }

  // `/` opens the general PR-wide tree menu (overview / GitHub / Jira). Like
  // Enter it's handled before the empty-blocks guard so it works while loading.
  // A focused input (the comment composer/reply) is already handled by the
  // relatedActive() branch above, so a typed `/` there never reaches here.
  if (e.key === '/') {
    e.preventDefault()
    openMenu('pr')
    return
  }

  // Enter opens the palette at the next-block slot. Handled before the empty-blocks
  // guard so it works even while a PR is still loading.
  if (e.key === 'Enter') {
    e.preventDefault()
    openMenu()
    return
  }

  if (state.blocks.length === 0) return

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

  if (state.mode === 'diff') {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (state.focusLevel > 0) drillNextChange()
      else nextChange()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (state.focusLevel > 0) drillPrevChange()
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
        scrollFocusIntoView()
      } else {
        // Already on the top-level block's own diff (no drilled column focused):
        // the existing diff→list transition. Also drop any drilled columns —
        // they only make sense in the context of this diff session.
        state.mode = 'list'
        state.drill = []
        state.drillCursor = []
        scrollSelectedIntoView()
        refreshHints() // stepping back to the list hides the hints
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      enterRelated() // step into the right-hand Related panel of the focused column
    }
    return
  }

  // Stop 1 of the nav chain (the PR-description column) sits to the left of the
  // block-index and owns the keyboard while open: → closes it back to stop 2,
  // any other arrow is a no-op (it has no internal cursor to walk) so it doesn't
  // move the block selection underneath it.
  if (state.showDescription) {
    e.preventDefault()
    if (e.key === 'ArrowRight') state.showDescription = false
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    state.selected = Math.min(state.selected + 1, state.blocks.length - 1)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    state.selected = Math.max(state.selected - 1, 0)
    scrollSelectedIntoView()
    scrollChangeIntoView(false)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    enterDiff()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    state.showDescription = true // step left out of the list into stop 1 (the description)
  }
}

window.addEventListener('keydown', onKeydown)

// connector — the dashed vertical line drawn between two stacked cards that come
// from the same file, so a reviewer sees at a glance they belong together.
function connector() {
  return html`
    <div class="flex h-5 pl-8" data-testid="file-connector">
      <div class="border-l-2 border-dashed border-slate-300"></div>
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
        class="flex h-5 w-8 items-center justify-center rounded-full bg-slate-200 text-slate-500 shadow-sm ring-1 ring-black/5"
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
function stepChevronSlot(delta, dir) {
  return html`${() => (canStep(delta) ? stepChevron(dir) : '')}`
}

// menuAnchor returns the element the command palette floats *beneath* (its
// vertical anchor): in 'comment' mode, the focused comment row; otherwise the
// active change row (present in both list-preview and diff mode) if there is
// one, else the selected block's card, else the sidebar row. Always something
// on-screen so the menu opens under whatever is selected.
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
  return (
    document.querySelector('[data-change-active]') ||
    document.querySelector('[data-testid="detail-panel"] article') ||
    document.querySelector(`[data-idx="${state.selected}"]`)
  )
}

// menuRegion returns the element whose left+width the palette takes: in
// 'comment' mode, the comment thread pane (so it sits over the comments panel,
// under the focused row); otherwise the NEW (right) pane of the selected
// block's diff, so the menu is half the diff's width and sits over the
// right-hand side — the new code you're reviewing. Falls back to the OLD pane
// (a removed block has no new pane), then the whole block column.
function menuRegion() {
  // Both comment-scoped menus sit over the comment thread pane.
  if (ms.mode === 'comment' || ms.mode === 'compose') {
    return (
      document.querySelector('[data-testid="comment-thread"]') ||
      document.querySelector('[data-testid="comments-panel"]')
    )
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

// ── PR-info column ──────────────────────────────────────────────────────────
// prInfoCard renders the first column of <main>: PR title/Jira badge, meta
// (author/diffstat/branch/GitHub link), the Claude summary, the PR description
// (+ Jira description if any), and review/CI pills — each section appearing as
// soon as its stage of the pr_status workflow has landed in state.prMeta. Reads
// only state.prMeta/state.pr — never b.code, so it can't race the diff render
// (see conventions.md).

const REPO_SLUG = 'plug-and-pay/plug-and-pay'

function prPill(text, cls) {
  return html`<span
    class="${'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ' + cls}"
    >${text}</span
  >`
}

function prReviewPill(meta) {
  const d = meta.reviewDecision
  if (d === 'APPROVED') return prPill('Goedgekeurd', 'bg-emerald-50 text-emerald-700 ring-emerald-200')
  if (d === 'CHANGES_REQUESTED') return prPill('Wijzigingen gevraagd', 'bg-rose-50 text-rose-700 ring-rose-200')
  return prPill('Wacht op review', 'bg-amber-50 text-amber-700 ring-amber-200')
}

function prChecksPill(meta) {
  const total = Number(meta.checksTotal) || 0
  if (!total) return null
  const passed = Number(meta.checksPassed) || 0
  if (passed >= total) return prPill('✓ ' + total + ' checks', 'bg-emerald-50 text-emerald-700 ring-emerald-200')
  return prPill(passed + '/' + total + ' checks', 'bg-slate-100 text-slate-600 ring-slate-200')
}

function prStatusSlot(meta) {
  const statusesIn = meta.reviewDecision !== '' || (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) || meta.checksTotal > 0
  if (!statusesIn) {
    return [
      html`<span
        class="inline-flex w-24 animate-pulse items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] ring-1 ring-inset ring-slate-200"
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
            class="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200"
            >${login}</span
          >`.key('rev:' + i + ':' + login),
        )}
      </span>`.key('reviewers'),
    )
  }
  return pills.filter(Boolean)
}

function prInfoCard(state) {
  return html`
    <div
      class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid="pr-info-card"
    >
      <div>
        <div class="flex items-start gap-2">
          <h1 class="min-w-0 flex-1 text-lg font-semibold leading-snug text-slate-900" data-testid="pr-info-title">
            ${() => state.prMeta.title || `PR #${state.pr}`}
          </h1>
          ${() =>
            state.jiraKey
              ? html`<a
                  href="${() => state.prMeta.jiraUrl || JIRA_BASE + state.jiraKey}"
                  target="_blank"
                  rel="noreferrer"
                  class="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-inset ring-indigo-200 hover:bg-indigo-100"
                  data-testid="pr-info-jira-key"
                  >${state.jiraKey}</a
                >`
              : ''}
        </div>
        <div class="mt-0.5 font-mono text-[11px] text-slate-400">${REPO_SLUG}#${state.pr}</div>
      </div>
      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-slate-500" data-testid="pr-info-meta">
        ${() => (state.prMeta.author ? html`<span>${state.prMeta.author}</span>` : '')}
        ${() =>
          state.prMeta.author && (state.prMeta.additions || state.prMeta.deletions)
            ? html`<span class="text-slate-300">·</span>`
            : ''}
        ${() =>
          state.prMeta.additions || state.prMeta.deletions
            ? html`<span
                ><span class="font-medium text-emerald-600">+${state.prMeta.additions || 0}</span>
                <span class="font-medium text-rose-600">−${state.prMeta.deletions || 0}</span></span
              >`
            : ''}
        ${() => (state.prMeta.changedFiles ? html`<span class="text-slate-300">·</span>` : '')}
        ${() => (state.prMeta.changedFiles ? html`<span>${state.prMeta.changedFiles} bestanden</span>` : '')}
        ${() => (state.prMeta.headRef ? html`<span class="text-slate-300">·</span>` : '')}
        ${() =>
          state.prMeta.headRef
            ? html`<span class="truncate font-mono text-sky-600" title="Huidige branch">${state.prMeta.headRef}</span>`
            : ''}
        ${() => (state.prUrl ? html`<span class="text-slate-300">·</span>` : '')}
        ${() =>
          state.prUrl
            ? html`<a href="${state.prUrl}" target="_blank" rel="noreferrer" class="text-indigo-600 hover:underline"
                >op GitHub ›</a
              >`
            : ''}
      </div>
      <div data-testid="pr-info-summary">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Samenvatting</div>
        ${() =>
          state.prMeta.summary
            ? html`<p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">${state.prMeta.summary}</p>`
            : html`<p class="text-[13px] italic text-slate-400">samenvatting genereren…</p>`}
      </div>
      <div data-testid="pr-info-body">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Omschrijving</div>
        ${() =>
          state.prMeta.body
            ? html`<p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">${state.prMeta.body}</p>`
            : html`<p class="text-[13px] text-slate-400">geen omschrijving</p>`}
        ${() =>
          state.prMeta.jiraTitle
            ? html`<div class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5" data-testid="pr-info-jira">
                <div class="text-[12px] font-medium text-slate-700">Jira: ${state.prMeta.jiraTitle}</div>
                ${state.prMeta.jiraDesc
                  ? html`<p class="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">${state.prMeta.jiraDesc}</p>`
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

// DetailPanel — the area right of the fixed sidebar. It shows the block card for
// the selected row, and the next row's card already (a look-ahead preview). When
// both cards are from the same file, a dashed connector links them.
function DetailPanel(state) {
  return html`
    <main
      class="${() =>
        'fixed bottom-[100px] right-6 top-6 z-10 flex min-h-0 flex-row gap-4 overflow-x-auto transition-all duration-200 ease-out ' +
        (state.mode === 'diff' ? 'left-6' : 'left-[29rem]')}"
      data-testid="detail-panel"
    >
      ${() =>
        state.showDescription
          ? html`<div class="flex min-h-0 w-[26rem] shrink-0 flex-col" data-testid="pr-info-column">
              ${prInfoCard(state)}
            </div>`.key('pr-info-column')
          : ''}
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
          const card = Block(b, {
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
              // current granularity's units (a run, a line, or a call segment).
              if (state.mode !== 'diff') return groupsFor(b)[0] || null
              return unitsOf(b)[state.change] || null
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
          }).key(
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
          return html`
            <div class="relative flex min-h-0 shrink-0 flex-col gap-3" data-testid="drill-column" data-drill-idx="${i}">
              ${focusedHere
                ? html`
                    <div
                      class="pointer-events-none absolute -left-3 top-1/2 z-10 -translate-y-1/2"
                      data-testid="drill-left-hint"
                    >
                      <span
                        class="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-slate-500 shadow-sm ring-1 ring-black/5"
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
                  return unitsFor(blockRows(b), cur.gran)[cur.change] || null
                },
                hintsEnabled: () => state.focusLevel === level,
                diffActive: () => state.focusLevel === level && !relatedActive(),
                approvedRows: () => approvedRowSet(b),
                approvedCalls: () => approvedCallSet(b),
                onApprove: (blk) => persistApproval(blk),
                commentedRows: () => commentRowSet(b),
              })}
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
        RelatedPanel(state, commentTarget, { drill: (child) => drillIntoChild(child), openTask }, () => {
          if (composeHasText()) openMenu('compose')
        }).key('related-panel')}
      ${() => (menu.open ? menuOverlay().key('command-overlay') : '')}
    </main>
  `
}

// Mount the sidebar and the detail panel into #app.
const app = document.getElementById('app')
BlockList(state)(app)
DetailPanel(state)(app)
Footer(state)(app)

// Start with the search box already focused so the reviewer can type straight
// away — a frame later, once BlockList has rendered the input into the DOM.
requestAnimationFrame(activateSearch)

// Kick off the initial load.
loadBlocks()
loadPRMeta()
pollWorkflows()
setInterval(pollWorkflows, WORKFLOWS_POLL_MS)
