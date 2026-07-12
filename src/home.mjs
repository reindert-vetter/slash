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
  relatedActive,
  enterRelated,
  handleRelatedKey,
  isCommentFocused,
  commentReplyEmpty,
  commentSelIndex,
  deleteFocusedComment,
  commentRowSet,
  setCommentScope,
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
  // blocks — the top-level blocks shown in the sidebar and walked by the
  // navigation: the full set minus any block that is a child in a relation
  // (those are nested under their parent in the RelatedPanel instead). allBlocks
  // keeps the full set for id→block lookup + rendering children. relations are
  // the parent→child edges (GET /api/relations), built by the build_relations
  // workflow.
  blocks: [],
  allBlocks: [],
  relations: [],
  selected: 0,
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
  ingesting: false,
  error: '',
  onIngest: ingest,
})

// Persist the navigation position in the URL so a refresh (or a shared link)
// reopens the same selected block, mode and change. The PR itself lives in the
// path (/pr/<id>), not the query string. Bare params are the main navigation;
// future extra windows bind their own state with their own `ns` so their params
// sit alongside these in the same query string. Do this before the first render
// so restored values are already in `state`.
bindUrlState(state, [
  { key: 'selected', param: 'sel', parse: num(0), default: 0 },
  { key: 'mode', param: 'mode', default: 'list' },
  { key: 'change', param: 'chg', parse: num(0), default: 0 },
  { key: 'gran', param: 'gran', default: 'group' },
])

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
// block, like ↓).
function fKey() {
  if (state.mode !== 'diff') {
    enterDiff()
    return
  }
  if (state.gran === 'call') nextChange()
  else setGran(1)
}

// dKey — go back. On 'call' it steps to the previous call (flowing back into the
// previous same-file block like ↑); at the very first call, with nowhere to flow,
// it zooms back out to 'line'. On the coarser levels it just zooms out one step.
function dKey() {
  if (state.mode !== 'diff') return
  if (state.gran === 'call' && (state.change > 0 || sameFileNeighbour(-1))) prevChange()
  else setGran(-1)
}

// sKey — always zoom out one level (call → line → group), clamped at 'group'.
function sKey() {
  if (state.mode === 'diff') setGran(-1)
}

async function loadBlocks() {
  const res = await fetch(`/api/blocks?pr=${state.pr}`)
  if (!res.ok) {
    state.error = `load failed: ${res.status}`
    return
  }
  const blocks = await res.json()
  const all = Array.isArray(blocks) ? blocks : []
  // Fetch the relations and pull any child block out of the left list — it is
  // nested under its parent in the RelatedPanel. What's left stays on the left.
  const rels = await loadRelations()
  const childIds = new Set(rels.map((r) => r.childId))
  state.allBlocks = all
  state.relations = rels
  state.blocks = all.filter((b) => !childIds.has(b.id))
  if (state.selected >= state.blocks.length) {
    state.selected = Math.max(0, state.blocks.length - 1)
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

// loadPRMeta ensures the per-PR pr_status tracker is running (its start fetches
// the PR's title + URL into the prmeta read-model) and then reads that read-model
// into state, deriving the Jira ticket key from the title. Both steps are
// best-effort — offline/no-gh runs simply leave the menu's links on their
// fallbacks (plain GitHub PR URL, Jira base). Starting the tracker is a
// sanctioned UI write path (an Execution start); everything else is a read.
async function loadPRMeta() {
  try {
    await fetch('/api/workflows/pr_status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr }),
    })
  } catch (_) {
    /* offline — fall through to read whatever the read-model already has */
  }
  try {
    const res = await fetch(`/api/pr?pr=${state.pr}`)
    if (!res.ok) return
    const meta = await res.json()
    if (!meta || !meta.ok) return
    state.title = meta.title || ''
    state.prUrl = meta.url || ''
    const m = state.title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)
    state.jiraKey = m ? m[1] : ''
  } catch (_) {
    /* transient — the menu keeps its fallback links */
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

// relatedChildren describes the selected block's children for the RelatedPanel:
// it lazily loads each child's code and returns a small descriptor per child.
// Reactive — reading state.selected/relations + each child's code, so the panel
// re-renders as the selection changes and as child code arrives.
function relatedChildren() {
  const b = state.blocks[state.selected]
  return childrenOf(b).map((kid) => {
    ensureCode(kid)
    const c = kid.code && !kid.code.error ? kid.code : null
    const code = (c && ((c.new && c.new.text) || (c.old && c.old.text))) || ''
    return { id: kid.id, label: kid.label, file: kid.file, line: kid.line, kind: 'event_listener', code }
  })
}

// codeRequested guards against re-fetching the source of a block we've already
// asked for. Kept outside the reactive state so reading it never creates a
// dependency (which would loop with the b.code writes below).
const codeRequested = new Set()

// ensureCode lazily fetches the old/new source of a block and stashes it on the
// block as `b.code` (reactive → the Block card re-renders). `b.code` is null
// while loading, then { file, old, new } or { error }.
async function ensureCode(b) {
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
      return
    }
    b.code = await res.json()
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
    }
    // Show the out-of-view hints for this freshly-rendered diff (its own card and
    // the look-ahead preview both land here). scrollChangeIntoView only fires for
    // the selected card, and only when a scroll actually happens.
    refreshHints()
  } catch (e) {
    b.code = { error: String(e) }
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
  scrollChangeIntoView()
}

// ── Command palette (`/`) ─────────────────────────────────────────────────────
// The `/` key opens a searchable command menu overlaid on the next-block preview
// slot (see DetailPanel). `menu` is a small reactive owning its open/query/selection
// state; it stays out of the URL (not in the bindUrlState list) since it's
// ephemeral. COMMANDS close over the navigation functions above, so the menu drives
// the same actions the keyboard does — plus block actions (approve, comment, GitHub).
// `sub` holds a parent command's children while a submenu is open (null at the
// root). Choosing a command with `children` (e.g. "Open GitHub") swaps the list to
// those children instead of running; Esc backs out to the root.
// `mode` selects which command list resolveCommands shows: 'block' (the
// default, the block palette opened by Enter), 'comment' (opened by Enter on a
// focused, not-yet-replied-to comment row — see COMMENT_COMMANDS), or 'pr' (the
// general PR-wide tree menu opened by `/` — see PR_COMMANDS).
const menu = reactive({ open: false, query: '', sel: 0, sub: null, mode: 'block' })

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

function curBlock() {
  return state.blocks[state.selected]
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
  if (!unit)
    return { gran, label: b.label, file: b.file, line: b.line, code: '', rowStart: -1, rowEnd: -1, seg: '' }
  let code = ''
  for (let i = unit.start; i <= unit.end; i++) {
    const r = rows[i]
    const text = r && (r.right != null ? r.right : r.left)
    if (text != null) code += (code ? '\n' : '') + text
  }
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
  }
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
  if (menu.mode === 'comment') return filterCommands(COMMENT_COMMANDS, query)
  // In a submenu we only show (and filter) that parent's children — no
  // make-a-comment fallback, since the submenu is a plain choice list.
  if (menu.sub) return filterCommands(menu.sub, query)
  // The PR-wide tree menu (opened with `/`) is a plain command list too — no
  // block actions, no comment fallback.
  if (menu.mode === 'pr') return filterCommands(PR_COMMANDS, query)
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

// openMenu opens the palette, resets the query/selection, then a frame later
// (once it's rendered and its size is known) focuses the input and positions it
// just beneath the current selection. `mode` picks the command list (see
// resolveCommands): 'block' (default) or 'comment'.
function openMenu(mode = 'block') {
  menu.mode = mode
  menu.query = ''
  menu.sel = 0
  menu.sub = null
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
  menu.open = false
  menu.query = ''
  menu.sel = 0
  menu.sub = null
  menu.mode = 'block'
}

// enterSubmenu swaps the visible list to a parent command's children without
// closing the palette, resetting the query/selection and repositioning (the list
// height changes). Esc later backs out via the keyboard handler.
function enterSubmenu(children) {
  menu.sub = children
  menu.query = ''
  menu.sel = 0
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
    const list = resolveCommands(menu.query)
    if (e.key === 'Escape') {
      e.preventDefault()
      // Esc first backs out of a submenu to the root, then closes the palette.
      if (menu.sub) {
        menu.sub = null
        menu.query = ''
        menu.sel = 0
      } else {
        closeMenu()
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      menu.sel = Math.min(menu.sel + 1, Math.max(0, list.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      menu.sel = Math.max(menu.sel - 1, 0)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (list[menu.sel]) runCommand(list[menu.sel])
    }
    // Typing filters the list, which changes the palette's height — reposition a
    // frame later (once re-rendered) so it stays snug under the selection, even
    // when flipped above it.
    if (menu.open) requestAnimationFrame(positionMenu)
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
      handleRelatedKey(e.key)
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
      nextChange()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      prevChange()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      state.mode = 'list'
      scrollSelectedIntoView()
      refreshHints() // stepping back to the list hides the hints
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      enterRelated() // step into the right-hand Related panel (green related block)
    }
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
  if (state.mode !== 'diff') return false
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

// menuAnchor returns the element the command palette floats *beneath* (its
// vertical anchor): in 'comment' mode, the focused comment row; otherwise the
// active change row (present in both list-preview and diff mode) if there is
// one, else the selected block's card, else the sidebar row. Always something
// on-screen so the menu opens under whatever is selected.
function menuAnchor() {
  if (menu.mode === 'comment') {
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
  if (menu.mode === 'comment') {
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
        ${CommandMenu(menu, resolveCommands, runCommand)}
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
      <div class="flex min-h-0 shrink-0 flex-col gap-3" data-testid="block-column">
      ${() => {
        const sel = state.selected
        const pair = state.blocks
          .map((b, i) => ({ b, i }))
          .filter(({ i }) => i === sel || i === sel + 1)
        const out = []
        // A step-up cue sits *above* the selected card when ↑ would flow into the
        // previous same-file block (which isn't rendered here — it's up the list).
        if (canStep(-1)) out.push(stepChevron('up').key('step-up'))
        pair.forEach(({ b, i }, idx) => {
          ensureCode(b)
          if (idx > 0 && pair[idx - 1].b.file === b.file) {
            // The step-down cue sits *below* the selected card, just above the
            // dashed connector to the next same-file block ↓ would flow into.
            if (canStep(1)) out.push(stepChevron('down').key('step-down'))
            out.push(connector().key('conn:' + b.file + ':' + i))
          }
          const card = Block(b, {
            preview: i !== sel,
            // Reactive: reads mode/selected/change so the pane re-highlights as
            // the reviewer navigates. Only the selected block, in diff mode,
            // gets a highlighted group.
            activeGroup: () => {
              if (i !== state.selected) return null
              // In list mode we preview the first change group (the very run →
              // would step onto). In diff mode we follow state.change into the
              // current granularity's units (a run, a line, or a call segment).
              if (state.mode !== 'diff') return groupsFor(b)[0] || null
              return unitsOf(b)[state.change] || null
            },
            // Out-of-view change hints belong only to the block being stepped
            // through: the selected card, in diff mode. Preview cards and list
            // mode never show them.
            hintsEnabled: () => i === state.selected && state.mode === 'diff',
            // Light-blue border while the keyboard drives this block's diff
            // (selected card, diff mode) — mirrors the selected comment-index row.
            // Once the reviewer steps → into the related panel the diff no longer
            // owns the keyboard, so the border drops (relatedActive()).
            diffActive: () => i === state.selected && state.mode === 'diff' && !relatedActive(),
            // Reactive Set of approved row indices → an emerald bar on approved
            // rows. Reads b.approvedRows so the pane re-tints on every approve.
            approvedRows: () => approvedRowSet(b),
            // Reactive Set of approved call-segment keys (finer than
            // approvedRows) → open-circle progress markers on rows with
            // multiple call segments that aren't fully approved yet. Reads
            // b.approvedCalls so the pane re-renders on every call-toggle.
            approvedCalls: () => approvedCallSet(b),
            // Reactive Set of rows that carry a comment → a 💬 marker on those
            // rows, so it's visible which units already hold a comment (however
            // many). Reads the comments read-model via RelatedPanel.
            commentedRows: () => commentRowSet(b),
          }).key('detail:' + b.file + ':' + b.label + ':' + b.side)
          out.push(card)
        })
        return out
      }}
      </div>
      ${() => RelatedPanel(state, commentTarget, relatedChildren).key('related-panel')}
      ${() => (menu.open ? menuOverlay().key('command-overlay') : '')}
    </main>
  `
}

// Mount the sidebar and the detail panel into #app.
const app = document.getElementById('app')
BlockList(state)(app)
DetailPanel(state)(app)
Footer(state)(app)

// Kick off the initial load.
loadBlocks()
loadPRMeta()
