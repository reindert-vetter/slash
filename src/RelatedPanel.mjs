// RelatedPanel — the column to the right of the selected block: the
// underlying code the block calls into — its child blocks from the relations
// read-model (GET /api/relations), passed down by home.mjs. The live
// **comments** on lines of code (wired to the task_code_comment workflow) are
// no longer part of this card — home.mjs renders them as their own inline
// block(s), directly above this card, via InlineComments below (one card per
// conversation, visible only while its unit is selected — see
// detail-layout.md). Tasks (workflow runs) also no longer live here — they
// moved to a block under the PR-description column (TasksPanel below, mounted
// from home.mjs' prInfoCard area).

import { html } from './vendor/arrow.js'
import { reactive } from './vendor/arrow.js'
import { highlight, blockLabel, codeGrowthChars } from './Block.mjs'
import { translationValueView } from './translationDiff.mjs'
import { statusInfo, categoryClass } from './BlockList.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { renderMarkdown } from './markdown.mjs'
import { avatarHTML, displayNameOf, ensureMe, ensureNames, identityOf, meLogin } from './avatar.mjs'
import { labelForWorkflow } from './workflowLabels.mjs'
import { claudeChatColumn } from './ClaudeChat.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { colWidthStyle, startColumnResize, resetColumnWidth, resizeHandle, parseAutoWidthPx } from './columnWidth.mjs'

// colWidthKeyFor — the manual-column-width identity (see columnWidth.mjs /
// .claude/docs/column-resize.md) for the three RelatedPanel-side columns
// (related-code/claude-chat-column/inline-comments). Unlike Block.mjs's
// diff/drilled columns these never receive a raw block, only
// commentTarget() — so the key reuses the same `${file}:${line}` identity
// blockRef already relies on elsewhere (see CLAUDE.md's URL-state section).
// Each kind gets an INDEPENDENT override, even though comments/claude/related
// sit in visually related rows — see column-resize.md's accepted trade-off
// (resizing one no longer keeps the comment/Claude row width-matched to the
// Underlying-code row beneath it).
function colWidthKeyFor(kind, commentTarget) {
  const t = commentTarget()
  return t ? kind + ':' + t.file + ':' + t.line : null
}

// ── Real comments (task_code_comment workflow) ────────────────────────────────
// This section IS wired to the API. Placing a comment starts a Workflow
// Execution (POST /api/workflows/task_code_comment); a reaction sends a Signal
// (POST /api/workflows/{runId}/signals/reply). Everything else here is read-only
// (GET /api/comments?pr=N). Per the write-boundary rule, the UI only ever writes
// by starting or signalling a workflow — never straight to a store.
// focus/threadPos drive the keyboard navigation of the inline comment block
// (see home.mjs → onKeydown). focus is which region owns the arrows: null (the
// diff/list has the keyboard), 'code' (the related-code block, light-blue
// border), 'new' (the composer actually OPEN/composing — reached only via the
// command palette's `startComment` (or convertWarningToComment for an AI
// finding) — there is no dedicated trigger row/stop for it any more, see the
// removed enterTrigger/isTriggerFocused), 'comment'
// (an existing conversation, cs.sel — walked with ↓/↑, only entered when at
// least one exists on the selected unit), or 'thread' (inside that
// conversation's message history). threadPos indexes the thread bottom-up: 0 =
// the reply field (typing), 1..n = the n-th message from the bottom (1 =
// newest), so ↑ walks to older messages and ↓ back down. A thread's messages
// are the comment's own body (its opening message) followed by its reactions
// — see threadMessages.
// `scope` is the current selection context (from home.mjs, pushed via
// setCommentScope): { file, label, mode, gran, rowStart, rowEnd, seg }, or
// `{ none: true }` when a PR-wide comment-index item is selected (no code
// anchor at all — see "Selecting a Start item empties the block-scoped index"
// in comments-panel.md), or plain `null` when nothing is selected yet.
// It lives on cs — RelatedPanel's own reactive — on purpose: the render reads
// cs and reliably re-renders on cs changes, whereas reading home.mjs' `state`
// across the module boundary from inside this list binding did not retrigger
// it. home.mjs bridges state→cs.scope with an arrow.js watch. cs.view (see
// recomputeView) is ALREADY scoped to exactly the selected unit — this is
// what InlineComments renders, unchanged from before this stops being a
// browsable, unscoped index.
// codeSel indexes the selected underlying-code child while cs.focus === 'code':
// → walks it forward through the child list.
const cs = reactive({
  pr: null,
  list: [],
  view: [],
  sel: 0,
  composing: false,
  busy: false,
  // replySent is a brief, ephemeral confirmation flash (mirrors overview.mjs'
  // ui.copiedFor) for the send-status icon next to the reaction "Stuur"
  // button — see sendStatusIcon/sendReaction below. Reset by a timer, never
  // bound to the URL.
  replySent: false,
  focus: null,
  threadPos: 0,
  // claudePos is threadPos's twin for the embedded Claude conversation
  // ('claude', see the "Embedded Claude conversation" section below): 0 = the
  // composer (typing), 1..n = the n-th turn from the bottom.
  claudePos: 0,
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
  // has ever restored, purely ephemeral.
  chipPath: [],
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
    { key: 'claudePos', param: 'cpos', parse: num(0), default: 0 },
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
  cs.focus !== null || cs.codeSel !== 0 || cs.sel !== 0 || cs.threadPos !== 0 || cs.claudePos !== 0
    ? { focus: cs.focus, codeSel: cs.codeSel, sel: cs.sel, threadPos: cs.threadPos, claudePos: cs.claudePos }
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
// reactive tick doesn't needlessly re-render the list. A sentinel scope
// (`{ none: true }` — a selected PR-wide comment-index item, see
// home.mjs' commentScope) gets its own fixed signature `'none'`, distinct from
// both the real-scope join (which always starts with a real file path) and the
// null-scope `''` ("nothing selected yet") — so switching between "nothing"
// and "comment-item selected" always triggers a recomputeView(), which is the
// only place cs.view actually re-derives.
export function setCommentScope(scope) {
  const sig = !scope
    ? ''
    : scope.none
      ? 'none'
      : [scope.file, scope.label, scope.mode, scope.gran, scope.rowStart, scope.rowEnd, scope.seg].join('|')
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
  // PR-wide comments (kind !== '': imported issue comments / review summaries
  // / code_warning findings) have no file:line anchor — home.mjs turns them
  // into their own navigable "Start" sidebar items instead (see
  // recomputeLeftList/commentBlockItem, and prWideComments/commentDetailCard
  // below), never the block-scoped index. Exclude them here so they don't
  // leak into this list (esp. list-mode / null-scope, which would otherwise
  // show the whole list).
  // An orphan is excluded for the same reason: its block is gone, so it gets a
  // "Start" row of its own (prWideComments below) and must not ALSO leak into the
  // null-scope list-mode view, which would show it twice.
  const anchored = cs.list.filter((c) => !c.kind && !isOrphanComment(c))
  const s = cs.scope
  // A selected PR-wide comment-index item (see setCommentScope's sentinel) has
  // no code anchor, so by definition no code-comment falls under it — this
  // must be checked BEFORE the `!s` branch below, since both leave `s`
  // falsy-for-filtering-purposes but mean opposite things: `!s` is "nothing
  // selected yet, show everything", `s.none` is "something is selected and it
  // is exactly this — show nothing".
  if (s && s.none) {
    cs.view = []
    return
  }
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
// Block can mark them with a 💬 (presence only — the count doesn't matter, and
// only an *open* comment counts: a resolved one is done, so it no longer marks
// its row — only if every comment on that row is resolved does the icon
// actually disappear, a row with a mix keeps it). Reads cs.list, so it re-runs
// as comments load/change (e.g. a resolve). Comments with an unknown anchor
// (rowStart < 0) sit on no row, so they're skipped here (they still show in the
// index). Exported for home.mjs → Block(commentedRows).
export function commentRowSet(b) {
  const set = new Set()
  if (!b) return set
  // No bounds check against the block's row count is needed here: paneHTML walks
  // the block's own rows and asks `commented.has(i)`, so an index past the end is
  // structurally unrenderable. An index that is stale but still IN range would
  // mark the wrong row, and no bound can catch that — that is what the re-anchor
  // pass on every ingest refresh is for (reanchor.go).
  for (const c of cs.list) {
    if (c.file !== b.file || c.label !== b.label) continue
    if (c.status === 'resolved') continue
    if (c.rowStart == null || c.rowStart < 0) continue
    for (let i = c.rowStart; i <= c.rowEnd; i++) set.add(i)
  }
  return set
}

// commentListSnapshot exposes cs.list itself (unconditionally, no early
// return) so home.mjs's decoupled commentActivity watch can list it as an
// inline dependency in its getter — the same "call an exported getter that
// unconditionally reads the property" pattern the recomputeLeftList watch
// already uses on prWideComments() (see detail-layout.md). Deliberately not
// cs.list directly (module-private) — this keeps the comments state owned by
// this module while still letting home.mjs subscribe to its changes.
export function commentListSnapshot() {
  return cs.list
}

// commentActivitySummary rolls up, over a set of "file|label" keys (a block's
// own anchor plus every PR-block in its subtree, see commentScopeKeys in
// home.mjs), how many OPEN comment THREADS anchor somewhere in that scope and
// who posted the most recent message across them — the sidebar's "there's
// something to look at in the underlying code" indicator
// (state.commentActivity → BlockList.mjs's commentActivityPill). Mirrors
// commentRowSet's own rule exactly: only an open comment counts (kind === '',
// i.e. block-anchored — a PR-wide comment has no file:label anchor and is
// never in scope anyway; status !== 'resolved') — once every thread in scope
// is resolved, the indicator disappears, same as the 💬 row marker. "Multiple
// comments" counts distinct THREADS, not individual messages within one
// thread's reactions — a single thread with several replies still counts as
// one. The "last person" is the author of the newest MESSAGE across all
// matched threads (a thread's own last reaction, or the thread's own body if
// it has no reactions yet — reactions already arrive in chronological order,
// same assumption as lastReplyNote), resolved through identityOf so the
// reviewer's own reply shows their own identity instead of the generic
// in-app placeholder. Returns null when nothing matches (keys empty, or no
// open thread in scope) so BlockList.mjs's nested slot can render '' — never
// an object with count 0.
//
// `matchesRow` (optional) additionally restricts which matched comments
// count — home.mjs's lineChildSummaries uses this to fold a comment placed
// directly on the block's OWN row into its per-line avatar+N badge (not just
// underlying-code-children activity, per Reindert's explicit choice): a
// child's own comments still count regardless of row (no restriction needed
// there — the child is a separate block), but the block's OWN comments must
// only count on the one anchor row they actually roll up onto, or every row
// of the block would show the same combined badge.
export function commentActivitySummary(keys, matchesRow) {
  if (!keys || !keys.size) return null
  let count = 0
  let lastMsg = null
  for (const c of cs.list) {
    if (c.kind) continue // PR-wide comment — no file:label anchor, can't be in scope
    if (c.status === 'resolved') continue
    if (!keys.has(c.file + '|' + c.label)) continue
    if (matchesRow && !matchesRow(c)) continue
    count++
    const reactions = c.reactions || []
    const msg = reactions.length
      ? reactions[reactions.length - 1]
      : { source: c.source || 'ui', author: c.author, avatarUrl: c.avatarUrl, createdAt: c.createdAt }
    if (!lastMsg || (msg.createdAt || '') > (lastMsg.createdAt || '')) lastMsg = msg
  }
  if (!count) return null
  return { count, last: identityOf(lastMsg.source, lastMsg.author, lastMsg.avatarUrl) }
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

// scrollIntoViewVertical brings `el` into view within the first ancestor that
// actually scrolls *vertically* (scrollHeight > clientHeight) — and no
// further. Element.scrollIntoView() bubbles through EVERY scrollable
// ancestor on BOTH axes; every "keep this row in view while walking with the
// arrows" caller below only ever specifies `block`, so the omitted `inline`
// defaults to 'nearest' — and since the Onderliggende-code card (and the
// chips fanning out of it) live inside <main>'s horizontally-scrolling column
// flow (see detail-layout.md), that implicit horizontal 'nearest' silently
// drags <main>'s scrollLeft along too, pushing the keyboard-focused diff
// column out of view. Walking a related-item/chip/task list must only ever
// move THIS panel's own vertical scroll, never <main>'s horizontal one — so
// walk up from `el`'s parent to the first genuinely vertically-scrollable
// ancestor and adjust only its scrollTop (a plain vertical <main> — no
// vertical overflow, only horizontal — never matches this check, so the walk
// naturally stops one level before it).
export function scrollIntoViewVertical(el) {
  let node = el.parentElement
  while (node && node !== document.documentElement) {
    if (node.scrollHeight > node.clientHeight) {
      const cRect = node.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      if (eRect.top < cRect.top) node.scrollTop -= cRect.top - eRect.top
      else if (eRect.bottom > cRect.bottom) node.scrollTop += eRect.bottom - cRect.bottom
      return
    }
    node = node.parentElement
  }
}

// scrollChipIntoView keeps the focused chip in view while walking the chip
// tree with the arrows, mirroring scrollCodeIntoView.
function scrollChipIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=related-nested-chip][data-active=true]')
    if (el) scrollIntoViewVertical(el)
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

// enterRelated hands the keyboard to the Onderliggende-code panel, starting
// on the first underlying-code child. Called by home.mjs on → from the diff
// (only when the selected unit carries no comments, see hasVisibleComments/
// enterCommentsHead below) and on ↓ falling through the last inline comment
// conversation (see advanceFromComment). releaseFocus() bumps focusToken so a
// STALE placeComment/createComment tail (see the guard there) recognizes that
// the keyboard has moved on to a — possibly different block's — Onderliggende-
// code panel in the meantime and skips its own now-irrelevant cleanup.
export function enterRelated() {
  releaseFocus()
  cs.composing = false
  cs.focus = 'code'
  cs.codeSel = 0
  cs.chipPath = []
  scrollCodeIntoView()
}

// exitRelated releases the keyboard back to the diff and drops any input focus /
// half-typed new comment. Exported as leaveRelated for home.mjs: drillIntoChild
// calls it to hand a freshly-drilled column's keyboard to its own diff instead
// of landing on its Onderliggende-code panel (see the "Drillen" flow).
function exitRelated() {
  cs.focus = null
  cs.composing = false
  releaseFocus() // a focus request still in flight must not land after this
  const el = document.activeElement
  if (el && el.blur) el.blur()
}
export { exitRelated as leaveRelated }

// focusToken counts every sidebar-focus transition. Originally only guarded
// focusEl's own deferred DOM focus (below): the request is only allowed to
// land while the token still matches the value at request time — i.e. while
// the reviewer has not moved on since. It now ALSO guards placeComment's/
// createComment's async tail (see there): both capture the token before
// their network round-trip and only apply their own follow-up state
// (cs.sel / exitRelated's cs.focus reset) if it's still unchanged by the time
// that await resolves — otherwise the reviewer has since moved the keyboard
// to a different comment/composer/Onderliggende-code panel (possibly on a
// different block entirely, since cs is a module-level singleton) and that
// stale cleanup must not clobber it. See tests/place-comment-return-focus.spec.mjs
// and the "async tail after navigating away" regression this addresses.
let focusToken = 0

// releaseFocus invalidates any focus request/pending async tail still in
// flight. Called by every transition that means "this comment conversation
// (or composer/Onderliggende-code panel) no longer owns the keyboard" or "the
// keyboard moved somewhere else within the inline comment block".
function releaseFocus() {
  focusToken++
}

// focusEl focuses an inline-comment-block input a frame later (once the
// reactive re-render has swapped in the matching view: the new-comment
// composer or the reply field).
//
// The token guard is load-bearing, not defensive dressing: the focus lands a
// FRAME later, so anything the reviewer does in between — most concretely a ←
// right after clicking a comment card (toComment focuses its reply field) —
// runs first. exitRelated then blurs and hands the keyboard back to the diff,
// after which this rAF used to fire anyway and silently steal DOM focus back
// into the (still-mounted) textarea. From there every subsequent key press
// was swallowed by home.mjs' isEditableFocused() guard. Bumping the token on
// each transition makes a stale request a no-op instead.
// Regression test: tests/place-comment-return-focus.spec.mjs.
//
// It waits ACROSS a few frames (FOCUS_FRAMES) rather than giving up after one,
// because the element it targets does not exist yet at call time and is
// mounted BY the very state change that called us: `reaction-compose` only
// renders inside expandedConversation, i.e. once cs.focus === 'comment' has
// already flipped. One frame is normally plenty (arrow.js's reactive update is
// a microtask, so it flushes before the rAF), but not guaranteed — a nested
// reactive slot can need a further pass, and a saturated box can push the
// render past the frame. A single attempt then found nothing and dropped the
// focus SILENTLY AND PERMANENTLY on the restore path, where applyRelRestore
// runs at most once (restorePending is cleared before it lands, by design, so
// it can never hijack later navigation): after a reload the comment card came
// back expanded with rel.foc=comment intact, but its reply field never got the
// caret — which flaked tests/urlstate.spec.mjs' "landing on a comment survives
// a reload" roughly one full-suite run in six.
//
// Retrying does not weaken the token guard above — that's re-checked before
// every attempt, so a navigation in between still cancels the whole thing;
// bounded frames only mean "wait for the render that this transition itself
// caused", never "keep hunting for something to focus".
const FOCUS_FRAMES = 10

function focusEl(sel) {
  const want = focusToken
  const attempt = (left) =>
    requestAnimationFrame(() => {
      if (want !== focusToken) return
      const el = document.querySelector(sel)
      if (el) {
        el.focus()
        return
      }
      if (left > 0) attempt(left - 1)
    })
  attempt(FOCUS_FRAMES)
}

// prefillField is focusEl's sibling for the ONE case that also needs to seed
// the field's value before focusing it (convertWarningToComment/
// startPrCommentConvert, below) — same rAF + focusToken guard, so a stray
// keyboard move in between (see focusEl's own doc comment) makes this a no-op
// too instead of clobbering whatever now owns the keyboard. Places the caret
// at the end of the seeded text (not the start), so the reviewer can keep
// typing straight after the AI's own wording. Waits across the same bounded
// number of frames as focusEl, for the same reason (the field is mounted by the
// state change that called us) — a missed prefill would leave the composer open
// but empty, silently dropping the AI's text the reviewer was meant to edit.
function prefillField(sel, text) {
  const want = focusToken
  const attempt = (left) =>
    requestAnimationFrame(() => {
      if (want !== focusToken) return
      const el = document.querySelector(sel)
      if (!el) {
        if (left > 0) attempt(left - 1)
        return
      }
      el.value = text
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  attempt(FOCUS_FRAMES)
}

// warningOverride, while set, forces the "+ Nieuwe comment" composer (below)
// to anchor on an AI finding's OWN anchor instead of the live cursor — see
// convertWarningToComment and placeComment's own doc comment. `original` is
// the finding comment to delete once the replacement is confirmed placed.
// Every ordinary "open the composer" entry point (toNew/startComment) clears
// this first, so a stale override from an abandoned conversion never leaks
// into a genuinely new, unrelated comment.
let warningOverride = null

// composeDrafts / composeDraftKey — an in-memory (per session, never
// persisted) draft of the new-comment composer's typed text, keyed by the
// unit it's anchored to (file/label/gran/row-range/seg — the same identity
// commentTarget() itself carries, see home.mjs). Without this, leaving the
// composer (e.g. ← at caret position 0, see editableCaretCanMoveLeft in
// keyboard-navigation.md) discards whatever was typed: the textarea is an
// otherwise uncontrolled DOM element that gets fully unmounted on close, and
// re-opening (toNew/startComment/convertWarningToComment) always
// mounted a brand-new, empty one. Re-opening on the SAME unit now restores it
// (via prefillField, the existing "set value once the field has mounted"
// helper — deliberately NOT a reactive `.value="${...}"` binding: there is no
// such binding anywhere else in this codebase, and re-evaluating it on an
// unrelated rerender while composing would reset the live DOM value/caret,
// see the "outer closure depends on navigation state" pitfall in
// conventions.md) so the reviewer can continue typing instead of starting
// over. `replyDrafts` mirrors this for an existing thread's reply field
// (reaction-compose, see toComment/sendReaction below) — keyed simply by the
// comment's own stable id, since a placed comment already has one.
const composeDrafts = new Map()
let composeDraftKey = null
const replyDrafts = new Map()

// draftKeyFor mirrors the same anchor identity commentPath/commentTarget()
// use server-side (file + label + gran + row-range + seg) — stable across
// leaving and returning to the SAME unit, distinct across different units. A
// null target (no navigable unit yet) falls back to one shared key — a rare
// edge case that at worst shares a draft across two such units, never a
// crash.
function draftKeyFor(t) {
  if (!t) return '__none__'
  return (t.file || '') + '|' + (t.label || '') + '|' + (t.gran || '') + '|' + t.rowStart + '-' + t.rowEnd + '|' + (t.seg || '')
}

// toNew / toComment land on an inline comment card. Landing already opens the
// reply pane and drops the caret in it — the reviewer types straight away, no
// → needed: 'new' shows an empty new-comment composer; a comment shows its
// history with the reply field focused. `commentTargetFn` (optional) is the
// same commentTarget() callback the composer itself renders against — used
// only to compute/restore the draft key above; every caller already has it
// in scope (see home.mjs's own commentTarget and RelatedPanel's own params).
function toNew(commentTargetFn) {
  releaseFocus()
  warningOverride = null
  // A stale ensureClaudeAnchorForNew pointer from a PREVIOUS draft (on a
  // different unit) must never be reused by placeComment below — see its own
  // doc comment. draftKeyFor's own unit-scoped compare is a second safety
  // net, this just avoids ever needing it in the common case.
  claudeAutoAnchor = null
  cs.composing = true
  cs.focus = 'new'
  composeDraftKey = draftKeyFor(commentTargetFn ? commentTargetFn() : null)
  focusEl('[data-testid=comment-compose]')
  const draft = composeDrafts.get(composeDraftKey)
  if (draft) prefillField('[data-testid=comment-compose]', draft)
  // A brand-new composer with no comment on THIS unit yet must not keep
  // showing a STALE Claude conversation left over from whatever was open
  // before (a different unit's transcript/runId — which "Commit wijziging"
  // would otherwise silently act on). Only reset when there is genuinely
  // nothing to anchor to yet; an existing conversation on this exact unit
  // (chatAnchorComment) keeps showing normally.
  if (!chatAnchorComment()) {
    cc.commentId = null
    cc.messages = []
    cc.runId = null
    cc.status = 'idle'
    cc.progress = null
  }
}

// `focusInput` defaults to true for every existing caller (a click or an
// explicit arrow-key step onto a comment card) — landing already opens the
// reply pane and drops the caret in it, per this file's own long-standing
// convention. `enterCommentsTail` below is the one exception: passing `false`
// there re-selects the card/scrolls it into view WITHOUT stealing the
// keyboard into the reply textarea, mirroring the ↑-from-the-first-
// underlying-code-child landing it's called from.
//
// Always resets threadPos to 0: 'comment' is the rest position of the
// conversation, and ↑ from there always starts a fresh walk of the thread's
// own bubbles (see handleRelatedKey's 'comment'+ArrowUp branch) — a leftover
// threadPos from a previous comment (or from stepping back out of 'thread'/
// 'claude') must never leak into that walk.
function toComment(focusInput = true) {
  releaseFocus()
  cs.composing = false
  cs.focus = 'comment'
  cs.threadPos = 0
  scrollCommentIntoView()
  if (focusInput) {
    focusEl('[data-testid=reaction-compose]')
    // Restore whatever reply the reviewer was mid-typing on THIS comment
    // before navigating away (see replyDrafts above) — same mechanism/
    // reasoning as the new-comment composer's own composeDrafts.
    const c = selComment()
    const draft = c && replyDrafts.get(c.id)
    if (draft) prefillField('[data-testid=reaction-compose]', draft)
  }
}

// hasVisibleComments reports whether the currently selected unit carries at
// least one comment conversation — the gate home.mjs' → (from the diff) uses
// before entering the inline comment block: it's only a REACHABLE stop via →
// when it actually has something to show (see keyboard-navigation.md).
export function hasVisibleComments() {
  return visibleComments().length > 0
}

// enterCommentsHead lands the keyboard on the FIRST comment conversation of
// the selected unit — called by home.mjs on → from the diff, only when
// hasVisibleComments() is true (otherwise → goes straight to enterRelated()).
export function enterCommentsHead() {
  cs.sel = 0
  toComment()
}

// enterCommentsTail lands on the LAST comment conversation — the mirror of
// enterCommentsHead, reached via ↑ from the first Onderliggende-code child
// (handleRelatedKey) when hasVisibleComments() is true. Highlight-only (no
// reply-field focus-steal), matching every other "step back into an already-
// populated stop" landing in this file.
export function enterCommentsTail() {
  cs.sel = Math.max(0, visibleComments().length - 1)
  toComment(false)
}

// advanceFromComment steps ↓ from the currently focused comment conversation
// (or from the bottom of its thread, threadPos === 0) to the next one — and,
// once there is no next conversation, continues on into the Onderliggende-
// code panel instead of clamping (see keyboard-navigation.md: "↓ loopt door
// naar het onderliggende-code-blok").
function advanceFromComment() {
  if (selI() < visibleComments().length - 1) {
    cs.sel += 1
    toComment()
  } else {
    enterRelated()
  }
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
// first message (the opening, shown as its author's bubble) followed by every
// reaction. So the comment that titles the thread also reads back as its first
// chat message. The synthetic opening carries the comment's OWN source (with
// 'ui' as the fallback for an app-placed comment without one), so an imported
// GitHub comment or an AI finding opens on the LEFT like any other foreign
// message — only genuinely own (ui-placed) comments render on the reviewer's
// side. An earlier version hardcoded 'ui' here, which put e.g. a review bot's
// whole opening comment in the reviewer's own right-aligned bubble.
function threadMessages(c) {
  if (!c) return []
  // The opening bubble carries the comment's own author AND avatar, so it shows
  // the same profile picture as the header above it instead of falling back to
  // an initials circle.
  const origin = {
    id: 'origin:' + c.id,
    source: c.source || 'ui',
    author: c.author,
    avatarUrl: c.avatarUrl,
    body: c.body,
  }
  return [origin, ...(c.reactions || [])]
}

// lastReplyNote — who sent the LAST message of the thread, for the compact
// summary (see compactConversation): the meta line otherwise only shows the
// ROOT author + reaction count, which never changes once someone replies —
// so a reviewer had no way to tell whether the ball is still in their own
// court without expanding every thread. Empty as long as there's nothing
// beyond the opening message (the author line already covers that), and
// empty once the reviewer's OWN reply is the last one — 'reviewer' is the
// current in-app-reply sentinel (a real GitHub login isn't threaded through
// yet, see the note in detail-layout.md); once that lands this still works,
// as long as the reviewer's own login is compared the same way. Plain text,
// not color, so it also carries meaning for a colorblind reviewer.
function lastReplyNote(c) {
  if (!c || !c.reactionCount) return ''
  const msgs = threadMessages(c)
  const last = msgs[msgs.length - 1]
  if (!last || !last.author || last.author === 'reviewer') return ''
  // Their real first name once known, the login otherwise — same rule as every
  // other author line (see identityOf/displayNameOf in avatar.mjs).
  return ' · ' + displayNameOf(last.author) + ' reageerde'
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
    if (el) scrollIntoViewVertical(el)
  })
}

function scrollReactionIntoView() {
  requestAnimationFrame(() => {
    // threadPos counts from the bottom (1 = newest), so the array index is
    // reactions.length - threadPos.
    const j = reactionCount() - cs.threadPos
    const el = document.querySelectorAll('[data-testid=reaction-bubble]')[j]
    if (el) scrollIntoViewVertical(el)
  })
}

// focusThread puts the caret in the reply field at the bottom of the thread
// (threadPos 0, ready to type) or, once the reviewer walks up into the history,
// blurs it and scrolls the selected older message into view. `focusInput`
// (default true, see toComment's own comment on the same pattern) is only
// passed false by applyRelRestore — a refresh-restore of a remembered thread
// position should re-highlight it, not immediately drop the keyboard into the
// reply field.
function focusThread(focusInput = true) {
  releaseFocus()
  const want = focusToken
  requestAnimationFrame(() => {
    if (want !== focusToken) return
    const input = document.querySelector('[data-testid=reaction-compose]')
    if (cs.threadPos === 0) {
      if (input && focusInput) input.focus()
    } else {
      if (input && document.activeElement === input) input.blur()
      scrollReactionIntoView()
    }
  })
}

// ── Embedded Claude conversation (claude_chat workflow) ──────────────────────
// A Claude conversation always hangs off an existing comment thread (product
// decision — see .claude/docs/claude-chat-panel.md).
// The column is reached the same way the comment thread itself is: → deepens
// one level further (comment → thread → claude), and it is ALSO reachable
// directly from the diff when the selected unit has no comment thread at all
// yet — the first entry then silently creates an empty, private (never
// posted to GitHub) comment to hang the conversation on, so the panel is
// unconditionally reachable, exactly like "net zo'n blok als het
// comments-blok" was asked for — it just starts out empty. `cc` is this
// module's own reactive chat state for whichever ONE conversation is
// currently in view — mirrors `cs`/`rc`. The actual template is a pure
// function in ClaudeChat.mjs, fed a plain snapshot + callbacks (never
// `cc`/`cs` directly), so that file never needs to import this one back —
// the same split translationDiff.mjs already has with Block.mjs.
const cc = reactive({
  commentId: null,
  runId: null,
  messages: [],
  // 'idle' | 'loading' | 'error' — a state of the PANEL itself (ensuring the
  // workflow / fetching the transcript). A genuinely failed Claude TURN is a
  // normal message with kind 'error' (see chat_workflow.go), not this field.
  status: 'idle',
  busy: false, // a message/turn is currently in flight (POST .../signals/message)
  // progress is the VOLATILE snapshot of a turn Claude is running right now
  // (chat_progress.go): which phase/tool, plus the answer text produced so
  // far. Pushed over SSE (chat.progress) and refetched on (re)connect from
  // GET /api/chat/progress; never persisted anywhere, so it is null whenever
  // no turn is running. The saved transcript (cc.messages) stays the truth.
  progress: null,
  // tick exists purely so the "Claude denkt… 12s" counter re-renders once a
  // second while a turn runs — a reactive heartbeat, not data.
  tick: 0,
  // conversations holds the ids of THIS PR's comment threads that already have
  // Claude turns (GET /api/chat?pr=N, refreshed alongside every comment poll).
  // Reactive and only ever REASSIGNED, never mutated — the chat column's
  // visibility binding reads it through chatConversationExists(), and a plain
  // (non-reactive) value would leave a column that should reappear invisible
  // until the next navigation step (see claude-chat-panel.md).
  conversations: [],
})

// chatConversationExists / chatAnchorComment answer the two halves of "does
// this unit have a Claude conversation to show, and which comment does it hang
// on". A chat ALWAYS hangs on an existing comment (the backend's own
// constraint) and nothing ever auto-creates one for it — so the unit either
// carries a comment, or it carries a comment whose conversation already has
// turns but which is filtered out of the visible index (an orphan/PR-wide
// comment), or there is simply no chat.
function chatAnchorComment() {
  const c = selComment()
  if (c) return c
  const s = cs.scope
  if (!s) return null
  const hasTurns = (id) => cc.conversations.indexOf(id) >= 0
  return cs.list.find((x) => x.file === s.file && x.label === s.label && hasTurns(x.id)) || null
}
function chatConversationExists() {
  return !!chatAnchorComment()
}

// loadChatConversations refreshes cc.conversations for pr — read-only GET, so
// it rides along with the comment poll (loadComments) rather than owning a
// timer of its own.
async function loadChatConversations(pr) {
  if (pr == null) return
  try {
    const res = await fetch('/api/chat?pr=' + encodeURIComponent(pr))
    if (!res.ok) return
    const json = await res.json()
    // Reassign, never mutate — that is what re-runs the visibility binding.
    cc.conversations = json.conversations || []
    // A pending refresh-restore of the chat focus can hinge on exactly this set
    // (a conversation whose comment isn't in the visible index), so give it the
    // same one-shot nudge loadComments gives it. See applyRelRestore.
    applyRelRestore()
  } catch (_) {
    // keep the last good set on a transient error
  }
}

// ensureAndLoadChat ensures the claude_chat Execution for `commentId` exists
// (idempotent server-side via StartWorkflowID) and loads its transcript.
// Switching to a DIFFERENT comment resets cc's transcript first, so a stale
// message from the previous conversation never flashes under the new one.
async function ensureAndLoadChat(pr, commentId) {
  if (cc.commentId !== commentId) {
    cc.commentId = commentId
    cc.messages = []
    cc.runId = null
  }
  cc.status = 'loading'
  try {
    const res = await fetch('/api/workflows/claude_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr, commentId }),
    })
    if (!res.ok) {
      cc.status = 'error'
      return
    }
    const json = await res.json()
    cc.runId = json.runId
    await loadChatMessages(commentId)
  } catch (_) {
    cc.status = 'error'
  }
}

// loadChatMessages re-fetches the transcript (read-only GET, safe to poll).
// Guards against a stale response landing after the reviewer has since
// switched to a different comment's conversation.
async function loadChatMessages(commentId) {
  try {
    const res = await fetch('/api/chat?commentId=' + encodeURIComponent(commentId))
    if (!res.ok) return
    const json = await res.json()
    if (cc.commentId !== commentId) return // stale — a later switch already won
    cc.messages = json.messages || []
    cc.status = 'idle'
  } catch (_) {
    // keep the last good transcript on a transient error
  }
}

// loadChatProgress is the RESYNC read for the live-progress channel: a tab
// that opens (or reconnects) halfway through a turn has missed every
// chat.progress event so far and catches up with this one call. Not a poll —
// it runs on (re)connect and when a conversation is opened, nothing else.
async function loadChatProgress(commentId) {
  const startedAt = Date.now()
  try {
    const res = await fetch('/api/chat/progress?commentId=' + encodeURIComponent(commentId))
    if (!res.ok) return
    const json = await res.json()
    if (cc.commentId !== commentId) return // stale — a later switch already won
    // A pushed event that landed WHILE this request was in flight is newer than
    // what the response describes, so it must win — otherwise a resync (which
    // runs on every reconnect, right next to the events it is catching up on)
    // could wipe a fresher snapshot and freeze the status line.
    if (lastProgressAt > startedAt) return
    applyChatProgress(json.running && json.progress ? json.progress : null)
  } catch (_) {
    // a missing snapshot just means "no live turn known" — the transcript stands
  }
}

// applyChatProgress is the single writer of cc.progress, so "when did we last
// learn something about the live turn" is tracked in exactly one place.
let lastProgressAt = 0
function applyChatProgress(p) {
  cc.progress = p
  lastProgressAt = Date.now()
  syncChatTicker()
}

// sendClaudeMessage sends the reviewer's turn (free text, or the text of a
// clicked question option — see claudeChatColumn's onSend, the same callback
// either way) — or, for `action === 'commit'`, the empty-body "commit this
// change" turn (see chat_workflow.go's ChatMessageSignal.Action). The Signal
// round-trip runs the Activities (incl. the real claude subprocess call, or —
// for 'commit' — the enqueue onto the PR's chat_merge queue) INLINE — see
// tembed-workflows.md — so this await genuinely spans that step. That await is
// no longer what makes an ordinary turn's reply appear, though: the live
// progress (streamed tokens, current tool) arrives meanwhile over SSE, and the
// finished transcript over chat.message. This is only the belt-and-braces
// refetch for the reviewer's OWN send. A 'commit' request's own OUTCOME
// (pushed / nothing to commit / conflict) is never returned synchronously
// here either — it lands later as its own chat message once the shared queue
// gets to it (see chat_merge.go), same as any other assistant turn.
//
// `action` is '' (plain, read-only turn), 'edit' (let Claude use its Edit tool
// against the conversation's shadow worktree) or 'commit' (push that shadow's
// edits — no Body needed, the ONLY case allowed to send with empty text; see
// tasks_api.go's validation of the exact same three values).
//
// `context` (optional) is the reviewer's SELECTION at send time — never part
// of the visible bubble. It travels as its own field on the Signal
// (ChatMessageSignal.Context, chat_workflow.go) and only enriches the PROMPT
// the claude CLI sees (buildChatPrompt); `text`/`trimmed` is what gets saved
// and shown, unchanged. See claudeContextBlock's doc comment for who builds it
// and why only the conversation's first turn does.
async function sendClaudeMessage(text, action = '', context = '') {
  const trimmed = (text || '').trim()
  const isCommit = action === 'commit'
  if (!cc.runId) return
  if (!isCommit && !trimmed) return
  cc.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(cc.runId) + '/signals/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'reviewer',
        body: trimmed,
        action: action || undefined,
        context: context || undefined,
      }),
    })
    await loadChatMessages(cc.commentId)
    clearFinishedChatProgress()
  } finally {
    cc.busy = false
  }
}

// claudeContextBlock builds the invisible selection context sent alongside a
// conversation's FIRST turn only (cc.messages still empty at that point —
// every later turn resumes the same claude CLI session, which already knows
// it, so repeating it would only bloat the prompt for nothing). Built from
// `commentTarget()` (home.mjs) — the same object the comment composer already
// renders against — so it always describes whatever unit/granularity
// (group/line/call, see keyboard-navigation.md's f/d/s) the reviewer is
// currently on. Returns '' when there's nothing useful to say (no target, or
// a block-level target with no real code — see commentTarget's `!unit`
// fallback), which sendClaudeMessage/sendClaudeMessageFromNew treat as "send
// nothing extra", identical to today's behaviour.
function claudeContextBlock(commentTarget) {
  if (cc.messages.length > 0) return '' // not this conversation's first turn
  const t = commentTarget && commentTarget()
  if (!t || !t.file || !t.code) return ''
  const lines = ['Context van de reviewer-selectie (niet door de reviewer getypt):', 'Bestand: ' + t.file]
  if (t.oldStartLine)
    lines.push('Oude regels: ' + t.oldStartLine + (t.oldEndLine > t.oldStartLine ? '-' + t.oldEndLine : ''))
  if (t.newStartLine)
    lines.push('Nieuwe regels: ' + t.newStartLine + (t.newEndLine > t.newStartLine ? '-' + t.newEndLine : ''))
  if (t.label) lines.push('Onderdeel: ' + t.label)
  lines.push('Voorbeeldcode:', '```php', t.code, '```')
  return lines.join('\n')
}

// commitClaudeChange sends the 'commit' turn after the reviewer confirms via
// CLAUDE_COMMIT_CONFIRM_COMMANDS (home.mjs, opened by the chat card's own
// "Commit" button — see ClaudeChatPanel's openCommit callback below). A
// dedicated confirm step because this genuinely fast-forward-pushes Claude's
// shadow-worktree edits onto the PR's real head branch — the same "don't act
// on a single click" caution as the two-step "Approve the whole PR" menu (see
// command-palette.md), unlike 'edit' (below), which only ever touches the
// conversation's own throwaway shadow worktree and is therefore a plain,
// unconfirmed send like any other turn.
export async function commitClaudeChange() {
  await sendClaudeMessage('', 'commit')
}

// clearFinishedChatProgress drops the volatile snapshot once its turn is over.
// Deliberately only when the turn is NOT running: a chat.message also fires for
// the reviewer's own message at the very start of a turn, and clearing there
// would blink the status line away again a moment after it appeared.
function clearFinishedChatProgress() {
  if (cc.progress && !cc.progress.running) applyChatProgress(null)
}

// syncChatTicker runs a 1s heartbeat only while a turn is actually running, so
// the elapsed-seconds counter advances without a permanent timer on the page.
let chatTickTimer = null
function syncChatTicker() {
  const running = !!(cc.progress && cc.progress.running)
  if (running && !chatTickTimer) {
    chatTickTimer = setInterval(() => {
      cc.tick = Date.now()
    }, 1000)
  } else if (!running && chatTickTimer) {
    clearInterval(chatTickTimer)
    chatTickTimer = null
  }
}

// enterClaudeChat is the single entry point for the → chain: called both from
// home.mjs (→ from the diff, only when the column is actually visible) and
// from handleRelatedKey's 'comment'/'thread' ArrowRight branch. `pr` mirrors
// cs.pr (home.mjs' state.pr).
//
// No comment (and no earlier conversation) to hang on ⇒ a plain NO-OP: nothing
// is wrong, there is simply nothing to chat about, and it must not silently
// create a comment to hang a conversation on (that placeholder comment is gone
// for good — see claude-chat-panel.md). Focus is therefore only taken once an
// anchor is known.
export async function enterClaudeChat(pr) {
  const c = chatAnchorComment()
  if (!c) return
  releaseFocus()
  const token = focusToken
  cs.focus = 'claude'
  cs.claudePos = 0
  await ensureAndLoadChat(pr, c.id)
  if (token !== focusToken) return
  ensureChatEvents(pr)
  loadChatProgress(c.id)
  focusClaudeComposer()
}

// isClaudeChatFocused/claudeChatVisible are the two questions home.mjs/this
// panel's own render need: whether the KEYBOARD is on the chat column, and
// whether the column should be VISIBLE at all.
//
// The column exists only when there is something to hang a conversation on: an
// ordinary comment thread already shows (hasVisibleComments(), "net zo'n blok
// als het comments-blok, zichtbaar zodra er al comments zijn"), or a Claude
// conversation for this unit already happened (chatConversationExists(), so a
// conversation whose comment fell out of the visible index doesn't become
// unreachable), or the keyboard is on it right now. NEVER unconditionally: a
// unit with neither must show no chat column at all, and → then goes straight
// to Onderliggende code (see home.mjs' ArrowRight branch).
export function isClaudeChatFocused() {
  return cs.focus === 'claude'
}
// The 'new' branch is the optimistic counterpart of the composer itself: a
// brand-new "Comment op deze regel" composer already shows before anything is
// persisted (cs.focus === 'new', see toNew/composeDrafts above), so the
// Claude column shows right alongside it — nothing is created on the backend
// yet, exactly like the composer's own draft. See "Optimistically visible
// while composing a brand-new comment" in claude-chat-panel.md for how the
// backing comment is lazily created only once the reviewer does something
// real (ensureClaudeAnchorForNew below).
export function claudeChatVisible() {
  return hasVisibleComments() || chatConversationExists() || cs.focus === 'claude' || cs.focus === 'new'
}

// focusClaudeComposer/scrollClaudeMessageIntoView mirror focusThread/
// scrollReactionIntoView exactly, over cc.messages instead of the comment's
// reactions, and cs.claudePos instead of cs.threadPos.
function scrollClaudeMessageIntoView() {
  requestAnimationFrame(() => {
    const j = cc.messages.length - cs.claudePos
    const el = document.querySelectorAll('[data-testid=claude-message]')[j]
    if (el) scrollIntoViewVertical(el)
  })
}
function focusClaudeComposer() {
  releaseFocus()
  const want = focusToken
  requestAnimationFrame(() => {
    if (want !== focusToken) return
    const input = document.querySelector('[data-testid=claude-chat-compose]')
    if (cs.claudePos === 0) {
      if (input) input.focus()
    } else {
      if (input && document.activeElement === input) input.blur()
      scrollClaudeMessageIntoView()
    }
  })
}

// ensureChatEvents subscribes this module to the tab's single SSE connection
// (src/events.mjs) — once per page, never per mount. It REPLACED a pair of
// polling timers (a 4s transcript refetch, and a planned sub-second progress
// poll): a turn is a minutes-long subprocess call whose interesting output is
// produced continuously, which is precisely what polling is bad at.
//
// Both handlers obey the "an event is never the source of truth" rule: a
// transcript change triggers a refetch of GET /api/chat rather than trusting a
// pushed message, and the progress payload — the one thing that IS carried in
// the event — is volatile by definition, with GET /api/chat/progress as its
// resync read.
let chatEventsBound = false
function ensureChatEvents(pr) {
  ensureEvents(pr)
  if (chatEventsBound) return
  chatEventsBound = true
  onEvent('chat.progress', (ev) => {
    if (!cc.commentId || ev.key !== cc.commentId) return
    applyChatProgress(ev.data || null)
    if (cc.progress && !cc.progress.running) {
      // The turn ended. Keep the partial visible for a moment so the bubble
      // doesn't blink out before the real message has been refetched — the
      // chat.message right behind this normally clears it within one fetch;
      // this timer is only the safety net for when that never arrives.
      setTimeout(clearFinishedChatProgress, 4000)
    }
  })
  onEvent('chat.message', (ev) => {
    if (!cc.commentId || ev.key !== cc.commentId) return
    loadChatMessages(cc.commentId).then(clearFinishedChatProgress)
  })
  onEventsResync(() => {
    if (!cc.commentId) return
    loadChatMessages(cc.commentId)
    loadChatProgress(cc.commentId)
  })
}

// claudeChatView/claudeChatCallbacks build the getters + callbacks the pure
// template in ClaudeChat.mjs renders from — GETTER FUNCTIONS (`() =>
// cc.messages`, not the array itself), never `cc`/`cs` imported directly, so
// that file stays free of this one's reactive machinery (and of a circular
// import back to it) — the same split translationDiff.mjs has with
// Block.mjs. Load-bearing that these are functions, not a one-off snapshot:
// once a nested template of a given shape is mounted, arrow.js's chunk reuse
// re-patches it via the STATIC path (only attribute slots and slots whose
// value is itself a function get re-applied; a plain array/string
// interpolation computed once is never revisited) — see the "keyed node
// reused without re-running its bindings" pitfall. So every place in
// ClaudeChat.mjs that can change over time must read through one of these
// getters from inside its OWN `${() => ...}` binding, exactly like
// reactionBubble's own `active`/class bindings do.
function claudeChatView() {
  return {
    messages: () => cc.messages,
    status: () => cc.status,
    busy: () => cc.busy,
    claudePos: () => cs.claudePos,
    // The live turn: null when nothing is running. See cc.progress.
    progress: () => cc.progress,
    // Seconds since the running turn started. cc.tick is read purely to
    // register the reactive dependency that makes this re-render every second
    // (the value itself is irrelevant — the real number comes from the clock).
    elapsed: () => {
      const p = cc.progress
      if (!p || !p.startedAt) return 0
      void cc.tick
      return Math.max(0, Math.round((Date.now() - p.startedAt) / 1000))
    },
  }
}
// `openCommit` is the one callback ClaudeChatPanel receives from home.mjs
// (mirrors InlineComments' own openCompose/openCommentMenu props): a click on
// the card's "Commit" button opens CLAUDE_COMMIT_CONFIRM_COMMANDS via the
// existing command-palette machinery — this file has no access to
// home.mjs's openMenu/ms directly, exactly like it has none for
// openMenu('compose')/openMenu('comment'). `commentTarget` is the same
// callback InlineComments/the composer already render against — needed here
// only for ensureClaudeAnchorForNew's lazy anchor creation (sendClaudeMessage
// itself needs no anchor info once one exists).
function claudeChatCallbacks(state, commentTarget, openCommit) {
  return {
    onSend: (text) => sendClaudeMessageFromNew(state, commentTarget, text),
    // "Bewerk code": the SAME typed text, but as an 'edit'-action turn (Claude
    // may use its Edit tool against the shadow worktree) — a plain send, no
    // confirm step, since it never touches the real PR branch. See
    // sendClaudeMessage's own doc comment for why only 'commit' skips the
    // "needs real text" requirement.
    onSendEdit: (text) => sendClaudeMessageFromNew(state, commentTarget, text, 'edit'),
    onCommitClick: () => {
      if (openCommit) openCommit()
    },
  }
}

// ClaudeChatPanel is the exported component home.mjs mounts next to
// InlineComments, in the same inner row of comments-and-related — 1/3 of
// relatedColumnWidthCls() next to InlineComments' 2/3, see
// commentColumnWidthCls/claudeColumnWidthCls above and detail-layout.md.
// `state`/`commentTarget` mirror InlineComments' own params (commentTarget is
// only needed for the lazy anchor creation above — an already-anchored
// conversation needs no live cursor info); `openCommit` mirrors
// InlineComments' openCompose/openCommentMenu (see claudeChatCallbacks
// above). Wrapped in a stable `contents` root — not a bare toggling
// expression — so the visibility (empty ↔ template) toggle never corrupts
// arrow.js's keyed reconcile (the same pitfall newCommentComposer/
// commentCard guard against). Everything that can change AFTER this column
// first mounts lives behind claudeChatView()'s getters, read from inside
// ClaudeChat.mjs's own `${() => ...}` bindings — see claudeChatView's doc
// comment for why a plain snapshot isn't enough here.
export function ClaudeChatPanel(state, commentTarget, openCommit) {
  ensureChatEvents(state.pr)
  const view = claudeChatView()
  const callbacks = claudeChatCallbacks(state, commentTarget, openCommit)
  const widthKey = () => colWidthKeyFor('claude', commentTarget)
  return html`
    <div class="contents">
      ${() =>
        claudeChatVisible()
          ? html`<div
              class="${() => 'relative shrink-0 p-3 ' + claudeColumnWidthCls()}"
              style="${() => colWidthStyle(state, widthKey())}"
              data-testid="claude-chat-column"
              data-col-resize-root
            >
              ${() =>
                widthKey()
                  ? resizeHandle(
                      (e) =>
                        startColumnResize(e, state, widthKey(), () => parseAutoWidthPx(claudeColumnWidthCls())),
                      () => resetColumnWidth(state, widthKey()),
                    )
                  : ''}
              ${claudeChatColumn(view, callbacks)}
            </div>`
          : ''}
    </div>
  `
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
  // 'claude' also needs a comment to hang the conversation on — it can only
  // ever be restored onto an EXISTING one (see the branch below), which is
  // either in the visible index or is the conversation-carrying comment
  // chatAnchorComment() falls back to (an orphan/PR-wide one).
  if (want.focus === 'code' && children === 0) return
  if ((want.focus === 'comment' || want.focus === 'thread') && comments === 0) return
  if (want.focus === 'claude' && comments === 0 && !chatConversationExists()) return
  restorePending = null
  cs.codeSel = children ? Math.min(want.codeSel, children - 1) : 0
  cs.sel = comments ? Math.min(want.sel, comments - 1) : 0
  // releaseFocus() on the branches that set cs.focus directly (instead of
  // through toNew()/toComment(), which already bump it themselves) — see the
  // focusToken doc comment above for why every cs.focus transition must.
  if (want.focus === 'code') {
    releaseFocus()
    cs.focus = 'code'
    scrollCodeIntoView()
  } else if (want.focus === 'new') {
    toNew()
  } else if (want.focus === 'thread') {
    releaseFocus()
    cs.focus = 'thread'
    cs.threadPos = Math.min(want.threadPos, reactionCount())
    focusThread()
  } else if (want.focus === 'comment') {
    toComment()
  } else if (want.focus === 'claude') {
    // An anchor comment now definitely exists (the guard above waited for it) —
    // restoring a position never writes anything. cs.claudePos isn't re-clamped
    // against cc.messages' real length yet at this point (it hasn't loaded); at
    // worst it's briefly out of range until the next ↑/↓, which clamp against
    // the live length.
    const c = chatAnchorComment()
    if (c) {
      releaseFocus()
      cs.focus = 'claude'
      cs.claudePos = want.claudePos
      ensureAndLoadChat(cs.pr, c.id)
      // A refresh may land mid-turn (the Activity keeps running server-side,
      // it has no idea a tab went away), so catch up on the live progress too.
      ensureChatEvents(cs.pr)
      loadChatProgress(c.id)
      focusClaudeComposer()
    }
  }
  // else (focus null): leave the diff with the keyboard, indices restored silently.
}

// handleRelatedKey drives the panel for one arrow/Escape press and returns 'exit'
// when focus leaves the panel back to the diff (else true). It serves three
// independent regions that share the same cs.focus enum:
//  - the inline Onderliggende-code card ('code', reached by → from the diff
//    when the unit has no comments, or by ↓ falling through the last comment
//    conversation — see advanceFromComment/enterRelated) — ↓/↑ walk its
//    children, ← exits to the diff (or back into comments, see below); ↑
//    from the FIRST child steps back onto the last comment conversation if
//    one exists, else exits to the diff (there is no trigger stop above it
//    any more — see the removed enterTrigger).
//  - an inline comment conversation ('new'/'comment', reached by → from the
//    diff only when hasVisibleComments() is true — see enterCommentsHead) —
//    ↓ walks to the next conversation, falling through to the
//    Onderliggende-code panel once there is no next one (advanceFromComment);
//    → steps ONE level further, straight into the embedded Claude conversation
//    attached to this comment ('claude', see enterClaudeChat) — 'thread' is no
//    longer a horizontal stop in between (↑/↓ within one card felt wrong, see
//    todo-claude-chat-blok.md TODO 2); ← exits to the diff. ↑ on 'comment'
//    first walks the conversation's OWN bubbles ('thread', see below) rather
//    than jumping straight to the previous conversation — only once you're
//    already past the oldest message does ↑ move to the previous conversation
//    (or exit, on the very first one).
//  - that conversation's own message history ('thread', a VERTICAL cursor
//    reached only via ↑ from 'comment', never via →) — ↑/↓ walk older/newer
//    messages; ↓ at the bottom (threadPos === 0) advances to the next
//    conversation (or the Onderliggende-code panel), same as the 'comment'
//    case; ↑ at the top (threadPos === reactionCount(), the oldest message)
//    steps to the PREVIOUS conversation (or exits, mirroring 'comment'+↑ on
//    the first conversation) instead of clamping; ← steps back to the
//    'comment' level (one stop back, not all the way to the diff — mirrors
//    the chip-path "← climbs one level" pattern just below); → steps ONE
//    level further, into the embedded Claude conversation attached to this
//    same comment thread ('claude', see enterClaudeChat).
//  - the embedded Claude conversation ('claude') — ↑/↓ walk older/newer
//    turns exactly like 'thread' does (its own claudePos cursor); ↓ at the
//    bottom falls through to the Onderliggende-code panel (mirroring
//    advanceFromComment, since there's nothing further right of it); ←
//    steps back directly to the 'comment' level (not to 'thread' — mirrors
//    'comment'.ArrowRight reaching 'claude' directly). → and ↑/↓ elsewhere in
//    the chain reach 'claude' via enterClaudeChat, not via a case here — see
//    its own doc comment for the "no comment thread yet" auto-create path.
export function handleRelatedKey(key) {
  if (key === 'Escape') {
    exitRelated()
    return 'exit'
  }
  if (cs.focus === 'claude') {
    if (key === 'ArrowUp') {
      cs.claudePos = Math.min(cs.claudePos + 1, cc.messages.length)
      focusClaudeComposer()
    } else if (key === 'ArrowDown') {
      if (cs.claudePos === 0) {
        enterRelated()
      } else {
        cs.claudePos -= 1
        focusClaudeComposer()
      }
    } else if (key === 'ArrowLeft') {
      // Straight back to 'comment' — 'thread' is no longer visited on the way
      // (mirrors 'comment'.ArrowRight reaching 'claude' directly, see TODO 2
      // in todo-claude-chat-blok.md). toComment() resets threadPos to 0.
      toComment()
    }
    return true
  }
  if (cs.focus === 'thread') {
    if (key === 'ArrowUp') {
      if (cs.threadPos < reactionCount()) {
        cs.threadPos += 1
        focusThread()
      } else if (selI() === 0) {
        // Already at the oldest message of the FIRST conversation — nothing
        // further up at all.
        exitRelated()
        return 'exit'
      } else {
        // Past the oldest message: step to the previous conversation (lands
        // on 'comment', not back into ITS thread — mirrors 'comment'+ArrowUp
        // on the first conversation exiting rather than auto-diving in).
        cs.sel -= 1
        toComment()
      }
    } else if (key === 'ArrowDown') {
      if (cs.threadPos === 0) {
        advanceFromComment()
      } else {
        cs.threadPos -= 1
        focusThread()
      }
    } else if (key === 'ArrowLeft') {
      toComment(false)
    } else if (key === 'ArrowRight') {
      // A focused thread always has its own comment to hang the conversation
      // on, so this can never hit enterClaudeChat's no-anchor no-op.
      enterClaudeChat(cs.pr)
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
        // Nothing further up in this list — step back to the last comment
        // conversation of the unit, if there is one, else leave the panel
        // entirely (there's no trigger stop above it any more — see the
        // removed enterTrigger). ← (below) keeps its own, unconditional
        // "leave the panel" behaviour regardless of codeSel.
        if (hasVisibleComments()) {
          enterCommentsTail()
        } else {
          exitRelated()
          return 'exit'
        }
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
      } else if (hasVisibleComments()) {
        enterCommentsTail()
      } else {
        exitRelated()
        return 'exit'
      }
    }
    return true
  }
  // cs.focus is 'new' or 'comment' here — an inline comment conversation (or
  // the still-empty composer). ↓ advances to the next conversation, falling
  // through to Onderliggende code once there's no next one (advanceFromComment);
  // ↑ on 'comment' first walks that conversation's OWN bubbles (see below) —
  // 'new' has no thread to walk, so it keeps the old "exit or previous
  // conversation" behaviour directly; ← always exits to the diff.
  if (key === 'ArrowDown') {
    advanceFromComment()
  } else if (key === 'ArrowUp') {
    if (cs.focus === 'comment' && selComment()) {
      // Step into 'thread' at the newest bubble — a conversation always has
      // at least its own opening message, so reactionCount() >= 1 here. Only
      // once ↑ walks past the OLDEST message (the 'thread' branch above) does
      // it move to the previous conversation or exit.
      cs.focus = 'thread'
      cs.threadPos = 1
      focusThread()
    } else if (selI() === 0) {
      exitRelated()
      return 'exit'
    } else {
      cs.sel -= 1
      toComment()
    }
  } else if (key === 'ArrowLeft') {
    exitRelated()
    return 'exit'
  } else if (key === 'ArrowRight') {
    if (cs.focus === 'comment' && selComment()) {
      // → steps straight into the embedded Claude conversation — 'thread' is
      // reached only via ↑, not as a horizontal stop (see TODO 2 in
      // todo-claude-chat-blok.md).
      enterClaudeChat(cs.pr)
    }
  }
  return true
}

// startComment opens the "new comment on this line" composer — the command menu
// (home.mjs) calls it so the reviewer can start a comment task from `/`, and it
// is also the only way the composer opens (besides convertWarningToComment,
// for an AI finding): never reached via arrow browsing (see
// hasVisibleComments/handleRelatedKey above — there is no dedicated trigger
// row/stop for it). Mirrors toNew():
// hands the keyboard focus to 'new' and focuses the textarea so the reviewer
// can type immediately. Placing the comment still goes through the workflow
// (placeComment), so the write-boundary is unchanged. `commentTargetFn`
// (optional) is threaded through to toNew() to key/restore a draft — see
// composeDrafts above.
export function startComment(commentTargetFn) {
  toNew(commentTargetFn)
}

// convertWarningToComment opens the "+ Nieuwe comment" composer prefilled
// with an ANCHORED (kind '') AI finding's own text, anchored on that
// finding's own file/label/gran/rowStart/rowEnd/code — not the current
// navigation cursor (see warningOverride/placeComment) — so the reviewer can
// edit it before placing it as a real comment. Called by home.mjs's
// commentCommandsFor (the "Comment hiervan maken" menu item), only for a
// comment whose source is 'ai'. See convertPrWideWarningToComment for the
// PR-wide (unanchored) equivalent, which has no diff/composer to reuse and
// thus goes through a different UI (the PR-wide item's own reply field).
export function convertWarningToComment(c) {
  if (!c || c.source !== 'ai' || c.kind) return
  releaseFocus()
  warningOverride = {
    original: c,
    target: {
      file: c.file,
      line: c.line,
      code: c.code || '',
      gran: c.gran || '',
      label: c.label || '',
      rowStart: c.rowStart != null ? c.rowStart : -1,
      rowEnd: c.rowEnd != null ? c.rowEnd : -1,
      seg: c.seg || '',
      startLine: 0,
      endLine: 0,
      side: 'RIGHT',
      segment: '',
    },
  }
  cs.composing = true
  cs.focus = 'new'
  composeDraftKey = draftKeyFor(warningOverride.target)
  // Prefer a draft the reviewer already started editing (e.g. left and came
  // back to the SAME conversion via the menu again) over the finding's
  // original body — see composeDrafts above.
  prefillField('[data-testid=comment-compose]', composeDrafts.get(composeDraftKey) || c.body || '')
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

// focusedCommentGithubId returns the focused comment's GitHub review-comment
// database id (as a string, for direct use in a URL) — or null when there is
// none (a local/private note, or a comment whose GitHub post hasn't landed
// yet/failed), which is also the signal home.mjs uses to decide whether to
// show the "Open op GitHub" menu item at all (see commentCommandsFor).
// Prefers the backend's own `githubId` field (comments.Comment.GithubID, see
// tembed-workflows.md — set for both an imported comment and a UI-placed one
// that got posted); falls back to parsing the "gh-<id>" runId shape that an
// imported comment's Run ID always has (importedRunID in comment_import.go)
// for a comment seeded/stored before that field existed.
export function focusedCommentGithubId() {
  const c = selComment()
  if (!c) return null
  if (c.githubId) return String(c.githubId)
  if (c.source === 'github' && typeof c.runId === 'string' && c.runId.startsWith('gh-')) {
    const id = c.runId.slice(3)
    if (/^\d+$/.test(id)) return id
  }
  return null
}

// focusedComment returns the currently-focused block-scoped comment object
// (or null) — exported so home.mjs's commentCommandsFor can inspect it (e.g.
// c.source === 'ai') to decide which menu items apply, without duplicating
// selComment/visibleComments' own scoping logic there.
export function focusedComment() {
  return selComment()
}

// deleteComment sends the "delete" signal for comment `c`'s own Workflow
// Execution — the sanctioned write path (see deleteFocusedComment below,
// which wraps this for the currently-focused comment). Exported separately
// so convertWarningToComment/sendConvertedPrWideComment can delete a
// SPECIFIC comment (the AI finding a new comment just replaced) that isn't
// necessarily the one currently focused by the time the replacement has
// landed — the reviewer may have kept typing/navigating in between. Reload
// is the caller's responsibility (both callers batch it with their own
// createComment reload).
export async function deleteComment(c) {
  if (!c || !c.runId) return
  await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'reviewer' }),
  })
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
    await deleteComment(c)
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

// resolveFocusedComment resolves the focused comment's thread. It reuses the
// same "reply" Signal as a thread reply (done:true, an empty "/resolve" body):
// the workflow flips the read-model status to "resolved" and, for a review-diff
// thread, resolves the conversation on GitHub too (the "/resolve" sentinel body
// is never posted as text). PR-wide threads have no GitHub resolve, so it stays
// local-only there.
export async function resolveFocusedComment() {
  const c = selComment()
  if (!c || !c.runId) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body: '/resolve', done: true }),
    })
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

// commentAuthors collects every login a comment list can show: the thread roots
// plus each reaction, plus the local reviewer (own messages resolve through
// identityOf to `me`, whose own first name we want too).
function commentAuthors(list) {
  const out = [meLogin()]
  for (const c of list || []) {
    out.push(c.author)
    for (const r of c.reactions || []) out.push(r.author)
  }
  return out
}

async function loadComments(pr) {
  if (pr == null) return
  try {
    // Who "I" am must be known BEFORE the first comment render: identityOf
    // substitutes the local reviewer on own (ui-placed) messages, and `me` is a
    // plain non-reactive object, so a later arrival would not repaint an
    // already-keyed comment node (see avatar.mjs/ensureMe). Cached after the
    // first call, so this is a no-op on every subsequent poll.
    await ensureMe()
    const res = await fetch('/api/comments?pr=' + encodeURIComponent(pr))
    if (res.ok) {
      const list = await res.json()
      // Same rule, same reason, for the real names behind those authors: resolve
      // every login in the batch BEFORE pushing the list, since `names` is a
      // plain non-reactive Map too (see ensureNames in avatar.mjs). Covers the
      // thread bubbles here as well as the comment-activity avatars in
      // BlockList.mjs/Block.mjs, which all read the same cs.list through
      // identityOf. Cached, so a poll that brings nothing new costs no request.
      await ensureNames(commentAuthors(list))
      cs.list = list
      recomputeView()
      // Which comments already carry a Claude conversation decides whether the
      // chat column exists at all (claudeChatVisible), so it is refreshed on the
      // same cadence as the comments themselves — one extra read-only GET per
      // poll, no bodies. Not awaited: the column simply appears a moment later
      // if this lands after the comment rows, since cc.conversations is reactive.
      loadChatConversations(pr)
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
// `body`. Shared by the composer (placeComment), the command menu's fallback
// ("Maak hiermee een comment", which uses the typed text as the comment), and
// convertPrWideWarningToComment (a brand-new, unanchored PR-wide comment). It
// writes only by starting the workflow (POST), so the write-boundary holds. On
// success it reloads the read-model and selects the fresh comment, and returns
// `true` — callers that need to chain a follow-up write (e.g. deleting the AI
// finding a new comment replaces, see convertWarningToComment/
// sendConvertedPrWideComment) check this before doing so, so a failed POST
// never discards the original without a replacement.
//
// `kind` classifies the comment's anchor exactly like the backend's
// CodeCommentInput.Kind (workflows.go): omitted/'' for a normal, block-scoped
// comment (every existing caller) — the one caller that needs a PR-wide one
// (convertPrWideWarningToComment, no file/line to anchor to) passes 'issue',
// the same Kind an imported general PR comment gets, so the result is an
// ordinary navigable "Start" row (see commentBlockItem/prWideComments in
// home.mjs), not tagged as an AI finding (that badge follows `source`, which
// stays the default 'ui' here — the reviewer, not the AI, now owns this text).
//
// `runCommand` (home.mjs) fires a command's async `run()` without awaiting it
// (see COMPOSE_COMMANDS), so the reviewer regains the keyboard immediately —
// well before this function's own POST + GET round-trip settles. In that
// window they can navigate anywhere, including opening a DIFFERENT comment/
// composer/Onderliggende-code panel (cs is a module-level singleton, shared
// across every block). The `cs.sel = ...` landing below is therefore only
// meaningful if nothing else has taken over the keyboard since — guarded via
// the same focusToken every cs.focus-owning transition bumps (see its doc
// comment). A stale token means the reviewer moved on; skip the landing
// rather than clobber whatever they're now looking at.
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
  kind,
}) {
  if (pr == null || !file || !body) return false
  const token = focusToken
  cs.busy = true
  try {
    const res = await fetch('/api/workflows/task_code_comment', {
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
        kind: kind || '',
      }),
    })
    await loadComments(pr)
    // The fresh comment sits on the unit we just placed it on, so it's the last
    // entry of the (order-preserving) visible list — land the selection there.
    // Only while still relevant (see the doc comment above) — otherwise the
    // reviewer has since focused a different comment/composer/panel, and
    // `visibleComments()` would land this on THAT unrelated context.
    if (token === focusToken) cs.sel = Math.max(0, visibleComments().length - 1)
    return res.ok
  } finally {
    cs.busy = false
  }
}

// claudeAutoAnchor tracks the ONE local comment ensureClaudeAnchorForNew
// (below) creates, keyed by the same draft identity draftKeyFor/composeDrafts
// already use — so placeComment can recognize "this exact still-open
// composer already has a real, if minimally-worded, comment behind it" and
// UPDATE that one instead of starting a second Execution next to it. Cleared
// whenever a fresh composer opens (toNew) so a stale pointer from a different
// unit's draft can never be reused; draftKeyFor's own unit-scoped compare in
// placeComment is a second safety net on top of that.
let claudeAutoAnchor = null

// CLAUDE_ANCHOR_PLACEHOLDER stands in for the reviewer's own comment text when
// they chat with Claude before typing (or instead of ever typing) anything in
// the "Comment op deze regel" field — see ensureClaudeAnchorForNew below. It
// is what the anchor comment's body reads until the reviewer's own text
// replaces it via placeComment's reply-update path.
const CLAUDE_ANCHOR_PLACEHOLDER = '(Nog geen eigen comment getypt — gesprek met Claude gestart.)'

// ensureClaudeAnchorForNew lazily creates the ONE backing comment a Claude
// conversation needs (the backend's own constraint: CommentID must name an
// EXISTING comment) the moment the reviewer sends Claude a message WHILE
// composing a brand-new, not-yet-placed comment (cs.focus === 'new', see
// toNew/startComment) — the same "shows before anything is persisted" idea
// the composer's own draft already relies on (composeDrafts above).
//
// Deliberately NOT the removed auto-placeholder-on-navigation behaviour (see
// "Product decision" in claude-chat-panel.md, "must not come back"): that one
// silently created a comment on bare → navigation, with zero reviewer input.
// This one only fires on a genuine, explicit send — typing into a real text
// field and clicking "Stuur"/"Bewerk code" is exactly the kind of deliberate
// action "Plaats…" already is.
//
// Always `local: true` (never posted to GitHub — the reviewer hasn't
// confirmed any public-facing text yet), reusing whatever is already typed in
// the "Comment op deze regel" field as the body (CLAUDE_ANCHOR_PLACEHOLDER if
// that field is still empty). Returns the created comment, or null if there
// is nothing to anchor to, or an anchor already exists (chatAnchorComment) —
// the ordinary, already-anchored path then applies unchanged.
async function ensureClaudeAnchorForNew(state, commentTarget) {
  if (cs.focus !== 'new') return null
  if (chatAnchorComment()) return null
  const b = state && state.blocks && state.blocks[state.selected]
  if (!b || b.kind === 'comment') return null
  const t = warningOverride ? warningOverride.target : (commentTarget && commentTarget()) || null
  const el = document.querySelector('[data-testid=comment-compose]')
  const typed = el && el.value.trim()
  const ok = await createComment({
    pr: state.pr,
    file: (t && t.file) || b.file,
    line: (t && t.startLine) || b.line,
    body: typed || CLAUDE_ANCHOR_PLACEHOLDER,
    code: t ? t.code : '',
    gran: t ? t.gran : '',
    label: t ? t.label : '',
    rowStart: t ? t.rowStart : -1,
    rowEnd: t ? t.rowEnd : -1,
    seg: t ? t.seg : '',
    local: true,
    startLine: t ? t.startLine : 0,
    endLine: t ? t.endLine : 0,
    side: t ? t.side : 'RIGHT',
    segment: t ? t.segment : '',
  })
  if (!ok) return null
  const c = selComment() // createComment already landed cs.sel on the fresh comment
  if (!c) return null
  claudeAutoAnchor = { draftKey: draftKeyFor(t) }
  return c
}

// sendClaudeMessageFromNew wraps sendClaudeMessage with the lazy-anchor step
// above — the one extra thing a still-composing ('new') unit needs over the
// ordinary, already-anchored case. A no-op ensureClaudeAnchorForNew (an
// anchor already exists, or there's nothing to anchor to) falls straight
// through to the plain send.
async function sendClaudeMessageFromNew(state, commentTarget, text, action) {
  const c = await ensureClaudeAnchorForNew(state, commentTarget)
  if (c) await ensureAndLoadChat(state.pr, c.id)
  await sendClaudeMessage(text, action, claudeContextBlock(commentTarget))
}

// placeComment submits the composer's text as a comment on the current unit.
// Exported so the comment-kind menu (home.mjs COMPOSE_COMMANDS) can place a
// private note via opts.local; the composer button routes through the menu too.
// COMPOSE_COMMANDS' `run()` is fired without being awaited (home.mjs's
// runCommand), so the menu closes and the reviewer gets the keyboard back
// immediately — well before createComment's POST + GET round-trip below
// settles. `token` snapshots focusToken before that await so the tail below
// can tell whether the reviewer has since moved the keyboard elsewhere (a
// different comment/composer/Onderliggende-code panel, possibly on a
// different block — cs is a module-level singleton) — see the focusToken doc
// comment. Regression test: tests/comment-nav-race.spec.mjs.
//
// `warningOverride`, if set (see convertWarningToComment), forces the anchor
// to the AI finding's OWN file/label/gran/rowStart/rowEnd/code instead of
// commentTarget()'s current-cursor unit — the reviewer may have navigated
// elsewhere within the block since choosing "Comment hiervan maken", and the
// replacement comment must land exactly where the finding itself was, not
// wherever the cursor happens to sit now. It's consumed (nulled) right away,
// before the async createComment call, mirroring every other "capture once,
// before the await" convention in this file (token above, focusToken
// elsewhere) — a second, unrelated "+ Nieuwe comment" started while this one
// is still in flight must never see a stale override.
export async function placeComment(state, commentTarget, opts = {}) {
  const b = state && state.blocks && state.blocks[state.selected]
  const el = document.querySelector('[data-testid=comment-compose]')
  const body = el && el.value.trim()
  // A synthetic comment-index item (kind:'comment', see home.mjs's
  // recomputeLeftList/commentBlockItem) has no file/line to anchor a NEW
  // comment to — the composer for such an item should never even open (the
  // block palette isn't reachable while one is selected, see selectedComment
  // in home.mjs), but guard here too rather than post a bogus, unanchored
  // comment if it somehow does.
  if (!b || b.kind === 'comment' || !body) return
  const token = focusToken
  const override = warningOverride
  warningOverride = null
  // Capture the exact unit the composer is previewing so the placed comment's
  // thread can show the same code (see composeTargetHint / the thread hint).
  // commentTarget() follows focusedBlock() (the column that currently owns the
  // diff keyboard), which may be a drilled column rather than the top-level
  // selected block `b` — so t.file/t.startLine (not b.file/b.line) are the
  // ones that must anchor the comment when a drilled column is focused.
  const t = override ? override.target : (commentTarget && commentTarget()) || null

  // A Claude message already lazily created the ONE backing comment for this
  // exact draft (see ensureClaudeAnchorForNew) — "Plaats…" must not start a
  // SECOND Execution next to it. There is no "edit body" Signal (a comment's
  // body is fixed at Execution start), so "updating" it means posting the
  // reviewer's own typed text as a reply on that same thread — the same
  // Signal an ordinary thread reply (sendReaction) already uses — instead of
  // creating a new one. The anchor's own local-ness (fixed at creation,
  // always private, see ensureClaudeAnchorForNew) wins over opts.local here:
  // chatting with Claude first already made this a private thread.
  if (claudeAutoAnchor && claudeAutoAnchor.draftKey === draftKeyFor(t)) {
    claudeAutoAnchor = null
    const c = chatAnchorComment()
    if (c && c.runId) {
      cs.busy = true
      try {
        await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author: 'reviewer', body, done: false }),
        })
        await loadComments(state.pr)
      } finally {
        cs.busy = false
      }
      composeDrafts.delete(draftKeyFor(t))
      if (token !== focusToken) return
      el.value = ''
      exitRelated()
      return
    }
  }

  const ok = await createComment({
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
  // The typed text just became a real, placed comment — the draft that was
  // standing in for it (see composeDrafts above) has nothing left to hold.
  if (ok) composeDrafts.delete(draftKeyFor(t))
  // Only delete the AI finding this comment replaces once the replacement
  // itself is confirmed placed — a failed POST must never discard the
  // finding without anything taking its place.
  if (ok && override && override.original) {
    await deleteComment(override.original)
    await loadComments(state.pr)
  }
  // Only while still relevant (see the doc comment above): if the token
  // changed, the reviewer has already navigated the keyboard elsewhere since
  // starting this comment, and both of the below would clobber that —
  // clearing a composer textarea the reviewer may since be reusing for a
  // fresh comment on a different unit, and forcing whatever now owns the
  // keyboard (e.g. another block's Onderliggende-code panel) back to the
  // diff via exitRelated()'s unconditional cs.focus/cs.composing reset.
  if (token !== focusToken) return
  el.value = ''
  // The reviewer placed a comment tied to a piece of code — hand the keyboard
  // back to that code's diff instead of leaving it sitting on the composer.
  exitRelated()
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
export function composeTargetHint(target) {
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
              class="language-php mt-1 block max-h-16 overflow-auto no-scrollbar whitespace-pre rounded bg-white/70 dark:bg-zinc-800/70 px-2 py-1 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
              .innerHTML="${() => highlight(target.code)}"
            ></code>`
          : ''}
    </div>
  `
}

// sendReaction posts the typed text as a plain (non-resolving) reply — the
// resolve variant (done:true) that used to live here moved to the
// comment-scoped command menu's "Resolve comment" item (resolveFocusedComment
// below), which always sends the fixed "/resolve" sentinel instead of
// whatever happened to be typed — see the reaction-status button in
// expandedConversation for how resolve stays mouse-reachable now.
async function sendReaction() {
  const c = selComment()
  if (!c) return
  const el = document.querySelector('[data-testid=reaction-compose]')
  const body = el && el.value.trim()
  if (!body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body, done: false }),
    })
    if (el) el.value = ''
    // The typed reply just went out — the draft standing in for it (see
    // replyDrafts above) has nothing left to hold.
    replyDrafts.delete(c.id)
    // Brief confirmation flash — unlike the composer/PR-wide reply (which
    // both close their input on success, see placeComment/sendPrCommentReply),
    // this thread stays open, so this is the one send-status spot where
    // "sent" is actually visible.
    cs.replySent = true
    setTimeout(() => {
      cs.replySent = false
    }, 1200)
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

// sendStatusIcon renders the send-status glyph next to a "Stuur"/"Plaats…"
// control: a draft (pencil) icon by default — covering both "nothing typed
// yet" and "typed but not sent" (a reviewer who can't tell colors apart gets
// nothing from a color change alone, and only 3 states were asked for, so
// this deliberately doesn't add a 4th "has text" state) —, a spinning arc
// while the send is in flight, and a circle-check right after it completes.
// Distinguished from commentStatusMark's bare "✓" glyph below on purpose:
// that mark is a PERSISTENT property of the comment thread itself (resolved
// or not, shown in the meta line); this one is a TRANSIENT status of the
// send control itself (an SVG circle-check, never a bare "✓" character) — a
// reviewer must never read "sent my reply" as "this thread got resolved".
// Shape-only, never color-only, since a reviewer using this app is
// colorblind.
function sendStatusIcon(status) {
  if (status === 'sending') {
    return html`<svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5 shrink-0 animate-spin"
      aria-hidden="true"
      data-testid="send-status-sending"
    ><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
  }
  if (status === 'sent') {
    return html`<svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5 shrink-0"
      aria-hidden="true"
      data-testid="send-status-sent"
    ><circle cx="12" cy="12" r="9"></circle><path d="m9 12 2 2 4-4"></path></svg>`
  }
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="h-3.5 w-3.5 shrink-0"
    aria-hidden="true"
    data-testid="send-status-draft"
  ><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`
}

// commentStatusMark is the colorblind-friendly replacement for the former
// color-only status dot (CSTATUS_DOT: open amber / resolved emerald) — a
// reviewer who can't tell amber from emerald gets nothing useful out of a
// plain colored circle. "open" is the neutral/default state and stays
// unmarked (no invented glyph needed for it — dropping the dot there is
// exactly "bolletjes mogen weg"); only "resolved" gets a mark, a plain ✓
// glyph (the same bare-character convention as the done/undone ✓ elsewhere
// in the app — BlockList.mjs's approval pills, translationDiff.mjs's
// per-key ✓ — no SVG). The emerald tint is decoration on top of the glyph,
// never the sole carrier of meaning. `extraCls` lets a call site add its
// own spacing (e.g. compactConversation's `mt-1` to align with the avatar
// row) without a second, near-duplicate function. Returns '' for anything
// else (open, or a null/undefined c during an edge-case render).
function commentStatusMark(c, extraCls) {
  if (!c || c.status !== 'resolved') return ''
  return html`<span
    class="${'shrink-0 text-xs font-bold leading-none text-emerald-600 dark:text-emerald-400 ' + (extraCls || '')}"
    data-testid="comment-resolved-mark"
    title="Opgelost"
    >✓</span
  >`
}

// sourceBadge marks a comment imported from GitHub (source === 'github'), so the
// reviewer can tell app-placed from imported comments — mirrors the "bron:
// haiku/sonnet" badge on LLM-resolved related children. Returns '' for an
// app-placed comment (source '' / 'ui').
function sourceBadge(c) {
  if (c.source !== 'github') return ''
  return html`<span
    class="shrink-0 rounded-full bg-slate-200/70 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400"
    data-testid="comment-source"
    >bron: github</span
  >`
}

// aiWarningBadge marks an automated risk finding from the code_warning
// workflow (source === 'ai') — the same warning-triangle SVG as the coverage
// warning (related-covers-warning above), but as a small inline pill so a
// reviewer can tell an AI-authored finding apart from a human comment at a
// glance, in the comment list, the thread header and the PR-wide list. Returns
// '' for anything else (mirrors sourceBadge's shape; also handles c == null,
// since callers pass selComment(), which can be undefined).
function aiWarningBadge(c) {
  if (!c || c.source !== 'ai') return ''
  return html`<span
    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
    data-testid="comment-ai-warning"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-2.5 w-2.5"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
    AI-risicowaarschuwing</span
  >`
}

// staleAnchorBadge marks a comment whose code the PR has since moved out from
// under it — either the whole symbol is gone ('orphan') or only the exact rows
// could no longer be found ('unpinned'), see reanchor.go. Without it such a
// comment reads as an ordinary one that just happens to sit somewhere odd, and
// the reviewer has no way to tell that the thread's stored snippet is a record of
// code that no longer exists in this shape.
//
// The word carries the meaning, not the colour (the amber tint is decoration on
// top) — same rule as the ✓ status mark, see conventions.md.
function staleAnchorBadge(c) {
  if (!c) return ''
  const label = c.anchorState === 'orphan' ? 'verouderd — code verdwenen' : ''
  const unpinned = c.anchorState === 'unpinned' ? 'verouderd — regel gewijzigd' : ''
  const text = label || unpinned
  if (!text) return ''
  return html`<span
    class="inline-flex shrink-0 items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
    data-testid="comment-stale-anchor"
    >${text}</span
  >`
}

// reactionBubble — one message in the thread. `i`/`total` let it light up when it
// is the one the reviewer walked up to (cs.threadPos counts from the bottom).
// `isActive`, when given, overrides that default check — used by
// commentDetailCard, whose thread cursor is pct (see its own comment above),
// not cs.focus/cs.threadPos. Each bubble carries its own author's avatar+name
// above it — reactions/replies have an `author` just like the comment root
// (see threadMessages), so this works for every message in the thread, not
// only the opening one.
function reactionBubble(r, i, total, isActive) {
  const mine = r.source === 'ui'
  // An own message carries no GitHub author/avatar — identityOf fills in the
  // local reviewer for it (see avatar.mjs), so the name and the picture always
  // describe the same person.
  const who = identityOf(r.source, r.author, r.avatarUrl)
  const active = isActive || (() => cs.focus === 'thread' && cs.threadPos === total - i)
  // Own (ui-placed) messages get a soft indigo tint instead of the earlier
  // saturated bg-indigo-500 + white text — markdown bodies (links, inline
  // code, fenced code with Prism colours) are unreadable on that. Foreign
  // messages keep the neutral tint but gain a subtle border so bubbles read
  // as cards on both themes. The `markdown-body` class on the bubble is
  // load-bearing: without it a fenced code block misses index.html's
  // `.markdown-body pre { overflow-x:auto }` styling and a long code line
  // gets clipped at the bubble edge instead of scrolling.
  return html`
    <div class="${() => 'flex flex-col gap-0.5 ' + (mine ? 'items-end' : 'items-start')}">
      <div class="flex items-center gap-2 py-0.5" data-testid="reaction-author-line">
        ${avatarHTML(who.name, who.avatarUrl, 'h-5 w-5')}
        <span
          class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400"
          data-testid="reaction-author"
          >${who.name || 'onbekend'}</span
        >
      </div>
      <div
        class="${() => {
          const sel = active()
          return (
            'markdown-body max-w-[92%] rounded-xl border px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] ' +
            (mine
              ? 'border-indigo-300 bg-indigo-50 text-slate-800 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-zinc-200'
              : 'border-slate-300 bg-slate-100 text-slate-800 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300') +
            (sel ? ' ring-2 ring-indigo-400' : '')
          )
        }}"
        data-testid="reaction-bubble"
        .innerHTML="${commentBody(r)}"
      ></div>
    </div>
  `
}

// ── Inline comment blocks ──────────────────────────────────────────────────
// A block-scoped comment thread is no longer a browsable, unscoped index in a
// fixed sidebar — it's a small stack of cards rendered inline, directly above
// the Onderliggende-code card (see home.mjs' DetailPanel), one card per
// conversation, EXACTLY the set already scoped to the selected unit
// (visibleComments()/cs.view — unchanged, see recomputeView/commentUnder
// above). Only the currently focused conversation renders expanded (full
// thread + reply field); every other one on the same unit stays a compact,
// clickable one-line summary — several threads on one line thus don't all
// compete for space at once. A new comment is started via the command
// palette's "Comment op deze regel" (startComment) — there is no dedicated
// always-present trigger row any more, and never was it part of the ↓/→
// arrow-key traversal below (see hasVisibleComments/handleRelatedKey above),
// which only ever walks EXISTING conversations.

// compactConversation — a collapsed, clamped-to-3-lines summary of a
// conversation that isn't currently focused/expanded (only the focused one
// gets the unclamped expandedConversation below). A hard 1-line `truncate`
// used to sit here — fine for a short human reply, but it cut off a
// multi-sentence AI-controle finding (code_warning, source 'ai') after just a
// few words, hiding exactly the risk text the reviewer most needs to read
// without having to click every card open first. `line-clamp-3` keeps the
// "only the focused card is fully expanded" space-saving design (several
// threads can still hang off one unit, see InlineComments' own doc comment)
// while giving a typical 2-4 sentence finding enough room to read in place;
// a genuinely long comment still ends in "…" and needs a click to read in
// full.
function compactConversation(c, i) {
  const who = identityOf(c.source, c.author, c.avatarUrl)
  return html`
    <button
      class="${() =>
        'flex w-full items-start gap-2 rounded-md border border-slate-300 dark:border-zinc-700 px-2.5 py-2 text-left transition ' +
        (c.status === 'resolved'
          ? 'bg-slate-50/60 dark:bg-zinc-800/40 hover:border-indigo-200 dark:hover:border-indigo-500/40'
          : 'bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      data-testid="comment-item"
      data-expanded="false"
      @click="${() => {
        cs.sel = i
        toComment()
        beat()
      }}"
    >
      ${() => commentStatusMark(c, 'mt-1')}
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="flex min-w-0 items-center gap-2" data-testid="comment-author-line">
          ${avatarHTML(who.name, who.avatarUrl, 'h-5 w-5')}
          <span class="truncate text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400" data-testid="comment-author"
            >${who.name || 'onbekend'}</span
          >
          ${() => sourceBadge(c)}
          ${() => aiWarningBadge(c)}
          ${() => staleAnchorBadge(c)}
        </span>
        <span
          class="line-clamp-3 [overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200"
          .innerHTML="${commentBody(c)}"
        ></span>
        <span class="truncate text-[11px] leading-snug text-slate-500 dark:text-zinc-500" data-testid="comment-meta"
          >${() =>
            c.file + ':' + c.line + ' · ' + c.reactionCount + ' reacties · ' + c.status + lastReplyNote(c)}</span
        >
      </span>
    </button>
  `
}

// expandedConversation — the full thread (every message via threadMessages/
// reactionBubble, unchanged) plus a working reply field, for the ONE
// conversation currently focused (selI() === i && cs.focus is 'comment'/
// 'thread'). No separate author+avatar header here anymore — that duplicated
// the opening bubble threadMessages() already renders (see threadMessages'
// own doc comment); only the bits the bubbles don't carry (source/AI-warning
// badge, status dot) remain, right-aligned in one slim meta line instead of
// the previous justify-between row (which, once its left side/avatar was
// removed, read as an almost-empty bar). The status mark itself is
// commentStatusMark (see its own doc comment) — a colorblind-friendly ✓
// instead of the former color-only dot.
// expandedConversation's second button (reaction-status, right of "Stuur")
// used to double as the resolve action (sendReaction(true)). It's now a pure
// send-status indicator (draft/sending/sent, see sendStatusIcon) — resolving
// moved to the comment-scoped command menu's "Resolve comment" item, reached
// by keyboard via Enter (see keyboard-navigation.md) and, so it stays
// reachable with the mouse too, by a click on this very button
// (openCommentMenu, threaded down from home.mjs's openMenu('comment') via
// InlineComments/commentCard — mirrors how the composer's own "Plaats…"
// button already opens its command menu via a click callback).
function expandedConversation(c, openCommentMenu) {
  return html`
    <div
      class="${() =>
        'flex flex-col gap-2 rounded-xl border border-indigo-300 dark:border-indigo-500/40 p-3 ring-1 ring-black/5 ' +
        (c.status === 'resolved' ? 'bg-slate-50/60 dark:bg-zinc-800/40' : 'bg-white dark:bg-zinc-900')}"
      data-testid="comment-item"
      data-expanded="true"
    >
      <div class="flex items-center justify-end gap-2" data-testid="comment-meta-line">
        ${() => sourceBadge(c)} ${() => aiWarningBadge(c)} ${() => staleAnchorBadge(c)}
        ${() => commentStatusMark(c)}
      </div>
      ${() => (c && c.code ? composeTargetHint({ gran: c.gran, label: c.label, code: c.code }) : '')}
      <div class="flex min-h-0 flex-col gap-2" data-testid="comment-thread">
        ${() => threadMessages(c).map((r, i, arr) => reactionBubble(r, i, arr.length).key('msg:' + r.id))}
      </div>
      <div class="flex items-center gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-2">
        <input
          class="flex-1 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-1.5 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
          placeholder="Reageer op deze comment…"
          data-testid="reaction-compose"
          @keydown="${(e) => e.key === 'Enter' && sendReaction()}"
          @input="${(e) => c && replyDrafts.set(c.id, e.target.value)}"
        />
        <button
          class="${() => 'shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' + (cs.busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-600')}"
          data-testid="reaction-send"
          disabled="${() => cs.busy}"
          @click="${() => sendReaction()}"
        >
          Stuur
        </button>
        <button
          type="button"
          class="${() =>
            'flex shrink-0 items-center justify-center rounded-lg border px-2.5 py-1.5 transition ' +
            (cs.busy
              ? 'cursor-not-allowed border-slate-200 text-slate-400 dark:border-zinc-800 dark:text-zinc-600'
              : 'border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-indigo-500/40 dark:hover:text-indigo-400')}"
          data-testid="reaction-status"
          title="Reactiestatus · resolve/verwijder via het menu"
          disabled="${() => cs.busy}"
          @click="${() => openCommentMenu && openCommentMenu()}"
        >
          ${() => sendStatusIcon(cs.busy ? 'sending' : cs.replySent ? 'sent' : 'draft')}
        </button>
      </div>
    </div>
  `
}

// commentCard toggles a conversation between compact and expanded. Wrapped in
// a stable `contents` root — not a bare toggling expression — so the swap
// never corrupts arrow.js's keyed reconcile (the "bare toggling expression"
// pitfall in conventions.md): the outer `.key('comment:'+c.id)` (see
// InlineComments below) never needs to change on this toggle, the nested
// `${() => …}` binding handles it.
function commentCard(c, i, openCommentMenu) {
  return html`
    <div class="contents">
      ${() =>
        selI() === i && (cs.focus === 'comment' || cs.focus === 'thread')
          ? expandedConversation(c, openCommentMenu)
          : compactConversation(c, i)}
    </div>
  `
}

// newCommentComposer — the new-comment composer, shown inline only while
// it's actually open (cs.focus === 'new', reached via startComment/the
// command palette's "Comment op deze regel" — never via a dedicated
// click/nav-stop trigger any more, see the removed enterTrigger/
// isTriggerFocused and the always-present "+ Nieuwe comment" row they used
// to belong to). Renders nothing while closed — the stable `<div
// class="contents">` root is still needed for the toggle itself (see the
// "bare toggling expression" pitfall in conventions.md), it just has no
// closed-state button to show any more.
function newCommentComposer(state, commentTarget, openCompose) {
  // effectiveTarget prefers warningOverride's own anchor (see
  // convertWarningToComment/placeComment) over the live cursor's
  // commentTarget() — the composer must show/post to the finding's own
  // anchor, not wherever the reviewer has since navigated to. A plain
  // (non-reactive) module `let` read here is fine: it's only ever set
  // synchronously right before cs.focus flips to 'new' (which this whole
  // slot already re-renders on), and cleared again before the next
  // unrelated open — so a fresh read at render/mount time is never stale.
  const effectiveTarget = () => (warningOverride ? warningOverride.target : commentTarget && commentTarget())
  const target = () => {
    const t = effectiveTarget()
    if (t) return t.file + ':' + (t.startLine || t.line)
    const b = state && state.blocks && state.blocks[state.selected]
    return b ? b.file + ':' + b.line : 'geen regel geselecteerd'
  }
  return html`
    <div class="contents">
      ${() =>
        cs.focus === 'new'
          ? html`
              <div
                class="flex flex-col gap-2 rounded-xl border border-indigo-300 dark:border-indigo-500/40 bg-white dark:bg-zinc-900 p-3 ring-1 ring-black/5"
                data-testid="comment-composer"
              >
                <p class="text-[11px] font-medium text-slate-500 dark:text-zinc-500">
                  ${() => (warningOverride ? 'Comment van AI-controle' : 'Nieuwe comment') + ' · ' + target()}
                </p>
                ${() => composeTargetHint(effectiveTarget() || null)}
                <textarea
                  class="min-h-20 rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-2 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="Je comment op deze regel…"
                  data-testid="comment-compose"
                  @input="${(e) => composeDrafts.set(composeDraftKey, e.target.value)}"
                ></textarea>
                <div class="flex items-center justify-end gap-2">
                  <button
                    class="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300"
                    @click="${() => {
                      warningOverride = null
                      composeDrafts.delete(composeDraftKey)
                      cs.composing = false
                    }}"
                  >
                    Annuleer
                  </button>
                  <button
                    class="${() =>
                      'flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' +
                      (cs.busy ? 'cursor-not-allowed opacity-50' : 'hover:bg-indigo-600')}"
                    data-testid="comment-send"
                    disabled="${() => cs.busy}"
                    @click="${() => (openCompose ? openCompose() : placeComment(state, commentTarget))}"
                  >
                    ${() => sendStatusIcon(cs.busy ? 'sending' : 'draft')}
                    Plaats…
                  </button>
                </div>
              </div>
            `
          : ''}
    </div>
  `
}

// InlineComments — the exported block home.mjs mounts directly above the
// Onderliggende-code card (see DetailPanel): the new-comment composer, once
// opened via the command palette (see newCommentComposer above), then one
// card per conversation already scoped to the selected unit
// (visibleComments()).
export function InlineComments(state, commentTarget, openCompose, openCommentMenu) {
  syncComments(state ? state.pr : null)
  // Own explicit, bounded width instead of the earlier "no own width,
  // stretches to the sibling" comment, which never held: a flex-col's
  // cross-axis stretch only applies to a child whose OWN width is auto, and
  // related-code already sets its own explicit width, so it never stretched
  // this one. Left unbounded, an unwrapped long line inside a comment
  // (composeTargetHint's code excerpt, or a fenced code block in a Markdown
  // comment body via commentBody/renderMarkdown — see conventions.md) forced
  // this whole column — and thus <main> — to shrink-to-fit around that one
  // long line instead of clipping/scrolling inside it, pushing the
  // block/drill columns to its left out of view. `overflow-auto`/
  // `.markdown-body pre {overflow-x:auto}` only actually clip+scroll once
  // their ancestor has a real (non-auto) width to clip against. See
  // detail-layout.md.
  //
  // commentColumnWidthCls() — 2/3 of relatedColumnWidthCls(), so this section
  // sits at 2/3 width next to the Claude column's 1/3 in their shared inner
  // row (home.mjs), while still lining up under related-code below (both
  // rows sum to the same relatedColumnWidthCls() total, see
  // commentColumnWidthCls's own doc comment). The `p-3` mirrors the p-3 on
  // related-code's own inner scroll wrapper (below) — without it, a comment
  // card sat flush against the shared column's left edge while a
  // related-code card sat inset by that same 12px, so the two stacked
  // sections' cards didn't line up vertically.
  const widthKey = () => colWidthKeyFor('comments', commentTarget)
  return html`
    <div
      class="${() => 'relative flex shrink-0 flex-col gap-2 p-3 ' + commentColumnWidthCls()}"
      style="${() => colWidthStyle(state, widthKey())}"
      data-testid="inline-comments"
      data-col-resize-root
    >
      ${() =>
        widthKey()
          ? resizeHandle(
              (e) => startColumnResize(e, state, widthKey(), () => parseAutoWidthPx(commentColumnWidthCls())),
              () => resetColumnWidth(state, widthKey()),
            )
          : ''}
      ${newCommentComposer(state, commentTarget, openCompose)}
      ${() => visibleComments().map((c, i) => commentCard(c, i, openCommentMenu).key('comment:' + c.id))}
    </div>
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
  // its methods (see .claude/docs/tembed-workflows.md, "migration → model").
  model_usage: 'model',
  migration_model: 'model',
  // A test's #[DataProvider('m')]/@dataProvider m → the provider method (see
  // .claude/docs/tembed-workflows.md, "PHPUnit data providers").
  data_provider: 'provider',
  // A class's `use TraitName;` → the trait as a whole (see
  // .claude/docs/tembed-workflows.md, "Resolving trait usage").
  trait_usage: 'trait',
  // A trans()/__()/@lang()/trans_choice() call → the lang file's key, one child
  // per locale (see .claude/docs/tembed-workflows.md, "Resolving translation
  // keys"). Shows the current value, not a diff.
  translation: 'vertaling',
  // A concrete method that both implements an interface method AND changed
  // together with it in this PR (relations.KindInterfaceMethod, "A2" — see
  // .claude/docs/tembed-workflows.md, "Interface methods as underlying
  // code"). No diffstat here — like event_listener/route_controller/etc.,
  // this is always a real, both-changed PR block, so a plain role badge is
  // enough.
  interface_method: 'interface',
  // An interface method with no changed caller/implementer in this PR ("B")
  // → up to 2 concrete implementations, shown alongside a diffstat/
  // "Ongewijzigd" badge (DIFFSTAT_KINDS below) since an implementation MAY
  // itself be a changed PR block.
  interface_impl: 'implementatie',
}

// diffStatBadge shows, for a called method (or a test's covered method), how
// many lines its definition adds/removes ("+A −R", green/red). Only rendered
// when there IS a diff — a call/covered method into an unchanged file has no
// diff (r.diff == null) and shows its "Ongewijzigd" status on the LEFT
// instead (leftStatusBadge, below), not here. Also covers the class-level
// callresolve kinds (model_usage/migration_model/data_provider/trait_usage) —
// they carry a diff just like a method_call child.
const DIFFSTAT_KINDS = new Set([
  'method_call',
  'covers',
  'model_usage',
  'migration_model',
  'data_provider',
  'trait_usage',
  'interface_impl',
])
function diffStatBadge(r) {
  if (!DIFFSTAT_KINDS.has(r.kind) || !r.diff) return ''
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

// leftStatusBadge renders the "Ongewijzigd" status LEFT of the child's title
// (next to categoryBadge, see below) — moved here, on explicit request, from
// the right-hand diffStatBadge slot it used to share: a call/covered method
// into a file this PR doesn't touch has nothing to show on the right (no
// +A −R diff), so its status now leads the header instead, next to the type
// badge, rather than trailing after the other right-hand badges. A child that
// DID change shows its diffStatBadge on the right instead (mutually
// exclusive with this); a kind without a diff concept at all (a relation
// child, e.g. event_listener) renders nothing here either.
function leftStatusBadge(r) {
  if (!DIFFSTAT_KINDS.has(r.kind) || r.diff) return ''
  return html`
    <span
      class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500"
      data-testid="related-diffstat"
      title="Aangeroepen definitie is niet gewijzigd in deze PR"
      >Ongewijzigd</span
    >
  `
}

// categoryBadge renders the child's type/category badge (ACTION/CONTROLLER/…,
// same style + colors as the top-level block card's left-hand badge, see
// Block.mjs) LEFT of the child's title, mirroring the top-level card. Falls
// back to "OTHER" — the same fallback categoryClass already applies to an
// unrecognized category — for a child with no PR-block of its own (an
// unchanged/synthetic call target was never scanned into a block, so it has
// no real category).
function categoryBadge(r) {
  const cat = r.category || 'OTHER'
  return html`
    <span class="${'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide ' + categoryClass(cat)}">${cat}</span>
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

// commentActivityBadge mirrors BlockList.mjs's commentActivityPill (same
// avatar + "+N-1" text badge, never color-only — the reviewer is
// colorblind, see conventions.md), but for a child card in the
// Onderliggende-code panel instead of a sidebar row: `s` is the same
// {count, last} summary (home.mjs computes it per child via
// commentScopeKeys/commentActivitySummary, right next to that child's own
// `approve` field), or null when the child has no open thread anywhere in
// its own subtree. The "+N" badge counts OTHER open threads besides the
// one the avatar already represents (s.count - 1), same reasoning as the
// sidebar pill.
function commentActivityBadge(s) {
  if (!s) return ''
  return html`
    <span
      class="shrink-0 flex items-center gap-0.5"
      data-testid="related-comment-activity"
      title="${s.count + (s.count === 1 ? ' open reactie' : ' open reacties') + ' (dit block + onderliggende code)'}"
    >
      ${avatarHTML(s.last.name, s.last.avatarUrl, 'h-4 w-4')}
      ${() =>
        s.count > 1
          ? html`<span
              data-testid="related-comment-activity-count"
              class="text-[9px] font-semibold text-slate-500 dark:text-zinc-500"
              >+${s.count - 1}</span
            >`
          : ''}
    </span>
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
        'w-72 shrink-0 rounded-md border bg-slate-50/60 dark:bg-zinc-800/40 px-1.5 py-1 text-left hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
        (focused()
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700')}"
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
      <div class="flex w-72 shrink-0 flex-col gap-1" data-testid="related-nested">
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

// codeGrowthChars now lives in Block.mjs (exported from there) — this
// column's own width calculation below still uses it (the 75th-percentile,
// non-ballooning technique, no live DOM measurement). Block.mjs's own
// fitWidthCls (the `a`-toggle's 'fit' stand) switched to a different,
// max-line-based, uncapped calculation instead — see its doc comment and
// keyboard-navigation.md/detail-layout.md — deliberately NOT applied here.

// relatedColumnWidthCls — the reactive width of the WHOLE Onderliggende-code
// column (not per-card): it grows with a representative non-comment code
// line (codeGrowthChars — the 75th percentile, not the single longest line)
// across every currently listed main card (rc.children, excluding the
// tests_group toggle bar — nested chips/the preview column are untouched,
// see detail-layout.md), clamped between the narrow default
// (w-[42rem] 2xl:w-[49.2rem], same as a one-sided/`a`-narrowed block) and a
// ceiling well short of the full diff-block-column width
// (w-[56rem] 2xl:w-[65rem] — a lower ceiling than the block column itself, so
// this card never eats up "half the screen" the way a single very wide
// method's card could before). Uses the CSS `ch` unit (the exact advance
// width of a monospace glyph) rather than a hand-picked px-per-char ratio —
// still zero live measurement, `ch` is resolved by the browser's layout
// engine from the char count we already computed, not from reading back a
// rendered node's size. `clamp()` handles the "no code yet / all comment"
// case for free (calc() then evaluates below the floor). Reads only
// rc.children — a plain snapshot pushed by setRelated, never the selected
// block's own `b.code` — so this cannot co-subscribe with the diff render
// (see the stuck-on-loading pitfall in conventions.md); it is exactly the
// same kind of read `kids()` below already does.
//
// Below the `narrow` breakpoint (< 1400px, see the tailwind.config comment
// in index.html) both the floor and the ceiling drop further — a smaller
// browser window means less room next to the diff card, which itself also
// narrows below this breakpoint (see widthCls in Block.mjs) — to
// w-[40rem]/w-[48rem] (640px/768px), instead of 42rem/56rem, so this column
// + the (also narrowed) diff card comfortably fit side by side at ~1378px
// without horizontal scroll at the floor width: 42rem(diff, narrow) +
// 1rem(gap) + 40rem(this column, narrow floor) = 83rem = 1328px, leaving
// ~50px of slack for a scrollbar/rounding. See "Narrow viewport (< 1400px)"
// in detail-layout.md for the full measurement this was based on.
// Exported: InlineComments/ClaudeChatPanel (above) reuse this same clamp
// SCALED (commentColumnWidthCls/claudeColumnWidthCls, below) rather than
// verbatim, so their row still sums to this exact width — see those
// functions' own doc comment for why that's load-bearing, not just cosmetic.
//
// relatedGrowthChars is the one shared "how wide does the code want to be"
// read, reused below by commentColumnWidthCls/claudeColumnWidthCls too so all
// three stay in lockstep off the same rc.children snapshot.
function relatedGrowthChars() {
  let chars = 0
  for (const r of rc.children) {
    if (r.kind === 'tests_group' || !r.code) continue
    const c = codeGrowthChars(r.code)
    if (c > chars) chars = c
  }
  return chars
}

// relatedWidthCls builds the clamp() triplet (default/narrow/2xl) shared by
// relatedColumnWidthCls and its two scaled siblings below.  clamp() scales
// homogeneously (k·clamp(a,b,c) = clamp(k·a,k·b,k·c) for any k>0), and
// subtracting a constant distributes through it the same way
// (clamp(a,b,c) − d = clamp(a−d,b−d,c−d)). So a `scale` (1, 2/3, 1/3) plus an
// optional `subtractRem` (the dashed comment↔Claude connector's own width,
// see home.mjs) are enough to keep
// commentColumnWidthCls() + connector + claudeColumnWidthCls() exactly equal
// to relatedColumnWidthCls() for EVERY value of `chars`, not just at the
// floor/ceiling extremes — no separate hand-picked rem table that could
// silently drift out of sync with this one.
function relatedWidthCls(chars, scale, subtractRem = 0) {
  const round = (n) => Math.round(n * 1000) / 1000
  const segment = (floor, ceil) => {
    const growth = round(2 * scale - subtractRem)
    const sign = growth < 0 ? '-' : '+'
    return (
      `clamp(${round(floor * scale - subtractRem)}rem,` +
      `calc(${round(chars * scale)}ch_${sign}_${Math.abs(growth)}rem),` +
      `${round(ceil * scale - subtractRem)}rem)`
    )
  }
  return `w-[${segment(42, 56)}] narrow:w-[${segment(40, 48)}] 2xl:w-[${segment(49.2, 65)}]`
}

export function relatedColumnWidthCls() {
  return relatedWidthCls(relatedGrowthChars(), 1)
}

// The dashed connector between the comment and Claude columns (home.mjs,
// data-testid=comment-claude-connector): w-3 = 0.75rem, no extra flex `gap`
// around it (mirrors nestedChipColumn's own connector, which also has none).
const COMMENT_CLAUDE_CONNECTOR_REM = 0.75

// commentColumnWidthCls / claudeColumnWidthCls — 2/3 and 1/3 of
// relatedColumnWidthCls()'s own clamp, reading the SAME chars snapshot so
// both split proportionally as the code grows, not just at the extremes. The
// connector's width comes off the comment side only (see the inner row in
// home.mjs), so this holds exactly, for any chars value:
//   commentColumnWidthCls() + 0.75rem(connector) + claudeColumnWidthCls()
//     === relatedColumnWidthCls()
export function commentColumnWidthCls() {
  return relatedWidthCls(relatedGrowthChars(), 2 / 3, COMMENT_CLAUDE_CONNECTOR_REM)
}

export function claudeColumnWidthCls() {
  return relatedWidthCls(relatedGrowthChars(), 1 / 3)
}

// relatedCard renders one child block: a header (label + file:line + relation
// kind) and a short, non-interactive code excerpt highlighted like the panes.
// The card sits in a flex row with, when the child itself has changed
// grandchildren (r.nested), a dashed connector to a narrow chip column on the
// right (nestedChipColumn) — the drill-hint that there is more underneath.
// The row div is the template's stable root; the chip column is a static
// interpolation (fresh keyed node per nested change — the key in the
// related-code render encodes the nested signature). data-child-id stays on the inner card, so
// the call-arrow overlay (callArrows.mjs, which targets the card's LEFT edge)
// is unaffected by the chips on the right.
function relatedCard(r, i, drill) {
  // The card's own highlight steps aside once the cursor descends into one of
  // its drill-hint chips (cs.chipPath, see nestedChip/handleRelatedKey) — only
  // one thing in the code panel is ever visually "active" at a time.
  const selected = () => cs.focus === 'code' && i === cs.codeSel && cs.chipPath.length === 0
  const nested = Array.isArray(r.nested) ? r.nested : []
  return html`
    <div class="flex items-start">
    <div
      class="${() =>
        // Every block/card uses the same indigo-when-selected / slate-300-
        // when-not border, no exceptions — an unchanged call/covered-method
        // target used to get a grey ring here even when selected (there's
        // nothing to review), but that distinction is still fully carried by
        // the separate "Unchanged" text badge (diffStatBadge) elsewhere in
        // this card, so dropping it here loses no colourblind-relevant signal.
        'min-w-0 flex-1 cursor-pointer rounded-lg border bg-slate-50/60 dark:bg-zinc-800/40 hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
        (selected()
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700')}"
      data-testid="related-item"
      data-child-id="${r.id}"
      data-active="${() => (selected() ? 'true' : 'false')}"
      @click="${() => drill && drill(r)}"
    >
      <div class="border-b border-slate-100 dark:border-zinc-800/60 px-3 py-1.5">
        <div class="flex items-baseline gap-2">
          ${() => categoryBadge(r)}
          ${() => leftStatusBadge(r)}
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
          ${() => commentActivityBadge(r.commentActivity)}
        </div>
        <span class="block truncate font-mono text-[10px] text-slate-400 dark:text-zinc-500" title="${() => r.file + ':' + r.line}"
          >${r.file}:${r.line}</span
        >
      </div>
      ${() =>
        r.kind === 'translation'
          ? translationValueView(r.code, r.transKey || r.label, r.locale || '')
          : r.code
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
// every toggle rebuilds the keyed node (the key encodes open/closed, see the
// related-code render above), so nothing here needs its own reactive binding.
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
          : 'border-slate-300 dark:border-zinc-700')}"
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

// The Workflow-Type → label map lives in workflowLabels.mjs (shared with the
// "Mislukte taken" block on /pr-overview); labelForWorkflow falls back to the
// raw type name for an unknown type.

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
  'code_warning:running': 'doorzoekt de PR op risico’s…',
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
  // code_warning's own "waiting/actively working" note never suggests
  // active work while there's nothing left to say — a completed run reports
  // exactly how many findings it produced (from run.warningsFound, see
  // RunsForPR's Result read), including the "none found" case, instead of
  // falling through to a generic "completed" status word.
  if (run.workflow === 'code_warning' && run.status === 'completed') {
    const n = run.warningsFound
    if (n === 0) return "geen risico's gevonden"
    if (n === 1) return '1 risico gevonden'
    if (typeof n === 'number') return n + " risico's gevonden"
  }
  return WORKFLOW_STATUS_NOTE[run.workflow + ':' + run.status] || run.status
}

// TASK_STALE_MS — a run older than this (by its own updatedAt) without being
// genuinely in progress is shown again as a "this hasn't moved in a while"
// signal (see visibleWorkflowRuns below).
const TASK_STALE_MS = 5 * 60 * 1000

// visibleWorkflowRuns is what TasksPanel (below, mounted under the
// PR-description column, see detail-layout.md) actually renders: a run shows
// only while it's genuinely IN PROGRESS (status === 'running' — deliberately
// not 'waiting' too: several long-lived per-PR trackers, build_relations/
// approve/pr_status, sit in 'waiting' indefinitely once their initial run is
// done, without being busy) OR it hasn't been updated in over
// TASK_STALE_MS — a recently completed/waiting run thus disappears for the
// first few minutes (nothing to act on), then reappears as a "this has been
// sitting idle for a while" signal. Running-first, then most-recently-updated.
export function visibleWorkflowRuns(state) {
  const all = state && Array.isArray(state.workflows) ? state.workflows : []
  const now = Date.now()
  const stale = (r) => {
    const t = new Date(r.updatedAt).getTime()
    return Number.isNaN(t) || now - t > TASK_STALE_MS
  }
  const visible = all.filter((r) => r.status === 'running' || stale(r))
  return visible.sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

// workflowRow renders one run. A task_code_comment run with a resolved
// `comment` reference is clickable: it opens that comment's block/diff-unit
// and selects its thread (openTask, from home.mjs). Other run types are
// purely informational. No keyboard cursor here — Tasks is click-only (it
// lives under the PR-description column, which already suppresses ↑/↓, see
// keyboard-navigation.md).
function workflowRow(run, openTask, state) {
  const badge = STATUS_BADGES[run.status] || { label: run.status, cls: 'bg-slate-50 dark:bg-zinc-800/60 text-slate-500 dark:text-zinc-500 ring-slate-200 dark:ring-zinc-800' }
  const active = run.status === 'running' || run.status === 'waiting'
  const clickable = !!(run.comment && openTask)
  return html`
    <div
      class="${() =>
        'flex flex-col gap-0.5 rounded-md px-2 py-1.5 ring-1 ring-inset ring-transparent ' +
        (active ? '' : 'opacity-60') +
        (clickable ? ' cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800/60' : '')}"
      data-testid="workflow-row"
      data-status="${run.status}"
      data-run-id="${run.runId}"
      @click="${() => (clickable ? openTask(run) : null)}"
    >
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[12px] text-slate-700 dark:text-zinc-300" data-testid="workflow-label"
          >${labelForWorkflow(run.workflow)}</span
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

// TasksPanel — the exported "Taken" block, mounted by home.mjs under the
// PR-description column (prInfoCard), no longer a fixed right-hand sidebar.
// Only shows runs that are genuinely in progress, or that have been sitting
// idle for a while (visibleWorkflowRuns) — no more Active/Recent split, a
// single filtered list.
export function TasksPanel(state, openTask) {
  return html`
    <section
      class="flex w-full shrink-0 max-h-[16rem] min-h-[6rem] flex-col overflow-hidden rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5"
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
          const runs = visibleWorkflowRuns(state)
          return runs.length === 0
            ? [html`<p class="px-1 py-2 text-[11px] text-slate-400 dark:text-zinc-500">Geen taken.</p>`.key('no-workflows')]
            : // Key includes status: a run whose status just changed (e.g.
              // running → completed) needs a fresh node, not a patched one —
              // arrow.js only re-runs a keyed node's own bindings on a key
              // change (see the block-card-key convention in conventions.md).
              runs.map((r) => workflowRow(r, openTask, state).key('run:' + r.runId + ':' + r.status))
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
  const widthKey = () => colWidthKeyFor('related', commentTarget)
  return html`
    <section
      class="${() => 'relative flex shrink-0 max-h-full min-h-0 flex-col overflow-hidden ' + relatedColumnWidthCls()}"
      style="${() => colWidthStyle(state, widthKey())}"
      data-testid="related-code"
      data-col-resize-root
    >
      ${() =>
        widthKey()
          ? resizeHandle(
              (e) => startColumnResize(e, state, widthKey(), () => parseAutoWidthPx(relatedColumnWidthCls())),
              () => resetColumnWidth(state, widthKey()),
            )
          : ''}
      ${() =>
        searching() || pending() > 0
          ? html`<span
              class="absolute right-2 top-2 z-10 shrink-0 rounded-md border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-2 py-1 text-[11px] text-slate-400 dark:text-zinc-500"
              data-testid="related-searching"
              >zoeken…</span
            >`
          : ''}
      <div
        class="${() =>
          'no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 ' +
          (searching() || pending() > 0 ? 'pt-9' : '')}"
      >
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
}

// ── PR-wide comments as navigable index items ────────────────────────────────
// GitHub-imported issue comments, review summaries and code_warning findings
// without a block anchor (c.kind !== '') have no file:line to hang off a
// block, so they never show in the block-scoped comments index above
// (recomputeView filters them out). They used to live in their own card under
// the PR description (PrWideComments); that card is gone — home.mjs now turns
// each one into a synthetic, navigable item in the "Start" sidebar itself
// (kind:'comment', see recomputeLeftList/commentBlockItem in home.mjs), right
// alongside the ordinary PR blocks: ↑/↓ select it like any other row, ← is
// zero/one ("0/1" not-resolved / "1/1" resolved) so it folds into the existing
// "Toon N goedgekeurde blocks" section once resolved (isFullyApproved stays
// generic — home.mjs's blockApproveCount special-cases a comment item's
// done/total instead). Enter on the selected row opens a small action menu
// (prCommentCommandsFor in home.mjs: "Beantwoorden" first, then "Resolve
// comment"); → instead steps into the item's own thread (enterPrCommentThread
// below). The block column to the right of the index shows this
// module's commentDetailCard (thread: body + reactions) instead of a Block
// diff card — see the DetailPanel pair.forEach branch in home.mjs and
// detail-layout.md.

// isKiloReview reports whether a comment body is a kilo-review bot summary we
// deliberately hide — matched on BOTH markers (AND) to avoid false positives.
// Mirrors the Go-side isKiloReview in comment_import.go (the import-skip); this
// frontend filter additionally hides any such comment already in the DB.
function isKiloReview(body) {
  return !!body && body.includes('<!-- kilo-review -->') && body.includes('Code Review Summary')
}

// prWideComments is the PR-wide subset of cs.list, in the same (created_at)
// order cs.list already carries — minus kilo-review bot summaries (see
// isKiloReview). Exported so home.mjs can turn each entry into a synthetic
// index item (recomputeLeftList/commentBlockItem); cs.list is kept loaded/
// polled by syncComments (called unconditionally by InlineComments below),
// so this needs no separate fetch of its own.
// An ORPHANED comment joins them: a new commit renamed or removed the symbol it
// was anchored to (anchorState 'orphan', set by the re-anchor pass — see
// reanchor.go), so recomputeView can never scope it to a block again and it would
// otherwise be visible nowhere at all. Giving it a "Start" row of its own is the
// same treatment a review comment that never mapped to a block already gets, and
// deliberately does NOT touch its `kind` — that would flip isPRWide on the backend
// and start mirroring its replies to GitHub as issue comments.
export function prWideComments() {
  return cs.list.filter((c) => (c.kind || c.anchorState === 'orphan') && !isKiloReview(c.body))
}

// isOrphanComment reports whether a comment lost the code it was anchored to. Used
// for the "verouderd" pill and by the index-item label, so an orphan is
// recognisable as such rather than looking like an ordinary PR-wide comment.
export function isOrphanComment(c) {
  return !!c && c.anchorState === 'orphan'
}

// COMMENT_KIND_LABEL names the kind badge on a comment-index item: issue/
// review comments read the same ("PR-comment"); a review summary gets its own
// label. "ai_warning" is a code_warning finding that couldn't be pinned to a
// block (see anchoredWarning in code_warning.go) — the aiWarningBadge next to
// this label already carries the warning-triangle icon, so this stays a plain
// text label rather than duplicating it.
const COMMENT_KIND_LABEL = { issue: 'PR-comment', review: 'PR-comment', review_summary: 'Review', ai_warning: 'AI-risico' }

// commentBody is the single place a comment's body text is rendered — kept
// tiny and reusable (compactConversation/expandedConversation/reactionBubble
// above and commentDetailCard below) so this one function drives markdown rendering
// everywhere a comment body shows up. Returns a getter of a *safe HTML
// string* (via the same renderMarkdown used by prInfoCard for the PR
// summary/description, see markdown.mjs) meant for an `.innerHTML` binding —
// never a plain-text slot, see the arrow.js `.innerHTML` convention in
// conventions.md.
export function commentBody(c) {
  return () => (c ? renderMarkdown(c.body) : '')
}

// pct ("PR-comment thread") is the ephemeral thread cursor for a selected
// comment-index item's own thread — → on such an item (home.mjs's onKeydown)
// steps into it, ↑/↓ then walk its messages (threadMessages, exactly the
// rendering commentDetailCard already uses) and ← steps back out to the
// index. This deliberately reuses that presentation, but is its OWN,
// non-URL-bound reactive rather than the block-scoped panel's `cs.focus`/
// `cs.threadPos` (which serve the exact same role for the inline-comments
// panel, reached only in diff mode, and ARE bound to the URL there — reusing
// them here would restore a stray 'thread' focus into list mode on every
// refresh, before any comment item is even selected). `commentId` scopes the
// cursor to one specific comment, mirroring picm.commentId just below (the
// selected item + its look-ahead preview both render through
// commentDetailCard, so a bare position wouldn't say WHICH comment's thread
// it belongs to).
const pct = reactive({ commentId: null, pos: 0 })

// enterPrCommentThread steps the keyboard into comment `c`'s own thread
// history — called by home.mjs on → from a selected comment-index item.
export function enterPrCommentThread(c) {
  if (!c) return
  pct.commentId = c.id
  pct.pos = 0
}

// isPrCommentThreadFocused reports whether the keyboard currently sits
// inside comment `c`'s thread (as opposed to owning the sidebar list) — used
// by home.mjs both to route ↑/↓/← there instead of the generic list
// navigation, and to reset the cursor on a selection change.
export function isPrCommentThreadFocused(c) {
  return !!c && pct.commentId === c.id
}

// exitPrCommentThread releases the thread cursor — called on ← out of the
// thread and whenever the sidebar selection moves off the comment it belongs
// to (mirrors the reasoning behind the selection-change watch that already
// resets picm/cancelPrCommentReply for the reply field).
export function exitPrCommentThread() {
  pct.commentId = null
  pct.pos = 0
}

// handlePrCommentThreadKey drives ↑/↓/← while comment `c`'s thread owns the
// keyboard (see isPrCommentThreadFocused) — ↑ steps to an older message,
// clamped at the top (no fall-through: mirrors the block-scoped
// handleRelatedKey's 'thread' branch, where ↑ also just clamps). ↓ steps to
// a newer one; once already at the newest message (pos === 0, nothing left
// to descend into), it instead FALLS THROUGH — returns `false` and leaves
// the thread (see below) — so the caller (home.mjs's onKeydown) can advance
// the sidebar cursor to the next comment/block, mirroring the block-scoped
// panel's own `advanceFromComment` "↓ loopt door" convention (see
// detail-layout.md, "Inline comment blocks"). ← steps back out to the
// index (same row, not the next one). Returns `true` when the key was fully
// handled here, `false` only for the ↓-falls-through case above.
export function handlePrCommentThreadKey(c, key) {
  if (key === 'ArrowUp') {
    pct.pos = Math.min(pct.pos + 1, threadMessages(c).length)
  } else if (key === 'ArrowDown') {
    if (pct.pos === 0) {
      exitPrCommentThread()
      return false
    }
    pct.pos -= 1
  } else if (key === 'ArrowLeft') {
    exitPrCommentThread()
  }
  return true
}

// picm ("PR-index comment menu") is the ephemeral reply-composer state for
// whichever comment-index item is currently selected in home.mjs's sidebar —
// mirrors cs.composing's role, just for this separate, simpler flow. `commentId`
// scopes `replying` to ONE specific comment: DetailPanel renders both the
// selected AND the look-ahead preview card through the very same
// commentDetailCard, so a bare boolean would reveal the reply field on BOTH
// cards at once (the preview's comment isn't even the one "Beantwoorden" was
// chosen for) — see commentDetailCard's own check below. The reply textarea
// is deliberately hidden until "Beantwoorden" (the menu's first, default
// item) is actually chosen — see keyboard-navigation.md ("Comment-index
// items"). Not bound to the URL — ephemeral UI state, like cs.composing/menu
// elsewhere.
// sending is this reply's own in-flight flag (mirrors cs.busy for the
// block-scoped thread) — drives the send-status icon on comment-detail-send.
// No "sent" flash here: sendPrCommentReply calls cancelPrCommentReply() on
// success, which hides this whole reply row immediately (see below), so a
// transient "sent" state would never actually be visible.
// `mode` distinguishes what the SAME textarea+button slot in commentDetailCard
// does with the typed text: 'reply' (default, startPrCommentReply) posts a
// reaction on this thread; 'convert' (startPrCommentConvert, see
// convertPrWideWarningToComment) instead starts a brand-new, unanchored
// PR-wide comment and deletes this one once that succeeds — a PR-wide AI
// finding has no diff/composer to reuse (unlike an anchored one, see
// convertWarningToComment/warningOverride), so it repurposes this reply field
// instead of duplicating a whole second composer UI.
const picm = reactive({ replying: false, commentId: null, sending: false, mode: 'reply' })

// startPrCommentReply reveals the reply textarea in commentDetailCard (only
// for the comment `c` it was opened for, see picm's own comment) and focuses
// it — called by the "Beantwoorden" command (home.mjs's prCommentCommandsFor).
// Mirrors toNew()'s focus-immediately convention.
export function startPrCommentReply(c) {
  picm.replying = true
  picm.commentId = c ? c.id : null
  picm.mode = 'reply'
  focusEl('[data-testid=comment-detail-reply]')
}

// startPrCommentConvert is startPrCommentReply's "convert" sibling — reveals
// the SAME reply field, but prefilled with the AI finding's own text and in
// 'convert' mode (see picm's own doc comment and sendConvertedPrWideComment).
// Called by convertPrWideWarningToComment (home.mjs's prCommentCommandsFor,
// "Comment hiervan maken" on a PR-wide, source:'ai' item).
function startPrCommentConvert(c) {
  picm.replying = true
  picm.commentId = c ? c.id : null
  picm.mode = 'convert'
  prefillField('[data-testid=comment-detail-reply]', c && c.body ? c.body : '')
}

// convertPrWideWarningToComment is convertWarningToComment's PR-wide (kind
// !== '', no file/line anchor) equivalent — an anchored finding reopens the
// block's own "+ Nieuwe comment" composer (see convertWarningToComment), but
// a PR-wide one has no diff/block context to reuse, so it repurposes this
// item's own reply field instead (startPrCommentConvert).
export function convertPrWideWarningToComment(c) {
  if (!c || c.source !== 'ai' || !c.kind) return
  startPrCommentConvert(c)
}

// cancelPrCommentReply hides the reply textarea again — called by home.mjs
// whenever the sidebar selection moves off the comment item it belongs to
// (a stray "Beantwoorden"/"Comment hiervan maken" state must not leak onto
// whatever gets selected next), and by Escape/blur within the field itself.
// Resets `mode` back to its 'reply' default too, so a later ordinary
// "Beantwoorden" on a DIFFERENT item never inherits a stale 'convert' mode.
export function cancelPrCommentReply() {
  picm.replying = false
  picm.commentId = null
  picm.mode = 'reply'
}

// sendPrCommentReply posts a real reply (done:false) via the exact same
// Signal the block-scoped thread / the old PR-wide card used — the backend
// already turns a reply on a PR-wide thread into a new GitHub issue comment,
// so the frontend needs no special casing here. Reloads cs.list afterwards so
// the new reaction shows immediately (and, via home.mjs's own watch on
// prWideComments(), recomputeLeftList runs again too).
export async function sendPrCommentReply(c, body) {
  const text = (body || '').trim()
  if (!c || !c.runId || !text) return
  picm.sending = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body: text, done: false }),
    })
    cancelPrCommentReply()
    await loadComments(cs.pr)
  } finally {
    picm.sending = false
  }
}

// sendConvertedPrWideComment is sendPrCommentReply's 'convert'-mode sibling:
// instead of replying on `c`'s own thread, it starts a genuinely NEW,
// unanchored PR-wide comment (Kind "issue", the same Kind an imported
// general PR comment gets — see createComment's own doc comment) with the
// (possibly edited) text, and only once THAT is confirmed placed does it
// delete `c` (the AI finding it replaces) — a failed placement must never
// discard the finding without anything taking its place, mirroring
// placeComment's own ordering for the anchored case.
export async function sendConvertedPrWideComment(c, body) {
  const text = (body || '').trim()
  if (!c || !text) return
  picm.sending = true
  try {
    const ok = await createComment({
      pr: cs.pr,
      file: c.file || '',
      line: c.line || 0,
      body: text,
      kind: 'issue',
    })
    if (ok) {
      await deleteComment(c)
      await loadComments(cs.pr)
      cancelPrCommentReply()
    }
  } finally {
    picm.sending = false
  }
}

// resolvePrCommentItem resolves the comment-index item's thread — the same
// "/resolve" sentinel + done:true reply Signal as resolveFocusedComment above
// (see its own doc comment: local-only for a PR-wide thread, GitHub-resolved
// for a review-diff thread). Called by the "Resolve comment" command.
export async function resolvePrCommentItem(c) {
  if (!c || !c.runId) return
  await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'reviewer', body: '/resolve', done: true }),
  })
  await loadComments(cs.pr)
}

// commentDetailCard renders the read-only thread (status mark, kind badge,
// source/AI-warning badges, relative time, then every reaction via
// threadMessages — the comment's own body is already the first message
// there, so it is deliberately NOT also rendered as a separate title above
// the thread (that looked duplicated), plus — once picm.replying is true
// (see startPrCommentReply) — a reply textarea + send button. This is what
// home.mjs's DetailPanel shows in the block column, to the right of the
// index, in place of a Block diff card whenever the selected sidebar item is
// a synthetic comment item (b.kind === 'comment') — see detail-layout.md.
export function commentDetailCard(c, opts) {
  if (!c) return html`<div class="hidden" data-testid="comment-detail-card"></div>`
  // Own (ui-placed) comment → the local reviewer's name/avatar, see identityOf.
  const detailWho = identityOf(c.source, c.author, c.avatarUrl)
  // preview dims the card exactly like Block()'s own preview prop does for the
  // look-ahead card — passed by home.mjs's DetailPanel when this isn't the
  // selected/focused sidebar item (i !== sel || not focusedHere).
  const preview = !!(opts && opts.preview)
  // The thread container below gets a ring while pct.commentId === c.id (the
  // keyboard has stepped into this item's thread, see enterPrCommentThread) —
  // needed because the rest position (pct.pos === 0) deliberately highlights
  // no single bubble (mirrors the block-scoped thread's cs.threadPos===0
  // convention, see reactionBubble). There that rest position is still
  // visible because it focuses a real reply input (focusThread); this thread
  // has no such input at that point, so without this container ring → looked
  // like it did nothing at all.
  return html`
    <div
      class="${() =>
        // The same on/off indigo/slate border every Block() diff card gets
        // (see Block.mjs's diffActive) — this card, after all, replaces a
        // Block() card in the same column position for a comment-index item
        // (see detail-layout.md). Unlike a real block there's no further
        // "stop" (drilled column / Onderliggende code) the keyboard can step
        // into that would steal this border away, so non-preview here is
        // simply the whole of the selected/focused state.
        'flex w-[42rem] shrink-0 flex-col gap-3 rounded-2xl border p-4 shadow-sm ' +
        (preview
          ? 'border-slate-300 dark:border-zinc-700 opacity-60 '
          : 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30 ') +
        (c.status === 'resolved' ? 'bg-slate-50/60 dark:bg-zinc-800/40 ' : 'bg-white dark:bg-zinc-900 ')}"
      data-testid="comment-detail-card"
    >
      <div
        class="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2.5 dark:border-zinc-800/60"
        data-testid="comment-detail-author-line"
      >
        ${() => commentStatusMark(c)}
        ${avatarHTML(detailWho.name, detailWho.avatarUrl, 'h-6 w-6')}
        <span
          class="mr-0.5 whitespace-nowrap text-sm font-semibold leading-6 text-slate-800 dark:text-zinc-200"
          data-testid="comment-detail-author"
          >${detailWho.name || 'onbekend'}</span
        >
        <span
          class="rounded-full bg-slate-200/70 dark:bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-600 dark:text-zinc-400"
          data-testid="comment-detail-kind"
          >${COMMENT_KIND_LABEL[c.kind] || c.kind || 'Regelcomment'}</span
        >
        ${() => sourceBadge(c)} ${() => aiWarningBadge(c)} ${() => staleAnchorBadge(c)}
        <span class="ml-auto shrink-0 text-[10px] text-slate-500 dark:text-zinc-500">${relTime(c.createdAt)}</span>
      </div>
      <div
        class="${() =>
          'flex max-h-[70vh] flex-col gap-2.5 overflow-auto rounded-lg ' +
          (!preview && pct.commentId === c.id ? 'ring-2 ring-indigo-200 dark:ring-indigo-500/30' : '')}"
        data-testid="comment-detail-thread"
      >
        ${() =>
          threadMessages(c).map((r, ti, arr) =>
            reactionBubble(r, ti, arr.length, () => !preview && pct.commentId === c.id && pct.pos === arr.length - ti).key(
              'detail-msg:' + r.id,
            ),
          )}
      </div>
      <div class="contents">
        ${() =>
          picm.replying && picm.commentId === c.id
            ? html`<div class="flex items-center gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-3">
                <textarea
                  class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2 py-1 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="${() => (picm.mode === 'convert' ? 'Nieuwe comment op basis van deze melding…' : 'Reageer…')}"
                  data-testid="comment-detail-reply"
                  @keydown="${(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (picm.mode === 'convert') sendConvertedPrWideComment(c, e.target.value)
                      else sendPrCommentReply(c, e.target.value)
                    } else if (e.key === 'Escape') {
                      cancelPrCommentReply()
                    }
                  }}"
                ></textarea>
                <button
                  type="button"
                  class="${() =>
                    'flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-500 px-2.5 py-1.5 text-xs font-medium text-white ' +
                    (picm.sending ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-600')}"
                  data-testid="comment-detail-send"
                  disabled="${() => picm.sending}"
                  @click="${(e) => {
                    // currentTarget, not target — a click can land on the icon
                    // inside this button, whose parentElement is the button
                    // itself, not the row that also holds the textarea.
                    const el = e.currentTarget.parentElement.querySelector('[data-testid=comment-detail-reply]')
                    if (!el) return
                    if (picm.mode === 'convert') sendConvertedPrWideComment(c, el.value)
                    else sendPrCommentReply(c, el.value)
                  }}"
                >
                  ${() => sendStatusIcon(picm.sending ? 'sending' : 'draft')}
                  ${() => (picm.mode === 'convert' ? 'Plaats' : 'Stuur')}
                </button>
              </div>`
            : ''}
      </div>
    </div>
  `
}

