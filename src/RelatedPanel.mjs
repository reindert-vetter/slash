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
import { reactive, watch } from './vendor/arrow.js'
import { highlight, blockLabel, codeGrowthChars } from './Block.mjs'
import { translationValueView } from './translationDiff.mjs'
import { statusInfo, categoryClass, isLocalAiWarning } from './BlockList.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { renderMarkdown, countCodeFences, annotateFenceNumbers } from './markdown.mjs'
import { avatarHTML, displayNameOf, ensureMe, ensureNames, identityOf, meLogin } from './avatar.mjs'
import { commentMentionsMe, ensureSettings } from './mentions.mjs'
import { labelForWorkflow } from './workflowLabels.mjs'
import { repoParam, repoField } from './prContext.mjs'
import { claudeChatColumn, claudeStatusText } from './ClaudeChat.mjs'
import { codePreviewColumn } from './CodePreview.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { syncCommentBatch, batchProgressFor, batchNoteFor } from './commentBatch.mjs'
import { colWidthStyle, startColumnResize, resetColumnWidth, resizeHandle, parseAutoWidthPx } from './columnWidth.mjs'
import { autoGrowTextarea, resetTextareaHeight } from './textareaAutoGrow.mjs'
import { updateScrollFade } from './scrollFade.mjs'

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
  // sendFailed — a session-only map of "this send/placement failed" flags,
  // keyed by a small string ('reply:'+commentId for a reply on an existing
  // thread, 'new:'+draftKey for a not-yet-created comment) — see
  // markSendFailed/clearSendFailed/sendFailedBadge below. Needed because
  // placeComment/sendReaction/sendPrCommentReply now hand the keyboard back
  // to the diff BEFORE the save is confirmed (optimistic exit, see their own
  // doc comments) — a silent failure would otherwise be very easy to miss,
  // since the reviewer is by then often looking at something else entirely.
  // Always reassigned wholesale (never mutated in place), same convention as
  // state.ignoredComments in home.mjs, so the reactive read re-triggers.
  sendFailed: {},
  // pendingComment — the just-submitted NEW comment's optimistic local echo
  // (see placeComment/pendingCommentFor/pendingCommentBubble below):
  // `{file, label, rowStart, rowEnd, gran, seg, body, at}` while the POST +
  // GET round-trip is in flight, `null` otherwise. exitRelated() already
  // hands the keyboard straight back to the diff before that round-trip even
  // starts (deliberate, see placeComment's own doc comment) — this is purely
  // a VISUAL echo, so the reviewer sees their own message right away instead
  // of only the generic "Bezig…" footer text, mirroring how a just-sent
  // Claude chat message stays visible while the reply is still coming in.
  // Cleared once createComment's own await settles (success or failure) —
  // by then the real comment, if the post succeeded, is already in cs.list
  // (createComment awaits loadComments itself), so the real compact card
  // takes over in the exact same spot with no visible gap.
  pendingComment: null,
  focus: null,
  threadPos: 0,
  // threadPinned mirrors "is the reviewer's own mouse-scroll still sitting at
  // the bottom of the comment-thread pane" — independent of threadPos, which
  // only tracks the ↑/↓ KEYBOARD cursor and stays 0 (rest) even while the
  // reviewer scrolls the pane's native scrollbar up by hand to reread an
  // older message. scrollCommentThreadToBottom used to force-scroll to the
  // newest message on every comment poll purely off threadPos === 0, so a
  // manual scroll-up got silently yanked back down within a few seconds —
  // reported bug. Kept alongside threadPos rather than in its own map: this
  // module only ever shows ONE comment's thread expanded at a time. Reset to
  // true whenever the thread is (re)entered at rest (toComment) and updated
  // live by the pane's own @scroll handler (see updateCommentThreadPinned).
  threadPinned: true,
  // claudePos is threadPos's twin for the embedded Claude conversation
  // ('claude', see the "Embedded Claude conversation" section below): 0 = the
  // composer (typing), 1..n = the n-th turn from the bottom.
  claudePos: 0,
  // claudeOptionSel is claudePos's own sub-cursor for the still-open
  // question's choice buttons (see claudeQuestionOptions in ClaudeChat.mjs):
  // 0 = none highlighted (composer/rest), 1..N = the N-th option counting
  // from the BOTTOM of the options list (mirrors claudePos'/threadPos' own
  // "counted from the bottom" convention) — so 1 is the option closest to the
  // composer, N the option closest to the question bubble above it. Only
  // meaningful while claudePos === 0 AND the newest message is a still-open,
  // unanswered question with options (pendingClaudeQuestion() below); ↑/↓
  // walk through it before falling through to claudePos itself, forming one
  // continuous chain composer → options → transcript (see handleRelatedKey's
  // 'claude' branch). Deliberately NOT bound to the URL — an ephemeral
  // keyboard highlight, like state.rangeAnchor, not a navigation position
  // worth restoring after a refresh.
  claudeOptionSel: 0,
  // claudePinned is threadPinned's twin for the embedded Claude chat pane —
  // see threadPinned's own doc comment just above. Reset to true whenever the
  // conversation is (re)entered at rest (enterClaudeChat/toNewFocus/a fresh
  // anchor) and updated live by claude-chat-thread's own @scroll handler.
  claudePinned: true,
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
  // prWideCompose marks the new-comment composer as composing a PR-WIDE
  // ("algemene") comment instead of one anchored on the current diff unit —
  // set by startPrWideComment (the `/`-menu's "Algemene comment plaatsen"),
  // cleared by every ordinary composer open (toNew) and every composer exit
  // (exitRelated / "Annuleer"). It changes three things and nothing else:
  // the composer header/placeholder (no meaningless file:line — see
  // newCommentComposer), placeComment's write (Kind "issue", no anchor), and
  // the surrounding layout (home.mjs/BlockList.mjs hide the pr-index and the
  // block column while it's true — see detail-layout.md). Reactive so those
  // bindings repaint; deliberately NOT bound to the URL, like cs.composing
  // itself.
  prWideCompose: false,
  // rangeCompose marks the composer/Claude chat as opened for a Shift-arrow
  // multi-row selection in the index/methodes-kolom ("Plaats comment over dit
  // bereik" / "Chat met Claude over dit bereik", rangeCommandsFor in
  // home.mjs) — set by startRangeComment/startRangeChat below, cleared by
  // every ordinary composer open (toNew) and every composer exit (exitRelated
  // / "Annuleer"), same lifecycle as prWideCompose. Unlike prWideCompose the
  // anchor stays a REAL block/unit (the cursor's own, via the untouched
  // commentTarget()) — this flag only widens what gets SENT alongside it: see
  // rangeComposeItems below.
  rangeCompose: false,
})

// rangeComposeItems — the blocks/methods a Shift-arrow index/methodes-kolom
// multi-selection covered when cs.rangeCompose was set (see
// startRangeComment/startRangeChat). Plain module state, not reactive — read
// exactly once each, by placeComment (rangeCommentPrefix) and
// claudeContextBlock (claudeRangeContextBlock), both of which fire at most
// once per composer open. Captured once at open time so a later Shift+↑/↓
// that grows/shrinks the selection doesn't retroactively change what an
// already-open composer claims to cover.
let rangeComposeItems = []

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
// the same block: c's aligned-row range ⊆ t's range, OR c starts on exactly the
// same row as t (a group/multi-line comment stays reachable from its own FIRST
// row, e.g. after narrowing from group to line granularity — its rows all carry
// a 💬 marker, see commentRowSet, so it must not become unreachable there);
// and — when t is a single 'call' segment — the same call (gran + seg). A
// comment with an unknown anchor (rowStart < 0: legacy/seeded) is always shown
// within its block. Deliberately NOT plain overlap: a wide comment must not
// surface under every row it happens to span, only under its start row (which
// is where the reviewer anchored it).
function commentUnder(c, t) {
  if (c.rowStart == null || c.rowStart < 0) return true
  if (c.rowStart !== t.rowStart && (c.rowStart < t.rowStart || c.rowEnd > t.rowEnd)) return false
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

// commentRangeRowSet returns the aligned-diff rows that the comment the
// KEYBOARD IS CURRENTLY IN spans — Block draws a vertical bar along the right
// edge of those rows, so the reviewer sees which lines/selection the open
// comment was actually made on (see "The focused comment's range gets a bar"
// in comments-panel.md). Empty in every other situation, which is the whole
// point: unlike commentRowSet (presence of ANY open comment, on every row it
// covers) this marks exactly one comment, only while it is open.
//
// Which comment: the focused one (selComment()), or — while the keyboard has
// stepped on into the embedded Claude column — the comment that conversation
// hangs on (chatAnchorComment(), the same comment whose card stays expanded
// there). Deliberately NOT while composing a new comment (cs.focus === 'new'):
// that composer targets the live cursor unit, which already carries its own
// left-hand cursor bar.
//
// Reads cs.focus/cs.sel/cs.view, all reactive, so the pane's .innerHTML
// binding re-runs on every focus/selection change — exactly like commentedFn.
// Same "no bounds check needed" reasoning as commentRowSet above.
export function commentRangeRowSet(b) {
  const set = new Set()
  if (!b) return set
  if (cs.focus !== 'comment' && cs.focus !== 'thread' && cs.focus !== 'claude') return set
  const c = cs.focus === 'claude' ? chatAnchorComment() : selComment()
  if (!c) return set
  if (c.file !== b.file || c.label !== b.label) return set
  if (c.rowStart == null || c.rowStart < 0) return set
  for (let i = c.rowStart; i <= c.rowEnd; i++) set.add(i)
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
// The returned `local` flag says every counted OTHER (non-AI-warning, see
// `hasAiWarning`/`otherCount` below) thread is a LOCAL one — never posted to
// GitHub (see isLocalComment). The per-line badge in the diff swaps the
// author avatar for a note glyph in that case (Block.mjs's lineSummaryParts):
// an avatar answers "who is waiting for you", which is meaningless when the
// only thing on that line is your own private note. As soon as ONE real
// GitHub thread is in scope the flag is false and the avatar comes back — a
// mixed scope still has someone in it.
//
// `hasAiWarning`/`aiCount` (isLocalAiWarning, BlockList.mjs — a not-yet-
// published code_warning finding) is tracked SEPARATELY from `local`/
// `otherCount`: an AI finding is always local by isLocalComment's own rule
// too (it has no githubId yet), but folding it into the ordinary local/avatar
// choice would hide it behind a generic note glyph — the same glyph a plain
// private note gets — right where the reviewer most needs to tell "a machine
// flagged this" apart from "I wrote this to myself". lineSummaryParts renders
// the AI-warning triangle and the note/avatar icon SIDE BY SIDE whenever both
// are present on the same line (explicit reviewer decision: never let one win
// over the other) — see `hasAiWarning`/`otherCount` there.
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
  let aiCount = 0
  let otherCount = 0
  let lastMsg = null
  let local = true
  for (const c of cs.list) {
    if (c.kind) continue // PR-wide comment — no file:label anchor, can't be in scope
    if (c.status === 'resolved') continue
    if (!keys.has(c.file + '|' + c.label)) continue
    if (matchesRow && !matchesRow(c)) continue
    count++
    if (isLocalAiWarning(c)) {
      aiCount++
    } else {
      otherCount++
      if (!isLocalComment(c)) local = false
    }
    const reactions = c.reactions || []
    const msg = reactions.length
      ? reactions[reactions.length - 1]
      : { source: c.source || 'ui', author: c.author, avatarUrl: c.avatarUrl, createdAt: c.createdAt }
    if (!lastMsg || (msg.createdAt || '') > (lastMsg.createdAt || '')) lastMsg = msg
  }
  if (!count) return null
  return {
    count,
    local,
    hasAiWarning: aiCount > 0,
    aiCount,
    otherCount,
    last: identityOf(lastMsg.source, lastMsg.author, lastMsg.avatarUrl),
  }
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
  const node = verticalScroller(el)
  if (!node) return
  const cRect = node.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  if (eRect.top < cRect.top) node.scrollTop -= cRect.top - eRect.top
  else if (eRect.bottom > cRect.bottom) node.scrollTop += eRect.bottom - cRect.bottom
}

// verticalScroller is the shared walk both scroll helpers use: the first
// ancestor of `el` that actually scrolls vertically, or null. Split out of
// scrollIntoViewVertical so alignToTopVertical below can reuse the exact same
// "and no further" rule (never <main>'s horizontal scroller — see above).
function verticalScroller(el) {
  let node = el.parentElement
  while (node && node !== document.documentElement) {
    if (node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}

// alignToTopVertical scrolls `el` to the TOP of its vertical scroller instead
// of merely into view. Reviewer request: selecting an Onderliggende-code child
// (or a comment card) that sits below another one must bring it to the top,
// "zodat hij niet buiten beeld komt" — for a comment card with a "there's
// something above" hint in the panel header (moreAboveHint) and ↑ still
// walking back up; for an Onderliggende-code child the cards above collapse to
// their header instead (see relatedCard's `collapsed`), so no such hint is
// shown there any more. Only ever scrolls DOWN to reach that alignment:
// clamped at 0, so selecting the first item never yanks the panel past its own
// top, and (unlike scrollIntoView) it never touches the horizontal axis — same
// axis rule as above.
function alignToTopVertical(el) {
  const node = verticalScroller(el)
  if (!node) return
  const cRect = node.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  node.scrollTop = Math.max(0, node.scrollTop + (eRect.top - cRect.top))
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
// (only when the selected unit carries no comments, or every one of them is
// already resolved and this unit has no other open comment — see
// enterCommentsOrRelated below) and on ↓ falling through the last inline comment
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
  // Leaving the composer always ends a PR-wide compose, which is what brings
  // the pr-index/block column back (see cs.prWideCompose) — this is the ←
  // path handleRelatedKey's own 'new' branch ends in.
  cs.prWideCompose = false
  // Same for a range-scoped compose (see startRangeComment/startRangeChat) —
  // leaving the composer without placing/sending anything must not leave a
  // stale item list for the NEXT ordinary composer open to accidentally see
  // (toNew already resets both too, this is belt-and-braces on the exit path).
  cs.rangeCompose = false
  rangeComposeItems = []
  cs.claudeOptionSel = 0
  releaseFocus() // a focus request still in flight must not land after this
  const el = document.activeElement
  if (el && el.blur) el.blur()
}
export { exitRelated as leaveRelated }

// focusToken counts every sidebar-focus transition. Originally only guarded
// focusEl's own deferred DOM focus (below): the request is only allowed to
// land while the token still matches the value at request time — i.e. while
// the reviewer has not moved on since. It now ALSO guards createComment's
// own async tail (see there): it captures the token before its network
// round-trip and only applies its own follow-up state (cs.sel, "land the
// selection on the freshly placed comment") if it's still unchanged by the
// time that await resolves — otherwise the reviewer has since moved the
// keyboard to a different comment/composer/Onderliggende-code panel
// (possibly on a different block entirely, since cs is a module-level
// singleton) and that stale cleanup must not clobber it.
//
// placeComment/postThreadReply/postPrCommentReply themselves no longer need
// this guard for their OWN exit (exitRelated/cancelPrCommentReply+
// exitPrCommentThread): they now call it synchronously, BEFORE their network
// round-trip even starts (optimistic exit, see placeComment's own doc
// comment) — there is no window left in which a later navigation could race
// with it. See tests/place-comment-return-focus.spec.mjs and
// tests/comment-nav-race.spec.mjs.
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
      // Setting .value here fires no `input` event, so a restored multi-line
      // draft needs an explicit auto-grow — otherwise it sits clipped at the
      // field's natural height until the reviewer's next keystroke.
      autoGrowTextarea(el)
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

// prReplyDrafts mirrors replyDrafts above for the comment-index item's own
// reply field (comment-detail-reply, commentDetailCard) — a plain, session-
// only Map keyed by comment id, so a reply that never got the chance to be
// typed-and-sent in one go (the field closes as soon as it's submitted, per
// the optimistic exit in sendPrCommentReply/postPrCommentReply) can still be
// recovered, and so a failed save doesn't also lose the typed text.
const prReplyDrafts = new Map()

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
  // Every ORDINARY composer open is anchored on the current unit — a stale
  // PR-wide flag from an earlier "Algemene comment plaatsen" must never leak
  // into it (it would post the next line comment as an unanchored issue
  // comment). startPrWideComment sets it back AFTER calling this.
  cs.prWideCompose = false
  // Same reasoning for a stale range-compose flag/item list from an earlier
  // "… over dit bereik" action — startRangeComment/startRangeChat set both
  // back AFTER calling toNew().
  cs.rangeCompose = false
  rangeComposeItems = []
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
  // A brand-new, not-yet-placed comment always starts its own fresh Claude
  // block — always reset, never keep showing whatever conversation happened
  // to be open before. That includes an EXISTING comment/conversation
  // already sitting on this exact unit: chatAnchorComment()/selComment()
  // would happily return that unrelated thread too (it doesn't know "new" is
  // being composed), which used to make this brand-new draft silently
  // piggyback the old conversation instead of getting its own — explicit
  // reviewer request: a new comment on a line is a wholly new comment +
  // Claude block, even when one already exists. ensureClaudeAnchorForNew
  // lazily creates THIS draft's own backing comment the moment the reviewer
  // actually sends a Claude message from here.
  cc.commentId = null
  cc.messages = []
  cc.runId = null
  cc.status = 'idle'
  cc.progress = null
  cc.sendError = ''
}

// toNewFocus is the mirror of toComment() for the still-open, not-yet-placed
// composer: it hands the keyboard back to 'new' from the embedded Claude
// composer (see enterClaudeChatFromNew/cc.commentId's role there) WITHOUT
// resetting cc/warningOverride/claudeAutoAnchor — none of that changed while
// the reviewer was typing into Claude, only the DOM focus/cs.focus did.
// newCommentComposer's own contents-root toggle now keys off
// isNewChatUnanchored(), which stays true across this transition — so the
// composer textarea stays MOUNTED the whole time (it used to unmount, see
// "Two bugs the → path never actually exercised" in claude-chat-panel.md).
// The prefill below is therefore only a harmless belt-and-braces restore, not
// a genuine remount recovery any more; composeDraftKey is unchanged since the
// original toNew() call, so it always resolves the SAME draft either way.
function toNewFocus() {
  cs.focus = 'new'
  cs.claudeOptionSel = 0
  focusEl('[data-testid=comment-compose]')
  const draft = composeDrafts.get(composeDraftKey)
  if (draft) prefillField('[data-testid=comment-compose]', draft)
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
  cs.threadPinned = true
  cs.claudeOptionSel = 0
  scrollCommentIntoView()
  scrollCommentThreadToBottom()
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

// enterCommentsOrRelated is home.mjs's single → routing entry point once the
// keyboard leaves a diff (or an anchored comment-index item's drilled
// column) — replaces the old inline hasVisibleComments()/enterCommentsHead()/
// claudeColumnVisible()/enterRelated() chain with one refinement: when the
// DEFAULT landing comment (visibleComments()[0], what enterCommentsHead()
// would select) is already resolved, → skips it. Reviewer request: "als die
// comment al resolved is, ga dan (als ze bestaan) direct naar de volgende
// comment of onderliggende code. als die niet bestaan, wil ik wel direct naar
// resolved comment blok" — a resolved thread is done, so defaulting the
// keyboard there when something still open exists reads as busywork, but
// with nothing else to land on the resolved comment is still a better
// landing than an empty Underlying-code panel.
//
// Deliberately narrow: only the FIRST comment's resolved status is checked.
// A unit whose open comment sits somewhere other than index 0 already lands
// on it via the unaffected branch below (enterCommentsHead() always starts
// at 0, unconditionally) — this function changes nothing for that case, it
// only ever fires the skip when index 0 itself is resolved.
export function enterCommentsOrRelated(pr) {
  if (hasVisibleComments()) {
    const list = visibleComments()
    if (list[0].status !== 'resolved') {
      enterCommentsHead()
      return
    }
    // The default landing comment is resolved — skip to the next still-open
    // one if this unit has one (not necessarily adjacent: a run of several
    // resolved comments ahead of it is skipped in one step).
    const next = list.findIndex((c) => c.status !== 'resolved')
    if (next >= 0) {
      cs.sel = next
      toComment()
      return
    }
    // Every comment on this unit is resolved — try Underlying code instead.
    if (rc.children.length > 0) {
      enterRelated()
      return
    }
    // Nothing else to land on: show the resolved comment anyway.
    enterCommentsHead()
    return
  }
  if (claudeColumnVisible()) enterClaudeChat(pr)
  else enterRelated()
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

// threadParticipants — every distinct person/bot that has spoken in a thread
// (root author + every reply), deduped by display name, in the order each
// first appears (so the root author always leads). Feeds
// authorAvatarStack's compact-card avatar stack below: a solo author keeps a
// single bare avatar, several joining in get a small overlapping stack so a
// reviewer can tell at a glance whether others replied, without expanding
// the thread.
function threadParticipants(c) {
  const seen = new Map()
  for (const m of threadMessages(c)) {
    const who = identityOf(m.source, m.author, m.avatarUrl)
    if (!seen.has(who.name)) seen.set(who.name, who)
  }
  return [...seen.values()]
}

// AVATAR_STACK_MAX — how many real avatars authorAvatarStack shows before
// collapsing the rest into a "+N" circle — a long-running thread with many
// participants would otherwise eat a growing chunk of the one-line author
// row.
const AVATAR_STACK_MAX = 3

// authorAvatarStack — compactConversation's author avatar: a single
// `avatarHTML` when only one person has spoken (unchanged from before), or a
// small overlapping stack (`-ml-2` + a `ring` to keep each circle visually
// separate from its neighbour — shape/border carries the distinction, not
// colour, per the colorblind rule in conventions.md) once more than one
// participant is in the thread. `who` is the already-computed root author
// (compactConversation's own `identityOf` call) so the single-participant
// path needs no second lookup.
function authorAvatarStack(c, who) {
  const participants = threadParticipants(c)
  if (participants.length <= 1) return avatarHTML(who.name, who.avatarUrl, 'h-5 w-5')
  const shown = participants.slice(0, AVATAR_STACK_MAX)
  const extra = participants.length - shown.length
  return html`
    <span class="flex shrink-0 items-center" data-testid="comment-author-stack">
      ${shown.map((p, idx) =>
        avatarHTML(
          p.name,
          p.avatarUrl,
          'h-5 w-5',
          (idx > 0 ? '-ml-2 ' : '') + 'ring-2 ring-white dark:ring-zinc-900',
        ).key('p:' + idx),
      )}
      ${() =>
        // Function-bound, not a bare toggling expression, per the "statically
        // interpolated template↔string slot" pitfall in arrowjs-pitfalls.md —
        // `extra` is fixed for this call, but the ${} slot's own chunk-caching
        // is keyed on TEMPLATE SHAPE, shared with every other authorAvatarStack
        // instance, so a plain ternary risks leaking the template as text.
        extra > 0
          ? html`<span
              class="-ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-700 text-[9px] font-semibold text-slate-600 dark:text-zinc-300 ring-2 ring-white dark:ring-zinc-900"
              data-testid="comment-author-stack-extra"
              >+${extra}</span
            >`
          : ''}
    </span>
  `
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
// Both align the selected card to the TOP of its own scroller (see
// alignToTopVertical) rather than just bringing it into view: a card selected
// below the fold otherwise stays half out of sight, and a card BELOW the
// selected one used to look like the top of the list. The moreAboveHint header
// says how many items sit above.
function scrollCommentIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelectorAll('[data-testid=comment-item]')[selI()]
    // Deliberately alignToTopVertical, not el.scrollIntoView({block:'nearest'}):
    // the latter also drags <main>'s horizontal scroll along (the axis rule in
    // .claude/rules/arrowjs-pitfalls.md) — this call site predates that rule.
    if (el) alignToTopVertical(el)
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
    if (el) alignToTopVertical(el)
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

// PINNED_EDGE_PX — how close to the bottom edge still counts as "at the
// bottom" for updateCommentThreadPinned/updateClaudeThreadPinned below. A
// couple of px of slack for sub-pixel scroll rounding, not a real threshold.
const PINNED_EDGE_PX = 8

// updateCommentThreadPinned/updateClaudeThreadPinned track whether the
// reviewer's OWN mouse/wheel scroll still sits at the bottom of the pane —
// independent of threadPos/claudePos, which only track the ↑/↓ KEYBOARD
// cursor and stay at rest (0) even while the pane's native scrollbar is
// dragged up by hand. Called from the pane's own @scroll handler, alongside
// updateScrollFade.
function updateCommentThreadPinned(el) {
  if (!el) return
  cs.threadPinned = el.scrollTop + el.clientHeight >= el.scrollHeight - PINNED_EDGE_PX
}
function updateClaudeThreadPinned(el) {
  if (!el) return
  cs.claudePinned = el.scrollTop + el.clientHeight >= el.scrollHeight - PINNED_EDGE_PX
}

// jumpToCommentThreadBottom/jumpToClaudeThreadBottom are the "scroll to
// recent messages" button's own handler (ClaudeChat.mjs's counterpart calls
// the Claude one via a callback, see claudeChatView) — re-pin, THEN scroll,
// since scrollCommentThreadToBottom/scrollClaudeThreadToBottom below are now
// themselves no-ops while not pinned.
export function jumpToCommentThreadBottom() {
  cs.threadPinned = true
  scrollCommentThreadToBottom()
}
export function jumpToClaudeThreadBottom() {
  cs.claudePinned = true
  scrollClaudeThreadToBottom()
}

// scrollToRecentButton — the small floating "you scrolled away, here's the
// newest messages" button, shown by expandedConversation while
// cs.threadPos === 0 && !cs.threadPinned. Same round pill/chevron look as
// Block.mjs's scrollHint (a static SVG string through the .innerHTML
// binding, safe since it's our own markup) — the shape carries the meaning
// per the colorblind rule, so no text label is needed, but a title/
// aria-label names it anyway. `onClick` is jumpToCommentThreadBottom or
// jumpToClaudeThreadBottom (this file), or ClaudeChat.mjs's own small local
// copy of this component for claude-chat-thread — kept file-local rather
// than shared, since ClaudeChat.mjs deliberately never imports this file
// back (see its own header comment).
const SCROLL_TO_BOTTOM_TITLE = 'Naar recente berichten'
function scrollToRecentButton(onClick, testid) {
  return html`
    <button
      type="button"
      class="absolute bottom-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-1 ring-black/5 hover:bg-emerald-600"
      data-testid="${testid}"
      title="${SCROLL_TO_BOTTOM_TITLE}"
      aria-label="${SCROLL_TO_BOTTOM_TITLE}"
      @click="${() => onClick()}"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="M6 9l6 6 6-6"/></svg>
    </button>
  `.key(testid)
}

// scrollCommentThreadToBottom keeps the newest message in view while the
// reviewer sits at the rest position (cs.threadPos === 0) AND hasn't
// scrolled the pane itself away from the bottom by hand (cs.threadPinned) —
// the exact mirror of scrollClaudeThreadToBottom below (`comment-thread` is
// now itself the scrolling container, capped at max-h-[38vh], see "A capped,
// fading thread" in .claude/docs/comments-panel.md). Called after
// toComment() resets threadPos to 0 and after a comment poll (loadComments)
// brings in a new reply on the currently-open thread. A no-op at any other
// threadPos — walking older messages via ↑ must never be yanked back down —
// and now ALSO a no-op while the reviewer has manually scrolled up: without
// threadPinned, a poll landing a few seconds later silently snapped a
// manual scroll-up back down (reported bug) — jumpToCommentThreadBottom's
// own button (rendered while !threadPinned, see expandedConversation) is the
// explicit way back down instead. Also updates the top-fade class directly,
// since a JS-driven scrollTop write isn't guaranteed to fire a native
// 'scroll' event in every browser.
function scrollCommentThreadToBottom() {
  if (cs.threadPos !== 0 || !cs.threadPinned) return
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=comment-thread]')
    if (!el) return
    el.scrollTop = el.scrollHeight
    updateScrollFade(el)
    // Same "a JS-driven scrollTop write isn't guaranteed to fire a native
    // 'scroll' event" reasoning as updateScrollFade just above — without this
    // direct call, threadPinned could be left stuck at a stale `false` (e.g.
    // from a transient scroll during layout/focus) with nothing to ever flip
    // it back to true again, permanently suppressing this very function.
    updateCommentThreadPinned(el)
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
  // sendError is the reviewer-facing sentence for a Signal POST that was
  // REJECTED or never arrived — '' whenever the last send was accepted. This
  // is deliberately separate from `status` (the panel's own load state) and
  // from a kind:'error' turn (Claude answered, but the call failed): here the
  // message never even reached the workflow, so nothing appears in the
  // transcript at all and without this the column is simply inert. See
  // sendClaudeMessage.
  sendError: '',
  // progress is the VOLATILE snapshot of a turn Claude is running right now
  // (chat_progress.go): which phase/tool, plus the answer text produced so
  // far. Pushed over SSE (chat.progress) and refetched on (re)connect from
  // GET /api/chat/progress; never persisted anywhere, so it is null whenever
  // no turn is running. The saved transcript (cc.messages) stays the truth.
  progress: null,
  // queued holds the reviewer's NEXT turns, typed while an earlier one is
  // still running ("doorpraten", like the Claude CLI): each entry is
  // {id, body, context, commentId, runId} and is sent as its own ordinary
  // "message" Signal once the turn before it returns (see queueClaudeMessage/
  // drainClaudeQueue). Reactive and only ever REASSIGNED, never mutated.
  queued: [],
  // tick exists purely so the "Claude denkt… 12s" counter re-renders once a
  // second while a turn runs — a reactive heartbeat, not data.
  tick: 0,
  // conversations holds the ids of THIS PR's comment threads that already have
  // Claude turns (GET /api/chat?pr=N, refreshed alongside every comment poll).
  // Reactive and only ever REASSIGNED, never mutated. No longer read by the
  // chat column's visibility binding (see claudeChatVisible()'s strict
  // invariant) — only chatAnchorComment()'s fallback below still reads it, to
  // resolve which comment a conversation hangs on when the reviewer's cursor
  // isn't sitting on a visible comment itself.
  conversations: [],
  // summary/summaryStatus mirror the conversation's own chat_conversations row
  // (see chat.Module.Summary, handleChat's extended /api/chat response) — the
  // summarize_chat workflow's short Dutch summary of this transcript, and its
  // status ('' never requested | 'searching' | 'done' | 'failed'). Refreshed
  // by every loadChatMessages call, same cadence as cc.messages. Consumed by
  // convertClaudeAnchorToComment's "Comment hiervan maken" prefill.
  summary: '',
  summaryStatus: '',
})

// pendingClaudeQuestion returns the newest message when it is a still-open
// question with clickable options (kind 'question', no answer yet, at least
// one option) — the one case claudeQuestionOptions (ClaudeChat.mjs) actually
// renders buttons for — else null. Used by handleRelatedKey's 'claude' branch
// to fold the options into the ↑/↓ chain (see cs.claudeOptionSel's own doc
// comment) and by selectHighlightedClaudeOption below.
function pendingClaudeQuestion() {
  const total = cc.messages.length
  if (total === 0) return null
  const m = cc.messages[total - 1]
  return m && m.kind === 'question' && !m.answer && m.options && m.options.length ? m : null
}

// chatAnchorComment answers "which comment does a Claude conversation on this
// unit hang on". A chat ALWAYS hangs on an existing comment (the backend's own
// constraint) and nothing ever auto-creates one for it — the unit either
// carries a visible comment (selComment()), or — a fallback kept for internal
// anchor resolution, though no longer relevant to the column's own visibility,
// see claudeChatVisible()'s strict invariant — a comment whose conversation
// already has turns but which is filtered out of the visible index (an
// orphan/PR-wide comment), or there is simply no chat.
function chatAnchorComment() {
  const c = selComment()
  if (c) return c
  const s = cs.scope
  if (!s) return null
  // A PR-wide comment-index item (home.mjs's commentScope sentinel, see its
  // own doc comment) carries the actual comment it was selected for — reuse
  // the SAME sync path a block-scoped comment gets instead of introducing a
  // second writer of `cc` (see startPrCommentChat/pcc below, and
  // syncClaudeAnchorForSelection's own doc comment for why nothing else may
  // race it).
  if (s.none) return s.prComment || null
  const hasTurns = (id) => cc.conversations.indexOf(id) >= 0
  return cs.list.find((x) => x.file === s.file && x.label === s.label && hasTurns(x.id)) || null
}

// syncClaudeAnchorForSelection keeps the VISIBLE Claude column matched to
// whichever comment is currently selected/scoped — claudeChatVisible() shows
// the column for ANY visible comment, regardless of cs.focus (browsing with
// the keyboard still on the diff, or on 'code', shows it too, not only
// 'comment'/'thread'/'claude' — see claudeChatVisible()'s doc comment), but
// until this watch existed nothing ever refreshed `cc` when the reviewer
// merely moved cs.sel to a DIFFERENT comment without explicitly entering
// 'claude' — so the column kept showing whatever conversation was last
// entered, unrelated to the newly selected comment. Bug report: selecting an
// AI-controle finding that never had a Claude conversation still showed the
// previous comment's transcript.
//
// Deliberately skips 'claude' and 'new' focus — those two already own `cc`
// completely (enterClaudeChat/applyRelRestore/ensureClaudeAnchorForNew resp.
// toNew), and this passive sync must never race or fight with them.
//
// Deliberately NEVER calls ensureAndLoadChat (the idempotent-but-CREATING
// `POST /api/workflows/claude_chat`) — merely browsing the comment list must
// not spin up a claude_chat Execution for a comment nobody chatted about yet
// (the same "nothing auto-creates a conversation" rule as the removed
// placeholder comment, see "Product decision" in claude-chat-panel.md). It
// always does a plain read-only GET (loadChatMessages/loadChatProgress)
// instead — `GET /api/chat?commentId=` is safe and side-effect-free even for
// a comment that never had a conversation at all (it just returns an empty
// `messages` array, see tasks_api.go's handleChat), so there is no need to
// gate this on cc.conversations first: that set is only refreshed on the
// comment poll's own cadence (loadChatConversations) and can lag behind a
// conversation the reviewer just started in THIS tab, which briefly made this
// sync wrongly treat a real, just-created conversation as nonexistent.
function syncClaudeAnchorForSelection() {
  // Also skip while a turn is actively running for the anchored conversation
  // (hasActiveClaudeTurn) — a plain block/comment switch elsewhere must not
  // re-anchor (and thereby reset/hide) `cc` while it is mid-turn; see
  // claudeChatVisible()'s own "stay open" comment above.
  if (cs.focus === 'claude' || cs.focus === 'new' || hasActiveClaudeTurn()) return
  const c = chatAnchorComment()
  const nextId = c ? c.id : null
  if (nextId === cc.commentId) return
  cc.commentId = nextId
  cc.messages = []
  cc.runId = null
  cc.progress = null
  cs.claudePinned = true // a different conversation always starts pinned to its own bottom
  cc.sendError = '' // another conversation, so the previous one's rejection no longer applies
  if (nextId == null) {
    cc.status = 'idle'
    return
  }
  cc.status = 'loading'
  loadChatMessages(nextId, false)
  loadChatProgress(nextId)
}

// The getter lists cs.sel/cs.focus/cs.list/cs.scopeSig INLINE (per the
// arrow.js `watch` pitfall — reads buried inside a called function can drop
// out of the crystallized dependency set on an early-return path); cs.scopeSig
// is the cheap primitive setCommentScope already bumps on every real scope
// change (a block switch), so this watch also re-fires on a bare ↓/↑ between
// blocks, not only when cs.sel/cs.list itself changes. The work happens in
// the callback via chatAnchorComment()/selComment().
watch(() => [cs.sel, cs.focus, cs.list, cs.scopeSig], syncClaudeAnchorForSelection)

// loadChatConversations refreshes cc.conversations for pr — read-only GET, so
// it rides along with the comment poll (loadComments) rather than owning a
// timer of its own.
async function loadChatConversations(pr) {
  if (pr == null) return
  try {
    const res = await fetch('/api/chat?pr=' + encodeURIComponent(pr) + repoParam())
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
    cc.summary = ''
    cc.summaryStatus = ''
    cs.claudePinned = true // a different conversation always starts pinned to its own bottom
  }
  cc.status = 'loading'
  try {
    const res = await fetch('/api/workflows/claude_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr, repo: repoField(), commentId }),
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

// appliedDraftReplyIds tracks which chat.KindDraftReply turns have already
// been merged into replyDrafts — a plain, session-only Set (mirrors
// replyDrafts itself), so a later re-render of the SAME turn (a poll, a
// resync, a page that happened to fetch the transcript twice) never
// re-appends the same text a second time. A genuinely NEW draft turn (a
// distinct id — see chatMessageID's turnID-derived, per-turn id in
// chat_workflow.go) always gets its own entry, so a follow-up Claude proposal
// in the SAME conversation still merges in — this is deliberately NOT a
// one-shot-then-frozen mechanism (Reindert's explicit request).
const appliedDraftReplyIds = new Set()

// pureChatDraftReplyIds tracks which comment threads currently hold a reply
// composer whose ENTIRE content is a still-unedited Claude draft — i.e. the
// field was EMPTY the moment applyPendingDraftReplies wrote into it (rule 3
// below never fired). Reviewer request: sending such a draft as-is should
// feel like one action, not two — the field is pre-selected so typing (or
// just pressing Enter) replaces/keeps it in one go, and sendReaction skips the
// publish-choice menu entirely and posts it straight to GitHub (see
// sendReaction's own doc comment for why `publish: 'reply'` specifically).
// Cleared by reaction-compose's own @input handler the moment the reviewer
// changes so much as one character — from then on it is the reviewer's own
// text, mixed or not, and the ordinary publish-choice flow applies again.
const pureChatDraftReplyIds = new Set()

// applyPendingDraftReplies is the frontend half of the comment_action "reply"
// draft (see chat_workflow.go's saveChatDraftReply / chat.KindDraftReply):
// Claude may draft a reply "on the reviewer's behalf", but it must never be
// posted by itself — this only SEEDS the left thread's own reply composer
// (reaction-compose) with the drafted text, exactly like an ordinary
// replyDrafts-backed draft the reviewer typed themselves, and leaves the
// actual send to sendReaction's normal, unprivileged path.
//
// Reindert's three explicit rules, in order:
//   1. Only a comment_action "reply" turn becomes a draft (chat_workflow.go's
//      own decision — "resolve" is applied immediately, nothing to merge here).
//   2. The text is ALWAYS written into replyDrafts (so it's there next time the
//      reviewer opens this thread, even if it isn't mounted right now), but the
//      DOM focus only moves onto the field when the reviewer is NOT currently
//      typing in the Claude composer — never steal the keyboard out from under
//      an in-progress follow-up message.
//   3. An already-typed reviewer draft is never overwritten or discarded —
//      Claude's text is appended UNDERNEATH it (blank line separator), so both
//      survive.
//
// A fourth rule, added later (Reindert's explicit request): when rule 3 above
// does NOT apply — the field was genuinely empty, so the whole thing is
// Claude's own text — the field is focused with its content fully SELECTED
// (`el.select()`, not just a caret at the end) and the thread is marked in
// `pureChatDraftReplyIds` so a bare Enter posts it straight to GitHub without
// the publish-choice menu (see sendReaction). A merged draft (rule 3 fired)
// gets neither: it is no longer purely Claude's text, so it goes through the
// ordinary flow untouched.
//
// Deliberately does NOT reuse prefillField's rAF + focusToken-gated wait: that
// mechanism exists for a field that is only ABOUT to mount because of the very
// state change that requested the focus (see prefillField's own doc comment),
// and entering/leaving the Claude column in between can bump focusToken before
// the deferred write lands — silently dropping the draft. reaction-compose is
// (per "Also stays expanded once the keyboard moves on into the Claude
// column" in .claude/docs/comments-panel.md) already mounted whenever this
// runs, or genuinely not part of the current view at all — either way a
// synchronous DOM read settles it with no race.
function applyPendingDraftReplies(commentId) {
  let appended = false
  let pure = false
  for (const m of cc.messages) {
    if (m.kind !== 'draft_reply' || appliedDraftReplyIds.has(m.id)) continue
    appliedDraftReplyIds.add(m.id)
    const existing = replyDrafts.get(commentId) || ''
    replyDrafts.set(commentId, existing ? existing + '\n\n' + m.body : m.body)
    appended = true
    pure = !existing
  }
  if (!appended) return
  if (pure) pureChatDraftReplyIds.add(commentId)
  else pureChatDraftReplyIds.delete(commentId)
  const merged = replyDrafts.get(commentId)
  const el = document.querySelector('[data-testid=reaction-compose]')
  if (!el) return // not currently mounted — replyDrafts already holds it for the next time this thread opens
  el.value = merged
  autoGrowTextarea(el) // .value= fires no input event, so the auto-grow needs an explicit nudge
  const active = document.activeElement
  const typingInClaude = !!(active && active.matches && active.matches('[data-testid=claude-chat-compose]'))
  if (typingInClaude) return // never steal the keyboard out from under an in-progress follow-up message
  el.focus()
  if (pure) el.select()
  else el.setSelectionRange(el.value.length, el.value.length)
}

// loadChatMessages re-fetches the transcript (read-only GET, safe to poll).
// Guards against a stale response landing after the reviewer has since
// switched to a different comment's conversation.
// applyDrafts defaults to true for every explicit "the reviewer is actually
// looking at/using this conversation" caller (ensureAndLoadChat,
// applyRelRestore, the chat.message SSE handler, the resync). It is passed
// `false` only by syncClaudeAnchorForSelection's passive preload — merely
// selecting a comment must not silently write a Claude-drafted reply into the
// reaction-compose field the moment its data happens to arrive, before the
// reviewer has had a chance to type (or decide not to) their own reply; see
// "The Claude column must follow the browsed comment" in
// claude-chat-panel.md. The transcript itself still loads either way — only
// the reply-field side effect is skipped.
async function loadChatMessages(commentId, applyDrafts = true) {
  try {
    const res = await fetch('/api/chat?commentId=' + encodeURIComponent(commentId) + repoParam())
    if (!res.ok) return
    const json = await res.json()
    if (cc.commentId !== commentId) return // stale — a later switch already won
    cc.messages = json.messages || []
    cc.summary = json.summary || ''
    cc.summaryStatus = json.summaryStatus || ''
    cc.status = 'idle'
    if (applyDrafts) applyPendingDraftReplies(commentId)
    scrollClaudeThreadToBottom()
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
    const res = await fetch('/api/chat/progress?commentId=' + encodeURIComponent(commentId) + repoParam())
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
  scrollClaudeThreadToBottom()
  syncChatTicker()
}

// sendClaudeMessage sends the reviewer's turn (free text, or the text of a
// clicked question option — see claudeChatColumn's onSend, the same callback
// either way). The Signal round-trip runs the Activities (incl. the real
// claude subprocess call) INLINE — see tembed-workflows.md — so this await
// genuinely spans that step. That await is no longer what makes an ordinary
// turn's reply appear, though: the live progress (streamed tokens, current
// tool) arrives meanwhile over SSE, and the finished transcript over
// chat.message. This is only the belt-and-braces refetch for the reviewer's
// OWN send.
//
// `action` stays `''` (plain, tool-less, network-independent turn) here — the
// old, separate "Bewerk code"/"Commit wijziging" buttons are gone (see
// claudeChatColumn), but sending `action: 'edit'`/`'commit'` on every ordinary
// turn was deliberately NOT made the new default: chat_workflow.go's
// runOneClaudeTurn calls ensureChatShadowWorktree (chat_shadow.go) for ANY
// non-'' action, which does a REAL `gh pr view` + `git fetch` before Claude is
// even asked anything, with no offline/degraded fallback — confirmed to break
// plain conversational turns entirely the moment that call fails (verified
// against tests/claude-chat-panel.spec.mjs; see claude-chat-panel.md's
// "Triggering agentic actions" for the full account and the currently open
// question this leaves). Until that is resolved, this file only ever sends
// the plain, always-available turn.
//
// `context` (optional) is the reviewer's SELECTION at send time — never part
// of the visible bubble. It travels as its own field on the Signal
// (ChatMessageSignal.Context, chat_workflow.go) and only enriches the PROMPT
// the claude CLI sees (buildChatPrompt); `text`/`trimmed` is what gets saved
// and shown, unchanged. See claudeContextBlock's doc comment for who builds it
// and why only the conversation's first turn does.
//
// `target` (optional) pins the conversation this turn belongs to
// ({runId, commentId}) instead of reading the live `cc.*`. Only
// drainClaudeQueue passes it: a queued turn is sent minutes after it was
// typed, by which time the reviewer may already be looking at another
// conversation — it must still land on the one it was written for, and only
// refetch the transcript when that is also the one currently in view.
// sendErrorText turns a rejected Signal POST into one Dutch sentence that says
// what to DO about it — the three statuses the message endpoint really
// produces (tasks_api.go's handleWorkflows):
//
//   400 "invalid action"  — the running server does not know this action at
//       all. In practice: a stale binary next to a fresh frontend. `src/` is
//       served straight off disk, so a browser reload picks up a new button
//       (e.g. "Opnieuw proberen", added with the `retry` action) while the Go
//       process still runs yesterday's code and rejects it. This is exactly
//       how the whole Claude column can look healthy and still refuse every
//       press, which is the bug this function was written for.
//   409 — SignalWorkflow refused because the Execution is already
//       completed/failed, so this conversation can never accept another turn.
//   anything else — an unexpected server-side failure; naming the status is
//       the most useful thing we can say.
//
// Every sentence starts with a WORD, never a bare colour/red bubble, per the
// colourblind rule in .claude/rules/conventions.md.
function sendErrorText(status) {
  if (status === 400) {
    return 'Versturen geweigerd — de server kent deze actie niet. Herstart slash (de server draait een oudere versie dan deze pagina) en laad opnieuw.'
  }
  if (status === 409) {
    return 'Dit gesprek is op de server afgesloten en neemt geen berichten meer aan. Wis het gesprek en begin opnieuw.'
  }
  return 'Versturen mislukt (HTTP ' + status + '). Probeer het opnieuw.'
}

async function sendClaudeMessage(text, action = '', context = '', target = null) {
  const trimmed = (text || '').trim()
  // 'commit'/'clear'/'retry' need no typed text — commit pushes whatever
  // Claude already changed, clear wipes the conversation, retry re-runs the
  // turn that finally failed from the workflow's own recorded input; none of
  // them asks anything new.
  const needsNoText = action === 'commit' || action === 'clear' || action === 'retry'
  const runId = target ? target.runId : cc.runId
  const commentId = target ? target.commentId : cc.commentId
  if (!runId) return
  if (!needsNoText && !trimmed) return
  cc.busy = true
  cc.sendError = ''
  try {
    const res = await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'reviewer',
        body: trimmed,
        action: action || undefined,
        context: context || undefined,
      }),
    })
    // A rejected Signal used to be swallowed whole: the response was never
    // read, so the reviewer got no bubble, no status line and no hint that
    // nothing had been sent — the column just sat there, inert. See
    // sendErrorText for the three ways this actually happens.
    if (!res.ok) {
      cc.sendError = sendErrorText(res.status)
      return
    }
    if (commentId === cc.commentId) {
      await loadChatMessages(commentId)
      clearFinishedChatProgress()
    }
  } catch (_) {
    // fetch() only rejects when the request never completed at all (server
    // down, connection dropped). Previously uncaught, so it escaped as an
    // unhandled rejection out of the click handler — again with nothing
    // visible in the column.
    cc.sendError = 'Geen verbinding met de server — draait slash nog?'
  } finally {
    cc.busy = false
    // Whatever the reviewer typed meanwhile goes out now, one turn at a time.
    drainClaudeQueue()
  }
}

// queuedIdSeq numbers the client-side queue entries. A queued turn has no
// Signal id yet (the server mints that, see the message handler in
// tasks_api.go) but its bubble still needs a stable arrow.js key, so this is
// purely a render key — never sent anywhere.
let queuedIdSeq = 0

// queueClaudeMessage is the one entry point for a reviewer turn from the
// composer: send it straight away when nothing is running, otherwise put it in
// cc.queued and let drainClaudeQueue pick it up after the running turn — the
// Claude CLI's own "keep typing while it works" behaviour. The composer is
// therefore no longer disabled while a turn runs (ClaudeChat.mjs), and a
// message typed during one is never silently swallowed.
//
// Deliberately NOT merged into the running turn: the workflow's own
// WaitSignal loop (chat_workflow.go) is what makes each turn a separate,
// replayable step, and its pendingQuestionID bookkeeping assumes one reviewer
// message per turn. Each queued entry keeps the runId/commentId it was typed
// against so a conversation switch can't misroute it.
//
// Durability trade-off, recorded in claude-chat-panel.md: the queued Signal
// only reaches the workflow history once the running turn finishes (tembed's
// SignalWorkflow holds the run lock while it drives the turn inline), so a
// queued message lives client-side until then and is lost if the server
// restarts mid-turn. The reviewer sees it sitting in the queue the whole time.
function queueClaudeMessage(text, context = '') {
  const trimmed = (text || '').trim()
  if (!trimmed) return Promise.resolve()
  if (!cc.busy) return sendClaudeMessage(trimmed, '', context)
  if (!cc.runId) return Promise.resolve()
  queuedIdSeq += 1
  cc.queued = cc.queued.concat([
    { id: 'q' + queuedIdSeq, body: trimmed, context, commentId: cc.commentId, runId: cc.runId },
  ])
  return Promise.resolve()
}

// drainClaudeQueue sends the oldest queued turn, if any — called from
// sendClaudeMessage's own `finally`, so the queue drains itself one turn at a
// time (each send ends in another drain). Guarded on cc.busy so two overlapping
// drains can never send the same entry twice; the entry is removed from the
// queue BEFORE it is sent, which is also what makes its "in de wachtrij"
// bubble give way to the ordinary user bubble the send itself produces.
function drainClaudeQueue() {
  if (cc.busy || !cc.queued.length) return
  const [next, ...rest] = cc.queued
  cc.queued = rest
  sendClaudeMessage(next.body, '', next.context, { runId: next.runId, commentId: next.commentId })
}

// clearClaudeChat sends the "clear" ChatMessageSignal (chatActionClear in
// chat_workflow.go) — wipes the transcript + the stored claude session, and
// best-effort removes the conversation's agentic-edit shadow worktree
// (chat_shadow.go's clearChatShadow). Only ever reached from the command
// palette's confirm-gated "Wis Claude-gesprek" item (home.mjs), which already
// ran the extra pending-work warning (chatShadowPendingWarning below) before
// this point — so this itself asks for no further confirmation.
// retryClaudeTurn sends the "retry" ChatMessageSignal (chatActionRetry in
// chat_workflow.go): re-run the turn whose automatic backoff ladder
// (3/6/12/24/48 seconds, escalating to Sonnet) ran out, from the workflow's
// OWN recorded input — nothing about the failed turn is re-sent from here, so
// there is no way for this to post a different message than the one that
// failed. A no-op on the workflow side when nothing failed.
//
// Two entry points, one function, per the mouse/keyboard rule in
// .claude/docs/mouse-navigation.md: the "Opnieuw proberen" button on the
// failed bubble (ClaudeChat.mjs) and the Enter-palette item in the Claude
// column (claudeChatCommandsFor in home.mjs).
export async function retryClaudeTurn() {
  await sendClaudeMessage('', 'retry')
}

// clearClaudeChat wipes the conversation AND — reviewer request — its
// backing comment when that comment counts as "empty": still exactly
// CLAUDE_ANCHOR_PLACEHOLDER, never replaced with the reviewer's own text
// ("ik zie het ook als een leeg veld als ik '(Nog geen eigen comment getypt —
// gesprek met Claude gestart.)' zie"). Deliberately keyed on the comment's
// CONTENT, not on which menu/gate the reviewer used to reach "Wis
// Claude-gesprek" — a comment that already carries real reviewer text always
// survives, regardless of entry point.
export async function clearClaudeChat() {
  await sendClaudeMessage('', 'clear')
  // Belt-and-braces local reset, same reasoning as sendClaudeMessage's own
  // refetch: chat.message (SSE) already triggers loadChatMessages elsewhere,
  // but the reviewer's OWN action shouldn't wait on that round trip.
  cc.progress = null
  cs.claudePos = 0
  cs.claudePinned = true
  cs.claudeOptionSel = 0
  const anchor = cc.commentId != null ? commentById(cc.commentId) : null
  if (anchor && anchor.body === CLAUDE_ANCHOR_PLACEHOLDER) {
    await deleteComment(anchor)
    await loadComments(cs.pr)
    exitRelated() // nothing left to focus — hand the keyboard back to the diff
  }
}

// claudeAnchorIsPlaceholder reports whether the CURRENTLY OPEN conversation's
// backing comment still carries CLAUDE_ANCHOR_PLACEHOLDER — i.e. "empty" per
// the reviewer's own definition above. Gates the "Comment hiervan maken" menu
// item. Looked up via cc.commentId + commentById (never chatAnchorComment()/
// selComment(), which can resolve to an unrelated comment on the same unit
// while nothing is anchored yet, see isNewChatUnanchored) — so this is exactly
// THIS conversation's own anchor, never a neighbour's.
export function claudeAnchorIsPlaceholder() {
  if (cc.commentId == null) return false
  const c = commentById(cc.commentId)
  return !!c && c.body === CLAUDE_ANCHOR_PLACEHOLDER
}

// requestChatSummary starts (idempotently, via StartSummarizeChat's
// deterministic Run ID) the summarize_chat Execution for the given
// conversation — the sanctioned write path. `msgCount` pins the request to
// the conversation's CURRENT length, so re-requesting with no new messages
// since the last request is a free no-op reuse, mirroring explain_code's own
// idempotent start.
async function requestChatSummary(commentId, msgCount) {
  try {
    await fetch('/api/workflows/summarize_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: cs.pr, repo: repoField(), commentId, msgCount }),
    })
  } catch (_) {
    // best-effort — a transient failure just leaves cc.summaryStatus as-is,
    // and convertClaudeAnchorToComment's own poll below simply times out.
  }
}

// pollChatSummary refetches the transcript (which also carries
// cc.summary/summaryStatus, see loadChatMessages) every 500ms, up to ~10s,
// until the just-started summarize_chat run lands (or fails) — a one-shot
// Haiku call, not worth a dedicated SSE event on top of the existing
// chat.message channel. `want` is the focusToken snapshotted by the caller
// (releaseFocus's own pattern, used throughout this file) so a stale poll
// started for a conversation the reviewer has since left never overwrites
// anything.
async function pollChatSummary(commentId, want) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (want !== focusToken || cc.commentId !== commentId) return
    await loadChatMessages(commentId, false)
    if (cc.summaryStatus === 'done' || cc.summaryStatus === 'failed') return
  }
}

// convertClaudeAnchorToComment is the "Comment hiervan maken" menu item
// (claudeChatCommandsFor, home.mjs) — only ever offered while
// claudeAnchorIsPlaceholder() is true. Steps the keyboard back onto the
// comment card (toComment(false), same as ←/Escape from 'claude' — see
// handleRelatedKey's 'claude' ArrowLeft branch) and opens the origin bubble's
// own inline editor (the existing "Bewerk bericht" mechanism —
// startEditMessage's editState/editTargetId) prefilled with a Claude-written
// summary of the conversation (reviewer request: "voorgevuld met de chat,
// maar dan door chat geschreven in maximaal 2 zinnen") instead of the
// placeholder text, so the reviewer edits/confirms a real draft rather than
// starting from either an empty field or the throwaway placeholder sentence.
// A summary already generated for the conversation's CURRENT length is reused
// instantly; otherwise this requests one and waits (pollChatSummary) —
// leaving the field on its "genereert…" placeholder meanwhile — and only
// overwrites the field if the reviewer hasn't already started typing their
// own text into it in the meantime.
export async function convertClaudeAnchorToComment() {
  if (cc.commentId == null) return
  const c = commentById(cc.commentId)
  if (!c || c.body !== CLAUDE_ANCHOR_PLACEHOLDER) return
  toComment(false)
  editState.commentId = c.id
  editState.targetId = c.id
  const want = focusToken
  if (cc.summaryStatus === 'done' && cc.summary) {
    prefillField('[data-testid=message-edit-compose]', cc.summary)
    return
  }
  prefillField('[data-testid=message-edit-compose]', 'Claude schrijft een samenvatting…')
  await requestChatSummary(c.id, cc.messages.length)
  await pollChatSummary(c.id, want)
  if (want !== focusToken) return
  const el = document.querySelector('[data-testid=message-edit-compose]')
  if (!el || el.value.trim() !== 'Claude schrijft een samenvatting…') return // reviewer already started typing
  if (cc.summaryStatus === 'done' && cc.summary) {
    prefillField('[data-testid=message-edit-compose]', cc.summary)
  } else {
    // Offline/hiccup ('failed'): nothing to prefill — leave it empty, the
    // same fallback as before summaries existed.
    prefillField('[data-testid=message-edit-compose]', '')
  }
}

// shadowWarning/shadowWarningFor cache the last-known shadow-pending check
// (refreshChatShadowWarning) for the CURRENTLY open conversation, so
// claudeChatShadowWarning below can answer SYNCHRONOUSLY — home.mjs builds
// the "Wis Claude-gesprek" confirm submenu at Enter/openMenu time (plain,
// non-reactive code, mirroring commentCommandsFor's own focusedCommentGithubId
// snapshot read), which cannot itself await a fetch.
let shadowWarning = ''
let shadowWarningFor = null

// refreshChatShadowWarning is the read-only check the Claude column runs
// right after entering a conversation (enterClaudeChat, fire-and-forget —
// entering the chat must not wait on it) — see GET /api/chat/shadow-status
// (tasks_api.go). Populates shadowWarning with a sentence when the
// conversation's own shadow worktree (chat_shadow.go) still has uncommitted
// or locally-unpushed work that "wis gesprek" would discard, '' when there's
// nothing to warn about (no shadow worktree at all, a clean one, or the check
// itself failed — best-effort, never blocks anything).
async function refreshChatShadowWarning(pr, commentId) {
  shadowWarning = ''
  shadowWarningFor = commentId
  try {
    const res = await fetch(
      '/api/chat/shadow-status?pr=' + encodeURIComponent(pr) + '&commentId=' + encodeURIComponent(commentId),
    )
    if (!res.ok) return
    const json = await res.json()
    if (cc.commentId !== commentId) return // stale — the reviewer switched conversations meanwhile
    if (json.exists && (json.dirty || json.ahead)) {
      shadowWarning =
        'Let op: er staat nog niet-gepushte Claude-code in de shadow-worktree van dit gesprek — die gaat verloren bij het wissen.'
    }
  } catch (_) {
    // keep '' — a failed check just means no extra warning line
  }
}

// claudeChatShadowWarning is a plain, non-reactive snapshot read of the
// cached warning for whichever conversation is currently open — '' if the
// cache belongs to a DIFFERENT (or no) conversation, so a stale check from a
// previously viewed thread never leaks into this one's confirm menu.
export function claudeChatShadowWarning() {
  return shadowWarningFor === cc.commentId ? shadowWarning : ''
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
  const parts = []
  // A range-scoped chat (startRangeChat, see cs.rangeCompose) sends a
  // MANIFEST of the whole Shift-selection instead of the single-unit
  // snippet below — see claudeRangeContextBlock's own doc comment for why.
  if (cs.rangeCompose && rangeComposeItems.length) {
    parts.push(claudeRangeContextBlock(rangeComposeItems))
  } else {
    const t = commentTarget && commentTarget()
    if (t && t.file && t.code) {
      const lines = ['Context van de reviewer-selectie (niet door de reviewer getypt):', 'Bestand: ' + t.file]
      if (t.oldStartLine)
        lines.push('Oude regels: ' + t.oldStartLine + (t.oldEndLine > t.oldStartLine ? '-' + t.oldEndLine : ''))
      if (t.newStartLine)
        lines.push('Nieuwe regels: ' + t.newStartLine + (t.newEndLine > t.newStartLine ? '-' + t.newEndLine : ''))
      if (t.label) lines.push('Onderdeel: ' + t.label)
      lines.push('Voorbeeldcode:', '```php', t.code, '```')
      parts.push(lines.join('\n'))
    }
  }
  const threadBlock = claudeThreadContextBlock()
  if (threadBlock) parts.push(threadBlock)
  return parts.join('\n\n')
}

// claudeRangeContextBlock builds the invisible first-turn context for "Chat
// met Claude over dit bereik" (startRangeChat) — a plain MANIFEST (label,
// file, and the block's own start line; the old/new start line too, when
// its code happens to be ALREADY loaded, never fetched for this alone) per
// block/method the Shift-selection covered. Deliberately NO source code:
// unlike a single-unit chat (claudeContextBlock's own branch above), an
// index-level range has no size ceiling on the number of blocks it can
// cover, and embedding every block's own diff snippet would make the prompt
// grow unboundedly with the selection instead of with one unit's row count
// (the existing MAX_EXPLAIN_LINES cap only bounds the AUTOMATIC per-unit
// explain, and only ever within one block — see keyboard-navigation.md).
// Explicit product decision (Reindert, not a guess): Claude already has
// Read/Bash access in its own shadow worktree for this conversation (see the
// carve-out in .claude/rules/workflows-write-boundary.md), so it can open a
// listed file itself the moment it actually needs to see the code, rather
// than every block's code being pushed into the prompt whether needed or not.
function claudeRangeContextBlock(items) {
  const lines = [
    'Context van de reviewer-selectie (niet door de reviewer getypt):',
    `Bereik van ${items.length} ${items.length === 1 ? 'blok' : 'blokken'} uit de PR-index — ` +
      'geen broncode meegestuurd, open het bestand zelf (je hebt hier leestoegang) als je de code nodig hebt:',
  ]
  for (const b of items) {
    let loc = 'regel ' + (b.line || '?')
    const c = b && b.code
    if (c && c.new && c.new.start) loc = 'nieuw vanaf regel ' + c.new.start + (c.old && c.old.start ? ', oud vanaf regel ' + c.old.start : '')
    lines.push('- ' + (b.label || b.file || '?') + (b.file ? ' (' + b.file + ')' : '') + ' — ' + loc)
  }
  return lines.join('\n')
}

// orderedThreadMessages returns every message across every comment thread on
// this unit (visibleComments()), chronologically (createdAt) — the exact
// scope/order claudeThreadContextBlock feeds to Claude, and ALSO the order
// used to number each message's own fenced code blocks (see
// threadFenceStartIndexes below), so a "Codeblok N" badge the reviewer sees
// always names the same block Claude's own copy of the context calls "Codeblok
// N" — the whole point of the numbering (the reviewer types "pas codeblok 3
// toe" in the Claude chat instead of a dedicated accept action). Skips
// CLAUDE_ANCHOR_PLACEHOLDER (see ensureClaudeAnchorForNew) since that is not a
// real message the reviewer wrote.
function orderedThreadMessages() {
  const threads = visibleComments()
  const msgs = []
  for (const c of threads) {
    for (const m of threadMessages(c)) {
      if (!m.body || m.body === CLAUDE_ANCHOR_PLACEHOLDER) continue
      msgs.push({ id: m.id, author: m.author, body: m.body, createdAt: m.createdAt || c.createdAt || '' })
    }
  }
  msgs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  return msgs
}

// threadFenceStartIndexes maps a message's own id to the running code-fence
// count BEFORE that message's own fences, so a rendered bubble can continue
// the thread's numbering instead of resetting to "Codeblok 1" in every bubble
// (commentBody's own `startIndex` parameter, see viewingBubble/
// compactConversation below). Uses the SAME cross-thread, chronological order
// as `orderedThreadMessages`/claudeThreadContextBlock when `c` is part of that
// scope (the ordinary block-scoped case, where an embedded Claude chat can
// reference these numbers) — and falls back to `c`'s own thread in isolation
// otherwise (e.g. a PR-wide comment-index item's detail card, which has no
// Claude chat/cross-thread scope to match), so numbering is always at least
// continuous within one thread even there.
function threadFenceStartIndexes(c) {
  const crossScope = visibleComments()
  const inScope = c && crossScope.some((x) => x.id === c.id)
  const msgs = inScope ? orderedThreadMessages() : threadMessages(c).filter((m) => m.body)
  const map = new Map()
  let running = 0
  for (const m of msgs) {
    map.set(m.id, running)
    running += countCodeFences(m.body)
  }
  return map
}

// claudeThreadContextBlock summarizes every already-written comment message
// scoped to this same code block/line — the conversation's own anchor thread
// (opening + reactions) PLUS any other comment thread on the same unit (i.e.
// exactly visibleComments()/cs.view, the same "under this selection" scope
// the comment index itself uses — see recomputeView/commentUnder) — so
// Claude doesn't need the reviewer to repeat in the chat what's already
// written right next to it. Deliberately NOT every comment on the whole PR,
// only this unit's.
//
// Ordered chronologically (createdAt) across every thread combined, and the
// LAST message is explicitly tagged as the most recent one the conversation
// builds on — an unordered dump left it unclear which remark is the standing
// one to react to (explicit reviewer request).
//
// Every fenced code block in every message is also annotated with the same
// "[Codeblok N]"/"[Suggestie N]" marker its visual badge shows
// (annotateFenceNumbers, markdown.mjs) — running continuously across every
// message in this same order — so the reviewer can say "pas codeblok 3 toe:
// ..." in the Claude composer and Claude's own copy of the context contains
// that exact same numbering, no separate accept action needed.
function claudeThreadContextBlock() {
  const msgs = orderedThreadMessages()
  if (!msgs.length) return ''
  const lines = ['Al geschreven comments op dit codeblok/deze regel (chronologisch, oud naar nieuw):']
  let running = 0
  msgs.forEach((m, i) => {
    const tag = i === msgs.length - 1 ? ' [meest recent — het gesprek gaat hierop verder]' : ''
    const { text: body, count } = annotateFenceNumbers(m.body, running)
    running += count
    lines.push('- ' + displayNameOf(m.author || 'onbekend') + ': ' + body + tag)
  })
  return lines.join('\n')
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
  cs.claudePinned = true
  cs.claudeOptionSel = 0
  await ensureAndLoadChat(pr, c.id)
  if (token !== focusToken) return
  ensureChatEvents(pr)
  loadChatProgress(c.id)
  focusClaudeComposer()
  // Fire-and-forget: the "Wis Claude-gesprek" palette command's extra warning
  // (claudeChatShadowWarning) reads this cache synchronously at open time —
  // entering the chat must not wait on this read-only check.
  refreshChatShadowWarning(pr, c.id)
}

// enterClaudeChatFromNew is the → target for the still-open "Comment op deze
// regel" composer (cs.focus === 'new') once the caret has nowhere further
// right to go (home.mjs's editableCaretCanMoveRight() guard) — reviewer
// request: type a comment, then keep going right into Claude without first
// placing the comment. Unlike enterClaudeChat it needs no anchor comment to
// already exist: claudeChatVisible() is already true while cs.focus === 'new'
// (see below), so the Claude column/composer is already mounted and cc is
// already blank/idle (reset by toNew) — sending from there lazily creates the
// backing comment on the reviewer's first actual send
// (ensureClaudeAnchorForNew/sendClaudeMessageFromNew), never on mere
// navigation (see "Product decision" in claude-chat-panel.md). No fetch, no
// SSE re-subscribe: ClaudeChatPanel's own mount already called
// ensureChatEvents while the composer opened.
function enterClaudeChatFromNew() {
  cs.focus = 'claude'
  cs.claudePos = 0
  cs.claudePinned = true
  cs.claudeOptionSel = 0
  focusClaudeComposer()
}

// isClaudeChatFocused/claudeChatVisible are the two questions home.mjs/this
// panel's own render need: whether the KEYBOARD is on the chat column, and
// whether the column should be VISIBLE at all.
//
// STRICT invariant (explicit request, replacing an earlier looser rule): the
// Claude column is visible EXACTLY when the comment column (InlineComments)
// has something to show — a visible comment thread (hasVisibleComments()) or
// the brand-new composer (cs.focus === 'new') — never on its own. This is a
// deliberate narrowing of the earlier "a conversation that already happened
// never becomes unreachable" guarantee: a conversation whose backing comment
// has fallen out of the visible index (an orphan/PR-wide comment, or one
// filtered out by the current granularity scope) is no longer reachable
// through ordinary navigation. Also fixes a stale-focus bug: cs.focus could
// stay 'claude' after the reviewer had already navigated to a different unit
// (see advanceToNextBlockFromClaudeChat, home.mjs), which used to keep this
// column showing with nothing behind it.
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
//
// The THIRD branch (cs.focus === 'claude' && cc.commentId == null) covers the
// keyboard sitting IN the Claude composer itself, reached via
// enterClaudeChatFromNew (→ from the still-open 'new' composer, see
// claude-chat-panel.md) before anything is placed: the moment cs.focus flips
// away from 'new' to 'claude', the plain 'new' check above no longer holds,
// and hasVisibleComments() is still false (there is genuinely no comment yet)
// — without this branch the whole column, including the very composer the
// keyboard just landed in, would vanish out from under the reviewer one
// keypress after entering it. cc.commentId is the same "no anchor exists yet"
// signal handleRelatedKey's own 'claude' ArrowLeft/Escape branches use (see
// toNewFocus) — an already-anchored conversation (reached via the ordinary
// enterClaudeChat) always has it set, so this branch can never keep a
// genuinely gone conversation visible.
//
// isNewChatUnanchored() names exactly this "'new', or 'claude' with no anchor
// yet" condition as its own predicate — three call sites need the identical
// check (this function, ensureClaudeAnchorForNew's own guard below, and
// newCommentComposer's visibility toggle in this same file) and a bare
// inline repeat of it drifting out of sync in only one of the three is
// exactly the shape of bug this fixes (see claude-chat-panel.md's "Comment
// column stays expanded..." section).
function isNewChatUnanchored() {
  return cs.focus === 'new' || (cs.focus === 'claude' && cc.commentId == null)
}
// Reviewer request: the opened-out conversation (the actual transcript,
// including the reviewer's own just-typed message) must stay visible for as
// long as a turn is running for it — even after navigating away to a
// different block/comment, or after explicitly closing the panel (←/Escape/
// the "Sluit" button). hasActiveClaudeTurn() is therefore a THIRD, standalone
// reason to show the column, independent of hasVisibleComments()/
// isNewChatUnanchored() — see "Stay open while a Claude turn is running" in
// claude-chat-panel.md. syncClaudeAnchorForSelection has a matching guard so
// `cc` itself is never re-anchored/reset out from under a running turn.
export function claudeChatVisible() {
  return hasVisibleComments() || isNewChatUnanchored() || hasActiveClaudeTurn()
}

// claudeColumnVisible is the narrower question "does the CLAUDE HALF of that
// merged card render". It differs from claudeChatVisible() in exactly one
// case: while an "algemene" (PR-wide) comment is being written there must be
// no Claude column, because ensureClaudeAnchorForNew would lazily create a
// backing comment ANCHORED on the current diff unit — precisely what a
// general comment is not. The two must stay separate: claudeChatVisible()
// also gates the merged row's own `hidden` class in home.mjs, so returning
// false there would display:none the very composer the reviewer is typing in
// (which silently swallows its focus, too — a display:none element can't take
// DOM focus at all).
export function claudeColumnVisible() {
  return !cs.prWideCompose && claudeChatVisible()
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
    // Blur while an option is highlighted too (claudePos stays 0 through the
    // options rung of the chain, see cs.claudeOptionSel's own doc comment) —
    // the highlighted button, not the empty composer, should read as "focused".
    if (cs.claudePos === 0 && cs.claudeOptionSel === 0) {
      if (input) input.focus()
      scrollClaudeThreadToBottom()
    } else {
      if (input && document.activeElement === input) input.blur()
      if (cs.claudePos === 0) scrollClaudeMessageIntoView0Options()
      else scrollClaudeMessageIntoView()
    }
  })
}

// scrollClaudeMessageIntoView0Options keeps the still-open question's bubble
// in view while an option is highlighted (claudePos === 0, claudeOptionSel >
// 0) — scrollClaudeMessageIntoView itself indexes off cs.claudePos, which
// stays 0 through the whole options rung, so it would resolve to the WRONG
// (newest) DOM node here; the question message is always the actual newest
// one in this state (pendingClaudeQuestion() only ever reads the last
// message), so this is simply "keep the last rendered message in view".
function scrollClaudeMessageIntoView0Options() {
  requestAnimationFrame(() => {
    const nodes = document.querySelectorAll('[data-testid=claude-message]')
    const el = nodes[nodes.length - 1]
    if (el) scrollIntoViewVertical(el)
  })
}

// scrollClaudeThreadToBottom keeps the newest turn in view while the
// reviewer sits at the rest position (cs.claudePos === 0) AND hasn't
// scrolled the pane itself away from the bottom by hand (cs.claudePinned,
// see updateClaudeThreadPinned above — same "manual scroll-up got snapped
// back down" bug as the comment thread's own scrollCommentThreadToBottom).
// Unlike scrollIntoViewVertical (which walks up to an ANCESTOR that
// scrolls), `claude-chat-thread` (ClaudeChat.mjs) is itself the scrolling
// container — so this sets its own scrollTop directly, no ancestor lookup,
// no conflict with the scrollIntoView axis rule in arrowjs-pitfalls.md.
// Called after a send (focusClaudeComposer), after a transcript refetch adds
// a message (loadChatMessages) and while the live progress/partial bubble
// grows (applyChatProgress) — the three moments new content is appended at
// the bottom of that div without anything moving its scroll position on its
// own. A no-op at any other cs.claudePos (walking older turns via ↑ must
// never be yanked back down) or while manually scrolled up —
// jumpToClaudeThreadBottom's own button is the explicit way back down.
function scrollClaudeThreadToBottom() {
  if (cs.claudePos !== 0 || !cs.claudePinned) return
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=claude-chat-thread]')
    if (!el) return
    el.scrollTop = el.scrollHeight
    // A JS-driven scrollTop write isn't guaranteed to fire a native 'scroll'
    // event in every browser, so update the top-fade class directly too (see
    // scrollFade.mjs / "A capped, fading thread" in comments-panel.md) — and,
    // for the same reason, resync claudePinned directly too: otherwise a
    // stale `false` left over from a transient scroll during layout/focus
    // would have nothing to ever flip it back, permanently suppressing this
    // very function.
    updateScrollFade(el)
    updateClaudeThreadPinned(el)
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
    // The last send that never made it to the workflow — '' when there is
    // none. See sendClaudeMessage/sendErrorText.
    sendError: () => cc.sendError,
    claudePos: () => cs.claudePos,
    // Whether the reviewer's OWN mouse/wheel scroll still sits at the bottom
    // of claude-chat-thread — see updateClaudeThreadPinned's own doc comment.
    // ClaudeChat.mjs shows its "scroll to recent" button while this is false
    // (and claudePos is 0, the rest position).
    pinned: () => cs.claudePinned,
    // The still-open question's option highlight (see cs.claudeOptionSel's own
    // doc comment) — 0 while nothing is highlighted.
    claudeOptionSel: () => cs.claudeOptionSel,
    // anchorHint — a short, human sentence naming where THIS conversation's
    // very first turn was sent from (e.g. "Regel 42"), for claudeBubble to
    // show above that one turn. '' when there's nothing to say (no anchor, or
    // the anchor carries no line — a block-level target).
    //
    // The invisible `context` a first turn carries (claudeContextBlock) is
    // never itself rendered in the transcript — only the reviewer's typed
    // text is (see sendClaudeMessage's `body: trimmed`) — so a multi-line
    // Shift+↑/↓ selection left no visible trace of what was actually sent
    // (reported bug). Deliberately anchored on the FIRST line of that
    // selection only (`c.line`, already how ensureClaudeAnchorForNew stores
    // it — see its own doc comment), not the full range: the reviewer
    // explicitly said anchoring on the first line is an acceptable
    // simplification, and Comment carries no separate end-line field of its
    // own to show more than that anyway.
    anchorHint: () => {
      const c = cs.list.find((x) => x.id === cc.commentId)
      if (!c || !c.line) return ''
      return (GRAN_LABEL[c.gran] || 'deze context') + ' · regel ' + c.line
    },
    // The live turn: null when nothing is running. See cc.progress.
    progress: () => cc.progress,
    // The reviewer's own not-yet-sent turns, oldest first — scoped to the
    // conversation in view, since an entry keeps the one it was typed against
    // (see queueClaudeMessage).
    queued: () => cc.queued.filter((q) => q.commentId === cc.commentId),
    // Whether the KEYBOARD is actually sitting in this column right now —
    // reuses the same isClaudeChatFocused() predicate the visibility rules
    // above use. Drives claudeChatColumn's own focus border (see its doc
    // comment in ClaudeChat.mjs): the border must follow cs.focus, not
    // "is a conversation merely shown here for context" (expandedConversation
    // stays expanded while cs.focus === 'claude', but that is NOT this).
    focused: () => isClaudeChatFocused(),
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
// `commentTarget` is the same callback InlineComments/the composer already
// render against — needed here only for ensureClaudeAnchorForNew's lazy
// anchor creation (sendClaudeMessage itself needs no anchor info once one
// exists). There used to be a second `openCommit` parameter (reaching
// home.mjs's command palette for the "Commit wijziging" confirm menu) — gone
// along with that button, see sendClaudeMessage's own doc comment.
// onFocus fires when the Claude composer's `@focus` fires by ANY means — a
// mouse click straight into it (the case that had no keyboard equivalent at
// all), Tab, or the reviewer already being there. Mouse-navigation Rule 1 (a
// click is the Enter/→-equivalent, never its own behaviour) previously had no
// entry for this target: entering the Claude column via `→` from 'comment'
// already flips `cs.focus` to `'claude'` (enterClaudeChat), which is what
// makes the merged comment card expand (commentCard) and is what lets
// applyPendingDraftReplies actually find and fill `reaction-compose`.
// Clicking straight into the already-visible composer of an EXISTING,
// already-anchored conversation (claudeChatVisible() shows it for ANY visible
// comment, regardless of cs.focus — see syncClaudeAnchorForSelection)
// bypassed that entirely: the reviewer could chat with Claude and see the
// "concept in comment-veld gezet" badge with the comment card still collapsed
// and no reaction-compose in the DOM at all for applyPendingDraftReplies to
// write into — a genuinely invisible draft until a SEPARATE click on the
// comment item. Reproduced and fixed after a reviewer bug report with a
// screenshot (an existing thread, reactionCount already > 0).
//
// A no-op once already there (`cs.focus === 'claude'`, the common case: the
// composer keeps focus across an entire turn) — enterClaudeChat itself is
// idempotent, but there is no reason to re-run its ensureAndLoadChat/
// ensureChatEvents/refreshChatShadowWarning side effects on every keystroke's
// implicit refocus.
//
// Deliberately excludes `cs.focus === 'new'` — the still-open, not-yet-placed
// "Comment op deze regel" composer — and does NOT mirror the
// enterClaudeChatFromNew half of handleRelatedKey's ArrowRight branch there.
// Two reasons, both found by a broken regression test, not by inspection:
//   1. Tried calling enterClaudeChat(cs.pr) whenever chatAnchorComment()
//      happens to resolve non-null while cs.focus === 'new' — but
//      chatAnchorComment()'s first branch is selComment() = cs.list[selI()],
//      and `cs.list`/`cs.sel` are NOT reset by toNew() when the reviewer opens
//      a brand-new composer on a line that already carries a DIFFERENT,
//      existing comment: selComment() then still resolves to that unrelated,
//      already-anchored conversation, so this callback would silently swap
//      the visible transcript out from under the fresh 'new' composer the
//      instant the reviewer clicks into the (still correctly empty-rendered)
//      Claude field to type its first message. Broke "a new comment on an
//      already-commented line gets its own comment + Claude block, not the
//      existing one".
//   2. Also tried calling enterClaudeChatFromNew() for the genuinely
//      anchor-less case — but that flips cs.focus to 'claude' the moment the
//      reviewer merely clicks into the Claude field, before ever pressing →.
//      isNewChatUnanchored() then goes false as soon as Claude's first reply
//      lazily creates the anchor, which unmounts the still-open
//      comment-compose composer the reviewer may still be mid-typing in.
//      Broke "placeComment never creates a SECOND comment once this anchor
//      exists" (composing-a-new-comment spec).
// The keyboard's own → still reaches enterClaudeChatFromNew exactly as
// before for both cases; only the already-anchored, cs.focus !== 'new' case
// gets a mouse-click equivalent here.
function onClaudeComposeFocus() {
  if (cs.focus === 'claude' || cs.focus === 'new') return
  if (chatAnchorComment()) enterClaudeChat(cs.pr)
}

function claudeChatCallbacks(state, commentTarget) {
  return {
    onSend: (text) => sendClaudeMessageFromNew(state, commentTarget, text),
    onRetry: () => retryClaudeTurn(),
    onFocus: () => onClaudeComposeFocus(),
    onEmptyEnter: () => openClaudeMenuFromComposer(),
    // The pane's own @scroll handler (see updateClaudeThreadPinned) and its
    // "scroll to recent" button's click handler — both live here, never in
    // ClaudeChat.mjs itself, since that file never imports this one back.
    onThreadScroll: (el) => updateClaudeThreadPinned(el),
    onJumpToBottom: () => jumpToClaudeThreadBottom(),
    // Mouse entry point into claudeChatCommandsFor() ("Wis Claude-gesprek",
    // "Comment hiervan maken", "Probeer de mislukte turn opnieuw") — reuses
    // the exact same opener the composer's own blank-Enter already calls.
    onOpenMenu: () => openClaudeMenuFromComposer(),
  }
}

// claudeMenuOpener is home.mjs's openMenu('claude'), registered once at module
// load (setClaudeMenuOpener) — mirrors replyPublishOpener/
// setReplyPublishMenuOpener exactly, for the same reason: RelatedPanel never
// imports from home.mjs (it would be circular; home.mjs imports THIS module),
// so a cross-module action call goes through a registered callback instead.
let claudeMenuOpener = null
export function setClaudeMenuOpener(fn) {
  claudeMenuOpener = fn
}

// openClaudeMenuFromComposer is ClaudeChat.mjs's own onEmptyEnter callback —
// Enter pressed on a BLANK composer (ClaudeChat.mjs's own @keydown already
// knows this definitively, at the moment of the keypress, before anything
// could mutate the field): open the Claude-column menu directly from here,
// rather than home.mjs's document-level onKeydown re-deriving "was it blank"
// from the DOM after the fact. That re-derivation is exactly what broke: for
// an ORDINARY non-blank send the composer's own handler clears `el.value`
// SYNCHRONOUSLY, in the same event dispatch, before the event ever reaches
// the window-level listener — so by the time that listener could read
// `el.value`, a just-sent real message and a genuinely blank Enter are
// indistinguishable (both read "" ). This callback instead fires only from
// the one call site that already knows the field WAS blank, so no race can
// exist. See "Comment hiervan maken' on an empty Claude input" in
// .claude/docs/claude-chat-panel.md.
function openClaudeMenuFromComposer() {
  if (claudeMenuOpener) claudeMenuOpener()
}

// selectHighlightedClaudeOption — the Enter-key counterpart of clicking a
// claudeQuestionOption button (see the ↑/↓ chain in handleRelatedKey's
// 'claude' branch above): sends whichever option cs.claudeOptionSel is
// currently pointing at, through the exact same path a click already uses
// (sendClaudeMessageFromNew), and resets the highlight. A no-op — returning
// false — when nothing is highlighted (cs.claudeOptionSel === 0) or the
// question the highlight was built against is no longer the pending one
// (answered/superseded meanwhile), so home.mjs's caller can fall through to
// whatever Enter would otherwise do in the Claude column.
export function selectHighlightedClaudeOption(state, commentTarget) {
  if (cs.focus !== 'claude' || cs.claudePos !== 0 || cs.claudeOptionSel === 0) return false
  const q = pendingClaudeQuestion()
  if (!q) return false
  const idx = q.options.length - cs.claudeOptionSel
  const text = q.options[idx]
  if (text == null) return false
  cs.claudeOptionSel = 0
  focusClaudeComposer()
  sendClaudeMessageFromNew(state, commentTarget, text)
  return true
}

// commentFooterText — the comment-side half of CommentClaudeFooter below.
// Generic (not "Bezig met versturen…"): cs.busy also covers deleteFocused-
// Comment/resolveFocusedComment, not only a reply/new-comment send, so a
// send-specific wording would mislabel those. cs.replySent is the one
// send-specific confirmation flash (see sendReaction) and stays worded as
// such. Returns '' when there is nothing to report — the caller hides the
// whole footer in that case.
function commentFooterText() {
  if (cs.busy) return 'Bezig…'
  if (cs.replySent) return 'Verstuurd'
  return ''
}

// hasActiveClaudeTurn — true whenever the currently anchored conversation
// (cc) has a turn in flight: a send/Signal round-trip actually running
// (cc.busy), a live progress snapshot pushed over SSE (cc.progress), or a
// reviewer message waiting in the client-side queue (cc.queued, see
// queueClaudeMessage). Extracted out of what used to be two near-identical
// local closures (hasCommentClaudeFooter's own check and
// CommentClaudeFooter's `claudeActive`) so BOTH "should the full,
// opened-out conversation stay visible" checks below share the exact same
// definition of "a turn is running" — see "Stay open while a Claude turn is
// running" in .claude/docs/claude-chat-panel.md.
export function hasActiveClaudeTurn() {
  return cc.busy || !!cc.progress || cc.queued.length > 0
}

// hasCommentClaudeFooter — true exactly when CommentClaudeFooter itself would
// render a status line (comment side busy/replySent, or a Claude turn
// running/reporting progress). Exported so home.mjs can fold away the whole
// comment-claude-row card (border/bg wrapper around InlineComments +
// ClaudeChatPanel + this footer) when NEITHER a visible conversation/composer
// (claudeChatVisible()) NOR this footer has anything to show — otherwise that
// bordered card still rendered with zero-height content on every line with no
// comments/Claude chat and nothing in flight, showing as a bare thin gray bar
// above Onderliggende code (see .claude/docs/comments-panel.md).
export function hasCommentClaudeFooter() {
  return !!commentFooterText() || hasActiveClaudeTurn()
}

// claudeQueueNote — the Claude half's queue suffix ("· nog 2 berichten in de
// wachtrij"): what the reviewer typed ahead while a turn was running, in words
// (never a colour or a bare count badge, per the colourblind rule). '' when
// nothing is waiting.
function claudeQueueNote() {
  const n = claudeChatView().queued().length
  if (n === 0) return ''
  return ' · nog ' + n + (n === 1 ? ' bericht' : ' berichten') + ' in de wachtrij'
}

// CommentClaudeFooter — ONE shared status line below both the comment and
// Claude columns (comment-claude-row in home.mjs), replacing two former,
// separate status spots: the reaction-status icon that used to sit next to
// "Stuur" in an expanded comment thread (now a plain menu button, see
// expandedConversation), and claudeChatColumn's own inline
// `claude-chat-thinking` paragraph (ClaudeChat.mjs). Full width means room
// for BOTH sides to say what's going on — comment-side and Claude-side are
// independent, own-conditioned halves, so either can show alone. Renders
// nothing at all (not even an empty bar) when neither side has anything to
// report, per "laat weg als het er niks is". Words only, per the colourblind
// rule — the pulsing dot next to each half is decoration on top, same as the
// dot claude-chat-thinking already carried.
//
// `commentId` (optional) additionally makes this footer the log line of a
// COMMENT BATCH run for that one comment (comment_batch.go): while the one agent
// is working on it, the same `claude-chat-status` element shows the same live
// "Claude leest src/x.php" sentence a chat turn shows, and afterwards it keeps
// the one-line outcome ("verwerkt: …" / "overgeslagen: …"). Deliberately this
// existing element rather than a log spot of its own — a batch run IS Claude
// doing something to this comment, and the reviewer asked for the place that
// already exists. Only commentDetailCard passes it (an index/PR-wide comment
// row, the card the reviewer lands on when a batch starts).
export function CommentClaudeFooter(commentId = '') {
  const view = claudeChatView()
  const claudeActive = hasActiveClaudeTurn
  // The batch half's own text: live while this comment is the current one,
  // otherwise its finished note. Both come from the volatile snapshot, so this
  // renders nothing at all for a comment no batch ever touched.
  const batchText = () => {
    if (!commentId) return ''
    const p = batchProgressFor(commentId)
    if (p) return claudeStatusText(p, 0)
    return batchNoteFor(commentId)
  }
  return html`
    <div class="contents">
      ${() =>
        commentFooterText() || claudeActive() || batchText()
          ? html`
              <div
                class="flex w-0 min-w-full flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 dark:border-zinc-800/60 px-3 py-1.5 text-[11px] text-slate-500 dark:text-zinc-500"
                data-testid="comment-claude-footer"
              >
                ${() =>
                  commentFooterText()
                    ? html`<span class="flex items-center gap-1.5" data-testid="comment-claude-footer-comment">
                        <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400"></span>
                        <span class="truncate">${() => commentFooterText()}</span>
                      </span>`
                    : ''}
                ${() =>
                  claudeActive()
                    ? html`<span
                        class="flex min-w-0 flex-1 items-start gap-1.5"
                        data-testid="comment-claude-footer-claude"
                      >
                        <span
                          class="mt-[0.3rem] inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400"
                        ></span>
                        <span
                          class="line-clamp-3 min-w-0 flex-1 [overflow-wrap:anywhere]"
                          data-testid="claude-chat-status"
                        >
                          ${() => claudeStatusText(view.progress(), view.elapsed()) + claudeQueueNote()}
                        </span>
                      </span>`
                    : ''}
                ${() =>
                  batchText()
                    ? html`<span
                        class="flex min-w-0 flex-1 items-start gap-1.5"
                        data-testid="comment-batch-footer"
                      >
                        <span
                          class="${() =>
                            'mt-[0.3rem] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400' +
                            (batchProgressFor(commentId) ? ' animate-pulse' : '')}"
                        ></span>
                        <span
                          class="line-clamp-3 min-w-0 flex-1 [overflow-wrap:anywhere]"
                          data-testid="comment-batch-status"
                        >
                          ${() => batchText()}
                        </span>
                      </span>`
                    : ''}
              </div>
            `
          : ''}
    </div>
  `
}

// ClaudeChatPanel is the exported component home.mjs mounts next to
// InlineComments, in the same inner row of comments-and-related — the same
// width as InlineComments (both half of relatedColumnWidthCls(), see
// commentColumnWidthCls/claudeColumnWidthCls above and detail-layout.md); the
// two merge into one visual card (border/bg on the shared row wrapper in
// home.mjs, `items-stretch` so both columns end up the same height), so this
// column has no padding/border/background of its own any more — see
// claudeChatColumn's own doc comment in ClaudeChat.mjs.
// `state`/`commentTarget` mirror InlineComments' own params (commentTarget is
// only needed for the lazy anchor creation above — an already-anchored
// conversation needs no live cursor info). Wrapped in a stable `contents`
// root — not a bare toggling expression — so the visibility (empty ↔
// template) toggle never corrupts arrow.js's keyed reconcile (the same
// pitfall newCommentComposer/commentCard guard against). Everything that can
// change AFTER this column first mounts lives behind claudeChatView()'s
// getters, read from inside ClaudeChat.mjs's own `${() => ...}` bindings —
// see claudeChatView's doc comment for why a plain snapshot isn't enough
// here.
export function ClaudeChatPanel(state, commentTarget) {
  ensureChatEvents(state.pr)
  const view = claudeChatView()
  const callbacks = claudeChatCallbacks(state, commentTarget)
  const widthKey = () => colWidthKeyFor('claude', commentTarget)
  return html`
    <div class="contents">
      ${() =>
        claudeColumnVisible()
          ? html`<div
              class="${() => 'relative flex min-h-0 flex-col shrink-0 ' + claudeColumnWidthCls()}"
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

// ── Standalone code-preview column ──────────────────────────────────────────
// "code blokken uit comments blok (+claude conversatie) ... losse blokken
// rechts daarvan die de code volledig laten zien ... diff (onder elkaar, oude
// boven, nieuwe onder)". A fenced code block inside a comment/Claude bubble
// (markdown.mjs's extractCodeFences) sits in the narrow comment/Claude column
// and gets its own horizontal scrollbar as soon as a line is wide — this
// column shows the SAME code full-size instead, and — when the fence is PHP
// (or unlabeled, the same default `highlightForLang` already uses) — stacked
// against the CURRENT PR code of whichever unit the comment/Claude panel is
// scoped to ("dat wat niet is in de pr vergelijken met wat er in de chat is
// voorgesteld", the reviewer's own words). See ".claude/docs/
// claude-chat-panel.md", "A full-size code-preview column" for the decisions
// (D1-D4) this implements.
//
// Reviewer follow-up request: "'Bekijk volledig' mag altijd aan, alle
// blokken rechts daarvan laten zien als comment|claude blok zichtbaar zijn" —
// reversing D2/D3. There is no click/open/close cycle any more: every fence
// currently rendered inside the comment/Claude columns (including a
// `suggestion` one, see markdown.mjs's `extractCodeFences`) gets its preview
// shown automatically, stacked in ONE column (the reviewer's own "gestapeld
// in één kolom" answer), for as long as `claudeChatVisible()` holds. A later
// reviewer request moved this column from a sibling to the RIGHT of
// `comment-claude-row` to a stacked row BELOW it (see home.mjs's
// `comments-and-related` and "Always on, stacked BELOW (reversing D3 again)"
// in claude-chat-panel.md) — this module's own state/logic is unaffected,
// only home.mjs's mount point changed.
//
// `cp` mirrors `cc`/`rc`: this module's own reactive state, now a plain
// LIST of previews (never mutated in place — recomputeCodePreviews always
// assigns a fresh array, so a `${() => ...}` reader always sees the latest
// set) — the template itself lives in the sibling pure-template file
// CodePreview.mjs, fed this array through a getter (mirrors ClaudeChat.mjs's
// `view` getters).
const cp = reactive({ items: [] })

// getCommentTarget is set once by CodePreviewPanel (see below) to the same
// live-cursor getter InlineComments/ClaudeChatPanel already receive from
// home.mjs — recomputeCodePreviews needs it every time it reruns (a
// MutationObserver callback, not a template binding), so it can't just be a
// function parameter threaded through like `commentTarget` is everywhere
// else in this file.
let getCommentTarget = () => null

// recomputeCodePreviews — the single place that turns "what's currently
// rendered in the comment/Claude columns" into `cp.items`. Reads the fence
// data straight off the `code-fence` wrapper elements markdown.mjs already
// stamps for every fence, `suggestion` included (data-fence-code/
// data-fence-lang/data-fence-suggestion), rather than re-parsing message
// text — the simplest, already-correct source of "which fences are visible
// right now, in reading order" (DOM/document order = comments column first,
// then the Claude column). This used to read the same two attributes off a
// `code-fence-open` button in each fence header; that dead "Bekijk volledig"
// button is gone (see extractCodeFences' own comment) and the attributes moved
// up to the wrapper.
//
// D4, SHARPENED on explicit request: the "Huidig (PR)"/"Voorgesteld (chat)"
// pair only makes sense for a ```suggestion fence — GitHub's own "replace
// these lines with this" convention, the one case where the fenced code
// really is a proposed replacement for the unit the conversation hangs on.
// For an ORDINARY fence the comparison was misleading: "Huidig (PR)" showed
// whatever line the conversation is anchored to (say a YAML line) next to a
// PHP snippet from the chat, two unrelated things stacked under
// "huidig/voorgesteld" headings. Such a fence now gets ONE pane with just its
// own code (the reviewer explicitly still wants to see that code full-size),
// titled "Codeblok" instead of "Voorgesteld (chat)".
//
// The rest of D4 is unchanged and still applies ON TOP for a suggestion
// fence: PHP (or unlabeled — a suggestion fence never announces a language)
// AND a resolvable current-code unit (oldCode stays `null` for a PR-wide
// comment, which getCommentTarget() itself already returns null for).
//
// `title` is the fence's own "Codeblok N"/"Suggestie N" label
// (data-fence-label), so the card and the inline badge carry the same name —
// a reviewer saying "codeblok 3" means one thing on screen. The language word
// rides along behind it when the fence announced one.
//
// Skips the reassignment when the recomputed set is identical to the
// current one (same length, same code/lang/oldCode per item) — this runs
// off a MutationObserver that also fires on unrelated churn inside the same
// container (e.g. a live Claude turn streaming its partial reply
// character-by-character), and an unconditional reassignment would rebuild
// (and re-highlight) the whole preview column on every one of those, not
// just when a fence actually changed.
function recomputeCodePreviews() {
  if (!claudeColumnVisible()) {
    if (cp.items.length) cp.items = []
    return
  }
  const root = document.querySelector('[data-testid="comment-claude-columns"]')
  // A comment card that isn't currently focused renders `compactConversation`
  // (see its own doc comment), which still runs the body through
  // `commentBody`/`renderMarkdown` — so a fence inside it is present in the
  // DOM (visually clamped via `line-clamp-3`, not actually removed) even
  // while the card is collapsed. Only a fence inside the FOCUSED card
  // (`expandedConversation`, `data-expanded="true"`) — or one with no
  // `comment-item` ancestor at all, i.e. a Claude chat bubble, which has no
  // compact/expanded state — should get a full-size preview here.
  const fences = root
    ? Array.from(root.querySelectorAll('[data-testid="code-fence"]')).filter((el) => {
        const card = el.closest('[data-testid="comment-item"]')
        return !card || card.dataset.expanded === 'true'
      })
    : []
  const t = getCommentTarget()
  const currentCode = t && t.file && t.code ? t.code : null
  const next = fences.map((el, i) => {
    const code = el.dataset.fenceCode || ''
    const lang = el.dataset.fenceLang || ''
    const label = el.dataset.fenceLabel || 'Codeblok'
    const isPhp = !lang || lang.toLowerCase() === 'php'
    const suggestion = el.dataset.fenceSuggestion === 'true'
    return {
      key: 'fence:' + i,
      title: lang ? label + ' · ' + lang.toUpperCase() : label,
      lang,
      code,
      oldCode: suggestion && isPhp ? currentCode : null,
    }
  })
  const unchanged =
    next.length === cp.items.length &&
    next.every(
      (it, i) =>
        it.code === cp.items[i].code &&
        it.lang === cp.items[i].lang &&
        it.title === cp.items[i].title &&
        it.oldCode === cp.items[i].oldCode,
    )
  if (!unchanged) cp.items = next
}

// scheduleRecomputeCodePreviews coalesces a burst of mutations (e.g. every
// character of a streaming Claude reply) into one recompute per animation
// frame, instead of re-scanning the DOM on every single mutation record.
let recomputeScheduled = false
function scheduleRecomputeCodePreviews() {
  if (recomputeScheduled) return
  recomputeScheduled = true
  requestAnimationFrame(() => {
    recomputeScheduled = false
    recomputeCodePreviews()
  })
}

// ensureCodePreviewObserver wires a MutationObserver to the comment/Claude
// COLUMNS container only (`comment-claude-columns`) — deliberately NOT
// `comments-and-related`, the outer stack that also holds this module's own
// CodePreviewPanel (now a sibling row BELOW `comment-claude-row`, see
// home.mjs), so the preview column's own re-renders can never feed back into
// the observer that triggers them. `comment-claude-columns` is always mounted
// (hidden via CSS while empty, see home.mjs's comment-claude-row), but not
// necessarily yet at the time CodePreviewPanel first runs (arrow.js builds
// the template before it's attached to the real DOM) — retried via
// requestAnimationFrame until the container exists, then set up exactly once.
let codePreviewObserver = null
function ensureCodePreviewObserver() {
  if (codePreviewObserver) return
  const root = document.querySelector('[data-testid="comment-claude-columns"]')
  if (!root) {
    requestAnimationFrame(ensureCodePreviewObserver)
    return
  }
  codePreviewObserver = new MutationObserver(scheduleRecomputeCodePreviews)
  codePreviewObserver.observe(root, { childList: true, subtree: true, characterData: true })
  scheduleRecomputeCodePreviews()
}

// CodePreviewPanel(commentTarget) — mounted by home.mjs directly BELOW
// comment-claude-row, inside the same comments-and-related stack (see "A
// full-size code-preview column" in claude-chat-panel.md for exactly where in
// the layout). Wrapped in a stable
// `contents` root, not a bare toggling expression, mirroring
// ClaudeChatPanel's own guard against the arrow.js "bare toggling
// expression" pitfall; the inner list itself is always an array (empty or
// not), never alternating with a scalar, so the single↔array pitfall in
// arrowjs-pitfalls.md doesn't apply either.
export function CodePreviewPanel(commentTarget) {
  getCommentTarget = commentTarget
  ensureCodePreviewObserver()
  return html`<div class="contents">${() => (cp.items.length ? codePreviewColumn(() => cp.items) : '')}</div>`
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
  // 'claude' also needs a comment to hang the conversation on — and, per the
  // strict claudeChatVisible() invariant above, that comment must actually be
  // in the VISIBLE index (comments === 0 means it isn't), otherwise the
  // column wouldn't render at all and cs.focus would restore onto nothing.
  if (want.focus === 'code' && children === 0) return
  if ((want.focus === 'comment' || want.focus === 'thread') && comments === 0) return
  if (want.focus === 'claude' && comments === 0) return
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
//    children, ← always exits straight to the diff (never onto comments,
//    even when the unit has them — explicit request, mirrors Escape); ↑
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
//    turns exactly like 'thread' does (its own claudePos cursor). When the
//    NEWEST turn is a still-open, unanswered question with clickable options
//    (pendingClaudeQuestion()), that cursor grows one extra rung: composer
//    (claudePos 0, claudeOptionSel 0) → the question's own options, bottom to
//    top (claudeOptionSel 1..N, claudePos still 0) → the question bubble
//    itself (claudePos 1, claudeOptionSel back to 0, same as an ordinary
//    turn) → older turns (claudePos 2..). ↑/↓ walk this ONE continuous chain
//    in both directions (reviewer request — not two disjoint modes); Enter
//    while an option is highlighted sends it (selectHighlightedClaudeOption,
//    home.mjs), exactly like clicking it. ↓ at the very bottom
//    (claudePos === 0 && claudeOptionSel === 0) does NOT fall into the
//    Onderliggende-code panel
//    any more (explicit request: that read as an unwanted extra "menu" in the
//    way of continuing to review) — it releases the panel focus and returns
//    the 'advance' sentinel so home.mjs's onKeydown can select the next
//    visible block and step straight into its diff (see
//    advanceToNextBlockFromClaudeChat, home.mjs) — UNCHANGED even when this
//    conversation has no anchor comment yet (reached via enterClaudeChatFromNew
//    below): the still-open composer's typed text stays put in composeDrafts
//    regardless (exitRelated never touches it), so advancing away loses
//    nothing. ← (and Escape) step back directly to the 'comment' level (not
//    to 'thread' — mirrors 'comment'.ArrowRight reaching 'claude' directly) —
//    OR, when this conversation has no anchor yet (cc.commentId == null, see
//    enterClaudeChatFromNew), back to the still-open composer ('new',
//    toNewFocus) instead, since there is no comment to land 'comment' on. →
//    and ↑/↓ elsewhere in the chain reach 'claude' via enterClaudeChat/
//    enterClaudeChatFromNew, not via a case here — see their own doc comments.
export function handleRelatedKey(key) {
  if (key === 'Escape') {
    if (cs.focus === 'claude' && cc.commentId == null) {
      toNewFocus()
      return true
    }
    exitRelated()
    return 'exit'
  }
  if (cs.focus === 'claude') {
    if (key === 'ArrowUp') {
      const q = cs.claudePos === 0 ? pendingClaudeQuestion() : null
      if (q) {
        if (cs.claudeOptionSel < q.options.length) {
          // Still walking the options, bottom to top.
          cs.claudeOptionSel += 1
        } else {
          // Past the topmost option: step onto the question bubble itself,
          // exactly like an ordinary newest turn.
          cs.claudeOptionSel = 0
          cs.claudePos = 1
        }
      } else {
        cs.claudePos = Math.min(cs.claudePos + 1, cc.messages.length)
      }
      focusClaudeComposer()
    } else if (key === 'ArrowDown') {
      if (cs.claudePos === 0 && cs.claudeOptionSel > 0) {
        // Walking the options back down, toward the composer.
        cs.claudeOptionSel -= 1
      } else if (cs.claudePos === 0) {
        // Nothing further within this unit's own chain any more (no
        // Onderliggende-code detour, per the explicit request above) —
        // release the panel focus and let home.mjs advance to the next
        // visible block's diff.
        exitRelated()
        return 'advance'
      } else if (cs.claudePos === 1 && pendingClaudeQuestion()) {
        // Leaving the question bubble back down re-enters its own options,
        // starting from the topmost one (mirrors the ArrowUp path above).
        const q = pendingClaudeQuestion()
        cs.claudePos = 0
        cs.claudeOptionSel = q.options.length
      } else {
        cs.claudePos -= 1
      }
      focusClaudeComposer()
    } else if (key === 'ArrowLeft') {
      if (cc.commentId == null) {
        // Reached via enterClaudeChatFromNew — there is no comment yet to
        // land 'comment' on, so go back to the still-open composer instead.
        toNewFocus()
      } else {
        // Straight back to 'comment' — 'thread' is no longer visited on the
        // way (mirrors 'comment'.ArrowRight reaching 'claude' directly, see
        // TODO 2 in todo-claude-chat-blok.md). toComment() resets threadPos
        // to 0.
        toComment()
      }
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
        // removed enterTrigger). ← (below) is deliberately NOT the mirror of
        // this: it always exits straight to the diff, regardless of codeSel
        // or comments — see its own branch below.
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
      } else {
        // Unconditionally straight to the diff — never onto the comments,
        // even when hasVisibleComments() (unlike ↑ on the first child, just
        // above, which still detours there). Explicit request: ← is "go to
        // the code to the left", not "walk back through the previous stop".
        // Mirrors Escape, which already skipped the comments detour here.
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
    } else if (cs.focus === 'new' && !cs.prWideCompose) {
      // Same one-step jump, but there is no anchor comment yet — see
      // enterClaudeChatFromNew. Never during a PR-wide compose: that column
      // isn't rendered at all (claudeChatVisible) and its lazy anchor comment
      // would be anchored on the diff unit, see cs.prWideCompose.
      enterClaudeChatFromNew()
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

// startPrWideComment opens that same composer for a PR-WIDE ("algemene")
// comment — the `/`-menu's "Algemene comment plaatsen" (PR_COMMANDS,
// home.mjs). Until this existed that menu item ran startComment, i.e. the
// ordinary LINE-comment composer: with a real block selected it silently
// placed a line comment on whatever unit the cursor sat on, and with a
// PR-comment index row selected (they rank first in the sidebar, so often the
// default selection) placeComment's own `b.kind === 'comment'` guard made it
// a silent no-op with an "undefined:undefined" header. A PR-wide comment has
// no file:line by definition, so it takes the anchorless path all the way
// down: no commentTarget, Kind "issue" in placeComment, and the backend's own
// isPRWide branch posts it as a top-level issue comment.
//
// It deliberately reuses toNew() (draft handling, Claude reset, focus) and
// only then flips the flag — toNew clears it, so the order matters.
export function startPrWideComment() {
  toNew(null)
  cs.prWideCompose = true
  // Its own draft identity — draftKeyFor(null) would be '__none__', which a
  // line-comment composer opened with no resolvable target also uses, and the
  // two drafts have nothing to do with each other.
  composeDraftKey = PRWIDE_DRAFT_KEY
  const draft = composeDrafts.get(PRWIDE_DRAFT_KEY)
  if (draft) prefillField('[data-testid=comment-compose]', draft)
}

// PRWIDE_DRAFT_KEY is that identity, shared by the composer's draft
// (composeDrafts), its failed-send badge ('new:' + it, see cs.sendFailed) and
// placeComment's PR-wide branch — one constant so the three can't drift.
const PRWIDE_DRAFT_KEY = '__prwide__'

// isPrWideComposing is the exported read of that flag, so home.mjs/
// BlockList.mjs can hide the pr-index and the block column while a general
// comment is being written (see detail-layout.md). Reading the reactive `cs`
// from inside their bindings is what makes them repaint on the toggle.
export function isPrWideComposing() {
  return cs.prWideCompose
}

// startClaudeChat is the "Chat over deze regel" palette command's own entry
// point (COMMANDS, home.mjs): reviewer request — chat with Claude about a
// line straight away, without first writing/placing a comment. It reuses
// startComment's exact setup (toNew: resets cs.focus to 'new', the comment
// draft state, cc's blank/idle chat state) and then immediately steps the
// keyboard into the Claude composer via enterClaudeChatFromNew, the same
// function the still-open "Comment op deze regel" field's own → reaches —
// so both entry points land in the identical state (an unanchored 'claude'
// focus, comment column still expanded via isNewChatUnanchored()) and every
// existing ←/Escape/send behaviour documented for that state applies
// unchanged.
export function startClaudeChat(commentTargetFn) {
  toNew(commentTargetFn)
  enterClaudeChatFromNew()
}

// startRangeComment is startComment's twin for a Shift-arrow multi-row
// selection in the index/methodes-kolom — "Plaats comment over dit bereik"
// (rangeCommandsFor, home.mjs). It anchors on the CURSOR's own block/method,
// exactly like startComment (commentTargetFn is the ordinary commentTarget()
// callback, untouched) — deliberately NOT the literal first item of the
// selection, since the composer can only ever render under the column
// currently on screen (Reindert's own call, see command-palette.md). `items`
// is the full list of blocks/methods the selection covered at the moment the
// palette item ran; placeComment (rangeCommentPrefix) prepends a short
// "which blocks does this cover" line built from it to the posted body — the
// only way to make the wider scope visible, since a GitHub comment has no
// separate invisible context field the way a Claude turn does.
export function startRangeComment(commentTargetFn, items) {
  toNew(commentTargetFn)
  rangeComposeItems = Array.isArray(items) ? items : []
  cs.rangeCompose = true
}

// startRangeChat is startClaudeChat's twin for the same selection — "Chat met
// Claude over dit bereik". Same anchor (the cursor's own block/method); the
// wider scope reaches Claude instead via claudeContextBlock's own
// cs.rangeCompose branch (claudeRangeContextBlock), sent once on the
// conversation's first turn.
export function startRangeChat(commentTargetFn, items) {
  toNew(commentTargetFn)
  rangeComposeItems = Array.isArray(items) ? items : []
  cs.rangeCompose = true
  enterClaudeChatFromNew()
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

// isCommentOrThreadFocused additionally covers cs.focus === 'thread' (the
// keyboard stepped ↑ into one of the conversation's own replies, see
// handleRelatedKey) — used to gate the Enter command palette so "Bewerk
// bericht" reaches a reply too, mirroring how the comment-index item's own
// Enter-opens-menu already works regardless of its pct thread position (see
// "Enter opens an action menu; → steps into the thread" in
// comments-panel.md).
export function isCommentOrThreadFocused() {
  return (cs.focus === 'comment' || cs.focus === 'thread') && selComment() != null
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

// unresolveFocusedComment is resolveFocusedComment's mirror image: it reopens
// the focused comment's thread through the SAME "reply" Signal, but with
// `action:'unresolve'` instead of `done:true` — the workflow flips the
// read-model status back to "open", stores the "/reopen" trace message (shown
// as a status line, see threadStatusSentinel) and, for a review-diff thread,
// unresolves the conversation on GitHub too.
//
// Only a thread resolved AFTER resolve stopped ending its Execution can be
// reopened: an older one already completed, and a completed Execution can never
// accept a Signal again (see taskCodeCommentWorkflow). The Signal then simply
// fails server-side and the status stays "resolved".
export async function unresolveFocusedComment() {
  const c = selComment()
  if (!c || !c.runId) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', action: 'unresolve' }),
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
    // Same rule, same reason, for WHICH @mentions mean me: the settings.json
    // aliases decide whether a comment lands in the "Mentioned" index section
    // and whether its body highlights, and `cfg` in mentions.mjs is plain
    // non-reactive state too. Cached after the first call.
    await ensureSettings()
    const res = await fetch('/api/comments?pr=' + encodeURIComponent(pr) + repoParam())
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
      // A poll can bring in a new reply on the currently-open thread — keep it
      // pinned to the newest message, mirroring loadChatMessages/
      // scrollClaudeThreadToBottom. A no-op while walking older messages
      // (cs.threadPos !== 0) or with nothing expanded (no [data-testid=
      // comment-thread] mounted).
      scrollCommentThreadToBottom()
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
  // The batch run's volatile per-comment snapshot rides along on the same PR
  // (one read + the SSE push, no poll of its own — see commentBatch.mjs).
  syncCommentBatch(pr)
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
// PR_WIDE_KINDS / isPrWideKind mirror the Go-side isPRWide (comment_import.go)
// — the kinds that carry no file:line anchor at all. Kept as a literal copy
// rather than derived from anything: the backend's list is the contract, and
// the two are asserted against each other by the comment tests.
const PR_WIDE_KINDS = ['issue', 'review_summary', 'review', 'ai_warning']
// lastCreatedCommentId holds the Run ID (== comment id) of the most recent
// successful createComment — see its assignment below.
let lastCreatedCommentId = ''
function isPrWideKind(kind) {
  return PR_WIDE_KINDS.includes(kind)
}

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
  // A PR-wide kind carries no file:line at all (an imported general comment
  // stores File "" too), so only a block-scoped comment must name its file —
  // mirrors handleTaskCodeComment's own validation (tasks_api.go). Requiring
  // it unconditionally is what silently rejected every unanchored comment,
  // including convertPrWideWarningToComment's replacement for a PR-wide AI
  // finding (whose `file` is empty).
  if (pr == null || !body || (!file && !isPrWideKind(kind))) return false
  const token = focusToken
  cs.busy = true
  try {
    let res
    try {
      res = await fetch('/api/workflows/task_code_comment', {
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
    } catch (_) {
      // Network-level failure (offline, etc.) — never let it become an
      // unhandled rejection; the caller only ever checks the boolean result.
      return false
    }
    // The Run ID the POST returns IS the new comment's id (see
    // StartCodeComment) — recorded here so a caller that has to address the
    // fresh comment itself can, without guessing at "the last entry" of a
    // list it doesn't control. Only placeComment's PR-wide branch uses it so
    // far, to land the sidebar selection on the brand-new index row. Parsed
    // best-effort: an unreadable body just leaves it null, never throws.
    lastCreatedCommentId = ''
    if (res.ok) {
      try {
        const j = await res.clone().json()
        lastCreatedCommentId = (j && j.runId) || ''
      } catch (_) {
        /* keep '' */
      }
    }
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
// is nothing to anchor to, or THIS EXACT draft already lazily created its own
// anchor (claudeAutoAnchor, set at the bottom of this function once it runs)
// — the ordinary, already-anchored path then applies unchanged.
//
// Deliberately NOT `chatAnchorComment()`/`selComment()` for that "already
// anchored" check (as it used to be): those resolve to whatever comment is
// currently selected in the scoped list, which is non-null as soon as the
// unit carries ANY existing comment — even one wholly unrelated to this
// brand-new draft. That wrongly skipped creating this draft's own anchor and
// made it silently continue/reply onto that unrelated conversation instead of
// getting a comment + Claude block of its own. `claudeAutoAnchor`'s own
// draftKey match is precise: it is only ever set here, for this draft.
async function ensureClaudeAnchorForNew(state, commentTarget) {
  // isNewChatUnanchored(), not a bare cs.focus === 'new': the reviewer's
  // first real send often happens FROM the Claude composer itself
  // (enterClaudeChatFromNew already flipped cs.focus to 'claude' by the time
  // "Stuur" is clicked), and a bare 'new' check here made that send a silent
  // no-op — no anchor ever got created, so cc.runId stayed empty and
  // sendClaudeMessage's own `if (!cc.runId) return` swallowed the click. See
  // "A send from the Claude composer never created its anchor" in
  // claude-chat-panel.md.
  if (!isNewChatUnanchored()) return null
  const t = warningOverride ? warningOverride.target : (commentTarget && commentTarget()) || null
  if (claudeAutoAnchor && claudeAutoAnchor.draftKey === draftKeyFor(t)) return null
  const b = state && state.blocks && state.blocks[state.selected]
  if (!b || b.kind === 'comment') return null
  const el = document.querySelector('[data-testid=comment-compose]')
  const typed = el && el.value.trim()
  const ok = await createComment({
    pr: state.pr,
    repo: repoField(),
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
  // A turn typed while an earlier one is still running only gets queued (see
  // queueClaudeMessage) — no anchor step needed, since a running turn means
  // this conversation is already anchored. Placed before the anchor step so
  // "doorpraten" never triggers a second lazy comment creation.
  // No selection context on a queued turn: a running turn means this is never
  // the conversation's FIRST turn, which is the only one that carries one
  // (claudeContextBlock) — and it would go stale anyway by the time this is
  // actually sent.
  if (cc.busy && !action) return queueClaudeMessage(text)
  const c = await ensureClaudeAnchorForNew(state, commentTarget)
  if (c) await ensureAndLoadChat(state.pr, c.id)
  await sendClaudeMessage(text, action, claudeContextBlock(commentTarget))
}

// placeComment submits the composer's text as a comment on the current unit.
// Exported so the comment-kind menu (home.mjs COMPOSE_COMMANDS) can place a
// private note via opts.local; the composer button routes through the menu too.
//
// The keyboard goes back to the diff (exitRelated) IMMEDIATELY, before the
// POST + GET round-trip below even starts — an explicit, optimistic-UI
// product decision (Reindert: "als ik een comment plaats, wil ik naar de
// code diff — direct, al voordat het echt is opgeslagen"). This used to wait
// for a successful createComment first; now the exit happens synchronously,
// so there is no window in which a later, unrelated navigation could race
// with it (see the focusToken doc comment for what that race used to look
// like) — everything that still runs AFTER the await below (composeDrafts
// cleanup, the AI-finding replacement's delete, cs.sel landing inside
// createComment itself) is pure background bookkeeping for a panel the
// reviewer has, by definition, already left. Regression test:
// tests/comment-nav-race.spec.mjs (now passes structurally rather than via
// the token-guard timing it originally exercised).
//
// A failed save is easy to miss once the reviewer has already moved on, so a
// failure marks cs.sendFailed (see its own doc comment) instead of vanishing
// silently — surfaced as a small badge (sendFailedBadge) wherever this draft
// resurfaces: reopening "+ Nieuwe comment" on the same unit, or, for the
// claudeAutoAnchor branch below, the resulting thread itself. The typed text
// itself is NOT lost either way: composeDrafts already only gets cleared on
// success (unchanged), so reopening the composer on the same unit restores it.
//
// `warningOverride`, if set (see convertWarningToComment), forces the anchor
// to the AI finding's OWN file/label/gran/rowStart/rowEnd/code instead of
// commentTarget()'s current-cursor unit — the reviewer may have navigated
// elsewhere within the block since choosing "Comment hiervan maken", and the
// replacement comment must land exactly where the finding itself was, not
// wherever the cursor happens to sit now. It's consumed (nulled) right away,
// before the async createComment call, mirroring every other "capture once,
// before the await" convention in this file — a second, unrelated "+ Nieuwe
// comment" started while this one is still in flight must never see a stale
// override.
//
// rangeCommentPrefix builds the short "which blocks does this cover" line
// prepended to a range-scoped comment's body (startRangeComment) — capped at
// a handful of names so a very large selection doesn't turn the actual
// reviewer text into an afterthought below a wall of labels.
function rangeCommentPrefix(items) {
  const MAX_LISTED = 5
  const names = items.slice(0, MAX_LISTED).map((b) => b.label || b.file || '?')
  let list = names.join(', ')
  if (items.length > MAX_LISTED) list += ` en ${items.length - MAX_LISTED} meer`
  return `_Comment over ${items.length} ${items.length === 1 ? 'blok' : 'blokken'}: ${list}_\n\n`
}
export async function placeComment(state, commentTarget, opts = {}) {
  const b = state && state.blocks && state.blocks[state.selected]
  const el = document.querySelector('[data-testid=comment-compose]')
  let body = el && el.value.trim()
  if (!body) return
  // A range-scoped compose (startRangeComment, "Plaats comment over dit
  // bereik") still anchors on ONE block below (the cursor's own, via
  // commentTarget() — untouched) — this is what makes the wider scope
  // visible in the posted text itself, since a GitHub comment has no
  // separate invisible context field the way claudeContextBlock's Signal
  // has. Consumed (nulled) right away, mirroring warningOverride/
  // claudeAutoAnchor below, before either the PR-wide branch or the
  // ordinary anchor path reads `body`.
  if (cs.rangeCompose && rangeComposeItems.length) body = rangeCommentPrefix(rangeComposeItems) + body
  cs.rangeCompose = false
  rangeComposeItems = []
  // A PR-WIDE ("algemene") comment is deliberately handled BEFORE the guards
  // below: it has no block and no unit by definition, so `b` may be missing
  // or be a comment-index item and neither disqualifies it. It writes through
  // the same createComment/workflow path as every other comment, only with
  // Kind "issue" (the same Kind an imported general PR comment gets) and no
  // anchor at all — which is exactly what turns it into a navigable
  // "PR-comments" index row (prWideComments/commentBlockItem) instead of an
  // invisible line comment. See startPrWideComment.
  if (cs.prWideCompose) {
    el.value = ''
    const key = 'new:' + PRWIDE_DRAFT_KEY
    exitRelated() // optimistic exit, and it restores the hidden columns
    const ok = await createComment({
      pr: state.pr,
      repo: repoField(),
      file: '',
      line: 0,
      body,
      kind: 'issue',
      local: !!opts.local,
    })
    if (ok) {
      composeDrafts.delete(PRWIDE_DRAFT_KEY)
      clearSendFailed(key)
      // Land the sidebar selection on the brand-new index row. It is
      // populated by the comment list, not by loadBlocks, so it may not exist
      // for another tick — blockRefPending is exactly the existing
      // "resolve this comment ref as soon as it turns up" retry
      // (applyCommentRefRestore, home.mjs), reused rather than duplicated.
      if (lastCreatedCommentId && commentSelectRequest) commentSelectRequest(lastCreatedCommentId)
    } else {
      markSendFailed(key)
      composeDrafts.set(PRWIDE_DRAFT_KEY, body)
    }
    return
  }
  // A synthetic comment-index item (kind:'comment', see home.mjs's
  // recomputeLeftList/commentBlockItem) has no file/line of its own to anchor
  // a NEW block-scoped comment to — the block palette isn't reachable while
  // one is selected (see selectedComment in home.mjs), so ordinarily this
  // composer should never even open while `state.selected` still points at
  // one. But `warningOverride` (see convertWarningToComment) is exactly the
  // one legitimate exception: `prCommentCommandsFor`'s "Comment hiervan
  // maken" on a line-anchored comment-index item (commentBlockItem's
  // b.lineAnchored) opens THIS composer without ever selecting the real
  // block it hangs on — it stays drilled behind the sidebar row instead (see
  // .claude/docs/comments-panel.md's "Converting an AI-controle finding..."),
  // so `b` here is still the synthetic item. The override already carries a
  // full, independent anchor (file/label/gran/rowStart/rowEnd/code), so `b`
  // isn't needed for anchoring in that case — only bail when there is
  // neither a real block NOR an override to anchor on.
  if (!warningOverride && (!b || b.kind === 'comment')) return
  const override = warningOverride
  warningOverride = null
  // Capture the exact unit the composer is previewing so the placed comment's
  // thread can show the same code (see composeTargetHint / the thread hint).
  // commentTarget() follows focusedBlock() (the column that currently owns the
  // diff keyboard), which may be a drilled column rather than the top-level
  // selected block `b` — so t.file/t.startLine (not b.file/b.line) are the
  // ones that must anchor the comment when a drilled column is focused.
  const t = override ? override.target : (commentTarget && commentTarget()) || null
  const draftKey = draftKeyFor(t)

  // A Claude message already lazily created the ONE backing comment for this
  // exact draft (see ensureClaudeAnchorForNew) — "Plaats…" must not start a
  // SECOND Execution next to it. There is no "edit body" Signal (a comment's
  // body is fixed at Execution start), so "updating" it means posting the
  // reviewer's own typed text as a reply on that same thread — the same
  // Signal an ordinary thread reply (sendReaction) already uses — instead of
  // creating a new one. The anchor's own local-ness (fixed at creation,
  // always private, see ensureClaudeAnchorForNew) wins over opts.local here:
  // chatting with Claude first already made this a private thread.
  if (claudeAutoAnchor && claudeAutoAnchor.draftKey === draftKey) {
    claudeAutoAnchor = null
    const c = chatAnchorComment()
    if (c && c.runId) {
      composeDrafts.delete(draftKey)
      el.value = ''
      exitRelated()
      cs.busy = true
      try {
        let res
        try {
          res = await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ author: 'reviewer', body, done: false }),
          })
        } catch (_) {
          res = null
        }
        if (res && res.ok) {
          clearSendFailed('reply:' + c.id)
          await loadComments(state.pr)
        } else {
          markSendFailed('reply:' + c.id)
          replyDrafts.set(c.id, body)
        }
      } finally {
        cs.busy = false
      }
      return
    }
  }

  // cs.pendingComment — the optimistic local echo (see its own doc comment
  // above): set right before the exit/POST so the reviewer's own message is
  // visible immediately, in the same spot the real compact card will take
  // over in once loadComments (inside createComment) brings it in. `at`
  // guards the clear below against a LATER placeComment call already having
  // started its own pending echo by the time this one's await resolves.
  const pendingAt = Date.now()
  cs.pendingComment = {
    file: (t && t.file) || b.file,
    label: (t && t.label) || b.label,
    rowStart: t ? t.rowStart : -1,
    rowEnd: t ? t.rowEnd : -1,
    gran: t ? t.gran : '',
    seg: t ? t.seg : '',
    body,
    at: pendingAt,
  }

  el.value = ''
  exitRelated()

  const ok = await createComment({
    pr: state.pr,
    repo: repoField(),
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
  if (cs.pendingComment && cs.pendingComment.at === pendingAt) cs.pendingComment = null
  // The typed text just became a real, placed comment — the draft that was
  // standing in for it (see composeDrafts above) has nothing left to hold.
  // A failed placement instead marks cs.sendFailed and KEEPS the draft, so
  // the reviewer can reopen the composer on this unit and retry.
  if (ok) {
    composeDrafts.delete(draftKey)
    clearSendFailed('new:' + draftKey)
  } else {
    markSendFailed('new:' + draftKey)
  }
  // Only delete the AI finding this comment replaces once the replacement
  // itself is confirmed placed — a failed POST must never discard the
  // finding without anything taking its place.
  if (ok && override && override.original) {
    await deleteComment(override.original)
    await loadComments(state.pr)
  }
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

// activeComposeTargetHint resolves what composeTargetHint should show right
// now, so home.mjs can render ONE copy of it spanning the FULL width of the
// merged comment+Claude card (comment-claude-row) instead of the two former
// call sites confined to the comment column's own half-width (inside
// newCommentComposer / expandedConversation, both removed) — the code
// preview is about the shared anchor, not just the comment side. Priority:
// the open new-comment composer's own target (warningOverride's anchor, or
// the live cursor) while composing; otherwise the currently expanded
// existing conversation's own anchor (gran/label/code); else null (nothing
// to show, e.g. while just browsing compact cards or the Onderliggende-code
// panel).
//
// The first branch is `isNewChatUnanchored()` (its FOURTH call site, see the
// function's own doc comment), not a bare `cs.focus === 'new'`: reaching the
// Claude composer via `enterClaudeChatFromNew` with no anchor comment yet
// (`cs.focus === 'claude' && cc.commentId == null`) is the exact same
// "nothing placed yet, show the live cursor's target" state as `'new'`
// itself. The second branch now ALSO covers `cs.focus === 'claude'` once it
// IS anchored (`chatAnchorComment()` resolves to the same `selComment()` this
// reads) — reported bug: navigating → from a commented line into its Claude
// conversation dropped the code card, because this function had never grown
// a 'claude' branch even though the anchor comment (and its code) is exactly
// as available there as in 'comment'/'thread' focus.
export function activeComposeTargetHint(commentTarget) {
  if (isNewChatUnanchored()) {
    return warningOverride ? warningOverride.target : commentTarget ? commentTarget() : null
  }
  if (cs.focus === 'comment' || cs.focus === 'thread' || cs.focus === 'claude') {
    const c = selComment()
    if (c && c.code) return { gran: c.gran, label: c.label, code: c.code }
  }
  return null
}

// sendReaction posts the typed text as a plain (non-resolving) reply — the
// resolve variant (done:true) that used to live here moved to the
// comment-scoped command menu's "Resolve comment" item (resolveFocusedComment
// below), which always sends the fixed "/resolve" sentinel instead of
// whatever happened to be typed — see the reaction-status button in
// expandedConversation for how resolve stays mouse-reachable now.
// --- Publishing a local thread to GitHub ------------------------------------
//
// A thread starts local in two ways: the reviewer placed it as "Alleen voor
// mijzelf" (createComment with local:true) or it IS an AI finding (source
// 'ai', always local — see code_warning.go). Such a thread has no GitHub root,
// so the backend mirrors nothing at all (the RootID === 0 guard in
// taskCodeCommentWorkflow). Replying to one therefore asks first what may
// become public, instead of silently staying private forever: the send opens
// the 'replyPublish' menu (home.mjs) and the chosen item calls
// sendPendingReply, which repeats the very same send with a `publish` flag on
// the Signal.
//
// "Is this a GitHub chat now?" needs no new state anywhere: the backend
// records the GitHub root id on the comment (github_id → `c.githubId`), so a
// non-zero githubId means every following reply mirrors on its own and the
// menu simply stops appearing — that is the whole "once it's a GitHub chat,
// the next messages go to GitHub too" rule.

// isLocalComment reports whether `c` is a thread that never reached GitHub: no
// GitHub root id of its own, and not github-SOURCED either (a thread written
// on GitHub in the first place can never be local, even if its id never made
// it into our read-model). Deliberately also true for a post that FAILED
// earlier — githubId stayed 0, so it is, factually, still only local.
//
// The single definition of "local" on the frontend: needsPublishChoice (the
// reply-publish menu) and commentActivitySummary (the per-line note glyph)
// both go through it. The backend has the matching rule for the pr-overview
// comment badge (`Source != "github"`, workflows.go).
export function isLocalComment(c) {
  return !!c && !c.githubId && (c.source || 'ui') !== 'github'
}

// needsPublishChoice reports whether replying to `c` should ask the publish
// question first: only while the thread has no GitHub root of its own — i.e.
// exactly while it is still local.
export function needsPublishChoice(c) {
  return isLocalComment(c)
}

// localLocalReplyCount counts the reviewer's OWN replies in `c` that never
// reached GitHub — the "eerdere berichten" a publish can optionally bring
// along (ReactionSignal.PublishHistory). AI/system notes are excluded: they
// are never mirrored. Used only for the menu labels, so it may be a plain
// synchronous read.
export function localReplyCount(c) {
  if (!c || !c.reactions) return 0
  return c.reactions.filter((r) => (r.source || 'ui') === 'ui' && !r.githubId).length
}

// pendingPublish holds the send that is waiting on the publish menu's answer:
// which thread, which reply field it came from ('thread' = the block-scoped
// conversation, 'prwide' = the PR-comment detail card), and the typed body
// ('' when the menu was opened without any new reply — see publishThreadOnly).
// A plain (non-reactive) object read once by the menu at open time, exactly
// like the snapshotCommands convention in home.mjs.
let pendingPublish = null

// replyPublishOpener is home.mjs's openMenu('replyPublish'), registered once
// at module load (setReplyPublishMenuOpener). RelatedPanel never imports from
// home.mjs — the dependency only runs the other way — so the opener is handed
// down, the same way InlineComments already receives openCommentMenu.
let replyPublishOpener = null

export function setReplyPublishMenuOpener(fn) {
  replyPublishOpener = fn
}

// commentSelectRequest is the same downward-injected callback shape for "put
// the sidebar selection on this comment's own index row" — home.mjs owns
// state.selected and the blockRefPending retry that waits for a row the
// comment poll has yet to produce, and this module never imports from it.
// Only placeComment's PR-wide branch uses it so far.
let commentSelectRequest = null

export function setCommentSelectRequest(fn) {
  commentSelectRequest = fn
}

// pendingPublishInfo exposes the waiting send to home.mjs so the menu can
// name what it is about (an AI finding vs the reviewer's own note, and how
// many earlier local replies there are).
export function pendingPublishInfo() {
  if (!pendingPublish) return null
  const c = commentById(pendingPublish.commentId)
  return {
    ...pendingPublish,
    source: c ? c.source || 'ui' : 'ui',
    localReplies: localReplyCount(c),
  }
}

// openPublishMenu holds the send and opens the choice menu — deliberately a
// FRAME LATER. Both reply fields open it from their own Enter handler, and that
// keydown keeps bubbling to home.mjs's document-level handler; opening the menu
// synchronously would make that same keystroke immediately run the menu's
// default item ("Alleen voor mijzelf"), so the reviewer would never see the
// question at all. By the next frame the keydown is long over, and the global
// handler saw a closed menu plus a non-empty reply field, which is a no-op
// there.
function openPublishMenu(info) {
  pendingPublish = info
  requestAnimationFrame(() => {
    if (replyPublishOpener) replyPublishOpener()
  })
}

function commentById(id) {
  return cs.list.find((c) => c.id === id) || null
}

// sendPendingReply performs the send the publish menu was asked about.
// `publish` is '' (keep it local, the default item), 'reply' (only the typed
// answer goes public, as the thread's new GitHub root) or 'thread' (the
// comment/finding itself goes public too); `withHistory` additionally mirrors
// the earlier local replies. Consumes pendingPublish before the first await,
// per this file's "capture once, before the await" convention — a second menu
// must never act on a stale snapshot.
export async function sendPendingReply(publish, withHistory) {
  const p = pendingPublish
  pendingPublish = null
  if (!p) return
  const c = commentById(p.commentId)
  if (!c) return
  if (p.kind === 'prwide') {
    await postPrCommentReply(c, p.body, publish, withHistory)
    return
  }
  await postThreadReply(c, p.body, publish, withHistory)
}

// publishThreadOnly moves an existing local conversation to GitHub without
// adding a message to it — the reviewer pressing Enter on an EMPTY reply field
// and picking "Zet op GitHub" from the comment menu (see commentCommandsFor/
// prCommentCommandsFor in home.mjs). `withHistory` decides whether the earlier
// local replies go along; the root (an AI finding gets its attribution quote
// backend-side) always does — there would be nothing to publish otherwise.
// Rides the same "reply" Signal as everything else, with Action "publish", so
// nothing is stored as a new reply.
export async function publishThreadOnly(c, withHistory) {
  if (!c || !c.runId) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', action: 'publish', publishHistory: !!withHistory }),
    })
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

async function sendReaction() {
  const c = selComment()
  if (!c) return
  const el = document.querySelector('[data-testid=reaction-compose]')
  const body = el && el.value.trim()
  if (!body) return
  // A pure, still-unedited Claude draft (see applyPendingDraftReplies' fourth
  // rule) skips the publish-choice menu entirely — Reindert's explicit
  // request: a comment generated from the chat should go straight to GitHub
  // on Enter, not through one more menu. `publish: 'reply'` specifically (not
  // 'thread'): only Claude's generated text becomes the new public GitHub
  // comment, the thread's own local root (often still the
  // CLAUDE_ANCHOR_PLACEHOLDER body, see chat_workflow.go) stays local, never
  // published without the reviewer's own say-so. Consumed once, so a later
  // reply on the same thread (once it has its own edits) goes through the
  // ordinary flow again.
  if (pureChatDraftReplyIds.has(c.id) && needsPublishChoice(c)) {
    pureChatDraftReplyIds.delete(c.id)
    await postThreadReply(c, body, 'reply', false)
    return
  }
  // A thread that has never touched GitHub asks first what may go public —
  // see openPublishMenu / sendPendingReply.
  if (needsPublishChoice(c)) {
    openPublishMenu({ kind: 'thread', commentId: c.id, body })
    return
  }
  await postThreadReply(c, body)
}

// postThreadReply is sendReaction's actual write half, split out so the
// publish menu (sendPendingReply) can reuse the exact same POST + tail after
// the reviewer picked what may reach GitHub. `publish`/`withHistory` ride
// along on the same "reply" Signal (see ReactionSignal.Publish in
// workflows.go); the ordinary, already-public path passes neither.
//
// The keyboard goes back to the diff (exitRelated) IMMEDIATELY, before the
// Signal POST + GET below even starts — the same optimistic-exit decision as
// placeComment (see its doc comment), extended to a reply on purpose:
// Reindert explicitly confirmed the thread should close on every reply now,
// reversing the earlier deliberate "this thread stays open after a reply"
// choice (a bare-Enter reply was the one send-status spot where "sent" was
// actually visible — that reasoning no longer applies). cs.replySent's brief
// flash still fires: commentFooterText() reads it regardless of cs.focus, so
// it's still visible in the shared comment/Claude footer for as long as the
// reviewer happens to still be looking at this unit.
//
// A failed send marks cs.sendFailed('reply:'+c.id) (see its own doc comment)
// instead of vanishing silently, and restores the typed text into
// replyDrafts (normally only cleared on success) so reopening this thread
// recovers it.
async function postThreadReply(c, body, publish, withHistory) {
  const el = document.querySelector('[data-testid=reaction-compose]')
  if (el) {
    el.value = ''
    resetTextareaHeight(el)
  }
  exitRelated()
  cs.busy = true
  try {
    let res
    try {
      res = await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: 'reviewer',
          body,
          done: false,
          ...(publish ? { publish, publishHistory: !!withHistory } : {}),
        }),
      })
    } catch (_) {
      res = null
    }
    if (res && res.ok) {
      // The typed reply went out — the draft standing in for it (see
      // replyDrafts above) has nothing left to hold.
      replyDrafts.delete(c.id)
      clearSendFailed('reply:' + c.id)
      cs.replySent = true
      setTimeout(() => {
        cs.replySent = false
      }, 1200)
      await loadComments(cs.pr)
    } else {
      markSendFailed('reply:' + c.id)
      replyDrafts.set(c.id, body)
    }
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

// blockWideBadge marks a comment anchored on a stand-in row (Comment.
// BlockWide, see its own doc comment/comments.go): the finding is genuinely
// about the WHOLE block, not specifically the row it happens to hang off (its
// RowStart/RowEnd point at the block's first changed row only so the index/💬
// marker have somewhere to attach). Without this label a reviewer would read
// it as being about that one row, which is misleading — the row is a
// placeholder, not the actual subject. Word-first per the colorblind rule (no
// color-only signal): a small map/layers glyph plus explicit text. Returns ''
// for anything else (mirrors sourceBadge/aiWarningBadge's shape).
function blockWideBadge(c) {
  if (!c || !c.blockWide) return ''
  return html`<span
    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
    data-testid="comment-block-wide"
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
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
      <rect x="14" y="14" width="7" height="7"></rect>
    </svg>
    Geldt voor het hele blok</span
  >`
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

// commentFileChip names the file (and, when it has one, the line) a comment is
// about, in the detail card's header. Added for the PR-wide AI risk findings
// (kind "ai_warning", see anchoredWarning in code_warning.go): such a finding
// could not be pinned to a block, so nothing else on the card says WHERE it was
// about — while the file/line the model named is stored on the comment all
// along. Generic over every kind rather than special-cased on "ai_warning": a
// path is just as useful on an orphaned or imported PR-wide comment, and a
// block-anchored comment's own card is the one place its file isn't repeated
// anywhere else either. Empty file (a genuinely PR-wide issue comment) → no
// chip at all.
function commentFileChip(c) {
  if (!c || !c.file) return ''
  const text = truncateMiddle(c.file) + (c.line > 0 ? ':' + c.line : '')
  return html`<span
    class="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400"
    data-testid="comment-detail-file"
    title="${c.file + (c.line > 0 ? ':' + c.line : '')}"
    >${text}</span
  >`
}

// markSendFailed/clearSendFailed — write cs.sendFailed (see its own doc
// comment above, next to cs's declaration). Reassigned wholesale so the
// reactive read re-triggers, same convention as state.ignoredComments.
function markSendFailed(key) {
  cs.sendFailed = { ...cs.sendFailed, [key]: true }
}
function clearSendFailed(key) {
  if (!cs.sendFailed[key]) return
  const next = { ...cs.sendFailed }
  delete next[key]
  cs.sendFailed = next
}

// sendFailedBadge marks a comment/reply/not-yet-placed comment whose most
// recent save attempt failed — see cs.sendFailed's own doc comment for why
// this needed adding: the reviewer's keyboard already left for the diff by
// the time the fetch settles, so a silently swallowed failure would be very
// easy to miss. The word carries the meaning, the amber tint only decorates
// it on top — same rule as staleAnchorBadge right above.
function sendFailedBadge(key, label) {
  if (!cs.sendFailed[key]) return ''
  return html`<span
    class="inline-flex shrink-0 items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
    data-testid="comment-send-failed"
    >${label || 'verzenden mislukt — probeer opnieuw'}</span
  >`
}

// editState is the ephemeral "which own message is being edited right now"
// cursor — mirrors picm's own commentId-scoping reasoning (a bare boolean
// would reveal an editor on every bubble at once, since several conversations/
// bubbles can be mounted side by side — the selected card and the look-ahead
// preview, or several comment-index items). `commentId` names the thread the
// edited message belongs to (needed to build the reply Signal's endpoint,
// `c.runId`); `targetId` is what ReactionSignal.ID means under Action "edit" —
// the thread's own run id for the root/opening message, or an existing
// reply's own reaction id (see editTargetId below). Reached primarily via the
// Enter command palette's "Bewerk bericht" item (commentCommandsFor/
// prCommentCommandsFor in home.mjs, using focusedThreadMessage/
// focusedPrThreadMessage below) — a click on the same message's own edit
// button runs the exact same startEditMessage, per the "click runs the same
// function a key runs" rule in .claude/docs/mouse-navigation.md.
const editState = reactive({ commentId: null, targetId: null, busy: false })

// isOwnMessage mirrors home.mjs's isOwnComment, but for one THREAD MESSAGE
// (the shape threadMessages() returns: {source, author, ...}) rather than a
// whole comment row — so it gates the edit affordance identically for the
// root/opening message and any later reply. Deliberately duplicated rather
// than imported: home.mjs imports FROM RelatedPanel.mjs, never the reverse,
// and the check itself is three lines.
export function isOwnMessage(msg) {
  if (!msg) return false
  if (!msg.source || msg.source === 'ui') return true
  return msg.source === 'github' && !!meLogin() && msg.author === meLogin()
}

// editTargetId maps a thread message back to the id ReactionSignal.ID must
// carry for Action "edit": the run id itself for the synthetic opening
// message threadMessages() builds (see its own doc comment — it carries no
// real reaction id of its own), or the reply's own real reaction id otherwise.
function editTargetId(c, msg) {
  if (!c || !msg) return null
  return msg.id === 'origin:' + c.id ? c.id : msg.id
}

// isEditingMessage/startEditMessage/cancelEditMessage/sendMessageEdit drive
// the inline editor a bubble swaps to (see reactionBubble/editingBubble
// below).
export function isEditingMessage(c, msg) {
  return !!c && !!msg && editState.targetId === editTargetId(c, msg)
}

// startEditMessage opens the inline editor on msg (a no-op for a foreign/AI
// message — isOwnMessage gates it here too, not just in the palette/button
// that call it, so a stray direct call can never open an editor on a message
// that isn't the reviewer's own). Prefills the field with the message's
// current (raw, pre-markdown) body, mirroring startPrCommentConvert's own use
// of prefillField.
export function startEditMessage(c, msg) {
  if (!c || !msg || !isOwnMessage(msg)) return
  editState.commentId = c.id
  editState.targetId = editTargetId(c, msg)
  prefillField('[data-testid=message-edit-compose]', msg.body || '')
}

export function cancelEditMessage() {
  editState.commentId = null
  editState.targetId = null
}

// sendMessageEdit posts the "edit" Action of the reply Signal (see
// ReactionSignal's own doc comment in workflows.go) — overwrites an
// already-placed message's own body in place, mirrored to GitHub
// (best-effort) when that message was posted there. Reuses the exact same
// endpoint every other reply already posts to; only the request body's shape
// differs (action + targetId instead of a plain reply/done).
async function sendMessageEdit(c) {
  if (!c || !c.runId || editState.commentId !== c.id) return
  const el = document.querySelector('[data-testid=message-edit-compose]')
  const body = el && el.value.trim()
  if (!body) return
  const targetId = editState.targetId
  editState.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body, action: 'edit', targetId }),
    })
    cancelEditMessage()
    await loadComments(cs.pr)
  } finally {
    editState.busy = false
  }
}

// focusedThreadMessage returns the block-scoped thread message currently
// under the keyboard — the bubble at cs.threadPos while stepped into the
// thread (cs.focus === 'thread', same index math as reactionBubble's own
// `active` check), or the root/opening message at rest (cs.focus ===
// 'comment', where no single bubble is highlighted — see handleRelatedKey)
// — matching what "Resolve comment"/"Verwijder comment" already treat as
// "the comment" at that position. Used by the Enter command palette's
// "Bewerk bericht" item (commentCommandsFor, home.mjs).
export function focusedThreadMessage() {
  const c = selComment()
  if (!c) return null
  const msgs = threadMessages(c)
  if (msgs.length === 0) return null
  if (cs.focus === 'thread') {
    return msgs[msgs.length - cs.threadPos] || null
  }
  return msgs[0]
}

// focusedPrThreadMessage is focusedThreadMessage's comment-index sibling,
// walking pct (this item's own thread cursor, see enterPrCommentThread)
// instead of cs.focus/cs.threadPos. pct.pos === 0 is the rest position (no
// bubble highlighted, mirrors cs.focus==='comment' above) and also resolves
// to the root/opening message.
export function focusedPrThreadMessage(c) {
  if (!c) return null
  const msgs = threadMessages(c)
  if (msgs.length === 0) return null
  if (pct.commentId === c.id && pct.pos > 0) {
    return msgs[msgs.length - pct.pos] || null
  }
  return msgs[0]
}

// editPencilIcon is the small inline "edit" affordance next to a bubble's own
// author line — same pencil path sendStatusIcon's 'draft' state already
// draws, factored out so the two never drift into slightly different icons.
function editPencilIcon() {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="h-3 w-3"
    aria-hidden="true"
  ><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`
}

// editingBubble replaces a bubble's normal content while it is being edited
// (isEditingMessage) — a plain uncontrolled textarea (prefilled imperatively
// by startEditMessage/prefillField, never a reactive `.value=` binding, per
// the existing convention every other composer field in this file follows)
// plus Opslaan/Annuleer. Enter sends (Shift+Enter is a newline, same
// convention as every other composer here); Escape cancels AND hands the
// keyboard back to whichever cursor owns this comment, landing on the block/
// item itself rather than leaving it stuck mid-thread — see "Editing an own
// message" in .claude/docs/comments-panel.md.
function editingBubble(c, msg) {
  const mine = msg.source === 'ui'
  return html`
    <div class="${() => 'flex flex-col gap-1.5 ' + (mine ? 'items-end' : 'items-start')}">
      <textarea
        rows="1"
        class="markdown-body w-full max-w-[92%] resize-none rounded-xl border border-indigo-300 dark:border-indigo-500/40 bg-white dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-slate-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
        data-testid="message-edit-compose"
        @input="${(e) => autoGrowTextarea(e.target)}"
        @keydown="${(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            // stopPropagation for the same reason as the Escape branch below:
            // without it this bubbles into onKeydown's isCommentOrThreadFocused()
            // + commentReplyEmpty() branch (the reply field is empty right after
            // saving), which opens the comment action menu right on top of the
            // just-saved edit.
            e.preventDefault()
            e.stopPropagation()
            sendMessageEdit(c)
          } else if (e.key === 'Escape') {
            // stopPropagation makes this fully self-contained rather than
            // relying on the event bubbling into onKeydown's relatedActive()/
            // isEditableFocused() fallbacks (which, for a comment-index item,
            // never released the pct thread cursor at all — see
            // .claude/docs/comments-panel.md).
            e.preventDefault()
            e.stopPropagation()
            cancelEditMessage()
            if (pct.commentId === c.id) exitPrCommentThread()
            else if (cs.focus !== null) exitRelated()
          }
        }}"
      ></textarea>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="${() =>
            'rounded-lg bg-indigo-500 px-2.5 py-1 text-[11px] font-medium text-white ' +
            (editState.busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-600')}"
          data-testid="message-edit-save"
          disabled="${() => editState.busy}"
          @click="${() => sendMessageEdit(c)}"
        >
          Opslaan
        </button>
        <button
          type="button"
          class="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300"
          data-testid="message-edit-cancel"
          @click="${() => cancelEditMessage()}"
        >
          Annuleer
        </button>
      </div>
    </div>
  `
}

// reactionBubble — one message in the thread. `i`/`total` let it light up when it
// is the one the reviewer walked up to (cs.threadPos counts from the bottom).
// `isActive`, when given, overrides that default check — used by
// commentDetailCard, whose thread cursor is pct (see its own comment above),
// not cs.focus/cs.threadPos. Each bubble carries its own author's avatar+name
// above it — reactions/replies have an `author` just like the comment root
// (see threadMessages), so this works for every message in the thread, not
// only the opening one. `c` is the message's own thread's comment row (needed
// to target an edit at the right run/reaction id, see editTargetId) — wrapped
// in a stable `contents` root so toggling to/from editingBubble never derails
// arrow.js's keyed reconcile (the "bare toggling expression" pitfall).
function reactionBubble(c, r, i, total, isActive) {
  return html`<div class="contents">${() => (isEditingMessage(c, r) ? editingBubble(c, r) : viewingBubble(c, r, i, total, isActive))}</div>`
}

function viewingBubble(c, r, i, total, isActive) {
  const mine = r.source === 'ui'
  // A state-change message ("/resolve", "/reopen") is not a chat message: it
  // renders as a plain status line (see threadStatusSentinel/commentBody), so
  // it drops the bubble chrome (border/tint/max-width) and the edit pencil —
  // there is no wording to edit. The author line above it stays, so you still
  // see WHO resolved or reopened the thread.
  const status = threadStatusSentinel(r.body)
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
        ${() =>
          isOwnMessage(r) && !status
            ? html`<button
                type="button"
                class="text-slate-400 hover:text-indigo-600 dark:text-zinc-600 dark:hover:text-indigo-400"
                data-testid="reaction-edit"
                title="Bewerk bericht"
                @click="${() => startEditMessage(c, r)}"
              >
                ${editPencilIcon()}
              </button>`
            : ''}
      </div>
      <div
        class="${() => {
          const sel = active()
          if (status) {
            return (
              'max-w-[92%] px-1 py-1 text-[11px] italic leading-relaxed text-slate-500 dark:text-zinc-400' +
              (sel ? ' rounded-md ring-2 ring-indigo-400' : '')
            )
          }
          return (
            'markdown-body max-w-[92%] rounded-xl border px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] ' +
            (mine
              ? 'border-indigo-300 bg-indigo-50 text-slate-800 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-zinc-200'
              : 'border-slate-300 bg-slate-100 text-slate-800 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300') +
            (sel ? ' ring-2 ring-indigo-400' : '')
          )
        }}"
        data-testid="reaction-bubble"
        .innerHTML="${commentBody(r, threadFenceStartIndexes(c).get(r.id) ?? 0)}"
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
//
// `full` (autoExpandLoneComment, below) lifts that clamp entirely, WITHOUT
// turning this into expandedConversation — no thread, no reply field, still
// a plain clickable summary card. Reviewer request: when there is nothing
// else in this column to look at (1 or 2 comments and no Onderliggende code
// at all — see "Geen onderliggende code." in RelatedPanel), a 3-line clamp
// only hides the one thing worth reading for no space-saving reason. This is
// a genuine third state next to "collapsed, no input" and "selected,
// expanded, with input": not-selected but fully expanded, no input.
// truncateMiddle — shortens a string in the MIDDLE instead of the end, so
// both the start and the end stay readable. Used for a file path (see the
// comment-meta line below): a plain end-truncate ("resources/admin/…/huddl…")
// eats the tail — the file name and line number, exactly the part that
// matters most for a path — while the leading directories are the least
// useful part to keep in full. A fixed character budget rather than a
// measured pixel width: there is no CSS-only way to middle-truncate variable
// text, and the comment/Claude columns already have a bounded, only
// mildly-varying width (commentColumnWidthCls(), ~21–28rem), so one constant
// comfortably fits without a measurement dance.
function truncateMiddle(str, maxLen = 46) {
  if (!str || str.length <= maxLen) return str
  const keep = maxLen - 1 // room for the … itself
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return str.slice(0, head) + '…' + str.slice(str.length - tail)
}

// pendingCommentFor reads cs.pendingComment (see its own doc comment) scoped
// to `target`, exactly like commentUnder scopes a real comment to the unit
// under the cursor — so the optimistic echo only shows while InlineComments
// is still rendering the same unit it was posted to (e.g. the reviewer
// hasn't already navigated elsewhere while the POST is in flight). Returns
// null while nothing is pending, or once the target no longer matches.
function pendingCommentFor(target) {
  const p = cs.pendingComment
  if (!p || !target) return null
  if (p.file !== target.file || p.label !== target.label) return null
  return commentUnder(p, target) ? p : null
}

// pendingCommentBubble renders the just-submitted comment's optimistic local
// echo (see cs.pendingComment/placeComment) — the reviewer's own message,
// visible right away instead of only the shared "Bezig…" footer text (see
// commentFooterText), mirroring how a just-sent Claude chat message stays
// visible in the transcript while the reply is still coming in. Deliberately
// NOT a real card: no click handler, no menu, no reply field — it disappears
// the instant the real comment lands (placeComment clears cs.pendingComment
// once createComment's own loadComments has already brought the real one
// into cs.list, so the compact card takes over in the same spot with no gap).
function pendingCommentBubble(p) {
  const who = identityOf('ui', 'reviewer', null)
  return html`
    <div
      class="mx-1 flex items-start gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-800/40 px-2.5 py-2 opacity-80"
      data-testid="comment-item-pending"
    >
      <span class="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-indigo-400" aria-hidden="true" title="Bezig met plaatsen…"></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="flex min-w-0 items-center gap-2">
          ${avatarHTML(who.name, who.avatarUrl, 'h-4 w-4')}
          <span class="truncate text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">${who.name || 'Jij'}</span>
        </span>
        <span class="line-clamp-3 [overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200">${p.body}</span>
        <span class="text-[11px] leading-snug text-slate-500 dark:text-zinc-500">Bezig met plaatsen…</span>
      </span>
    </div>
  `
}

// autoExpandLoneComment — true while this unit's comments deserve the full,
// unclamped body: only 1 or 2 of them, and no Onderliggende code sitting
// right below to compete for attention (rc.children, the exact same source
// RelatedPanel's own "Geen onderliggende code." check reads). Missing/absent
// underlying code is the trigger, not merely "few comments" — with real
// children below, the clamp still earns its keep as a space-saver.
function autoExpandLoneComment() {
  const list = visibleComments()
  return list.length > 0 && list.length <= 2 && rc.children.length === 0
}

function compactConversation(c, i, full) {
  const who = identityOf(c.source, c.author, c.avatarUrl)
  return html`
    <button
      class="${() =>
        // mx-1: a small horizontal outer margin — this column has no padding
        // of its own (see InlineComments' doc comment), so a bare w-full
        // button used to touch the shared card's left/right border directly.
        'mx-1 flex items-start gap-2 rounded-xl border border-slate-300 dark:border-zinc-700 px-2.5 py-2 text-left ring-1 ring-black/5 transition ' +
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
          ${authorAvatarStack(c, who)}
          <span class="truncate text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400" data-testid="comment-author"
            >${who.name || 'onbekend'}</span
          >
          ${() => sourceBadge(c)}
          ${() => aiWarningBadge(c)}
          ${() => blockWideBadge(c)}
          ${() => staleAnchorBadge(c)}
          ${() => sendFailedBadge('reply:' + c.id)}
        </span>
        <span
          class="${full
            ? '[overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200'
            : 'line-clamp-3 [overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200'}"
          .innerHTML="${commentBody(c, threadFenceStartIndexes(c).get('origin:' + c.id) ?? 0)}"
        ></span>
        <span class="truncate text-[11px] leading-snug text-slate-500 dark:text-zinc-500" data-testid="comment-meta"
          >${() =>
            truncateMiddle(c.file) + ':' + c.line + ' · ' + c.reactionCount + ' reacties · ' + c.status + lastReplyNote(c)}</span
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
// used to double as the resolve action (sendReaction(true)), then became a
// pure send-status indicator (draft/sending/sent, sendStatusIcon). That
// status glyph moved out again — to the one shared CommentClaudeFooter below
// both columns, alongside Claude's own status — so this button now shows a
// neutral "more options" (kebab) icon and does exactly one thing: open the
// comment-scoped command menu (resolve/delete/…), reached by keyboard via
// Enter (see keyboard-navigation.md) and, so it stays reachable with the
// mouse too, by a click on this very button (openCommentMenu, threaded down
// from home.mjs's openMenu('comment') via InlineComments/commentCard —
// mirrors how the composer's own "Plaats…" button already opens its command
// menu via a click callback). Still disabled while cs.busy, so a reply/
// resolve/delete in flight can't be interrupted by opening the menu.
function expandedConversation(c, openCommentMenu) {
  return html`
    <div
      class="${() =>
        'flex flex-col gap-2 rounded-xl border p-3 ring-1 ring-black/5 ' +
        // The indigo focus border follows the KEYBOARD (cs.focus), not merely
        // "this thread is the one shown here" — this card also stays expanded
        // while cs.focus === 'claude' (see commentCard's doc comment), and in
        // that case the reviewer's cursor is actually in the Claude column, so
        // this side gets NO border at all (never a neutral gray fallback —
        // explicit reviewer request: only the truly focused column ever shows
        // a border).
        (cs.focus === 'comment' || cs.focus === 'thread'
          ? 'border-indigo-300 dark:border-indigo-500/40'
          : 'border-transparent') +
        ' ' +
        (c.status === 'resolved' ? 'bg-slate-50/60 dark:bg-zinc-800/40' : 'bg-white dark:bg-zinc-900')}"
      data-testid="comment-item"
      data-expanded="true"
    >
      <div class="flex items-center justify-end gap-2" data-testid="comment-meta-line">
        ${() => sourceBadge(c)} ${() => aiWarningBadge(c)} ${() => blockWideBadge(c)} ${() => staleAnchorBadge(c)}
        ${() => sendFailedBadge('reply:' + c.id)}
        ${() => commentStatusMark(c)}
      </div>
      <div class="relative min-h-0">
        <div
          class="flex max-h-[38vh] min-h-0 flex-col gap-2 overflow-y-auto p-0.5"
          data-testid="comment-thread"
          @scroll="${(e) => {
            updateScrollFade(e.target)
            updateCommentThreadPinned(e.target)
          }}"
        >
          ${() => threadMessages(c).map((r, i, arr) => reactionBubble(c, r, i, arr.length).key('msg:' + r.id))}
        </div>
        <div class="contents">
          ${() =>
            cs.threadPos === 0 && !cs.threadPinned
              ? scrollToRecentButton(jumpToCommentThreadBottom, 'scroll-to-bottom-comments')
              : ''}
        </div>
      </div>
      <div class="flex items-end gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-2">
        <textarea
          rows="1"
          class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-1.5 text-xs leading-6 text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
          placeholder="Reageer op deze comment…"
          data-testid="reaction-compose"
          @input="${(e) => {
            if (c) replyDrafts.set(c.id, e.target.value)
            // Any reviewer edit — even selecting-all-then-retyping — means the
            // field is no longer PURELY Claude's unedited draft, so the
            // select-all-on-arrival/auto-post-on-Enter treatment stops
            // applying (see applyPendingDraftReplies/sendReaction).
            if (c) pureChatDraftReplyIds.delete(c.id)
            autoGrowTextarea(e.target)
          }}"
          @keydown="${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // stopPropagation (only when there's actually text to send) is
              // load-bearing, not defensive: sendReaction now calls
              // exitRelated() SYNCHRONOUSLY (optimistic exit, see
              // postThreadReply's doc comment), which blurs this very field —
              // changing document.activeElement while this same keydown is
              // still bubbling. Without stopping it here, home.mjs's
              // document-level handler would see the (already blurred) field
              // and misread this Enter as "not typing in a field", opening
              // an unrelated menu (mirrors the "nested @click" pitfall in
              // arrowjs-pitfalls.md, for a keydown instead of a click). An
              // EMPTY field must keep bubbling — that's what opens the
              // comment-scoped command menu (commentReplyEmpty(), home.mjs).
              if (e.target.value.trim()) e.stopPropagation()
              sendReaction()
            }
          }}"
        ></textarea>
        <button
          class="${() => 'flex min-h-[2.25rem] shrink-0 items-center justify-center rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' + (cs.busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-600')}"
          data-testid="reaction-send"
          disabled="${() => cs.busy}"
          @click="${() => sendReaction()}"
        >
          Stuur
        </button>
        <button
          type="button"
          class="${() =>
            'flex min-h-[2.25rem] shrink-0 items-center justify-center rounded-lg border px-2.5 py-1.5 transition ' +
            (cs.busy
              ? 'cursor-not-allowed border-slate-200 text-slate-400 dark:border-zinc-800 dark:text-zinc-600'
              : 'border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-indigo-500/40 dark:hover:text-indigo-400')}"
          data-testid="reaction-status"
          title="Resolve/verwijder via het menu"
          disabled="${() => cs.busy}"
          @click="${() => openCommentMenu && openCommentMenu()}"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
            data-testid="reaction-status-icon"
          ><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
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
//
// Also stays expanded while the keyboard has actually moved on to the Claude
// column (cs.focus === 'claude'), for exactly the comment that Claude
// conversation is anchored on (chatAnchorComment()) — the merged
// comment-claude-row card (home.mjs) shows both halves side by side, so
// collapsing the comment back the moment → moves focus into Claude read as a
// bug: the reviewer loses the very thread the conversation is about. Compared
// by id, not selI() === i, because chatAnchorComment() has its own fallback
// (an orphan/PR-wide comment whose conversation already has turns) that can
// point elsewhere than the current selection index.
function commentCard(c, i, openCommentMenu) {
  return html`
    <div class="contents">
      ${() =>
        (selI() === i && (cs.focus === 'comment' || cs.focus === 'thread')) ||
        (cs.focus === 'claude' && chatAnchorComment() && chatAnchorComment().id === c.id)
          ? expandedConversation(c, openCommentMenu)
          : compactConversation(c, i, autoExpandLoneComment())}
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
    // A PR-wide ("algemene") comment hangs on the PR itself, so a file:line
    // here is not just unknown but meaningless — and reading one off a
    // selected comment-index item is exactly what printed the reported
    // "undefined:undefined". See startPrWideComment.
    if (cs.prWideCompose) return 'hele PR'
    const t = effectiveTarget()
    if (t) return t.file + ':' + (t.startLine || t.line)
    const b = state && state.blocks && state.blocks[state.selected]
    return b ? b.file + ':' + b.line : 'geen regel geselecteerd'
  }
  const heading = () => {
    if (cs.prWideCompose) return 'Nieuwe algemene comment'
    return warningOverride ? 'Comment van AI-controle' : 'Nieuwe comment'
  }
  return html`
    <div class="contents">
      ${() =>
        // isNewChatUnanchored() (not a bare cs.focus === 'new'): the reviewer
        // can reach the Claude composer from here (enterClaudeChatFromNew,
        // → from this very field) before anything is placed, and this
        // composer must stay expanded/visible the whole time — otherwise the
        // left column goes blank the moment the keyboard lands in Claude.
        // See "Comment column stays expanded while chatting on a brand-new
        // unit" in claude-chat-panel.md.
        isNewChatUnanchored()
          ? html`
              <div
                class="flex flex-col gap-2 rounded-xl border border-indigo-300 dark:border-indigo-500/40 bg-white dark:bg-zinc-900 p-3 ring-1 ring-black/5"
                data-testid="comment-composer"
              >
                <p class="text-[11px] font-medium text-slate-500 dark:text-zinc-500">
                  ${() => heading() + ' · ' + target()}
                </p>
                ${() =>
                  sendFailedBadge(
                    'new:' + (cs.prWideCompose ? PRWIDE_DRAFT_KEY : draftKeyFor(effectiveTarget())),
                    'plaatsen mislukt — probeer opnieuw',
                  )}
                <textarea
                  rows="1"
                  class="min-h-20 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-2 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="${() => (cs.prWideCompose ? 'Je algemene comment op deze PR…' : 'Je comment op deze regel…')}"
                  data-testid="comment-compose"
                  @input="${(e) => {
                    composeDrafts.set(composeDraftKey, e.target.value)
                    autoGrowTextarea(e.target)
                  }}"
                ></textarea>
                <div class="flex items-center justify-end gap-2">
                  <button
                    class="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300"
                    @click="${() => {
                      warningOverride = null
                      composeDrafts.delete(composeDraftKey)
                      clearSendFailed('new:' + composeDraftKey)
                      cs.composing = false
                      // Ends a PR-wide compose too, which brings the hidden
                      // pr-index/block column back (see cs.prWideCompose).
                      cs.prWideCompose = false
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
  // commentColumnWidthCls() — half of relatedColumnWidthCls(), so this
  // section sits at the same width as the Claude column in their shared
  // inner row (home.mjs), while still lining up under related-code below
  // (both rows sum to the same relatedColumnWidthCls() total, see
  // commentColumnWidthCls's own doc comment). The two columns merge into one
  // visual card (border/bg live on the shared row wrapper in home.mjs) with
  // `items-stretch`, so this column has no padding/border/background of its
  // own any more — only its own inner cards (compactConversation/
  // expandedConversation/newCommentComposer) keep their own padding.
  //
  // `justify-end`: `items-stretch` gives this column the full height of the
  // (often taller) Claude column next to it, but this column's own content
  // is only as tall as its comments — without `justify-end` that content
  // sits at the TOP, leaving a dead gap below and stranding the reply
  // composer far above the Claude composer beside it. The Claude column
  // doesn't need this itself: its message thread already carries its own
  // `flex-1` to pin its composer to the bottom (see claudeChatColumn in
  // ClaudeChat.mjs).
  const widthKey = () => colWidthKeyFor('comments', commentTarget)
  return html`
    <div
      class="${() => 'relative flex shrink-0 flex-col justify-end gap-2 ' + commentColumnWidthCls()}"
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
      ${() =>
        (cs.focus === 'comment' || cs.focus === 'thread') && selI() > 0
          ? moreAboveHint(selI(), 'comment-more-above')
          : ''}
      ${newCommentComposer(state, commentTarget, openCompose)}
      <div class="contents">
        ${() => {
          const p = pendingCommentFor(commentTarget && commentTarget())
          return p ? pendingCommentBubble(p) : ''
        }}
      </div>
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
  // A bare Foo::class reference (no call, no cast, no Activity-stub var) →
  // the class as a whole — the generic sibling of model_usage for any other
  // indexed class (resolveCalls rule 6c, see .claude/docs/workflows-analysis.md).
  class_ref: 'klasse',
  // The same Foo::class reference ALSO pulls in the class's own constructor
  // and its first other method, even when this PR changed neither (rule
  // 6c-bis) — the two blocks that tell a reader what the class is. Their
  // badges name that role, since "klasse" is already taken by the header card
  // sitting next to them.
  class_ctor: 'constructor',
  class_first_method: 'eerste method',
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
  // A <class-header> block's own declared members, broken out of that one
  // coarse block into a card each (resolveClassMembers), plus a Foo::MAX_TRIES
  // reference resolved to its declaration (rule 6b). All four are read-only
  // leaves — the gewijzigd/ongewijzigd distinction rides on memberStatusBadge
  // below, not on this role badge.
  class_property: 'property',
  class_constant_changed: 'constante',
  class_constant: 'constante',
  const_ref: 'constante',
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
  'class_ref',
  'class_ctor',
  'class_first_method',
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

// memberStatusBadge says, in a WORD, whether a class-member card is one the PR
// changed — the members are shown side by side (a changed $listen next to an
// untouched MAX_TRIES, see resolveClassMembers), so without this they'd be
// indistinguishable. Colour is decoration only; the word carries the meaning.
//
// Only for the three <class-header> member kinds. `const_ref` (a reference to
// some other class's constant, rule 6b) deliberately gets nothing: it is pure
// reference material, and claiming it is "ongewijzigd" would assert something
// this rule never checked.
const MEMBER_CHANGED_KINDS = new Set(['class_property', 'class_constant_changed'])
function memberStatusBadge(r) {
  const changed = MEMBER_CHANGED_KINDS.has(r.kind)
  if (!changed && r.kind !== 'class_constant') return ''
  return html`
    <span
      class="${'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ' +
      (changed
        ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
        : 'bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500')}"
      data-testid="related-member-status"
      title="${changed ? 'Deze PR wijzigt deze declaratie' : 'Deze PR wijzigt deze declaratie niet'}"
      >${changed ? 'Gewijzigd' : 'Ongewijzigd'}</span
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

// viewOnlyBadge is the "there is nothing to sign off here, only to look at"
// mark: a small eye glyph in the slot where a child would otherwise show its
// approve counter (approvalBadge, e.g. `0/16`) or a comment avatar
// (commentActivityBadge). Reviewer's own wording: "als er geen avatar
// aanwezig is en geen aantal approved aantal regels is, laat dan een oogje
// zien". That is exactly a call/covered method into a file this PR doesn't
// change, and the read-only class members — reference material, reachable
// (now also from an unchanged line, see referenceRows in home.mjs) but never
// approvable.
//
// Colorblind rule: the meaning is carried by the SHAPE (an eye) plus its
// title text, never by colour — it is drawn in the same neutral slate/zinc as
// the rest of the header.
function viewOnlyBadge(r) {
  if ((r.approve && r.approve.total) || r.commentActivity) return ''
  return html`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-zinc-500"
      data-testid="related-view-only"
    >
      <title>Alleen bekijken — hier valt niets goed te keuren</title>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
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

// commentColumnWidthCls / claudeColumnWidthCls — equal (1/2 each) halves of
// relatedColumnWidthCls()'s own clamp, reading the SAME chars snapshot so
// both split evenly as the code grows, not just at the extremes — the two
// blocks read as one merged card (see home.mjs's comment-claude-row) and
// must therefore stay the same width as each other. The connector's width
// comes off the comment side only (see the inner row in home.mjs), so this
// holds exactly, for any chars value:
//   commentColumnWidthCls() + 0.75rem(connector) + claudeColumnWidthCls()
//     === relatedColumnWidthCls()
export function commentColumnWidthCls() {
  return relatedWidthCls(relatedGrowthChars(), 1 / 2, COMMENT_CLAUDE_CONNECTOR_REM)
}

export function claudeColumnWidthCls() {
  return relatedWidthCls(relatedGrowthChars(), 1 / 2)
}

// relatedCard renders one child block: a header (label + file:line + relation
// kind) and a short, non-interactive code excerpt highlighted like the panes —
// unless the card sits above the cursor in the list (`collapsed`, see below),
// in which case only that header stays visible. The card sits in a flex row
// with, when the child itself has changed grandchildren (r.nested), a dashed
// connector to a narrow chip column on the right (nestedChipColumn) — the
// drill-hint that there is more underneath, also hidden while collapsed.
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
  // collapsed: this card sits ABOVE the cursor in the vertical list (an item
  // the reviewer has already stepped past on the way down). Only its header
  // stays visible — the code excerpt/translation view and its drill-hint
  // chips fall away — so a long walk through Underlying code doesn't grow the
  // panel unboundedly. A pure function of `i < cs.codeSel`, not a stored
  // toggle: stepping back up (↑) "un-collapses" a card for free the moment the
  // cursor passes it again, no separate state to reset. Reviewer request:
  // "als ik naar beneden ga moeten de bovenstaande blokken ingeklapt worden,
  // en als ik naar boven ga weer uitgeklapt".
  const collapsed = () => cs.focus === 'code' && i < cs.codeSel
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
      data-collapsed="${() => (collapsed() ? 'true' : 'false')}"
      @click="${() => drill && drill(r)}"
    >
      <div class="border-b border-slate-100 dark:border-zinc-800/60 px-3 py-1.5">
        <div class="flex items-baseline gap-2">
          ${() => categoryBadge(r)}
          ${() => leftStatusBadge(r)}
          ${() => memberStatusBadge(r)}
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
          ${() => viewOnlyBadge(r)}
        </div>
        <span class="block truncate font-mono text-[10px] text-slate-400 dark:text-zinc-500" title="${() => r.file + ':' + r.line}"
          >${r.file}:${r.line}</span
        >
      </div>
      ${() =>
        collapsed()
          ? ''
          : r.kind === 'translation'
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
    ${() => (!collapsed() && nested.length ? nestedChipColumn([r], nested, drill, [], i) : '')}
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
  'summarize_chat:running': 'chat-samenvatting genereren…',
  'summarize_chat:completed': 'chat-samenvatting gegenereerd',
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
// only while it's genuinely IN PROGRESS (status === 'running') OR it hasn't
// been updated in over TASK_STALE_MS AND isn't sitting in 'waiting' — a
// recently completed run thus disappears for the first few minutes (nothing
// to act on), then reappears as a "this has been sitting idle for a while"
// signal. 'waiting' is excluded even when stale: several long-lived per-PR
// trackers (build_relations/approve/pr_status) and any other workflow that
// simply idles on a Signal sit in 'waiting' indefinitely without being busy,
// so showing it here — however old — is never actionable, just noise (see
// "laat hier geen taken zien die in de wacht staan"). Running-first, then
// most-recently-updated.
export function visibleWorkflowRuns(state) {
  const all = state && Array.isArray(state.workflows) ? state.workflows : []
  const now = Date.now()
  const stale = (r) => {
    const t = new Date(r.updatedAt).getTime()
    return Number.isNaN(t) || now - t > TASK_STALE_MS
  }
  const visible = all.filter((r) => r.status !== 'waiting' && (r.status === 'running' || stale(r)))
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
  // moreAboveHint is the "er staat nog iets boven" cue that belongs with
// alignToTopVertical: since the selected card is scrolled to the TOP of its
// column, the items before it are off-screen above and the list would
// otherwise read as if it started here. A slim sticky header naming how many
// there are (`▲ N hierboven`), so ↑ is an obvious thing to press.
//
// Colorblind rule: the meaning sits in the WORD (the count + "hierboven") and
// in the ▲ SHAPE — there is no colour carrying anything here.
//
// `n` is the cursor's own index (cs.codeSel / selI()), not a scroll
// measurement: deterministic, reactive for free, and it can't disagree with
// what ↑ would actually do.
//
// Only used for stacked comment cards (InlineComments' comment-more-above)
// now — the Onderliggende-code list dropped its own call site once its cards
// above the cursor started collapsing to just their header (relatedCard's
// `collapsed`), which already shows what's above without a separate hint.
function moreAboveHint(n, testid) {
  return html`
    <div
      class="sticky top-0 z-10 -mt-1 mb-1 flex shrink-0 items-center gap-1 rounded-md border border-slate-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 px-2 py-1 text-[11px] text-slate-500 dark:text-zinc-400"
      data-testid="${testid}"
    >
      <span aria-hidden="true">▲</span>
      <span>${n} hierboven</span>
    </div>
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
export function isKiloReview(body) {
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

// indexComments is the FULL set of comments that get a row in the block index —
// the PR-wide/orphan ones above, PLUS every block-anchored (kind === '') comment
// that is still UNRESOLVED (or mentions the local reviewer, see mentions.mjs).
// Such a comment already lives in its block's own inline thread; the extra row
// is deliberate, so an open comment can't hide inside a block you haven't opened
// yet. It is one row, not two: the inline thread is a different panel, not a
// second index item.
//
// The unresolved half is a reviewer decision with two visible consequences,
// both wanted: every open comment becomes a stop on the ↑/↓ walk, and — because
// blockApproveCount already scores a comment row as "resolved == approved"
// (home.mjs) — the PR is only ever fully approved once every comment is
// resolved, including other people's. Resolving such a row is reached through
// its own Enter menu (prCommentCommandsFor in home.mjs) — deliberately NOT
// Space, which instead toggles the row's comment_batch checkbox (spaceKey) —
// which is what makes that walk finishable. A RESOLVED block-anchored comment
// drops out of the index again; a resolved PR-wide one stays, exactly as
// before.
//
// One extra condition on that unresolved half lives in home.mjs, not here,
// because it needs state.blocks: the comment's own block must actually be in the
// tree (see recomputeLeftList). A row for a comment with no block to step into
// would be a dead end.
//
// DEDUP ON c.id IS LOAD-BEARING, not cosmetic. A PR-wide comment that also
// mentions me matches both halves, and two items would carry the SAME
// state.blocks id ('comment:' + c.id) — exactly the id that
// recomputeLeftList's selection-preserving findIndex and the
// ?sel=comment:<id> restore (applyCommentRefRestore) resolve through. One
// comment = exactly one index row, always.
export function indexComments() {
  const out = []
  const seen = new Set()
  for (const c of cs.list) {
    const prWide = (c.kind || c.anchorState === 'orphan') && !isKiloReview(c.body)
    const inBlock =
      !c.kind &&
      !isOrphanComment(c) &&
      !isKiloReview(c.body) &&
      (c.status !== 'resolved' || commentMentionsMe(c))
    if (!prWide && !inBlock) continue
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  return out
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
//
// `startIndex` (default 0) continues the running "Codeblok N"/"Suggestie N"
// numbering across a thread's messages instead of resetting to 1 in every
// bubble — see threadFenceStartIndexes, which computes the value callers pass
// here.
export function commentBody(c, startIndex = 0) {
  return () => {
    if (!c) return ''
    const st = threadStatusSentinel(c.body)
    if (st) return statusLineHTML(st)
    return renderMarkdown(c.body, startIndex, true)
  }
}

// THREAD_STATUS_SENTINELS — the two command-like reply bodies the backend
// stores to mark a thread's state change (resolveSentinel/reopenSentinel,
// workflows.go) mapped onto what a reader should actually SEE. Rendering these
// is a DISPLAY-time transform, exactly like identityOf's own-message identity
// (see conventions.md): the stored body stays the literal command — the
// GitHub-side resolve detection and the workflow's "never mirror this as text"
// guard both key on it — so every already-stored "/resolve" reaction from
// before this existed renders as a proper status line too, without a backfill.
//
// Meaning lives in the WORD ("opgelost" / "heropend"); the glyph is a second,
// redundant cue and colour carries nothing at all (colorblind rule,
// conventions.md).
const THREAD_STATUS_SENTINELS = {
  '/resolve': { icon: '✓', text: 'Thread opgelost' },
  '/reopen': { icon: '↩', text: 'Thread heropend' },
}

// threadStatusSentinel maps a message body onto its status line, or null for an
// ordinary message. Exact (trimmed, lowercased) match only — a real reply that
// merely mentions "/resolve" somewhere in a sentence stays ordinary text.
export function threadStatusSentinel(body) {
  if (typeof body !== 'string') return null
  return THREAD_STATUS_SENTINELS[body.trim().toLowerCase()] || null
}

// statusLineHTML renders such a status line as the safe HTML string the
// `.innerHTML` bindings expect. Both parts are module constants (never user
// input), so there is nothing to escape here.
function statusLineHTML(st) {
  return (
    '<span class="inline-flex items-center gap-1 font-medium" data-testid="thread-status-line">' +
    '<span aria-hidden="true">' +
    st.icon +
    '</span>' +
    st.text +
    '</span>'
  )
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
// No "sent" flash here: sendPrCommentReply now calls cancelPrCommentReply()/
// exitPrCommentThread() IMMEDIATELY (optimistic exit, see postPrCommentReply's
// own doc comment), which hides this whole reply row before the send even
// resolves — so a transient "sent" state would never actually be visible.
// `mode` distinguishes what the SAME textarea+button slot in commentDetailCard
// does with the typed text: 'reply' (default, startPrCommentReply) posts a
// reaction on this thread; 'convert' (startPrCommentConvert, see
// convertPrWideWarningToComment) instead starts a brand-new, unanchored
// PR-wide comment and deletes this one once that succeeds — a PR-wide AI
// finding has no diff/composer to reuse (unlike a line-anchored one, which
// drills into its real block and uses convertWarningToComment/warningOverride
// instead, see convertPrWideWarningToComment's own doc comment), so it
// repurposes this reply field instead of duplicating a whole second composer
// UI.
const picm = reactive({ replying: false, commentId: null, sending: false, mode: 'reply' })

// startPrCommentReply reveals the reply textarea in commentDetailCard (only
// for the comment `c` it was opened for, see picm's own comment) and focuses
// it — called by the "Beantwoorden" command (home.mjs's prCommentCommandsFor).
// Mirrors toNew()'s focus-immediately convention. Restores a draft left
// behind by a failed send (see prReplyDrafts/postPrCommentReply) if there is
// one for this exact comment.
export function startPrCommentReply(c) {
  picm.replying = true
  picm.commentId = c ? c.id : null
  picm.mode = 'reply'
  focusEl('[data-testid=comment-detail-reply]')
  const draft = c && prReplyDrafts.get(c.id)
  if (draft) prefillField('[data-testid=comment-detail-reply]', draft)
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
// !== '', no file/line anchor) equivalent. A line-anchored finding reached
// via its own comment-index sidebar row still drills into the real block
// (see commentBlockItem's b.lineAnchored — home.mjs's DetailPanel renders
// that block's own Block()/InlineComments there, same as an ordinary
// selection), so home.mjs's prCommentCommandsFor routes THAT case to
// convertWarningToComment instead (the block's own "+ Nieuwe comment"
// composer, already mounted on screen) — see comments-panel.md ("Converting
// an AI-controle finding...") for why a guard requiring c.kind here once
// silently no-opped for such a finding, before this dispatch existed. A
// genuinely PR-wide item has no block/diff to drill into at all, so it
// repurposes this item's own reply field instead (startPrCommentConvert).
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

// pcc ("PR-index comment chat") is the ephemeral toggle for the embedded
// Claude conversation shown under a comment-index item's own detail card
// (commentDetailCard) — the PR-wide sibling of ClaudeChatPanel's block-scoped
// column, reached via the "Chat met Claude" command (home.mjs's
// prCommentCommandsFor) instead of `→` (a comment-index item has no code
// context to hang a `→` chain off — see keyboard-navigation.md). `commentId`
// scopes `open` to ONE specific item, mirroring picm/pct just above: the
// selected AND the look-ahead preview item both render through this very same
// commentDetailCard.
//
// This only toggles VISIBILITY here — the conversation DATA is the existing
// `cc` (see claudeChatView), which already keeps itself correctly anchored on
// whichever comment-index item is selected: home.mjs's commentScope sentinel
// now carries the actual comment (`{ none: true, prComment: c }`), and
// chatAnchorComment()'s own `s.none` branch returns it, so the pre-existing
// syncClaudeAnchorForSelection watch picks it up exactly like it already does
// for a block-scoped comment — no second writer of `cc`, no risk of the two
// contexts racing. Not bound to the URL — ephemeral UI state, like picm/pct.
// pinned mirrors cs.claudePinned/cs.threadPinned above, scoped to THIS card's
// own claude-chat-thread pane (a comment-index item's embedded chat is a
// separate DOM instance from the block-scoped one, and claudeChatVisible()'s
// strict invariant means at most one of the two is ever mounted at once, but
// they still must not share one flag — see updatePccThreadPinned/
// jumpToPccThreadBottom below).
const pcc = reactive({ open: false, commentId: null, pinned: true })

// prCommentClaudeView is claudeChatView()'s PR-wide sibling: same `cc`-backed
// fields, but claudePos/focused come from THIS card's own state instead of
// the block-scoped panel's `cs.claudePos`/`cs.focus` — those drive an
// unrelated URL-bound keyboard cursor (rel.cpos/rel.foc) for the diff-mode
// Claude column, and must never be touched from here (see pcc's own doc
// comment). No turn-walking cursor of its own yet (claudePos always 0) —
// deliberately smaller scope than the block-scoped chat's full keyboard
// chain; mouse/click only for now.
function prCommentClaudeView() {
  const base = claudeChatView()
  return { ...base, claudePos: () => 0, focused: () => pcc.open, pinned: () => pcc.pinned }
}

// updatePccThreadPinned/jumpToPccThreadBottom are this card's own copies of
// updateClaudeThreadPinned/jumpToClaudeThreadBottom (see their doc comments),
// scoped to pcc.pinned instead of cs.claudePinned since this is a separate
// claude-chat-thread instance (a comment-index item's own embedded chat).
function updatePccThreadPinned(el) {
  if (!el) return
  pcc.pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - PINNED_EDGE_PX
}
function jumpToPccThreadBottom() {
  pcc.pinned = true
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=claude-chat-thread]')
    if (!el) return
    el.scrollTop = el.scrollHeight
    updateScrollFade(el)
  })
}

// startPrCommentChat reveals the embedded Claude column under comment `c`'s
// detail card and ensures its Execution — called by the "Chat met Claude"
// command. `cc.commentId` is already `c.id` by the time this runs
// (chatAnchorComment/syncClaudeAnchorForSelection resolved it the moment the
// item was selected, see pcc's own doc comment above), so ensureAndLoadChat
// here is the same idempotent call enterClaudeChat makes — it only needs to
// make sure the Execution/transcript are actually loaded before focusing the
// composer.
export async function startPrCommentChat(c) {
  if (!c) return
  pcc.open = true
  pcc.commentId = c.id
  pcc.pinned = true
  // Mirrors enterClaudeChat's own ordering: focus only AFTER the Execution is
  // ensured and cc.runId is actually populated — sending before that resolves
  // is a silent no-op (sendClaudeMessage's own `if (!runId) return`).
  await ensureAndLoadChat(cs.pr, c.id)
  ensureChatEvents(cs.pr)
  focusEl('[data-testid=claude-chat-compose]')
}

// closePrCommentChat hides the embedded Claude column again — called by
// home.mjs whenever the sidebar selection moves off the comment item it
// belongs to (mirrors cancelPrCommentReply/exitPrCommentThread's own reset),
// and by the column's own close control. The conversation itself is left
// alone (cc keeps following the selection via syncClaudeAnchorForSelection) —
// only this card's visibility toggle resets, same as leaving a block-scoped
// conversation via ← never deletes it either.
export function closePrCommentChat() {
  pcc.open = false
  pcc.commentId = null
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
  // Same publish question as the block-scoped thread (see needsPublishChoice):
  // a PR-wide AI finding is local too, so replying to one asks first.
  if (needsPublishChoice(c)) {
    openPublishMenu({ kind: 'prwide', commentId: c.id, body: text })
    return
  }
  await postPrCommentReply(c, text)
}

// postPrCommentReply is sendPrCommentReply's write half, split out for the
// publish menu (sendPendingReply) exactly like postThreadReply above.
//
// The reply row closes back to the item's rest position IMMEDIATELY —
// cancelPrCommentReply() (hides the field) + exitPrCommentThread() (releases
// pct back to the same "Start" row, per the confirmed decision: a comment-
// index item has no diff of its own to return to, unlike a block-scoped
// thread) — before the Signal POST + GET below even starts. Same optimistic-
// exit family as placeComment/postThreadReply; see placeComment's doc
// comment for the reasoning.
//
// A failed send marks cs.sendFailed('reply:'+c.id) and keeps the typed text
// recoverable via prReplyDrafts (normally only cleared on success) — see
// startPrCommentReply, which restores it the next time this item's reply
// field reopens.
async function postPrCommentReply(c, body, publish, withHistory) {
  const text = (body || '').trim()
  if (!c || !c.runId || !text) return
  cancelPrCommentReply()
  exitPrCommentThread()
  picm.sending = true
  try {
    let res
    try {
      res = await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: 'reviewer',
          body: text,
          done: false,
          ...(publish ? { publish, publishHistory: !!withHistory } : {}),
        }),
      })
    } catch (_) {
      res = null
    }
    if (res && res.ok) {
      prReplyDrafts.delete(c.id)
      clearSendFailed('reply:' + c.id)
      await loadComments(cs.pr)
    } else {
      markSendFailed('reply:' + c.id)
      prReplyDrafts.set(c.id, text)
    }
  } finally {
    picm.sending = false
  }
}

// Its `file`/`line` are passed through only because a PR-wide finding
// sometimes still knows which file it was about; an ai_warning that has
// neither used to make this whole call fail on createComment's (and the
// backend's) unconditional "a comment must name a file" rule — both now
// exempt a PR-wide kind, see createComment/handleTaskCodeComment.
//
// sendConvertedPrWideComment is sendPrCommentReply's 'convert'-mode sibling:
// instead of replying on `c`'s own thread, it starts a genuinely NEW,
// unanchored PR-wide comment (Kind "issue", the same Kind an imported
// general PR comment gets — see createComment's own doc comment) with the
// (possibly edited) text, and only once THAT is confirmed placed does it
// delete `c` (the AI finding it replaces) — a failed placement must never
// discard the finding without anything taking its place, mirroring
// placeComment's own ordering for the anchored case. Only ever reached for a
// genuinely PR-wide `c` (`c.kind` set) — see convertPrWideWarningToComment's
// own doc comment for the line-anchored case, which goes through
// convertWarningToComment/placeComment instead and keeps its anchor there.
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

// deletePrCommentItem deletes the comment-index item's own thread — the same
// "delete" Signal on its own Execution as deleteFocusedComment above, just
// against this item instead of the block-scoped focused one. Called by the
// "Verwijder comment" command in prCommentCommandsFor (home.mjs), which used
// to have no delete at all: a PR-wide AI risk finding could be resolved but
// never removed, even though the backend has supported it all along. No
// cursor fix-up like deleteCommentAndSelectRow's (there is no diff row to
// land on for a PR-wide item) — recomputeLeftList's own clamp moves the
// selection off the row that just disappeared.
export async function deletePrCommentItem(c) {
  if (!c || !c.runId) return
  await deleteComment(c)
  await loadComments(cs.pr)
}

// unresolvePrCommentItem reopens a comment-index item's thread — the same
// `action:'unresolve'` Signal as unresolveFocusedComment above (see its doc
// comment, including why a thread resolved long ago can no longer be reopened).
// Called by the "Unresolve comment" command.
export async function unresolvePrCommentItem(c) {
  if (!c || !c.runId) return
  await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'reviewer', action: 'unresolve' }),
  })
  await loadComments(cs.pr)
}

// commentMenuButton — the mouse entry point into prCommentCommandsFor()
// (Beantwoorden/Resolve/Verwijder/Bewerk/Chat met Claude/Ignore), the same
// menu Enter already opens on a comment-index row (home.mjs's
// selectedComment() branch). A speech-bubble-with-dots icon, distinct from
// blockMenuButton's plain kebab (Block.mjs) and the PR/Claude menu icons, so
// a reviewer can tell the four menu buttons apart at a glance. Only rendered
// on the selected/focused card, never the look-ahead preview (mirrors
// blockMenuButton's own !preview gate) — a no-op openMenu argument (never
// passed, in practice) would otherwise render a dead button.
function commentMenuButton(openMenu) {
  if (!openMenu) return ''
  return html`
    <button
      type="button"
      title="Menu voor deze comment"
      data-testid="comment-detail-menu"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
      @click="${(e) => {
        e.stopPropagation()
        openMenu()
      }}"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true">
        <path d="M1.5 3.5h13v7h-8l-3 2.5v-2.5h-2v-7z"></path>
        <circle cx="5.2" cy="7" r="0.6" fill="currentColor" stroke="none"></circle>
        <circle cx="8" cy="7" r="0.6" fill="currentColor" stroke="none"></circle>
        <circle cx="10.8" cy="7" r="0.6" fill="currentColor" stroke="none"></circle>
      </svg>
    </button>
  `
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
        ${() => commentFileChip(c)} ${() => sendFailedBadge('reply:' + c.id)}
        <span class="ml-auto shrink-0 text-[10px] text-slate-500 dark:text-zinc-500">${relTime(c.createdAt)}</span>
        ${() => (preview ? '' : commentMenuButton(opts && opts.openMenu))}
      </div>
      <div
        class="${() =>
          'flex max-h-[70vh] flex-col gap-2.5 overflow-auto rounded-lg ' +
          (!preview && pct.commentId === c.id ? 'ring-2 ring-indigo-200 dark:ring-indigo-500/30' : '')}"
        data-testid="comment-detail-thread"
      >
        ${() =>
          threadMessages(c).map((r, ti, arr) =>
            reactionBubble(c, r, ti, arr.length, () => !preview && pct.commentId === c.id && pct.pos === arr.length - ti).key(
              'detail-msg:' + r.id,
            ),
          )}
      </div>
      <div class="contents">
        ${() =>
          picm.replying && picm.commentId === c.id
            ? html`<div class="flex items-end gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-3">
                <textarea
                  rows="1"
                  class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2 py-1 text-xs leading-[1.625rem] text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="${() => (picm.mode === 'convert' ? 'Nieuwe comment op basis van deze melding…' : 'Reageer…')}"
                  data-testid="comment-detail-reply"
                  @input="${(e) => {
                    if (picm.mode === 'reply' && c) prReplyDrafts.set(c.id, e.target.value)
                    autoGrowTextarea(e.target)
                  }}"
                  @keydown="${(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      // See reaction-compose's own @keydown for why this is
                      // load-bearing (only when there's actually text to
                      // send — an EMPTY field must keep bubbling, that's what
                      // opens the publish-choice/action menu, see
                      // needsPublishChoice/prCommentCommandsFor): sendPrCommentReply
                      // now closes this field SYNCHRONOUSLY (optimistic exit)
                      // before the Signal even fires, which would otherwise
                      // let this same keydown be reinterpreted by home.mjs's
                      // document-level handler.
                      if (e.target.value.trim()) e.stopPropagation()
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
      <div class="contents">
        ${() =>
          // Also shows while a turn is actively running for this exact
          // comment (hasActiveClaudeTurn + cc.commentId === c.id), even when
          // pcc.open is false — reached either because the reviewer clicked
          // "Sluit" mid-turn or navigated to a different item and back
          // (closePrCommentChat resets pcc.open on every selection change,
          // see home.mjs). Reviewer request: the opened-out conversation
          // (including what was typed) must stay visible for as long as the
          // turn runs, regardless of pcc's own open/closed toggle — see
          // "Stay open while a Claude turn is running" in
          // claude-chat-panel.md.
          (pcc.open && pcc.commentId === c.id) || (hasActiveClaudeTurn() && cc.commentId === c.id)
            ? html`<div
                class="flex flex-col gap-1 border-t border-slate-100 dark:border-zinc-800/60 pt-3"
                data-testid="pr-comment-claude-section"
              >
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-medium text-slate-500 dark:text-zinc-500">Claude</span>
                  <button
                    type="button"
                    class="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100 dark:text-zinc-500 dark:hover:bg-zinc-800"
                    data-testid="pr-comment-claude-close"
                    @click="${() => closePrCommentChat()}"
                  >
                    Sluit
                  </button>
                </div>
                ${claudeChatColumn(prCommentClaudeView(), {
                  onSend: (text) => queueClaudeMessage(text),
                  onRetry: () => retryClaudeTurn(),
                  onThreadScroll: (el) => updatePccThreadPinned(el),
                  onJumpToBottom: () => jumpToPccThreadBottom(),
                  // Same 'claude' menu the block-scoped column opens — it acts
                  // on the same cc state regardless of which surface it was
                  // opened from (see "A PR-wide comment-index item can also
                  // start a conversation" in claude-chat-panel.md).
                  onOpenMenu: () => openClaudeMenuFromComposer(),
                })}
              </div>`
            : ''}
      </div>
      ${() =>
        // The SAME status/log line the block-scoped comment card already has
        // (comment-claude-row in home.mjs) — here it also carries this comment's
        // own comment_batch state, live while Claude is working on it and as a
        // one-line outcome afterwards. Renders nothing when there's nothing to
        // report, so an ordinary comment card is unchanged.
        CommentClaudeFooter(c.id)}
    </div>
  `
}

