// RelatedPanel — the column to the right of the selected block. Two stacked
// cards: on top the underlying code the block calls into — its child blocks
// from the relations read-model (GET /api/relations), passed down by home.mjs —
// below the live **comments** on lines of code (wired to the task_code_comment
// workflow).

import { html } from './vendor/arrow.js'
import { reactive } from './vendor/arrow.js'
import { highlight, blockLabel } from './Block.mjs'
import { statusInfo } from './BlockList.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { renderMarkdown } from './markdown.mjs'
import { avatarHTML } from './avatar.mjs'

// ── Real comments (task_code_comment workflow) ────────────────────────────────
// This section IS wired to the API. Placing a comment starts a Workflow
// Execution (POST /api/workflows/task_code_comment); a reaction sends a Signal
// (POST /api/workflows/{runId}/signals/reply). Everything else here is read-only
// (GET /api/comments?pr=N). Per the write-boundary rule, the UI only ever writes
// by starting or signalling a workflow — never straight to a store.
// focus/threadPos drive the keyboard navigation of this right-hand panel (see
// home.mjs → onKeydown). focus is which region owns the arrows: null (the diff/
// list has the keyboard), 'code' (the related-code block, light-blue border), 'new'
// (the "+ Comment op deze regel" button), 'comment' (a comment row in the index,
// cs.sel), or 'thread' (inside the selected comment's thread). threadPos indexes
// the thread bottom-up: 0 = the reply field (typing), 1..n = the n-th message
// from the bottom (1 = newest), so ↑ walks to older messages and ↓ back down.
// A thread's messages are the comment's own body (its opening message) followed
// by its reactions — see threadMessages.
// `scope` is the current selection context (from home.mjs, pushed via
// setCommentScope): { file, label, mode, gran, rowStart, rowEnd, seg } or null.
// It lives on cs — RelatedPanel's own reactive — on purpose: the index render
// reads cs and reliably re-renders on cs changes, whereas reading home.mjs'
// `state` across the module boundary from inside this list binding did not
// retrigger it. home.mjs bridges state→cs.scope with an arrow.js watch.
// codeSel indexes the selected underlying-code child while cs.focus === 'code':
// → walks it forward through the child list, ↓ leaves it for the comments column.
const cs = reactive({
  pr: null,
  list: [],
  view: [],
  sel: 0,
  composing: false,
  busy: false,
  focus: null,
  threadPos: 0,
  scope: null,
  scopeSig: '',
  codeSel: 0,
  // chipPath indexes the drill-hint chip tree next to the child card at
  // codeSel (see nestedChip/nestedChipColumn below): [] means the keyboard
  // sits on the card itself, [i] the i-th top-level chip, [i,j] its j-th
  // sub-chip, etc. — one index per depth, mirroring the chip data's own
  // recursive `nested` shape (home.mjs' nestedChangedKids). → descends into
  // whatever's focused own nested list, ← climbs one level back out (only
  // falling through to exitRelated once chipPath is already empty), ↓/↑ walk
  // siblings at the current depth (see handleRelatedKey/chipListAt). Reset to
  // [] whenever codeSel changes — a chip path only makes sense relative to
  // the card it hangs off. Deliberately NOT bound to the URL (unlike codeSel
  // above): a sub-cursor one level deeper than anything else in this panel
  // has ever restored, ephemeral like taskSel below.
  chipPath: [],
  // taskSel indexes the flat active+done workflow-run list while
  // cs.focus === 'task' (the Taken stop of the comments/taken sidebar).
  // Deliberately NOT bound to the URL (unlike codeSel/sel/threadPos below) —
  // it's a step further than any of those flows have gone before and, like
  // `menu`/`ui.task` elsewhere, an ephemeral cursor rather than a navigation
  // position worth restoring on refresh.
  taskSel: 0,
  // sidebarOpen — whether the comments/taken sidebar (see CommentsSidebar
  // below) is expanded (comments-on-top-of-taken, w-[36rem]) or collapsed to a
  // narrow hint rail on the right edge. Toggled with `g` (home.mjs' onKeydown).
  // Deliberately NOT bound to the URL — ephemeral UI state, like
  // showDescription/`menu` elsewhere: a refresh always starts collapsed.
  // Distinct from cs.focus on purpose: the sidebar can stay open while the
  // keyboard sits elsewhere (diff, or the inline Onderliggende-code card) —
  // see toggleSidebar/exitSidebarToDiff.
  sidebarOpen: false,
})

// The panel cursor survives a browser refresh: focus/codeSel/sel/threadPos live in
// the URL under their own `rel` namespace, alongside the main navigation (sel/mode/
// chg/gran) that home.mjs binds. The composer/busy/list/view/scope are transient or
// loaded data and stay out. focus === null (diff owns the keyboard) is the default,
// so the params only appear once you actually step into the panel.
bindUrlState(
  cs,
  [
    { key: 'focus', param: 'foc', default: null },
    { key: 'codeSel', param: 'code', parse: num(0), default: 0 },
    { key: 'sel', param: 'csel', parse: num(0), default: 0 },
    { key: 'threadPos', param: 'thr', parse: num(0), default: 0 },
  ],
  { ns: 'rel' },
)

// restorePending captures what the URL restored into cs *before* the async data
// pushes (setRelated / loadComments) can clobber it — those clamp codeSel/sel back
// to 0 and drop a dangling focus while the children/comments are still loading,
// which would immediately mirror the params out of the URL again. We re-apply this
// snapshot once the data settles (applyRelRestore), then clear it so it never
// hijacks later navigation. Null when the URL carried no rel.* param — nothing to
// restore, and the mirror-watch is then free to keep the URL canonical.
let restorePending =
  cs.focus !== null || cs.codeSel !== 0 || cs.sel !== 0 || cs.threadPos !== 0
    ? { focus: cs.focus, codeSel: cs.codeSel, sel: cs.sel, threadPos: cs.threadPos }
    : null

// ── Underlying code, pushed from home.mjs ─────────────────────────────────────
// The underlying-code card follows the cursor: which child blocks / resolved
// calls to show depends on the current navigation unit, which lives in home.mjs'
// `state`. Rather than read that reactive `state` (and the selected block's
// lazily-loaded `b.code`) from inside this panel's render binding — which races
// with home.mjs' own diff render over `b.code` and can leave the diff stuck on
// "loading" — home.mjs computes the list in a `watch` and pushes it here via
// setRelated (the same decoupling the comment index uses with setCommentScope).
// `rc` is this module's own reactive so the render reliably re-runs on a push.
const rc = reactive({ children: [], unresolved: [], warning: null })

// setRelated receives the freshly-scoped underlying-code children, the
// unresolved-call/test-coverage list, and the test-coverage warning (or null)
// from home.mjs (via a watch on the navigation state) and stores them on rc.
// Always reassigns (never mutates in place) so arrow.js re-renders the keyed
// card list.
export function setRelated(children, unresolved, warning) {
  rc.children = Array.isArray(children) ? children : []
  rc.unresolved = Array.isArray(unresolved) ? unresolved : []
  rc.warning = warning || null
  // A block switch (or a shrinking list) must not leave the child cursor on a
  // stale index; snap it back to the first block.
  if (cs.codeSel >= rc.children.length) cs.codeSel = 0
  // A fresh push rebuilds the whole descriptor tree — any chip-depth cursor
  // from before almost certainly no longer points at the same node (the tree
  // shape can shift under a re-render, e.g. after a code load or an approval
  // change), so drop back to the card itself rather than risk pointing at a
  // stale/out-of-range chip.
  cs.chipPath = []
  // Children just arrived — a pending refresh-restore that wanted the code card
  // (or a codeSel) can now land. One-shot; see applyRelRestore.
  applyRelRestore()
}

// ── Index scoping (filter by the selected navigation unit) ────────────────────
// The index shows only the comments *under* what's selected in the diff: a whole
// group's comments include its lines' and calls'; a line's include its calls'; a
// call's are only that call. It's always scoped to the selected block (a group/
// line/call is a block-internal notion), so in list mode the block's whole set
// shows.

// setCommentScope receives the live selection context from home.mjs (via a watch
// on the navigation state) and stores it on cs, so the index re-filters as the
// reviewer moves. Skips a redundant write (same signature) so an unrelated
// reactive tick doesn't needlessly re-render the list.
export function setCommentScope(scope) {
  const sig = scope
    ? [scope.file, scope.label, scope.mode, scope.gran, scope.rowStart, scope.rowEnd, scope.seg].join('|')
    : ''
  if (sig === cs.scopeSig) return
  cs.scopeSig = sig
  cs.scope = scope
  recomputeView()
}

// commentUnder reports whether comment c sits at or below the selected unit t in
// the same block: c's aligned-row range ⊆ t's range and — when t is a single
// 'call' segment — the same call (gran + seg). A comment with an unknown anchor
// (rowStart < 0: legacy/seeded) is always shown within its block.
function commentUnder(c, t) {
  if (c.rowStart == null || c.rowStart < 0) return true
  if (c.rowStart < t.rowStart || c.rowEnd > t.rowEnd) return false
  if (t.gran === 'call') return c.gran === 'call' && c.seg === t.seg
  return true
}

// recomputeView derives the visible list from cs.list + cs.scope and reassigns
// cs.view. Reassigning a reactive *array* property is the pattern that reliably
// re-renders arrow.js keyed lists (cs.list itself works that way) — computing the
// filter lazily inside the render binding did not re-run it when only cs.scope
// changed (e.g. navigating between blocks). Called whenever the list or the scope
// changes (loadComments / setCommentScope).
function recomputeView() {
  // PR-wide comments (kind !== '': imported issue comments / review summaries)
  // have no file:line anchor — they live in the PR-info column's PR-wide block
  // (see PrWideComments), never in the block-scoped index. Exclude them here so
  // they don't leak into the sidebar (esp. list-mode / null-scope, which would
  // otherwise show the whole list).
  const anchored = cs.list.filter((c) => !c.kind)
  const s = cs.scope
  if (!s) {
    cs.view = anchored
    return
  }
  const inBlock = anchored.filter((c) => c.file === s.file && c.label === s.label)
  cs.view = s.mode !== 'diff' || s.rowStart < 0 ? inBlock : inBlock.filter((c) => commentUnder(c, s))
}

// visibleComments is the current filtered index — the scoped/​narrowed comments
// under the selection (see recomputeView). Bindings read cs.view (reactive), so
// they re-render whenever the list or scope changes.
function visibleComments() {
  void cs.list // subscribe the binding to cs.list — its reassignment is what
  // reliably patches the keyed list (see setCommentScope); cs.view holds the
  // actual filtered result.
  return cs.view
}

// selI clamps cs.sel onto the visible list (cs.sel indexes the *visible* list),
// so a shrinking filter never leaves the selection dangling past the end.
function selI() {
  const n = visibleComments().length
  return n ? Math.min(cs.sel, n - 1) : 0
}

// selComment is the currently-selected comment within the visible list.
function selComment() {
  return visibleComments()[selI()]
}

// commentRowSet returns the aligned-diff rows of block b that carry a comment, so
// Block can mark them with a 💬 (presence only — the count doesn't matter). Reads
// cs.list, so it re-runs as comments load. Comments with an unknown anchor
// (rowStart < 0) sit on no row, so they're skipped here (they still show in the
// index). Exported for home.mjs → Block(commentedRows).
export function commentRowSet(b) {
  const set = new Set()
  if (!b) return set
  for (const c of cs.list) {
    if (c.file !== b.file || c.label !== b.label) continue
    if (c.rowStart == null || c.rowStart < 0) continue
    for (let i = c.rowStart; i <= c.rowEnd; i++) set.add(i)
  }
  return set
}

// ── Keyboard focus in the right-hand panel ────────────────────────────────────
// home.mjs owns the single keydown listener and, once the reviewer steps into
// this panel (→ from the diff), routes the arrows here via handleRelatedKey. The
// focus state is navigation position, not durable state: it is mirrored to the URL
// (rel.foc, so a refresh restores where the cursor sat — see bindUrlState above),
// but never written to a store, so the write-boundary rule is unaffected.

// relatedActive reports whether this panel currently owns the keyboard.
export function relatedActive() {
  return cs.focus !== null
}

// sidebarOpen reports whether the comments/taken sidebar (CommentsSidebar,
// toggled with `g`) is expanded or collapsed to its hint rail. home.mjs reads
// this to keep <main>'s right-hand margin clear of whichever one is showing
// (see the DetailPanel comment in home.mjs and detail-layout.md).
export function sidebarOpen() {
  return cs.sidebarOpen
}

// ── Onderliggende-code auto-collapse on a laptop-width viewport ──────────────
// Once the comments/taken sidebar is open (see sidebarOpen above) on a screen
// narrower than Tailwind's 2xl breakpoint (1536px — the same threshold the
// rest of the layout already uses for width scaling, e.g. Block.mjs's
// w-[70rem] 2xl:w-[82rem]), the sidebar and the full-width Onderliggende-code
// card compete for room. `viewport` tracks whether the window is at least
// 2xl-wide via matchMedia (mirrors theme.mjs's system-preference listener),
// reactively — a resize (or DevTools viewport change) re-evaluates it live.
const viewport = reactive({
  wide: typeof window !== 'undefined' ? window.matchMedia('(min-width: 1536px)').matches : true,
})
if (typeof window !== 'undefined') {
  const mq = window.matchMedia('(min-width: 1536px)')
  const applyMQ = (e) => {
    viewport.wide = e.matches
  }
  if (mq.addEventListener) mq.addEventListener('change', applyMQ)
  else if (mq.addListener) mq.addListener(applyMQ) // older Safari fallback
}

// relatedRailActive reports whether the Onderliggende-code card should
// collapse to a narrow rail (see relatedRail) instead of its full card: the
// sidebar is open, the viewport is narrower than 2xl, AND the card does not
// currently own the keyboard. That last condition mirrors the drilled-column
// rail rule (collapsedColumnHTML, home.mjs): only the column/card that
// currently owns the keyboard stays full-width, everything else collapses.
// It guarantees → (enterRelated, which sets cs.focus = 'code') always lands
// on a fully expanded, navigable card — keyboard navigation never lands on
// dead/hidden content.
function relatedRailActive() {
  return sidebarOpen() && !viewport.wide && cs.focus !== 'code'
}

// relatedRail — the collapsed state of the Onderliggende-code card: a narrow
// rail (mirrors collapsedColumnHTML in home.mjs / sidebarHintRail below),
// icon + vertical label + the current child count, clickable to expand. A
// click calls enterRelated() directly — the same landing → takes from the
// diff — which flips cs.focus to 'code' and, via relatedRailActive() above,
// immediately re-expands this same slot into the full card.
function relatedRail() {
  return html`
    <button
      type="button"
      class="flex h-full w-14 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 ring-1 ring-black/5 text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800/60 hover:text-indigo-500 dark:hover:text-indigo-400"
      data-testid="related-collapsed"
      title="Onderliggende code"
      aria-label="Onderliggende code tonen"
      @click="${() => enterRelated()}"
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
        >Onderliggende code</span
      >
      <span class="text-[11px] font-semibold tabular-nums" data-testid="related-collapsed-count"
        >${() => rc.children.length}</span
      >
    </button>
  `
}

// isCodeFocused reports whether the keyboard is on the Onderliggende-code block
// (so home.mjs can wire Enter there to the LLM call-search).
export function isCodeFocused() {
  return cs.focus === 'code'
}

// focusedRelatedChild returns the underlying-code child the keyboard is
// currently on (cs.focus === 'code', indexed by cs.codeSel), or null. home.mjs
// reads this on Enter to know which child to drill into (see drillIntoChild).
export function focusedRelatedChild() {
  return cs.focus === 'code' ? rc.children[cs.codeSel] || null : null
}

// chipListAt walks `path` (an array of chip indices, chip.nested-deep) down
// from the card at codeSel's own top-level chips (r.nested) and returns the
// chips array reached there — capped at NESTED_CHIP_CAP, mirroring exactly
// what's actually rendered (the "+N meer" remainder is deliberately never
// keyboard-reachable, same as the mouse). `path` = [] returns the card's own
// top-level chips; `handleRelatedKey` calls this both for the sibling list at
// the CURRENT chip depth (path = chipPath.slice(0,-1)) and to check whether
// the FOCUSED chip has anything to descend into (path = chipPath).
function chipListAt(path) {
  const r = rc.children[cs.codeSel]
  let kids = r && Array.isArray(r.nested) ? r.nested.slice(0, NESTED_CHIP_CAP) : []
  for (const idx of path) {
    const k = kids[idx]
    if (!k) return []
    kids = Array.isArray(k.nested) ? k.nested.slice(0, NESTED_CHIP_CAP) : []
  }
  return kids
}

// chipPathEquals compares two chip-path arrays for the focus-ring binding
// (nestedChip) — plain value equality, no reference identity involved since
// cs.chipPath is reassigned wholesale on every step (see handleRelatedKey).
function chipPathEquals(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// scrollChipIntoView keeps the focused chip in view while walking the chip
// tree with the arrows, mirroring scrollCodeIntoView.
function scrollChipIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=related-nested-chip][data-active=true]')
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

// focusedChipChain returns the ordered chain of drill targets a focused chip
// represents — every ancestor (the card itself, then each intermediate chip,
// each converted via chipDrillTarget) followed by the focused chip itself —
// or null when the code-focus cursor sits on the card (chipPath === []).
// home.mjs's Enter handler drills through this chain exactly like a click on
// the chip does (see nestedChip's own @click), just without the mouse.
export function focusedChipChain() {
  if (cs.focus !== 'code' || cs.chipPath.length === 0) return null
  const r = rc.children[cs.codeSel]
  if (!r) return null
  const chain = [r]
  let kids = Array.isArray(r.nested) ? r.nested : []
  for (const idx of cs.chipPath) {
    const k = kids[idx]
    if (!k) return null
    chain.push(chipDrillTarget(k))
    kids = Array.isArray(k.nested) ? k.nested : []
  }
  return chain
}

// enterRelated hands the keyboard to the panel, starting on the first
// underlying-code child. Called by home.mjs on → from the diff.
export function enterRelated() {
  cs.composing = false
  cs.focus = 'code'
  cs.codeSel = 0
  cs.chipPath = []
  scrollCodeIntoView()
}

// lastSidebarFocus remembers the comments-sidebar substop (only 'new'/
// 'comment'/'thread' — never 'code' or 'task') the keyboard sat on the last
// time it left the sidebar this session (← or a closing `g`, both go through
// exitRelated below), so a later `g`-reopen (openSidebar) can land back there
// instead of always resetting to the composer row. Deliberately a plain
// module `let`, not on `cs`/the URL: this is a within-session memory only —
// the reviewer asked for "g out, g back → same spot", not a refresh-restore
// (that already exists separately for cs.focus/sel/threadPos via the `rel`
// URL namespace, and cs.sidebarOpen itself deliberately stays out of the URL,
// see the sidebarOpen field comment above). Mirrors the preTaskFocus pattern.
let lastSidebarFocus = null

// exitRelated releases the keyboard back to the diff and drops any input focus /
// half-typed new comment. Exported as leaveRelated for home.mjs: drillIntoChild
// calls it to hand a freshly-drilled column's keyboard to its own diff instead
// of landing on its Onderliggende-code panel (see the "Drillen" flow). It
// deliberately never touches cs.sidebarOpen — leaving the code card (or the
// sidebar, see handleRelatedKey's ArrowLeft below) must not close a sidebar
// the reviewer left open.
function exitRelated() {
  if (cs.focus === 'new' || cs.focus === 'comment' || cs.focus === 'thread') {
    lastSidebarFocus = { focus: cs.focus, sel: cs.sel, threadPos: cs.threadPos }
  }
  cs.focus = null
  cs.composing = false
  const el = document.activeElement
  if (el && el.blur) el.blur()
}
export { exitRelated as leaveRelated }

// focusEl focuses a right-pane input a frame later (once the reactive re-render
// has swapped in the matching view: the new-comment composer or the reply field).
function focusEl(sel) {
  requestAnimationFrame(() => {
    const el = document.querySelector(sel)
    if (el) el.focus()
  })
}

// toNew / toComment land on a left-column item of the comments sidebar. Landing
// already opens the right pane and drops the caret in it — the reviewer types
// straight away, no → needed: 'new' shows an empty new-comment composer; a
// comment shows its history with the reply field focused.
function toNew() {
  cs.composing = true
  cs.focus = 'new'
  focusEl('[data-testid=comment-compose]')
}

// enterComments hands the keyboard to the comments/taken sidebar, always
// landing on the "+ Comment op deze regel" row (row 0) — a deterministic
// anchor, mirroring enterRelated always landing on the first child /
// toTask defaulting to row 0. Called by toggleSidebar (`g`, home.mjs) and by
// a click on the collapsed hint rail — both "open the sidebar and highlight
// comments" paths. Deliberately does NOT open the composer / focus its
// textarea (unlike toNew): a fresh `g`-open must leave the keyboard free so a
// 2nd `g` can toggle the sidebar shut right away instead of typing a literal
// "g" into an already-focused field (isEditableFocused would swallow it).
// Enter (home.mjs, via openComposer) is what actually opens the composer.
function enterComments() {
  cs.composing = false
  cs.focus = 'new'
}

// toggleSidebar drives `g` (home.mjs' onKeydown), globally (list or diff mode):
// closed → open + focus comments; open but the keyboard sits elsewhere (diff,
// or the inline Onderliggende-code card) → focus comments, stays open; open
// and already focused inside it (composer/comment/thread/task) → close and
// hand the keyboard back to the diff. Exported for home.mjs.
export function toggleSidebar() {
  const inSidebar = cs.focus === 'new' || cs.focus === 'comment' || cs.focus === 'thread' || cs.focus === 'task'
  if (cs.sidebarOpen && inSidebar) {
    cs.sidebarOpen = false
    exitRelated()
  } else {
    openSidebar()
  }
}

// preTaskFocus remembers which comments-substop (the 'new' composer, a
// comment row, or a comment's 'thread') ↓ advanced from into the Taken stop,
// so ↑ out of Taken lands back where it left off instead of always resetting
// to the composer. A plain module `let`, not on `cs` — it's a one-shot
// breadcrumb for a single step back, not navigation state worth
// exposing/restoring. Note: landing back on 'new' (see handleRelatedKey's
// ArrowUp branch) only highlights the composer row via enterComments — it
// does not auto-open/focus it, unlike the 'comment'/'thread' cases.
let preTaskFocus = 'new'

// toTask hands the keyboard to the Taken/workflows panel, landing on row `i`
// (default the first row). Reached by ↓ once comments has nowhere deeper down
// left to go (the last comment row, the empty composer, or the bottom of a
// thread) — see handleRelatedKey.
function toTask(i = 0) {
  preTaskFocus = cs.focus
  cs.composing = false
  cs.focus = 'task'
  cs.taskSel = i
  scrollTaskIntoView()
}

// scrollTaskIntoView keeps the selected Taken row in view while walking it
// with the arrows, mirroring scrollCodeIntoView/scrollCommentIntoView.
function scrollTaskIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelectorAll('[data-testid=workflow-row]')[cs.taskSel]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// isTaskFocused / focusedTaskRun mirror isCodeFocused/focusedRelatedChild for
// the Taken panel: home.mjs reads these on Enter to know whether — and which
// run — to hand to its own openTask (which lives in home.mjs, since it drives
// the shared navigation state, not this panel). `runs` is the same ordered
// list `workflowsSection` renders (active runs, then done — see `taskRuns`),
// passed in by the caller rather than read from home.mjs' `state` directly
// (this module stays decoupled from that reactive's shape, like `rc`/`cs`
// elsewhere).
export function isTaskFocused() {
  return cs.focus === 'task'
}

export function focusedTaskRun(runs) {
  return cs.focus === 'task' && Array.isArray(runs) ? runs[cs.taskSel] || null : null
}

// taskRuns is the single ordering both workflowsSection (row indices) and
// home.mjs (handleRelatedKey's taskCount + focusedTaskRun's `runs`) rely on —
// active runs first, then done — so cs.taskSel always points at the same run
// in both the render and the keyboard nav.
export function taskRuns(state) {
  const all = state && Array.isArray(state.workflows) ? state.workflows : []
  const active = all.filter((r) => r.status === 'running' || r.status === 'waiting')
  const done = all.filter((r) => r.status === 'completed' || r.status === 'failed')
  return active.concat(done)
}

// `focusInput` defaults to true for every existing caller (a click or an
// explicit arrow-key step onto a comment row) — landing already opens the
// reply pane and drops the caret in it, per this file's own long-standing
// convention. `restoreLastSidebarFocus` (a `g`-reopen restoring where the
// reviewer left off) is the one exception: passing `false` there re-selects
// the row/scrolls it into view WITHOUT stealing the keyboard into the reply
// textarea — mirroring how a fresh `g`-open (enterComments) only highlights
// the "+ Comment op deze regel" row rather than opening it.
function toComment(focusInput = true) {
  cs.composing = false
  cs.focus = 'comment'
  scrollCommentIntoView()
  if (focusInput) focusEl('[data-testid=reaction-compose]')
}

// selectComment focuses the panel on the comment whose id matches `id` (a
// task_code_comment run's Run ID == its comment's id) — home.mjs' openTask
// calls this once it has landed on the comment's block/diff-unit, so clicking
// a "Taken" row opens that comment's thread. It looks the comment up in the
// currently-scoped view (cs.view, kept in sync with the navigation by
// setCommentScope), so it only succeeds once the scope actually covers the
// comment's unit. Fails silently (returns false) if the comment isn't visible
// yet — the caller doesn't retry.
export function selectComment(id) {
  const vi = cs.view.findIndex((c) => c.id === id)
  if (vi < 0) return false
  cs.sel = vi
  toComment()
  return true
}

// threadMessages builds the rendered thread of a comment: its own body as the
// first message (the reviewer's opening, shown as their own bubble) followed by
// every reaction. So the comment that titles the thread also reads back as its
// first chat message. The synthetic opening carries source 'ui' so it renders on
// the reviewer's side, like the composer that placed it.
function threadMessages(c) {
  if (!c) return []
  const origin = { id: 'origin:' + c.id, source: 'ui', author: c.author, body: c.body }
  return [origin, ...(c.reactions || [])]
}

// reactionCount is the number of bubbles the thread renders (opening + reactions)
// — the upper bound the keyboard walks to when stepping up through the history.
function reactionCount() {
  return threadMessages(selComment()).length
}

// scrollCommentIntoView / scrollReactionIntoView keep the active row / bubble in
// view while walking with the arrows (deferred a frame so the DOM has the new
// highlight class first), mirroring scrollSelectedIntoView in home.mjs.
function scrollCommentIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelectorAll('[data-testid=comment-item]')[selI()]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// scrollCodeIntoView keeps the selected underlying-code child in view while
// walking the card with the arrows (deferred a frame so the DOM has the active
// highlight first), mirroring scrollCommentIntoView.
function scrollCodeIntoView() {
  requestAnimationFrame(() => {
    // The cursor can sit on an ordinary child card OR on the grouped
    // covering-tests bar (see testsBar) — both carry data-active.
    const el = document.querySelector(
      '[data-testid=related-item][data-active=true], [data-testid=related-tests-bar][data-active=true]',
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

function scrollReactionIntoView() {
  requestAnimationFrame(() => {
    // threadPos counts from the bottom (1 = newest), so the array index is
    // reactions.length - threadPos.
    const j = reactionCount() - cs.threadPos
    const el = document.querySelectorAll('[data-testid=reaction-bubble]')[j]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// focusThread puts the caret in the reply field at the bottom of the thread
// (threadPos 0, ready to type) or, once the reviewer walks up into the history,
// blurs it and scrolls the selected older message into view. `focusInput`
// (default true, see toComment's own comment on the same pattern) is only
// passed false by restoreLastSidebarFocus — a `g`-reopen restoring a
// remembered thread position should re-highlight it, not immediately drop
// the keyboard into the reply field.
function focusThread(focusInput = true) {
  requestAnimationFrame(() => {
    const input = document.querySelector('[data-testid=reaction-compose]')
    if (cs.threadPos === 0) {
      if (input && focusInput) input.focus()
    } else {
      if (input && document.activeElement === input) input.blur()
      scrollReactionIntoView()
    }
  })
}

// enterThread steps into the selected comment's thread, landing on the reply
// field so the reviewer can type straight away (→ from a comment row).
function enterThread() {
  cs.composing = false
  cs.focus = 'thread'
  cs.threadPos = 0
  focusThread()
}

// applyRelRestore re-applies the URL-restored panel cursor (restorePending, set at
// module load) once the data it points at has actually loaded — children arrive via
// setRelated, comments via loadComments, and either can win the race. It gates on
// the data the *wanted* focus needs and only clears restorePending once it applies,
// so a comment focus isn't dropped because setRelated happened to fire first with
// children but no comments yet (and vice-versa). It runs at most once, so it never
// hijacks navigation the reviewer does afterwards. Indices are clamped to what
// loaded and a focus is restored via the same land helpers the arrows use — so the
// caret/scroll land exactly where a manual step would — but only when the target
// exists; otherwise the diff keeps the keyboard.
function applyRelRestore() {
  const want = restorePending
  if (!want) return
  const children = rc.children.length
  const comments = visibleComments().length
  // Wait for the data the wanted focus points at; 'new'/null need none.
  if (want.focus === 'code' && children === 0) return
  if ((want.focus === 'comment' || want.focus === 'thread') && comments === 0) return
  restorePending = null
  cs.codeSel = children ? Math.min(want.codeSel, children - 1) : 0
  cs.sel = comments ? Math.min(want.sel, comments - 1) : 0
  if (want.focus === 'code') {
    cs.focus = 'code'
    scrollCodeIntoView()
  } else if (want.focus === 'new') {
    // 'new'/'thread'/'comment' are sidebar stops (see cs.sidebarOpen) — a
    // restored focus there means the sidebar must come back open too, not
    // just cs.focus, or it would render as the collapsed hint rail with the
    // keyboard silently sitting on hidden content.
    cs.sidebarOpen = true
    toNew()
  } else if (want.focus === 'thread') {
    cs.sidebarOpen = true
    cs.focus = 'thread'
    cs.threadPos = Math.min(want.threadPos, reactionCount())
    focusThread()
  } else if (want.focus === 'comment') {
    cs.sidebarOpen = true
    toComment()
  }
  // else (focus null): leave the diff with the keyboard, indices restored silently.
}

// The comments column (top of the sidebar) is one flat vertical list the
// arrows walk: the "+ Comment op deze regel" button (row 0), then one row per
// comment (row 1 + i). Modelling it as a single cursor — instead of per-region
// special cases — is what keeps ↑/↓ deterministic: the same key always moves
// one row, whatever path you took to get there.
function rowCount() {
  return 1 + visibleComments().length
}

// currentRow maps the live focus/selection back to that flat index.
function currentRow() {
  if (cs.focus === 'new') return 0
  return 1 + selI()
}

// gotoRow lands on row `n` (clamped into range) via the matching landing action,
// so the right pane and input focus follow the cursor. Rows ≥ 1 are comments.
function gotoRow(n) {
  n = Math.max(0, Math.min(n, rowCount() - 1))
  if (n === 0) toNew()
  else {
    cs.sel = n - 1
    toComment()
  }
}

// handleRelatedKey drives the panel for one arrow/Escape press and returns 'exit'
// when focus leaves the panel back to the diff (else true). It serves two
// independent regions that share the same cs.focus enum:
//  - the inline Onderliggende-code card ('code', reached by → from the diff,
//    see enterRelated) — unchanged: ↓/↑ walk its children, ← exits to the diff.
//  - the comments/taken sidebar ('new'/'comment'/'thread'/'task', reached by
//    `g` — see toggleSidebar) — comments is a flat row walk (gotoRow), thread
//    is the one region where ↑/↓ mean something else (walk the message
//    history), and task is its own row walk. ↓/↑ cross between the comments
//    list and the taken list (the sidebar stacks them vertically, comments on
//    top of taken); ← from *anywhere* in the sidebar exits straight back to
//    the diff in one step, leaving the sidebar open (see toggleSidebar's
//    comment on cs.sidebarOpen) — unlike 'code', which is a single flat region
//    with nothing to descend into further.
// `taskCount` is the current length of the Taken/workflows list (see `taskRuns`,
// exported for the caller to compute from its own state) — needed here only to
// clamp cs.taskSel while cs.focus === 'task'.
export function handleRelatedKey(key, taskCount = 0) {
  if (key === 'Escape') {
    exitRelated()
    return 'exit'
  }
  if (cs.focus === 'task') {
    // ↓ walks down the task rows; ↑ at the first row climbs back up into
    // whichever comments-substop it descended from (preTaskFocus/toTask) —
    // climbing back to the composer only highlights it (see enterComments
    // below), a comment row or thread still auto-focuses its reply field as
    // before; ← exits straight to the diff, sidebar stays open.
    if (key === 'ArrowDown') {
      cs.taskSel = Math.min(cs.taskSel + 1, Math.max(0, taskCount - 1))
      scrollTaskIntoView()
    } else if (key === 'ArrowUp') {
      if (cs.taskSel === 0) {
        if (preTaskFocus === 'thread') {
          cs.focus = 'thread'
          focusThread()
        } else if (preTaskFocus === 'comment') {
          toComment()
        } else {
          // preTaskFocus is 'new' — climb back to the composer substop the
          // same way a fresh `g`-open lands on it (enterComments): highlight
          // the "+ Comment op deze regel" row only, don't auto-open/focus the
          // composer. Mirrors the `g` rationale (don't hijack the keyboard
          // into a textarea the reviewer didn't explicitly ask to type into) —
          // an explicit Enter (isNewFocused + openComposer, home.mjs) opens it.
          enterComments()
        }
      } else {
        cs.taskSel -= 1
        scrollTaskIntoView()
      }
    } else if (key === 'ArrowLeft') {
      exitRelated()
      return 'exit'
    }
    return true
  }
  if (cs.focus === 'thread') {
    if (key === 'ArrowUp') {
      cs.threadPos = Math.min(cs.threadPos + 1, reactionCount())
      focusThread()
    } else if (key === 'ArrowDown') {
      if (cs.threadPos === 0) {
        // Bottom of the thread (the reply field) — descend into Taken.
        toTask(0)
      } else {
        cs.threadPos -= 1
        focusThread()
      }
    } else if (key === 'ArrowLeft') {
      exitRelated()
      return 'exit'
    }
    return true
  }
  if (cs.focus === 'code') {
    // The code card is a flat vertical list of underlying-code children —
    // unrelated to the comments/taken sidebar (see the function comment
    // above). Each child can additionally carry its own drill-hint chip tree
    // to the right (nestedChip/nestedChipColumn) — cs.chipPath is a second,
    // nested cursor into THAT tree, off of whichever card sits at codeSel.
    // Empty chipPath ⇒ the keyboard is on the card itself: ↓/↑ walk the flat
    // card list as before (↑ from the first card exits to the diff), and →
    // descends into the card's own top-level chips (chipListAt(chipPath)
    // resolves to the same list whether chipPath is empty or not). Once
    // chipPath is non-empty, ↓/↑ instead walk *siblings at that same chip
    // depth* (chipListAt(chipPath.slice(0,-1))), → descends one level further
    // (into the focused chip's own nested chips, if any — a no-op otherwise),
    // and ← climbs one level back up; only once chipPath is already empty
    // does ← fall through to the existing "leave the panel" behaviour. This
    // mirrors the app's left→right "stop" navigation elsewhere (→ = deeper, ←
    // = one level back) — spatially consistent with the chips fanning out to
    // the right (see nestedChipColumn/detail-layout.md).
    const n = rc.children.length
    if (key === 'ArrowDown') {
      if (cs.chipPath.length) {
        const last = cs.chipPath.length - 1
        const siblings = chipListAt(cs.chipPath.slice(0, last))
        if (cs.chipPath[last] < siblings.length - 1) {
          cs.chipPath = [...cs.chipPath.slice(0, last), cs.chipPath[last] + 1]
          scrollChipIntoView()
        }
      } else if (cs.codeSel < n - 1) {
        cs.codeSel += 1
        scrollCodeIntoView()
      }
    } else if (key === 'ArrowUp') {
      if (cs.chipPath.length) {
        const last = cs.chipPath.length - 1
        if (cs.chipPath[last] > 0) {
          cs.chipPath = [...cs.chipPath.slice(0, last), cs.chipPath[last] - 1]
          scrollChipIntoView()
        }
      } else if (cs.codeSel === 0) {
        exitRelated()
        return 'exit'
      } else {
        cs.codeSel -= 1
        scrollCodeIntoView()
      }
    } else if (key === 'ArrowRight') {
      const deeper = chipListAt(cs.chipPath)
      if (deeper.length) {
        cs.chipPath = [...cs.chipPath, 0]
        scrollChipIntoView()
      }
    } else if (key === 'ArrowLeft') {
      if (cs.chipPath.length) {
        cs.chipPath = cs.chipPath.slice(0, -1)
        scrollChipIntoView()
      } else {
        exitRelated()
        return 'exit'
      }
    }
    return true
  }
  // cs.focus is 'new' or 'comment' here (the flat comments row-walk).
  if (key === 'ArrowDown') {
    if (currentRow() >= rowCount() - 1) {
      // Last comments row (or the empty composer) — descend into Taken.
      toTask(0)
    } else {
      gotoRow(currentRow() + 1)
    }
  } else if (key === 'ArrowUp') gotoRow(currentRow() - 1)
  else if (key === 'ArrowLeft') {
    // Exit straight back to the diff, in one step — the sidebar stays open
    // (see toggleSidebar).
    exitRelated()
    return 'exit'
  } else if (key === 'ArrowRight') {
    if (cs.focus === 'comment' && selComment()) {
      // → steps into the thread so ↑ walks the old messages instead of the index.
      enterThread()
    }
  }
  return true
}

// startComment opens the "new comment on this line" composer — the command menu
// (home.mjs) calls it so the reviewer can start a comment task from `/`. Mirrors
// toNew(): besides flipping the local composing flag it also opens the sidebar
// (cs.sidebarOpen) and hands the keyboard focus to 'new' (the "+ Comment op deze
// regel" button shows as selected) and focuses the textarea so the reviewer can
// type immediately. Placing the comment still goes through the workflow
// (placeComment), so the write-boundary is unchanged.
export function startComment() {
  cs.sidebarOpen = true
  cs.composing = true
  cs.focus = 'new'
  focusEl('[data-testid=comment-compose]')
}

// isComposeOpen reports whether the new-comment composer is currently open, so
// home.mjs's keydown handler can catch Enter on a filled composer and open the
// comment-kind menu (Claude / Git / private / Jira) instead of placing directly.
export function isComposeOpen() {
  return cs.composing
}

// composeHasText reports whether the composer textarea holds non-whitespace text
// — the gate for opening the comment-kind menu (an empty composer + Enter does
// nothing). Reads the DOM (home.mjs has no access to the textarea otherwise).
export function composeHasText() {
  const el = document.querySelector('[data-testid=comment-compose]')
  return !!el && el.value.trim() !== ''
}

// isNewFocused reports whether the "+ Comment op deze regel" row currently
// owns the keyboard (highlighted, but — since enterComments no longer
// auto-opens the composer on a fresh `g` — not necessarily composing yet).
// home.mjs's Enter handler uses this to know when Enter should open the
// composer (see openComposer below).
export function isNewFocused() {
  return cs.focus === 'new'
}

// openComposer actually opens the composer (composing=true) and focuses its
// textarea — the same landing toNew() has always done. Exported so home.mjs's
// Enter handler can trigger it once the reviewer has highlighted the "+
// Comment op deze regel" row (cs.focus === 'new') via `g` — a fresh `g`-open
// only highlights that row (enterComments), it deliberately doesn't call this.
export function openComposer() {
  toNew()
}

// isCommentFocused reports whether a placed comment's row currently owns the
// keyboard (landed on via ↑/↓ or a click, reply field focused but not yet
// stepped into the thread). home.mjs uses this to decide whether Enter should
// open the delete menu instead of falling through to the reply field.
export function isCommentFocused() {
  return cs.focus === 'comment' && selComment() != null
}

// commentReplyEmpty reports whether the focused comment's reply field is
// empty. Landing on a comment row already focuses that field (see toComment),
// so Enter must only open the delete menu when there's nothing typed to send
// — otherwise it would hijack the "type a quick reply, hit Enter" flow.
export function commentReplyEmpty() {
  const el = document.querySelector('[data-testid=reaction-compose]')
  return !el || el.value.trim() === ''
}

// commentSelIndex is the index of the focused comment row, for anchoring the
// delete menu under the right element (home.mjs has no access to cs directly).
export function commentSelIndex() {
  return selI()
}

// deleteFocusedComment sends the "delete" signal for the focused comment's
// Workflow Execution. This is the only write path: the workflow first flips
// the comment's status to "deleting", then removes it from GitHub and from
// the read-model — the UI just asks and reloads once it's done.
export async function deleteFocusedComment() {
  const c = selComment()
  if (!c || !c.runId) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer' }),
    })
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

async function loadComments(pr) {
  if (pr == null) return
  try {
    const res = await fetch('/api/comments?pr=' + encodeURIComponent(pr))
    if (res.ok) {
      cs.list = await res.json()
      recomputeView()
      // A delete (or a shrinking list generally) can leave cs.sel pointing past
      // the end, or the focused/threaded row can vanish entirely — clamp back
      // onto the list and drop out of a now-dangling focus/thread.
      if (cs.sel >= cs.list.length) cs.sel = Math.max(0, cs.list.length - 1)
      if ((cs.focus === 'comment' || cs.focus === 'thread') && cs.list.length === 0) {
        cs.focus = 'new'
        cs.threadPos = 0
      }
      // Comments just arrived — a pending refresh-restore that wanted a comment/
      // thread (or a sel) can now land. One-shot; see applyRelRestore.
      applyRelRestore()
    }
  } catch (_) {
    // keep the last good list on a transient error
  }
}

// Activity tracking: a tab being *visible* is not the same as the reviewer being
// *active* — a tab left open in the foreground while the reviewer walked away
// would otherwise keep heartbeating forever. We only beat on genuine engagement:
// visible + focused + input within ACTIVITY_WINDOW. No input for that long ⇒ we
// stop beating, and the server backs off to its slow cadence.
const ACTIVITY_WINDOW = 120000 // 2 min without input ⇒ treat the reviewer as away
let lastActivity = 0
if (typeof window !== 'undefined') {
  const mark = () => {
    lastActivity = Date.now()
  }
  ;['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'focus'].forEach((ev) =>
    window.addEventListener(ev, mark, { passive: true })
  )
}

function tabActive() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
  return Date.now() - lastActivity < ACTIVITY_WINDOW
}

// beat tells the server the reviewer is actively viewing the selected open
// thread, so its GitHub poller keeps its fast cadence (server backs off to a
// 10-min cadence without a heartbeat within the last 10 min). It only fires while
// the tab is genuinely active (see tabActive) and writes no state.
function beat() {
  if (!tabActive()) return
  const c = selComment()
  if (!c || !c.runId || c.status !== 'open') return
  fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/heartbeat', { method: 'POST' }).catch(() => {})
}

// syncComments refetches when the PR changes and starts a slow refresh so
// GitHub-polled reactions (server-side) surface in the UI, plus a heartbeat so
// the server keeps fast-polling the thread you are looking at.
let refreshTimer = null
let heartbeatTimer = null
function syncComments(pr) {
  if (cs.pr !== pr) {
    cs.pr = pr
    cs.sel = 0
    loadComments(pr)
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(() => cs.pr != null && loadComments(cs.pr), 5000)
  }
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(beat, 60000)
  }
}

// createComment starts a comment task (Workflow Execution) on the given line with
// `body`. Shared by the composer (placeComment) and the command menu's fallback
// ("Maak hiermee een comment", which uses the typed text as the comment). It writes
// only by starting the workflow (POST), so the write-boundary holds. On success it
// reloads the read-model and selects the fresh comment.
export async function createComment({
  pr,
  file,
  line,
  body,
  code,
  gran,
  label,
  rowStart,
  rowEnd,
  seg,
  local,
  startLine,
  endLine,
  side,
  segment,
}) {
  if (pr == null || !file || !body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/task_code_comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pr,
        file,
        line,
        author: 'reviewer',
        body,
        code,
        gran,
        label,
        rowStart: rowStart == null ? -1 : rowStart,
        rowEnd: rowEnd == null ? -1 : rowEnd,
        seg: seg || '',
        // A private note ("alleen voor mijzelf"): stored but never posted to
        // GitHub (the workflow skips postGithubComment). Default false, so the
        // existing composer/fallback paths are unchanged.
        local: !!local,
        // The unit's real source line range/side (see home.mjs' commentTarget/
        // unitLineRange) +, for a 'call' unit, its segment text — lets the
        // workflow post a correctly-anchored (multi-line, right side) GitHub
        // comment instead of always the block's first line.
        startLine: startLine || 0,
        endLine: endLine || 0,
        side: side || 'RIGHT',
        segment: segment || '',
      }),
    })
    await loadComments(pr)
    // The fresh comment sits on the unit we just placed it on, so it's the last
    // entry of the (order-preserving) visible list — land the selection there.
    cs.sel = Math.max(0, visibleComments().length - 1)
  } finally {
    cs.busy = false
  }
}

// placeComment submits the composer's text as a comment on the current unit.
// Exported so the comment-kind menu (home.mjs COMPOSE_COMMANDS) can place a
// private note via opts.local; the composer button routes through the menu too.
export async function placeComment(state, commentTarget, opts = {}) {
  const b = state && state.blocks && state.blocks[state.selected]
  const el = document.querySelector('[data-testid=comment-compose]')
  const body = el && el.value.trim()
  if (!b || !body) return
  // Capture the exact unit the composer is previewing so the placed comment's
  // thread can show the same code (see composeTargetHint / the thread hint).
  // commentTarget() follows focusedBlock() (the column that currently owns the
  // diff keyboard), which may be a drilled column rather than the top-level
  // selected block `b` — so t.file/t.startLine (not b.file/b.line) are the
  // ones that must anchor the comment when a drilled column is focused.
  const t = (commentTarget && commentTarget()) || null
  await createComment({
    pr: state.pr,
    file: (t && t.file) || b.file,
    // Prefer the unit's real source line (see home.mjs' commentTarget/
    // unitLineRange) over the block's own start line; falls back to it when
    // there's no navigable unit (t.startLine is 0).
    line: (t && t.startLine) || b.line,
    body,
    code: t ? t.code : '',
    gran: t ? t.gran : '',
    label: t ? t.label : '',
    rowStart: t ? t.rowStart : -1,
    rowEnd: t ? t.rowEnd : -1,
    seg: t ? t.seg : '',
    local: !!opts.local,
    startLine: t ? t.startLine : 0,
    endLine: t ? t.endLine : 0,
    side: t ? t.side : 'RIGHT',
    segment: t ? t.segment : '',
  })
  el.value = ''
  cs.composing = false
}

// GRAN_LABEL — how each navigation granularity is described in the composer's
// "linked to" hint (see composeTargetHint), coarsest to finest.
const GRAN_LABEL = {
  group: 'een groep wijzigingen',
  line: 'deze regel',
  call: 'deze aanroep',
}

// composeTargetHint renders what the in-progress comment is linked to: the
// granularity (group/line/call) plus the block's class::method and a code
// example of the exact unit — so the reviewer sees the link *while* typing,
// before the comment is placed. `target` is the `commentTarget()` result passed
// down from home.mjs (null until a block is selected).
function composeTargetHint(target) {
  if (!target) return ''
  return html`
    <div
      class="rounded-lg border border-indigo-100 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 px-2.5 py-2 text-[11px]"
      data-testid="comment-target"
    >
      <div class="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
        <span class="font-medium">${() => GRAN_LABEL[target.gran] || target.gran}</span>
        <span class="text-indigo-300 dark:text-indigo-500">·</span>
        <span class="truncate font-mono font-semibold">${() => target.label}</span>
      </div>
      ${() =>
        target.code
          ? html`<code
              class="language-php mt-1 block max-h-16 overflow-auto whitespace-pre rounded bg-white/70 dark:bg-zinc-800/70 px-2 py-1 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
              .innerHTML="${() => highlight(target.code)}"
            ></code>`
          : ''}
    </div>
  `
}

async function sendReaction(done) {
  const c = selComment()
  if (!c) return
  const el = document.querySelector('[data-testid=reaction-compose]')
  const body = (el && el.value.trim()) || (done ? '/resolve' : '')
  if (!body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body, done }),
    })
    if (el) el.value = ''
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

const CSTATUS_DOT = { open: 'bg-amber-400', resolved: 'bg-emerald-500' }

// commentRow — one placed comment (a Workflow Execution) in the left list.
function commentRow(c, i) {
  return html`
    <button
      class="${() =>
        'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition ' +
        (selI() === i && cs.focus === 'comment'
          ? 'bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : selI() === i && (cs.focus === 'thread' || cs.focus === 'comment')
          ? // still the comment whose thread is open in the chat on the right,
            // just not the row the keyboard is on right now: a lighter border
            // keeps it marked without competing with an actively-focused row.
            'bg-indigo-50/40 dark:bg-indigo-500/10 ring-1 ring-indigo-100 dark:ring-indigo-500/20'
          : 'hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      data-testid="comment-item"
      @click="${() => {
        cs.sel = i
        toComment()
        beat()
      }}"
    >
      <span class="${() => 'mt-1 h-2 w-2 shrink-0 rounded-full ' + (CSTATUS_DOT[c.status] || 'bg-slate-300 dark:bg-zinc-600')}"></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="flex items-center gap-1.5" data-testid="comment-author-line">
          ${avatarHTML(c.author, c.avatarUrl, 'h-4 w-4')}
          <span class="truncate text-[11px] font-medium text-slate-600 dark:text-zinc-400" data-testid="comment-author"
            >${c.author || 'onbekend'}</span
          >
          ${() => sourceBadge(c)}
        </span>
        <span
          class="truncate [overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200"
          .innerHTML="${commentBody(c)}"
        ></span>
        <span class="truncate text-[11px] leading-snug text-slate-500 dark:text-zinc-500" data-testid="comment-meta"
          >${() => c.file + ':' + c.line + ' · ' + c.reactionCount + ' reacties · ' + c.status}</span
        >
      </span>
    </button>
  `
}

// sourceBadge marks a comment imported from GitHub (source === 'github'), so the
// reviewer can tell app-placed from imported comments — mirrors the "bron:
// haiku/sonnet" badge on LLM-resolved related children. Returns '' for an
// app-placed comment (source '' / 'ui').
function sourceBadge(c) {
  if (c.source !== 'github') return ''
  return html`<span
    class="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
    data-testid="comment-source"
    >bron: github</span
  >`
}

// reactionBubble — one message in the thread. `i`/`total` let it light up when it
// is the one the reviewer walked up to (cs.threadPos counts from the bottom).
// Each bubble carries its own author's avatar+name above it — reactions/replies
// have an `author` just like the comment root (see threadMessages), so this
// works for every message in the thread, not only the opening one.
function reactionBubble(r, i, total) {
  const mine = r.source === 'ui'
  return html`
    <div class="${() => 'flex flex-col gap-0.5 ' + (mine ? 'items-end' : 'items-start')}">
      <div class="flex items-center gap-1" data-testid="reaction-author-line">
        ${avatarHTML(r.author, r.avatarUrl, 'h-4 w-4')}
        <span class="text-[10px] font-medium text-slate-500 dark:text-zinc-400" data-testid="reaction-author"
          >${r.author || 'onbekend'}</span
        >
      </div>
      <div
        class="${() => {
          const sel = cs.focus === 'thread' && cs.threadPos === total - i
          return (
            'max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed [overflow-wrap:anywhere] ' +
            (mine ? 'bg-indigo-500 text-white' : 'bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300') +
            (sel ? ' ring-2 ring-indigo-400' : '')
          )
        }}"
        data-testid="reaction-bubble"
        .innerHTML="${commentBody(r)}"
      ></div>
    </div>
  `
}

// commentsSection — the wired panel: placed comments on the left, the selected
// comment's reactions + a working composer on the right, and a "+ Comment op deze
// regel" button that starts a new Execution on the current block.
function commentsSection(state, commentTarget, openCompose) {
  syncComments(state ? state.pr : null)
  // Prefer commentTarget()'s file/line — it follows focusedBlock() (the column
  // that currently owns the diff keyboard, which may be a drilled column, see
  // home.mjs) — over the top-level state.selected block, so this header never
  // shows a different block's file than the one the composer is actually
  // linked to (see composeTargetHint just below, which already does this).
  const target = () => {
    const t = commentTarget && commentTarget()
    if (t) return t.file + ':' + (t.startLine || t.line)
    const b = state && state.blocks && state.blocks[state.selected]
    return b ? b.file + ':' + b.line : 'geen regel geselecteerd'
  }
  // The `new-comment` button's "open" click (below) routes through openComposer()
  // (toNew()) instead of a bare `cs.composing = !cs.composing` toggle: that used
  // to leave cs.focus untouched, so a click here while cs.focus wasn't already
  // 'new' opened the textarea without relatedActive() ever becoming true —
  // home.mjs's onKeydown then had no signal that a real editable field owned DOM
  // focus, and s/d/f/arrows/`/` leaked through as global shortcuts instead of
  // flowing into the composer. openComposer() keeps cs.focus in lockstep with
  // cs.composing, like every other path into this composer (toNew/startComment).
  // See keyboard-navigation.md and the isEditableFocused() fallback in home.mjs.
  return html`
    <section
      class="flex w-full min-h-0 flex-1 flex-row overflow-hidden rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5"
      data-testid="comments-panel"
    >
      <div class="flex w-56 shrink-0 flex-col overflow-hidden border-r border-slate-100 dark:border-zinc-800/60">
        <div class="border-b border-slate-100 dark:border-zinc-800/60 px-3 py-2.5">
          <h2 class="text-sm font-semibold text-slate-800 dark:text-zinc-200">Comments</h2>
          <p class="text-[11px] text-slate-400 dark:text-zinc-500">op regels code · live</p>
        </div>
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
          <button
            class="${() =>
              'flex w-full items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-left transition ' +
              (cs.focus === 'new'
                ? 'border-indigo-400 text-indigo-600 dark:text-indigo-400 ring-1 ring-indigo-300 dark:ring-indigo-500/40'
                : 'border-slate-200 dark:border-zinc-800 text-slate-400 dark:text-zinc-500 hover:border-indigo-200 dark:hover:border-indigo-500/40 hover:text-indigo-500 dark:hover:text-indigo-400')}"
            data-testid="new-comment"
            @click="${() => (cs.composing ? (cs.composing = false) : openComposer())}"
          >
            <span
              class="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-current text-[11px] leading-none"
              >+</span
            >
            <span class="text-xs font-medium">Comment op deze regel</span>
          </button>
          ${() => {
            // Always return an ARRAY from this slot. Arrow.js mishandles a slot
            // that alternates between a single element (the "no comments" note) and
            // an array (the comment rows): after the empty render it would not
            // re-render the rows when navigating back to a block whose comments had
            // repopulated, leaving the list frozen empty. Wrapping the empty note in
            // a one-element array keeps the slot's shape stable so it re-renders.
            const cts = visibleComments()
            return cts.length === 0
              ? [html`<p class="px-2.5 py-3 text-[11px] text-slate-400 dark:text-zinc-500">Nog geen comments.</p>`.key('no-comments')]
              : cts.map((c, i) => commentRow(c, i).key('comment:' + c.id))
          }}
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="comment-thread">
        <div class="border-b border-slate-100 dark:border-zinc-800/60 px-4 py-2.5">
          <h2 class="truncate text-sm font-semibold text-slate-800 dark:text-zinc-200">
            ${() =>
              cs.composing
                ? 'Nieuwe comment · ' + target()
                : selComment()
                  ? selComment().body
                  : // Idle fallback: "Thread", not "Comments" — the list column
                    // to the left is already titled "Comments", and two bare
                    // "Comments" headings side by side read as a duplicate.
                    'Thread'}
          </h2>
          <p class="text-[11px] text-slate-400 dark:text-zinc-500">
            ${() => (cs.composing ? 'start een task op deze regel' : 'reacties hooken hier op de comment in')}
          </p>
        </div>

        ${() =>
          cs.composing
            ? html`
                <div class="flex min-h-0 flex-1 flex-col gap-2 p-3">
                  ${() => composeTargetHint(commentTarget ? commentTarget() : null)}
                  <textarea
                    class="min-h-24 flex-1 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-2 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                    placeholder="Je comment op deze regel…"
                    data-testid="comment-compose"
                  ></textarea>
                  <div class="flex items-center justify-end gap-2">
                    <button
                      class="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300"
                      @click="${() => (cs.composing = false)}"
                    >
                      Annuleer
                    </button>
                    <button
                      class="${() =>
                        'rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' +
                        (cs.busy ? 'opacity-50' : 'hover:bg-indigo-600')}"
                      data-testid="comment-send"
                      @click="${() => (openCompose ? openCompose() : placeComment(state, commentTarget))}"
                    >
                      Plaats…
                    </button>
                  </div>
                </div>
              `
            : html`
                <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                  ${() => {
                    const c = selComment()
                    return c && c.code
                      ? composeTargetHint({ gran: c.gran, label: c.label, code: c.code })
                      : ''
                  }}
                  ${() =>
                    threadMessages(selComment()).map((r, i, arr) =>
                      reactionBubble(r, i, arr.length).key('msg:' + r.id)
                    )}
                </div>
                <div class="flex items-center gap-2 border-t border-slate-100 dark:border-zinc-800/60 p-2.5">
                  <input
                    class="flex-1 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-1.5 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
                    placeholder="Reageer op deze comment…"
                    data-testid="reaction-compose"
                    @keydown="${(e) => e.key === 'Enter' && sendReaction(false)}"
                  />
                  <button
                    class="shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
                    data-testid="reaction-send"
                    @click="${() => sendReaction(false)}"
                  >
                    Stuur
                  </button>
                  <button
                    class="shrink-0 rounded-lg border border-emerald-300 dark:border-emerald-500/40 px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/15"
                    data-testid="reaction-resolve"
                    @click="${() => sendReaction(true)}"
                  >
                    ✓
                  </button>
                </div>
              `}
      </div>
    </section>
  `
}

// ── Underlying code (real, from the relations read-model) ─────────────────────
// The children of the selected block: the blocks it is coupled to (e.g. the
// Listener::handle for an event it dispatches). They are pulled out of the left
// list and shown here, top-right of the block. Fed by home.mjs' relatedChildren
// (GET /api/relations), which lazily loads each child's code.

// KIND_LABEL names the relation on a child card. method_call/covers carry no
// label: they show a +added/-removed diff-stat (diffStatBadge) instead.
const KIND_LABEL = {
  event_listener: 'listener',
  covered_by: 'test',
  // Laravel request-lifecycle children — the badge names the child's role, seen
  // from its parent (a route's child is a controller, a controller's child is a
  // request/resource/model, a request's child is a policy).
  route_controller: 'controller',
  controller_request: 'request',
  controller_resource: 'resource',
  controller_model: 'model',
  request_policy: 'policy',
  // Class-level callresolve children — the whole model as a child, not one of
  // its methods (see .claude/rules/tembed-workflows.md, "migration → model").
  model_usage: 'model',
  migration_model: 'model',
}

// diffStatBadge shows, for a called method (or a test's covered method), how
// many lines its definition adds/removes ("+A −R", green/red) instead of a
// word label. A call/covered method into an unchanged file has no diff
// (r.diff == null) → a grey "Ongewijzigd" badge. Also covers the class-level
// callresolve kinds (model_usage/migration_model) — they carry a diff just
// like a method_call child.
const DIFFSTAT_KINDS = new Set(['method_call', 'covers', 'model_usage', 'migration_model'])
function diffStatBadge(r) {
  if (!DIFFSTAT_KINDS.has(r.kind)) return ''
  if (!r.diff) {
    return html`
      <span
        class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500"
        data-testid="related-diffstat"
        title="Aangeroepen definitie is niet gewijzigd in deze PR"
        >Ongewijzigd</span
      >
    `
  }
  return html`
    <span
      class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums"
      data-testid="related-diffstat"
      title="Toegevoegde / verwijderde regels in de aangeroepen definitie"
    >
      <span class="text-emerald-600 dark:text-emerald-400">+${() => r.diff.add}</span>
      <span class="text-rose-500 dark:text-rose-400">&#8722;${() => r.diff.del}</span>
    </span>
  `
}

// approvalBadge shows a child block's approval progress ("done/total", green +
// ✓ once fully approved). `a` is { done, total } or null (a call into an
// unchanged file — nothing to approve). Hidden only when there's nothing to
// approve yet (total 0); the done state is always shown.
function approvalBadge(a) {
  if (!a || !a.total) return ''
  const done = a.done === a.total
  return html`
    <span
      class="${'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums ' +
      (done ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500')}"
      data-testid="related-approval"
      title="Goedgekeurde regels"
      >${done ? '✓ ' : ''}${a.done}/${a.total}</span
    >
  `
}

// NESTED_CHIP_CAP caps how many drill-hint chips render next to a child card
// (or under a chip, recursively) at any one level; anything beyond it
// collapses into a "+N meer" line so a fan-out child can't blow up the
// card's height. Shared by every nesting depth — the cap is per level, not
// cumulative.
const NESTED_CHIP_CAP = 3

// chipDrillTarget builds the plain object drillIntoChild expects for a chip
// (or ancestor chip) target — every chip's `id` IS a real PR block id (built
// by home.mjs' nestedChangedKids from directChildBlocks), so drillIntoChild's
// `byId.get(child.blockId)` always resolves it to the real block. Shared by
// nestedChip's own click target and by the ancestor chain a deeper sub-chip
// must drill through first.
function chipDrillTarget(k) {
  return { blockId: k.id, id: k.id, label: k.label, file: k.file, line: k.line, code: '' }
}

// nestedDiffStat renders a chip's own +added/−removed diff-stat, or a grey
// "…" placeholder while its lazily-loaded code (home.mjs' nestedChangedKids
// calls ensureCode for every chip target) is still in flight — every chip
// target is, by construction, a changed PR block, so it always eventually
// gets a real diff-stat, never the "Ongewijzigd" badge diffStatBadge shows
// for an unchanged call/covered-method target. A `${() => …}`-function
// binding (never a static interpolation) — see the "i=>je(n,i)" pitfall in
// conventions.md: the loading↔loaded swap is a template↔template shape
// change, and every nestedChip instance shares this same call site.
function nestedDiffStat(k) {
  if (k.loading) {
    return html`<span
      class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800 px-1 py-px text-[9px] font-medium text-slate-400 dark:text-zinc-500"
      data-testid="related-nested-diffstat"
      >…</span
    >`
  }
  const d = k.diff || { add: 0, del: 0 }
  return html`
    <span
      class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800 px-1 py-px text-[9px] font-semibold tabular-nums"
      data-testid="related-nested-diffstat"
    >
      <span class="text-emerald-600 dark:text-emerald-400">+${d.add}</span>
      <span class="text-rose-500 dark:text-rose-400">&#8722;${d.del}</span>
    </span>
  `
}

// nestedChip renders one drill-hint chip: a narrow block naming a changed
// (grand)child (FULL class::method label — wrapped, never truncated, so a
// long name like ProductGroupStoreRequest::authorize always reads in full —
// its own diff-stat, its approval done/total — no file line, that only lives
// in `title`) of the card/chip it sits next to — the "there is more
// underneath" cue. `ancestors` is the ordered chain of drill targets (the
// parent card's own descriptor `r`, then every ancestor chip in between) to
// drill through before finally drilling into `k` itself — one click (or
// Enter while focused, see home.mjs' focusedChipChain) at depth d drills d+1
// levels in one go (drillIntoChild resolves each via blockId; every chip
// target is a PR block by construction, see home.mjs' nestedChangedKids).
// stopPropagation keeps the click from ALSO triggering the card's own
// one-level drill. `path` is this chip's own index path into cs.chipPath
// (RelatedPanel's keyboard cursor into the chip tree, see handleRelatedKey) —
// used only to compute the focus ring, never for drilling itself.
//
// This chip is a flex ROW — button, then (if k.nested.length) its own further
// chips recursively to the RIGHT via nestedChipColumn — rather than a column
// with the recursion indented underneath: the reviewer asked for "onderliggende
// van de onderliggende" to fan out rightward, matching → descending deeper in
// the keyboard nav (see handleRelatedKey) and mirroring how a card's own
// top-level chip column already sits to ITS right (relatedCard). Every depth
// therefore shares the exact same shape (row: chip + optional right column),
// so nestedChipColumn is now the ONE recursive building block at every level —
// unlike before, there is no longer a second, differently-shaped
// "nestedSubChips" variant (see nestedChipColumn's own comment for why that
// used to be necessary and no longer is).
//
// Two of this chip's slots deliberately use DIFFERENT fix patterns for the
// same underlying arrow.js pitfall (a static `${cond ? html`…` : ''}`
// template↔string ternary corrupts once arrow.js reuses this shared call
// site's cached chunk across sibling instances whose condition differs — see
// conventions.md, the "i=>je(n,i)" regression):
//  - the approval badge is ALWAYS rendered (fix-vorm 1): `k.approveText`/
//    `k.approveCls` are plain strings precomputed on the descriptor
//    (home.mjs' nestedChangedKids) — an always-present element, `hidden`
//    when there's nothing to approve, so the slot's shape never toggles;
//  - the diff-stat and the recursive sub-chip column genuinely swap between
//    two different templates (loading vs. loaded; present vs. absent), so
//    those go through a `${() => …}`-function binding (fix-vorm 2) instead.
function nestedChip(ancestors, k, drill, path, cardIdx) {
  const st = statusInfo(k.status)
  // `path` alone isn't enough to identify this chip — every card's chip tree
  // starts fresh at path [0], [0,0], etc., so two DIFFERENT cards' chips at
  // the same tree position would otherwise both light up. cardIdx (the
  // card's own index in rc.children, i.e. what cs.codeSel indexes) scopes
  // the match to the card this chip actually belongs to.
  const focused = () => cs.focus === 'code' && cardIdx === cs.codeSel && chipPathEquals(cs.chipPath, path)
  return html`
    <div class="flex items-start">
    <button
      type="button"
      class="${() =>
        'w-36 shrink-0 rounded-md border bg-slate-50/60 dark:bg-zinc-800/40 px-1.5 py-1 text-left hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
        (focused()
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="related-nested-chip"
      data-active="${() => (focused() ? 'true' : 'false')}"
      title="${blockLabel(k) + ' · ' + k.file}"
      @click="${(e) => {
        e.stopPropagation()
        if (!drill) return
        for (const a of ancestors) drill(a)
        drill(chipDrillTarget(k))
      }}"
    >
      <span class="block whitespace-normal break-words font-mono text-[10px] font-semibold text-slate-700 dark:text-zinc-300">${blockLabel(k)}</span>
      <span class="mt-0.5 flex items-center gap-1">
        <span class="${'truncate text-[9px] font-medium uppercase tracking-wide ' + st.cls}" data-testid="related-nested-status"
          >${k.status}</span
        >
        ${() => nestedDiffStat(k)}
        <span class="${k.approveCls}" data-testid="related-nested-approval" title="Goedgekeurde regels">${k.approveText}</span>
      </span>
    </button>
    ${() =>
      k.nested && k.nested.length
        ? nestedChipColumn([...ancestors, chipDrillTarget(k)], k.nested, drill, path, cardIdx)
        : ''}
    </div>
  `
}

// nestedChipColumn renders the connector dash + the stacked chips to the
// right of a child card OR another chip — the ONE recursive building block
// for the whole drill-hint tree (home.mjs' nestedChangedKids/NESTED_DEPTH):
// `ancestors` is the chain of drill targets to walk through before `kids`'
// own chips (the card `r` at the top, then chipDrillTarget(k) for every chip
// in between — see nestedChip's own doc comment), `path` is the index-path
// prefix cs.chipPath uses for everything already ABOVE `kids` (so each
// child's own path is `[...path, idx]`). Capped at NESTED_CHIP_CAP + a "+N
// meer" remainder line at every depth, same as before — only the remainder
// is never keyboard-reachable (chipListAt in handleRelatedKey caps the same
// way, so ↓/↑/→ never land past what's actually rendered here). `cardIdx` is
// the top-level card's own index in rc.children (see nestedChip's own doc
// comment on why it's needed for the focus ring) — threaded through unchanged
// at every depth.
function nestedChipColumn(ancestors, kids, drill, path, cardIdx) {
  const capped = kids.slice(0, NESTED_CHIP_CAP)
  const more = kids.length - capped.length
  const keyPrefix = ancestors.map((a) => a.id).join('>')
  return html`
    <div class="flex shrink-0 items-start">
      <div class="mt-5 h-px w-3 shrink-0 border-t border-dashed border-slate-300 dark:border-zinc-700"></div>
      <div class="flex w-36 shrink-0 flex-col gap-1" data-testid="related-nested">
        ${capped.map((k, idx) => nestedChip(ancestors, k, drill, [...path, idx], cardIdx).key('nested:' + keyPrefix + '>' + k.id))}
        ${() =>
          more > 0
            ? html`<span class="px-1 text-[9px] text-slate-400 dark:text-zinc-500" data-testid="related-nested-more"
                >+${more} meer</span
              >`
            : ''}
      </div>
    </div>
  `
}

// relatedCard renders one child block: a header (label + file:line + relation
// kind) and a short, non-interactive code excerpt highlighted like the panes.
// The card sits in a flex row with, when the child itself has changed
// grandchildren (r.nested), a dashed connector to a narrow chip column on the
// right (nestedChipColumn) — the drill-hint that there is more underneath.
// The row div is the template's stable root; the chip column is a static
// interpolation (fresh keyed node per nested change — the key in fullCard
// encodes the nested signature). data-child-id stays on the inner card, so
// the call-arrow overlay (callArrows.mjs, which targets the card's LEFT edge)
// is unaffected by the chips on the right.
function relatedCard(r, i, drill) {
  // The card's own highlight steps aside once the cursor descends into one of
  // its drill-hint chips (cs.chipPath, see nestedChip/handleRelatedKey) — only
  // one thing in the code panel is ever visually "active" at a time.
  const selected = () => cs.focus === 'code' && i === cs.codeSel && cs.chipPath.length === 0
  // An unchanged call/covered-method target (into a file this PR doesn't touch)
  // has no diff to review, so its selection highlight is grey rather than indigo.
  const unchanged = DIFFSTAT_KINDS.has(r.kind) && !r.diff
  const nested = Array.isArray(r.nested) ? r.nested : []
  return html`
    <div class="flex items-start">
    <div
      class="${() =>
        'min-w-0 flex-1 cursor-pointer rounded-lg border bg-slate-50/60 dark:bg-zinc-800/40 hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
        (selected()
          ? unchanged
            ? 'border-slate-300 dark:border-zinc-700 ring-1 ring-slate-200 dark:ring-zinc-800'
            : 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="related-item"
      data-child-id="${r.id}"
      data-active="${() => (selected() ? 'true' : 'false')}"
      @click="${() => drill && drill(r)}"
    >
      <div class="border-b border-slate-100 dark:border-zinc-800/60 px-3 py-1.5">
        <div class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-700 dark:text-zinc-300">${r.label}</span>
          ${() =>
            KIND_LABEL[r.kind]
              ? html`<span
                  class="shrink-0 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-500 dark:text-indigo-400"
                  >${KIND_LABEL[r.kind]}</span
                >`
              : ''}
          ${() =>
            r.source
              ? html`<span
                  class="shrink-0 rounded-full bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
                  title="Gevonden door een LLM"
                  >bron: ${r.source}</span
                >`
              : ''}
          ${() => diffStatBadge(r)}
          ${() => approvalBadge(r.approve)}
        </div>
        <span class="block truncate font-mono text-[10px] text-slate-400 dark:text-zinc-500" title="${() => r.file + ':' + r.line}"
          >${r.file}:${r.line}</span
        >
      </div>
      ${() =>
        r.code
          ? html`<code
              class="language-php m-0 block whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
              .innerHTML="${() => highlight(r.code)}"
            ></code>`
          : r.loading
            ? html`<p class="px-3 py-2 text-[11px] text-slate-400 dark:text-zinc-500">code laden…</p>`
            : html`<p class="px-3 py-2 text-[11px] text-slate-400 dark:text-zinc-500" data-testid="related-empty">
                geen code gevonden
              </p>`}
    </div>
    ${() => (nested.length ? nestedChipColumn([r], nested, drill, [], i) : '')}
    </div>
  `
}

// testsBar renders the grouped covering tests as ONE horizontal row (a
// `tests_group` descriptor, built by home.mjs' groupTestChildren whenever a
// block has covered_by children AND other, non-test children): a chevron, a
// count pill and one compact chip per test (its method name). It participates
// in the panel cursor exactly like a card — cs.codeSel indexes rc.children,
// which contains this descriptor at the slot the first test sorted to — and
// click/Enter toggle the expansion through the same drill callback a card
// uses (drillIntoChild branches on the kind). The chevron/data-expanded/chips
// are static interpolations on purpose: the descriptor is a plain object and
// every toggle rebuilds the keyed node (the key encodes open/closed, see
// fullCard), so nothing here needs its own reactive binding.
function testsBar(r, i, drill) {
  // The card's own highlight steps aside once the cursor descends into one of
  // its drill-hint chips (cs.chipPath, see nestedChip/handleRelatedKey) — only
  // one thing in the code panel is ever visually "active" at a time.
  const selected = () => cs.focus === 'code' && i === cs.codeSel && cs.chipPath.length === 0
  return html`
    <div
      class="${() =>
        'flex cursor-pointer items-center gap-2 overflow-hidden rounded-lg border bg-slate-50/60 dark:bg-zinc-800/40 px-3 py-2 hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
        (selected()
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="related-tests-bar"
      data-active="${() => (selected() ? 'true' : 'false')}"
      data-expanded="${r.expanded ? 'true' : 'false'}"
      title="${r.expanded ? 'Tests inklappen' : 'Tests uitklappen'}"
      @click="${() => drill && drill(r)}"
    >
      <span class="shrink-0 text-[10px] text-slate-400 dark:text-zinc-500">${r.expanded ? '▾' : '▸'}</span>
      <span
        class="shrink-0 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-500 dark:text-indigo-400"
        >${r.count === 1 ? '1 test' : r.count + ' tests'}</span
      >
      ${r.tests.map((t) =>
        html`<span
          class="min-w-0 shrink truncate rounded-md border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-zinc-400"
          data-testid="related-tests-chip"
          title="${t.label}"
          >${t.label && t.label.includes('::') ? t.label.split('::').pop() : t.label}</span
        >`.key('chip:' + t.id),
      )}
    </div>
  `
}

// RelatedPanel — the fixed-width right column: the selected block's underlying
// (child) code on top, live comments below. `commentTarget` (from home.mjs)
// reports what an in-progress comment would attach to at the current navigation
// granularity; passed through to the composer. The underlying-code children +
// the unresolved-call list are read from `rc`, which home.mjs keeps up to date
// via setRelated (see the note on rc above). The LLM search for unresolved calls
// runs automatically (home.mjs' startCallSearch); `search.drill` opens a child.
// ── "Taken" (workflow runs) ────────────────────────────────────────────────
// Read-only column: home.mjs polls GET /api/workflows?pr=N into state.workflows
// (see pollWorkflows); this section just renders that snapshot. It never writes
// anything itself.

// WORKFLOW_LABELS maps a Workflow Type to the Dutch label shown in the list;
// an unknown type falls back to its raw name.
const WORKFLOW_LABELS = {
  task_code_comment: 'Comment',
  pr_status: 'PR-status',
  build_relations: 'Relaties',
  resolve_call: 'Call zoeken',
  resolve_test_covers: 'Testdekking',
  explain_code: 'AI-omschrijving',
  approve: 'Goedkeuring',
  pr_inbox: 'Inbox',
}

// STATUS_BADGES maps a run status to its Dutch label + badge colour classes.
const STATUS_BADGES = {
  running: { label: 'draait', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30' },
  waiting: { label: 'wacht', cls: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/30' },
  completed: { label: 'klaar', cls: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30' },
  failed: { label: 'mislukt', cls: 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30' },
}

// WORKFLOW_STATUS_NOTE maps `${workflow}:${status}` to a short Dutch sentence
// explaining *why* a non-comment run sits in that status — the description
// line for every run type except task_code_comment (which instead shows its
// linked comment's label/line/snippet, see workflowNote).
const WORKFLOW_STATUS_NOTE = {
  'pr_status:waiting': 'volgt of de PR gemerged/gesloten wordt',
  'build_relations:completed': 'relaties opgebouwd',
  'build_relations:running': 'relaties opbouwen…',
  'build_relations:waiting': 'relaties opgebouwd, wacht op wijzigingen',
  'resolve_call:running': 'zoekt call-definities',
  'resolve_call:waiting': 'zoekt call-definities',
  'resolve_call:completed': 'call-definities opgelost',
  'explain_code:running': 'omschrijving genereren…',
  'explain_code:completed': 'omschrijving gegenereerd',
  'approve:waiting': 'wacht op goedkeuringen',
  'pr_inbox:running': 'houdt de PR-inbox bij',
  'pr_inbox:waiting': 'houdt de PR-inbox bij',
  'pr_inbox:completed': 'houdt de PR-inbox bij',
}

// buildRelationsSummary describes what build_relations actually produced for
// this PR — relation edges + resolved method-calls + resolved test-coverage
// links — read from the same state RelatedPanel already tracks
// (state.relations/callResolve/testCovers), no extra fetch needed.
function buildRelationsSummary(state) {
  const relCount = state && Array.isArray(state.relations) ? state.relations.length : 0
  const calls = state && Array.isArray(state.callResolve) ? state.callResolve : []
  const resolvedCalls = calls.filter((r) => r.status === 'resolved' || r.status === 'found').length
  const covers = state && Array.isArray(state.testCovers) ? state.testCovers : []
  const resolvedCovers = covers.filter((r) => r.status === 'resolved' || r.status === 'found').length
  const parts = []
  if (relCount > 0) parts.push(relCount + ' relatie' + (relCount === 1 ? '' : 's'))
  if (resolvedCalls > 0) parts.push(resolvedCalls + ' call' + (resolvedCalls === 1 ? '' : 's') + ' opgelost')
  if (resolvedCovers > 0) parts.push(resolvedCovers + ' testdekking' + (resolvedCovers === 1 ? '' : 'en'))
  return parts.join(' · ')
}

// relTime formats a run's last-update timestamp as a short Dutch relative
// string ("net nu" / "N min geleden" / "N uur geleden" / "N dagen geleden")
// so a "wacht"/"draait" badge doesn't leave the reviewer guessing how stale
// that status actually is.
function relTime(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diffSec < 60) return 'net nu'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return diffMin + ' min geleden'
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return diffHour + ' uur geleden'
  const diffDay = Math.floor(diffHour / 24)
  return diffDay + ' dag' + (diffDay === 1 ? '' : 'en') + ' geleden'
}

// workflowNote builds the small description line under a run's label + status
// badge: a rich "label · regel N · snippet" for a code-comment run, else a
// short explanatory sentence keyed on workflow+status (falling back to the
// kale status when no combination matches). build_relations:waiting is a
// special case: the workflow already ran its build synchronously at start
// and is now idling on a `rebuild` Signal (see tembed-workflows.md), so
// "wacht" there never means "actively building" — we replace the generic
// note with what was actually built (buildRelationsSummary) when that data
// is available, falling back to the static WORKFLOW_STATUS_NOTE text
// otherwise.
function workflowNote(run, state) {
  const c = run.comment
  if (c) {
    const parts = [c.label]
    if (c.line) parts.push('regel ' + c.line)
    if (c.snippet) parts.push('"' + c.snippet + '"')
    return parts.filter(Boolean).join(' · ')
  }
  if (run.status === 'failed') return 'mislukt'
  if (run.workflow === 'build_relations' && run.status === 'waiting') {
    const summary = buildRelationsSummary(state)
    if (summary) return summary + ' — wacht op wijzigingen'
  }
  return WORKFLOW_STATUS_NOTE[run.workflow + ':' + run.status] || run.status
}

// workflowRow renders one run at flat index `i` (its position in `taskRuns`'
// active-then-done order — see workflowsSection). A task_code_comment run with
// a resolved `comment` reference is clickable: it opens that comment's
// block/diff-unit and selects its thread (openTask, from home.mjs via the
// `search` options object). Other run types are purely informational — a click
// still lands the keyboard cursor on the row (mouse equivalent of → walking
// here, see toTask) but doesn't navigate anywhere.
function workflowRow(run, openTask, i, state) {
  const badge = STATUS_BADGES[run.status] || { label: run.status, cls: 'bg-slate-50 dark:bg-zinc-800/60 text-slate-500 dark:text-zinc-500 ring-slate-200 dark:ring-zinc-800' }
  const active = run.status === 'running' || run.status === 'waiting'
  const clickable = !!(run.comment && openTask)
  const focused = () => cs.focus === 'task' && cs.taskSel === i
  return html`
    <div
      class="${() =>
        'flex flex-col gap-0.5 rounded-md px-2 py-1.5 ring-1 ring-inset ' +
        (active ? '' : 'opacity-60') +
        (clickable ? ' cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800/60' : '') +
        (focused() ? ' ring-indigo-300 dark:ring-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-500/10' : ' ring-transparent')}"
      data-testid="workflow-row"
      data-status="${run.status}"
      data-run-id="${run.runId}"
      data-active="${() => focused()}"
      @click="${() => (clickable ? openTask(run) : toTask(i))}"
    >
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[12px] text-slate-700 dark:text-zinc-300" data-testid="workflow-label"
          >${WORKFLOW_LABELS[run.workflow] || run.workflow}</span
        >
        <span
          class="${'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ' + badge.cls}"
          data-testid="workflow-status"
          >${badge.label}</span
        >
      </div>
      <p class="line-clamp-2 text-[11px] leading-snug text-slate-400 dark:text-zinc-500" data-testid="workflow-note">
        ${workflowNote(run, state)}
      </p>
      <p class="text-[10px] text-slate-300 dark:text-zinc-600" data-testid="workflow-updated">
        ${relTime(run.updatedAt)}
      </p>
    </div>
  `
}

function workflowsSection(state, openTask) {
  const runs = () => (state && Array.isArray(state.workflows) ? state.workflows : [])
  const activeRuns = () => runs().filter((r) => r.status === 'running' || r.status === 'waiting')
  const doneRuns = () => runs().filter((r) => r.status === 'completed' || r.status === 'failed')
  return html`
    <section
      class="flex w-full shrink-0 max-h-[16rem] min-h-[10rem] flex-col overflow-hidden rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5"
      data-testid="workflows-panel"
    >
      <div class="border-b border-slate-100 dark:border-zinc-800/60 px-3 py-2.5">
        <h2 class="text-sm font-semibold text-slate-800 dark:text-zinc-200">Taken</h2>
        <p class="text-[11px] text-slate-400 dark:text-zinc-500">workflow-runs · deze PR</p>
      </div>
      <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
        ${() => {
          // Always return an ARRAY from this slot (see the "no comments" note
          // above): a slot that alternates between a single element and an
          // array can freeze empty after the first empty render.
          const all = runs()
          if (all.length === 0) {
            return [html`<p class="px-1 py-2 text-[11px] text-slate-400 dark:text-zinc-500">Geen taken.</p>`.key('no-workflows')]
          }
          const rows = []
          const act = activeRuns()
          const done = doneRuns()
          // idx tracks each run's position in the flat active-then-done order —
          // the same order `taskRuns` (exported) returns — so cs.taskSel always
          // points at the same run the keyboard nav (home.mjs) sees.
          let idx = 0
          if (act.length > 0) {
            rows.push(
              html`<p class="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500">Actief</p>`.key(
                'hdr-active'
              )
            )
            // Key includes status: a run whose status just changed (e.g.
            // running → completed) needs a fresh node, not a patched one —
            // arrow.js only re-runs a keyed node's own bindings on a key
            // change (see the block-card-key convention in conventions.md).
            for (const r of act) rows.push(workflowRow(r, openTask, idx++, state).key('run:' + r.runId + ':' + r.status))
          }
          if (done.length > 0) {
            rows.push(
              html`<p class="px-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500">Recent</p>`.key(
                'hdr-done'
              )
            )
            for (const r of done) rows.push(workflowRow(r, openTask, idx++, state).key('run:' + r.runId + ':' + r.status))
          }
          return rows
        }}
      </div>
    </section>
  `
}

// RelatedPanel — the inline Onderliggende-code card, rendered next to the diff
// (stop 5 of the left→right nav chain, see keyboard-navigation.md; unaffected
// by the comments/taken sidebar below). `search.drill` opens a resolved child
// as its own diff column.
export default function RelatedPanel(state, commentTarget, search) {
  const kids = () => rc.children
  // Calls the Go resolver could not pin (status unresolved) + any in flight
  // (searching). Both show the "zoeken…" spinner — the LLM search auto-runs.
  const unresolved = () => rc.unresolved
  const pending = () => unresolved().filter((r) => r.status === 'unresolved').length
  const searching = () => unresolved().some((r) => r.status === 'searching')
  // coversWarning renders the "dekking niet te bepalen" line under the card
  // header's description when the focused block is a test with no usable
  // coverage annotation (rc.warning, pushed by home.mjs' testCoverWarning): a
  // custom inline warning-triangle SVG (deliberately not one more Prism/vendor
  // dependency) + a short explanation. `unannotated` = no #[CoversMethod]/
  // @covers found at all (never sent to an LLM); `notfound` = a class-level-
  // only annotation (#[CoversClass]/bare "@covers Class") whose LLM search
  // could not pin a specific method. Both share the same icon/testid, only
  // the wording differs.
  const COVERS_WARNING_TEXT = {
    unannotated: 'Dekking niet te bepalen — geen #[CoversMethod]/@covers gevonden op deze test.',
    notfound:
      'Dekking niet te bepalen — #[CoversClass] gevonden, maar geen specifieke methode kunnen vaststellen.',
  }
  const coversWarning = () => {
    const kind = rc.warning
    if (!kind) return ''
    return html`
      <p
        class="mt-1 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-300"
        data-testid="related-covers-warning"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="mt-0.5 h-3 w-3 shrink-0"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <span>${COVERS_WARNING_TEXT[kind] || 'Dekking niet te bepalen.'}</span>
      </p>
    `
  }
  // Clicking a child drills into it as its own diff column — the same path Enter
  // takes on a focused child (drillIntoChild in home.mjs), just mouse-driven.
  const drill = (r) => search && search.drill && search.drill(r)
  // fullCard is the ordinary, expanded Onderliggende-code card — unchanged from
  // before the laptop-width auto-collapse (see relatedRailActive/relatedRail
  // above). Wrapped in its own function (rather than being the direct return
  // value) so the outer return below can toggle it against relatedRail() from
  // within a *stable element root* — see the "kale toggelende expressie"
  // pitfall in conventions.md: a template whose entire body is one toggling
  // expression corrupts arrow.js's keyed reconcile once it flips shape (here:
  // <section> ↔ <button>). The `<div class="contents">` wrapper keeps the
  // outer .key('related-panel') (home.mjs) pointed at a permanent element
  // while only the inner slot swaps.
  const fullCard = () => html`
    <section class="relative flex w-[34rem] 2xl:w-[41rem] shrink-0 max-h-full min-h-0 flex-col overflow-hidden" data-testid="related-code">
      ${() =>
        searching() || pending() > 0
          ? html`<span
              class="absolute right-2 top-2 z-10 shrink-0 rounded-md border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-2 py-1 text-[11px] text-slate-400 dark:text-zinc-500"
              data-testid="related-searching"
              >zoeken…</span
            >`
          : ''}
      <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        ${() => coversWarning()}
        ${() => {
          // All children render as one flat vertical list, full width, in order.
          const ks = kids()
          return ks.length === 0
            ? html`<p class="px-1 py-2 text-[11px] text-slate-400 dark:text-zinc-500">Geen onderliggende code.</p>`
            : ks.map((r, i) =>
                // The key encodes the code-load state (load/code/empty) next to
                // the child id — the block-card precedent from conventions.md:
                // arrow.js reuses a keyed node via move+patch WITHOUT re-running
                // its function bindings against the fresh descriptor object, so
                // without this the "code laden…" → code/"geen code gevonden"
                // transition can freeze on the old closure. The tests-group bar
                // key encodes open/closed + the grouped test ids instead, so a
                // toggle (or a changed test set) always builds a fresh node.
                // The card key also carries the recursive nested drill-hint
                // signature (r.nestedSig, precomputed by home.mjs'
                // nestedChangedKids/nestedSigOf — every id/status/diff/
                // approval anywhere in the chip subtree, not just the direct
                // children): any change at any depth must flip the key to
                // build a fresh node.
                r.kind === 'tests_group'
                  ? testsBar(r, i, drill).key(
                      'tests-group:' +
                        (r.expanded ? 'open' : 'closed') +
                        ':' +
                        r.tests.map((t) => t.id).join('|'),
                    )
                  : relatedCard(r, i, drill).key(
                      'related:' +
                        r.id +
                        ':' +
                        (r.code ? 'code' : r.loading ? 'load' : 'empty') +
                        ':n' +
                        (r.nestedSig || ''),
                    ),
              )
        }}
      </div>
    </section>
  `
  return html`
    <div class="contents" data-testid="related-panel-root">
      ${() => (relatedRailActive() ? relatedRail() : fullCard())}
    </div>
  `
}

// ── PR-wide comments (issue/review comments, no file:line anchor) ────────────
// GitHub-imported issue comments and review summaries (c.kind !== '') have no
// file:line to anchor them to a block, so they never show in the block-scoped
// comments index above (recomputeView filters them out) — they live here,
// under the PR description in the PR-info column (stop 1 of the nav chain,
// see detail-layout.md / keyboard-navigation.md). They share cs.list (already
// loaded/polled by syncComments — see CommentsSidebar) but own a *separate*
// cursor, `pw`: this block's keyboard focus is independent of the block-scoped
// sidebar's cs.focus/cs.sel, and of the description card itself.
//
// pw.focus: null (the description owns the keyboard, nothing selected here) |
// 'item' (↑/↓ walk the flat entry list) | 'thread' (↑/↓ walk that entry's
// message history, mirroring cs.focus==='thread'/threadPos above). pw.sel
// indexes the entry list; the selected entry's thread is always shown inline
// under its row (unlike the block-scoped sidebar's separate list+thread
// panes) — 'item' vs 'thread' only changes what the arrows do, not what's
// rendered.
const pw = reactive({ focus: null, sel: 0, threadPos: 0, busy: false })

// prWideList is the PR-wide subset of cs.list, in the same (created_at) order
// cs.list already carries.
function prWideList() {
  return cs.list.filter((c) => c.kind)
}

// pwSelI clamps pw.sel onto the current PR-wide list, like selI() does for
// the block-scoped index.
function pwSelI() {
  const n = prWideList().length
  return n ? Math.min(pw.sel, n - 1) : 0
}

function pwSelComment() {
  return prWideList()[pwSelI()]
}

function pwReactionCount() {
  return threadMessages(pwSelComment()).length
}

function pwScrollIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelectorAll('[data-testid=pr-wide-item]')[pwSelI()]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// pwFocusThread mirrors focusThread() above: caret in the reply field at the
// bottom of the thread (threadPos 0), or blurred while walking older messages.
function pwFocusThread() {
  requestAnimationFrame(() => {
    const input = document.querySelector('[data-testid=pr-wide-compose]')
    if (pw.threadPos === 0) {
      if (input) input.focus()
    } else if (input && document.activeElement === input) {
      input.blur()
    }
  })
}

function pwEnterThread() {
  pw.focus = 'thread'
  pw.threadPos = 0
  pwFocusThread()
}

// isPrWideFocused reports whether this block currently owns the keyboard
// (home.mjs's onKeydown checks this, alongside state.showDescription, before
// letting the generic Enter/`/`/f-d-s shortcuts run — mirrors relatedActive()
// for the block-scoped panel).
export function isPrWideFocused() {
  return pw.focus !== null
}

// pwComposeEmpty reports whether the focused entry's reply textarea is empty
// — mirrors commentReplyEmpty/commentReplyEmpty's role: Enter on an empty
// composer resolves instead of sending a reply (see handlePrWideKey/
// pwSendReaction).
function pwComposeEmpty() {
  const el = document.querySelector('[data-testid=pr-wide-compose]')
  return !el || el.value.trim() === ''
}

// pwSendReaction posts a reply (done:false) or resolves (done:true) via the
// exact same Signal the block-scoped thread uses (sendReaction above) — the
// backend already turns a reply on a PR-wide thread into a new GitHub issue
// comment and treats resolve as local-only, so the frontend needs no special
// casing here.
async function pwSendReaction(done) {
  const c = pwSelComment()
  if (!c) return
  const el = document.querySelector('[data-testid=pr-wide-compose]')
  const body = (el && el.value.trim()) || (done ? '/resolve' : '')
  if (!body) return
  pw.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body, done }),
    })
    if (el) el.value = ''
    await loadComments(cs.pr)
  } finally {
    pw.busy = false
  }
}

// handlePrWideKey drives one arrow/Enter/Escape press for this block, called
// from home.mjs's onKeydown while state.showDescription is true. Returns
// true/false to report whether it acted on the key — ArrowLeft/ArrowDown from
// an unfocused block (pw.focus === null) fall through to the caller (which,
// for ArrowLeft, leaves the whole nav chain to /pr-overview — see
// keyboard-navigation.md).
export function handlePrWideKey(key) {
  const list = prWideList()
  if (pw.focus === null) {
    if (key === 'ArrowDown' && list.length) {
      pw.focus = 'item'
      pw.sel = 0
      pw.threadPos = 0
      pwScrollIntoView()
      return true
    }
    return false
  }
  if (key === 'Escape') {
    pw.focus = null
    pw.threadPos = 0
    const el = document.activeElement
    if (el && el.blur) el.blur()
    return true
  }
  if (pw.focus === 'thread') {
    if (key === 'ArrowUp') {
      pw.threadPos = Math.min(pw.threadPos + 1, pwReactionCount())
      pwFocusThread()
    } else if (key === 'ArrowDown') {
      if (pw.threadPos === 0) {
        // Bottom of the thread (the reply field) — advance to the next entry,
        // if any (clamped, mirrors handleRelatedKey's flat comment-row walk).
        if (pwSelI() < list.length - 1) {
          pw.sel = pwSelI() + 1
          pw.focus = 'item'
          pw.threadPos = 0
          pwScrollIntoView()
        }
      } else {
        pw.threadPos -= 1
        pwFocusThread()
      }
    } else if (key === 'ArrowLeft') {
      // Back to the row focus (still within this block) — mirrors the
      // block-scoped thread's own ArrowLeft (which exits the whole panel;
      // here there's a shallower 'item' level to step back to first).
      pw.focus = 'item'
      pw.threadPos = 0
    } else if (key === 'Enter') {
      // Only reached when the reply textarea does NOT have DOM focus itself
      // (isEditableFocused, home.mjs, catches that case first) — a
      // discoverable resolve shortcut, mirroring the reaction-compose Enter/
      // resolve-button split above: empty composer + Enter resolves.
      if (pwComposeEmpty()) pwSendReaction(true)
    }
    return true
  }
  // pw.focus === 'item'
  if (key === 'ArrowDown') {
    if (pwSelI() < list.length - 1) {
      pw.sel = pwSelI() + 1
      pwScrollIntoView()
    }
  } else if (key === 'ArrowUp') {
    if (pwSelI() === 0) {
      pw.focus = null
      return true
    }
    pw.sel = pwSelI() - 1
    pwScrollIntoView()
  } else if (key === 'ArrowLeft') {
    // One step back to the description — mirrors exitRelated()'s "return to
    // whatever's above" role, but within stop 1 only (never leaves the chain;
    // the null-focus case above is what falls through to /pr-overview).
    pw.focus = null
    pw.threadPos = 0
  } else if (key === 'Enter') {
    pwEnterThread()
  }
  return true
}

// PW_KIND_LABEL names the kind badge on a PR-wide entry — issue/review
// comments read the same ("PR-comment"); a review summary gets its own label.
const PW_KIND_LABEL = { issue: 'PR-comment', review: 'PR-comment', review_summary: 'Review' }

// commentBody is the single place a comment's body text is rendered — kept
// tiny and reusable (block-scoped commentRow/reactionBubble and the PR-wide
// prWideItem) so this one function drives markdown rendering everywhere a
// comment body shows up. Returns a getter of a *safe HTML string* (via the
// same renderMarkdown used by prInfoCard for the PR summary/description, see
// markdown.mjs) meant for an `.innerHTML` binding — never a plain-text slot,
// see the arrow.js `.innerHTML` convention in conventions.md.
function commentBody(c) {
  return () => (c ? renderMarkdown(c.body) : '')
}

// prWideItem renders one PR-wide entry: a clickable summary row (status dot,
// kind badge, source badge, relative time, body) that — like toComment() for
// the block-scoped index — opens its thread right underneath when selected
// (pw.sel === i), with the same reply/resolve controls as the block-scoped
// thread (sendReaction), just against pw's own cursor.
function prWideItem(c, i) {
  const isSel = () => pwSelI() === i
  const rowFocused = () => isSel() && pw.focus === 'item'
  return html`
    <div
      class="${() =>
        'rounded-lg border transition ' +
        (isSel()
          ? 'border-indigo-200 dark:border-indigo-500/40 bg-indigo-50/40 dark:bg-indigo-500/10'
          : 'border-slate-200 dark:border-zinc-800 hover:border-indigo-200 dark:hover:border-indigo-500/40')}"
      data-testid="pr-wide-item"
      data-active="${() => (isSel() ? 'true' : 'false')}"
    >
      <button
        type="button"
        class="${() =>
          'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left ' +
          (rowFocused() ? 'ring-1 ring-indigo-300 dark:ring-indigo-500/40' : '')}"
        @click="${() => {
          pw.sel = i
          pwEnterThread()
        }}"
      >
        <span
          class="${() => 'mt-1 h-2 w-2 shrink-0 rounded-full ' + (CSTATUS_DOT[c.status] || 'bg-slate-300 dark:bg-zinc-600')}"
        ></span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="flex flex-wrap items-center gap-1.5" data-testid="pr-wide-author-line">
            ${avatarHTML(c.author, c.avatarUrl, 'h-4 w-4')}
            <span class="text-[11px] font-medium text-slate-600 dark:text-zinc-400" data-testid="pr-wide-author"
              >${c.author || 'onbekend'}</span
            >
            <span
              class="rounded-full bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400"
              data-testid="pr-wide-kind"
              >${PW_KIND_LABEL[c.kind] || c.kind}</span
            >
            ${() => sourceBadge(c)}
            <span class="text-[10px] text-slate-400 dark:text-zinc-500">${relTime(c.createdAt)}</span>
          </span>
          <span
            class="line-clamp-2 [overflow-wrap:anywhere] text-xs text-slate-700 dark:text-zinc-300"
            .innerHTML="${commentBody(c)}"
          ></span>
        </span>
      </button>
      ${() =>
        isSel()
          ? html`<div class="border-t border-slate-100 dark:border-zinc-800/60 p-2.5">
              <div class="mb-2 flex max-h-40 flex-col gap-1.5 overflow-auto">
                ${() =>
                  threadMessages(c).map((r, ti, arr) => reactionBubble(r, ti, arr.length).key('pwmsg:' + r.id))}
              </div>
              <div class="flex items-center gap-2">
                <textarea
                  class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2 py-1 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="Reageer…"
                  data-testid="pr-wide-compose"
                  @keydown="${(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      pwSendReaction(false)
                    }
                  }}"
                ></textarea>
                <button
                  type="button"
                  class="shrink-0 rounded-lg bg-indigo-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
                  data-testid="pr-wide-send"
                  @click="${() => pwSendReaction(false)}"
                >
                  Stuur
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded-lg border border-emerald-300 dark:border-emerald-500/40 px-2 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/15"
                  data-testid="pr-wide-resolve"
                  @click="${() => pwSendReaction(true)}"
                >
                  ✓
                </button>
              </div>
            </div>`
          : ''}
    </div>
  `
}

// PrWideComments — the card mounted below prInfoCard in PrInfoPanel
// (home.mjs), inside the same state.showDescription-gated container, so it
// needs no visibility check of its own. `min-h-[14rem]` gives it a decent
// floor so the comments stay readable even at the smaller (unfocused) share,
// scrolling internally for overflow, mirroring how workflowsSection sits
// under commentsSection in CommentsSidebar (see detail-layout.md).
export function PrWideComments(state) {
  syncComments(state ? state.pr : null)
  return html`
    <section
      class="${() =>
        'flex min-h-[14rem] flex-col overflow-hidden rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm ' +
        // Height is proportional to which of the two pr-info-column cards owns
        // the keyboard: 5/6 while navigating this block (isPrWideFocused, i.e.
        // pw.focus !== null), 2/5 while the description above it is selected —
        // the complement of prInfoCard's own 1/6 / 3/5 (home.mjs). Both shares
        // grew versus before (was 3/4 / 1/3): the comments read better with
        // more vertical room in either state. Both use flex-grow with a 0
        // basis (like flex-1), so the ratio is purely the two numbers. See
        // detail-layout.md.
        (isPrWideFocused() ? 'flex-[5]' : 'flex-[2]')}"
      data-testid="pr-wide-comments"
    >
      <div class="border-b border-slate-100 dark:border-zinc-800/60 px-4 py-2.5">
        <h2 class="text-sm font-semibold text-slate-800 dark:text-zinc-200">PR-comments</h2>
        <p class="text-[11px] text-slate-400 dark:text-zinc-500">issue- en review-comments op de hele PR</p>
      </div>
      <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-2">
        ${() => {
          // Always return an ARRAY from this slot (see the "no comments" note
          // on commentsSection's empty state) — a slot alternating between a
          // single element and an array can freeze empty after the first
          // empty render.
          const list = prWideList()
          return list.length === 0
            ? [
                html`<p class="px-2.5 py-3 text-[11px] text-slate-400 dark:text-zinc-500">
                  Geen PR-brede comments.
                </p>`.key('no-pr-wide'),
              ]
            : list.map((c, i) => prWideItem(c, i).key('pr-wide:' + c.id))
        }}
      </div>
    </section>
  `
}

// ── Comments/taken sidebar (fixed, toggled with `g`) ──────────────────────────
// A fixed right-hand overlay (mirrors PrInfoPanel's fixed left-hand column,
// see detail-layout.md), independent of <main>'s horizontal-scrolling column
// flow: comments on top, taken stacked below. Toggled globally with `g`
// (toggleSidebar, home.mjs' onKeydown) rather than reached by stepping →
// through the nav chain — see keyboard-navigation.md. Collapsed
// (!cs.sidebarOpen) it renders as a narrow hint rail showing the comment count
// + the running/waiting task count; a click on the rail opens it the same way
// `g` does.

// runningTaskCount is the number of active (running/waiting) runs — the second
// number on the collapsed hint rail.
function runningTaskCount(state) {
  return taskRuns(state).filter((r) => r.status === 'running' || r.status === 'waiting').length
}

// openSidebar is the "open it" half of toggleSidebar, also used directly by a
// click on the collapsed hint rail (which can only ever mean "open"). Restores
// the last comments-sidebar spot (see restoreLastSidebarFocus) instead of
// always resetting to the composer row.
function openSidebar() {
  cs.sidebarOpen = true
  restoreLastSidebarFocus()
}

// restoreLastSidebarFocus lands the keyboard back on the comment/thread the
// reviewer left last this session (lastSidebarFocus, set by exitRelated),
// falling back to the default enterComments() landing (row 0, highlight only
// — see its own comment for why that doesn't auto-open the composer) when:
// there is no remembered spot yet, it was the composer row itself (which is
// exactly what enterComments already lands on), or the remembered comment is
// no longer visible (deleted, or the reviewer since moved to a block/unit
// whose comment scope is now empty). A remembered index past the end of a
// shrunk-but-non-empty list clamps to the last comment instead of bouncing to
// the default, mirroring applyRelRestore's clamping.
// Highlight only, like enterComments — does NOT drop the keyboard into the
// reply/reaction textarea (toComment(false)/focusThread(false)): a `g`
// re-open must behave the same way a fresh open does (see enterComments'
// own comment on why) — landing straight in an editable field would swallow
// the reviewer's very next keystroke (e.g. a literal "g" meant to toggle the
// sidebar shut again) as typed text instead. An explicit Enter still opens
// it (isCommentFocused/openComposer in home.mjs), same as a fresh `g`-open.
function restoreLastSidebarFocus() {
  const want = lastSidebarFocus
  if (!want || want.focus === 'new') {
    enterComments()
    return
  }
  const n = visibleComments().length
  if (n === 0) {
    enterComments()
    return
  }
  cs.sel = Math.min(want.sel, n - 1)
  if (want.focus === 'thread') {
    cs.focus = 'thread'
    cs.threadPos = Math.min(want.threadPos, reactionCount())
    focusThread(false)
  } else {
    toComment(false)
  }
}

// sidebarHintRail — the collapsed state: a narrow rail on the right edge with
// the comment count and the running/waiting task count, clickable to open.
function sidebarHintRail(state) {
  return html`
    <button
      type="button"
      class="${() =>
        // Mirror <main>'s reactive bottom reservation (home.mjs's DetailPanel):
        // none once the footer has nothing to show (state.footerVisible
        // false), 90px for just the inline diff, 140px while it also shows an
        // AI unit description — so the rail never slides in behind it, but
        // doesn't reserve dead space once the footer itself is gone. Whole-
        // value function binding (arrow.js class rule, see conventions.md).
        `fixed right-0 top-6 ${
          !(state && state.footerVisible) ? 'bottom-6' : state.footerExplain ? 'bottom-[140px]' : 'bottom-[90px]'
        } z-20 flex w-12 flex-col items-center justify-center gap-4 rounded-l-xl border border-r-0 border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5 text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800/60 hover:text-indigo-500 dark:hover:text-indigo-400`}"
      data-testid="sidebar-collapsed"
      title="Comments &amp; taken (g)"
      aria-label="Comments en taken tonen"
      @click="${() => openSidebar()}"
    >
      <span class="flex flex-col items-center gap-0.5" data-testid="sidebar-hint-comments">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-4 w-4"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
        </svg>
        <span class="text-[11px] font-semibold tabular-nums" data-testid="sidebar-hint-comments-count"
          >${() => visibleComments().length}</span
        >
      </span>
      <span class="flex flex-col items-center gap-0.5 text-amber-600 dark:text-amber-400" data-testid="sidebar-hint-tasks">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-4 w-4"
        >
          <circle cx="12" cy="12" r="9"></circle>
          <polyline points="12 7 12 12 16 14"></polyline>
        </svg>
        <span class="text-[11px] font-semibold tabular-nums" data-testid="sidebar-hint-tasks-count"
          >${() => runningTaskCount(state)}</span
        >
      </span>
    </button>
  `
}

// CommentsSidebar — the fixed-position sidebar itself: comments on top, taken
// stacked below when open (cs.sidebarOpen), else the collapsed hint rail.
// Mounted once, at top level, alongside PrInfoPanel/BlockList/DetailPanel (see
// home.mjs) — not inside <main>'s column flow.
export function CommentsSidebar(state, commentTarget, openCompose, openTaskFn) {
  const openTask = (run) => openTaskFn && openTaskFn(run)
  // Load comments (and start the poll/heartbeat) unconditionally, once, at
  // mount — regardless of whether the sidebar is open. commentsSection() only
  // runs its own syncComments() call while cs.sidebarOpen is true (it's inside
  // the collapsible branch below), so without this the comment list — and
  // hence visibleComments(), which the ↓/↑ row-walk and the hint-rail count
  // both depend on — would stay empty until the reviewer opens the sidebar
  // for the first time. Mirrors how state.prMeta/state.workflows already load
  // progressively regardless of whether their column happens to be visible.
  syncComments(state ? state.pr : null)
  return html`
    <div>
      ${() =>
        cs.sidebarOpen
          ? html`<div
              class="${() =>
                // Reactive bottom reservation, same 3-way rule as
                // sidebarHintRail above (mirrors <main>'s DetailPanel binding
                // in home.mjs).
                `fixed right-6 top-6 ${
                  !(state && state.footerVisible) ? 'bottom-6' : state.footerExplain ? 'bottom-[140px]' : 'bottom-[90px]'
                } z-20 flex w-[36rem] min-h-0 flex-col gap-3`}"
              data-testid="comments-sidebar"
            >
              ${commentsSection(state, commentTarget, openCompose)}
              ${workflowsSection(state, openTask)}
            </div>`.key('comments-sidebar-open')
          : sidebarHintRail(state).key('comments-sidebar-collapsed')}
    </div>
  `
}
