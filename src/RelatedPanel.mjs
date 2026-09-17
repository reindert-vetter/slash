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
import { t } from './i18n.mjs'
import { highlight, blockLabel, codeGrowthChars, scrollHint } from './Block.mjs'
import { translationValueView } from './translationDiff.mjs'
import { statusInfo, categoryClass, isLocalAiWarning } from './BlockList.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { renderMarkdown, countCodeFences, annotateFenceNumbers } from './markdown.mjs'
import { avatarHTML, displayNameOf, ensureMe, ensureNames, identityOf, meLogin } from './avatar.mjs'
import { commentMentionsMe, ensureSettings } from './mentions.mjs'
import { labelForWorkflow } from './workflowLabels.mjs'
// baseName — the same "trim a repo path to its file name" helper the
// /pr-overview "Mislukte taken" drawer uses, reused by the merged Taken row's
// failed-run note (failedRunNote below) so both name a file the same way.
import { baseName } from './problems.mjs'
import { repoParam, repoField } from './prContext.mjs'
// autoWarn gates the automatic comment_titles request below, exactly as it
// gates code_warning and the footer's explain_code — see autowarn.mjs.
import { autoWarn } from './autowarn.mjs'
import { claudeChatColumn, claudeStatusText } from './ClaudeChat.mjs'
// The composer's pasted/dragged images. The module owns the upload + the
// pending state; this file only decides WHICH bucket a send empties and which
// Signal the resulting ids ride on — see "Afbeeldingen meesturen" in
// .claude/docs/claude-chat-panel.md.
import {
  hasPendingAttachments,
  restorePendingAttachments,
  takePendingAttachments,
} from './chatAttachments.mjs'
import { loadDraft, saveDraft, clearDraft } from './draftStorage.mjs'
import { codePreviewColumn } from './CodePreview.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { syncCommentBatch, batchProgressFor, batchNoteFor } from './commentBatch.mjs'
import {
  isChatUnread,
  lastAssistantMessageAt,
  setChatUnread,
  dropChatUnreadCache,
  markChatSeenOnServer,
} from './chatUnread.mjs'
import {
  anyRecentlyFinishedTurn,
  anyTurnRunning,
  clearTurnAnswered,
  isTurnBusy,
  isTurnRecentlyFinished,
  lastTurnProgressAt,
  loadRunningTurns,
  markTurnAnswered,
  recentlyFinishedTurnIds,
  runningTurnIds,
  setTurnBusy,
  setTurnProgress,
  setTurnScopes,
  setTurnSendError,
  turnProgress,
  turnSendError,
} from './claudeTurns.mjs'
import { colWidthStyle, startColumnResize, resetColumnWidth, resizeHandle, parseAutoWidthPx } from './columnWidth.mjs'
import { autoGrowTextarea, resetTextareaHeight } from './textareaAutoGrow.mjs'
import { updateScrollHints, refreshScrollHints } from './scrollFade.mjs'
import { setCommentArrows } from './callArrows.mjs'

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
  // previewPos is the keyboard cursor over the code-preview cards stacked
  // BELOW the comment/Claude row (cp.items / CodePreview.mjs): 0 = not in
  // them (the composer/transcript owns the cursor), 1..n = the n-th card
  // counted from the TOP, i.e. in reading/document order. Counting from the
  // top instead of from the bottom (threadPos/claudePos/claudeOptionSel all
  // count from the bottom) is the mirror-correct choice here: those chains
  // are walked UPWARD out of the composer, this one DOWNWARD out of it, so
  // "1" is in both cases the rung closest to the composer. Only meaningful
  // while cs.focus === 'claude' (reviewer request: "als vanuit een claude
  // chat andere blokken zijn die te maken hebben met de chat, dan wil ik
  // daar doorheen kunnen gaan met mijn keys naar beneden en naar boven") —
  // see handleRelatedKey's 'claude' branch. Reached only AFTER
  // claudeTasksPos below has been walked through (or immediately if there
  // are no other running tasks to show) — matching the on-screen order,
  // where the "Andere chats in deze PR" block renders above these cards. Reviewer
  // report: ↓ used to reach these cards BEFORE claudeTasksPos, so "Ook bezig
  // elders" was only reachable after walking past every code block first.
  // Deliberately NOT bound to the URL, like claudeOptionSel/chipPath above:
  // cp.items is derived from the rendered DOM (recomputeCodePreviews'
  // MutationObserver) rather than from loaded data, so restoring this would
  // need its own re-apply pass in applyRelRestore for a purely ephemeral
  // highlight.
  previewPos: 0,
  // claudeTasksPos is the rung ABOVE previewPos in the SAME chain (↓ from the
  // composer reaches this one FIRST): 0 = not there, 1..n = the n-th OTHER
  // running Claude conversation in this PR (top to bottom, mirrors
  // previewPos' own top-to-bottom counting — walked BEFORE previewPos, or
  // immediately if there is no anchored comment yet — see handleRelatedKey's
  // 'claude' branch and otherClaudeChats below).
  // Enter jumps to that conversation's own code/comment
  // (selectHighlightedClaudeTask). Deliberately NOT bound to the URL, same
  // reasoning as previewPos/claudeOptionSel: this walks other people's live,
  // constantly-changing turns, not a navigation position worth restoring
  // after a refresh.
  //
  // ALSO meaningful while cs.focus === 'tasks' (see enterFooterTasks below) —
  // the same rung, reached without any anchored comment/claude conversation at
  // all, straight from the panel's own top boundary ('code''s first child, or
  // 'thread''s oldest message on the first conversation) whenever the
  // footer-only card (CommentClaudeFooter, hasCommentClaudeFooter() true,
  // claudeChatVisible() false) has other tasks to show. Reviewer report: with
  // no comment on the current unit, ↑ used to leave the panel immediately
  // instead of ever reaching that list.
  claudeTasksPos: 0,
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
  // (exitRelated, e.g. Escape — there is no more explicit "Annuleer" button).
  // It changes three things and nothing else:
  // the composer header/placeholder (no meaningless file:line — see
  // newCommentComposer), placeComment's write (Kind "issue", no anchor), and
  // the surrounding layout (home.mjs/BlockList.mjs hide the pr-index and the
  // block column while it's true — see detail-layout.md). Reactive so those
  // bindings repaint; deliberately NOT bound to the URL, like cs.focus
  // itself.
  prWideCompose: false,
  // generalOverlay — true while the general-chat overlay (generalChatOverlay.mjs)
  // is showing this PR's general conversation full-screen. Reactive because the
  // tree's own Claude column hides on it: the overlay renders the SAME `cc`, so
  // both at once is a visible duplicate behind a partly transparent overlay.
  // Set through setGeneralChatOverlayVisible below (the overlay imports this
  // module, never the other way round).
  generalOverlay: false,
  // rangeCompose marks the composer/Claude chat as opened for a Shift-arrow
  // multi-row selection in the index/methodes-kolom ("Plaats comment over dit
  // bereik" / "Chat met Claude over dit bereik", rangeCommandsFor in
  // home.mjs) — set by startRangeComment/startRangeChat below, cleared by
  // every ordinary composer open (toNew) and every composer exit (exitRelated,
  // e.g. Escape), same lifecycle as prWideCompose. Unlike prWideCompose the
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

// codeFromClaudeTail — plain module state, not reactive — marks that the
// Onderliggende-code panel ('code') was entered via enterRelatedFromClaudeChat
// (a drilled column's ↓ exhausting the chat's own code-preview cards, see
// home.mjs's 'advance' handling) rather than the ordinary → from the diff or
// ↓ falling through the last comment (advanceFromComment). Consumed exactly
// once by handleRelatedKey's ↑-on-the-first-child branch, which uses it to
// step back into 'claude' at its own tail (the same card the reviewer just
// left) instead of the ordinary enterCommentsTail()/exitRelated() landing.
// enterRelated() always clears it first, so every other way of reaching
// 'code' is unaffected.
//
// codeFromClaudeTailPreviewPos captures codePreviewCount() at the MOMENT
// enterRelatedFromClaudeChat runs — not re-read later, when ↑ is actually
// pressed. This matters: entering 'code' collapses the comment card back to
// its compact rendering (commentCard's own expanded-iff-cs.focus-is-comment/
// thread/claude rule), which drops its fence(s) out of the DOM — so
// recomputeCodePreviews' MutationObserver empties cp.items shortly after
// (asynchronously, on its own rAF). A later, fresh codePreviewCount() read
// (once the reviewer has actually pressed ↑) reliably reads 0 by then, which
// would always send them to the composer instead of back onto the exact card
// they left. Reading it once, synchronously, right as the drilled column's
// own code-preview cards are still expanded/rendered avoids that race.
let codeFromClaudeTail = false
let codeFromClaudeTailPreviewPos = 0

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
  const isNone = !!(scope && scope.none)
  // onlyIds is appended to the signature (not just the file/label/gran/row
  // fields) because two DIFFERENT "Comments op regels" rows anchored to the
  // exact same source line — now that commentGroupKeyOf no longer merges
  // them into one row, see "Comment-index rows: grouping per source line was
  // reverted" in comments-panel.md — resolve to an otherwise IDENTICAL
  // signature (same file/label/gran/rowStart/rowEnd/seg, since they sit on
  // the same unit): only onlyIds tells the two selections apart. Without
  // this, stepping from one such row to the other left cs.view (and thus the
  // right-hand comment card) stuck on the FIRST comment's id forever, since
  // the dedup below short-circuited before recomputeView ever re-read the
  // new onlyIds.
  const sig = !scope
    ? ''
    : isNone
      ? 'none'
      : [scope.file, scope.label, scope.mode, scope.gran, scope.rowStart, scope.rowEnd, scope.seg].join('|') +
        '|' +
        (scope.onlyIds ? scope.onlyIds.join(',') : '')
  // The 'none' sentinel is NEVER deduped by signature, unlike the real-scope
  // join below. Every unanchored comment-index item (PR-wide/orphan/
  // ai_warning) shares that exact same bare signature regardless of WHICH
  // comment it carries or whether that comment's own fields (a title
  // arriving on a later poll, a status change) just changed — so deduping
  // on it would leave cs.scope.prComment stuck on a stale object, either
  // across two different such items selected back to back, or across a
  // poll landing while the reviewer stays on the very same one. Cheap to
  // always let through: recomputeView's own `s.none` branch is O(1)
  // (cs.view = []), unlike the real-scope case, where this signature exists
  // specifically to skip an expensive cs.list re-filter on an unrelated
  // reactive tick. See "The comment-detail card moved into the merged
  // comment-claude-row" in comments-panel.md.
  if (!isNone && sig === cs.scopeSig) return
  cs.scopeSig = sig
  cs.scope = scope
  recomputeView()
}

// commentUnder reports whether comment c sits at or below the selected unit t in
// the same block: c's aligned-row range ⊆ t's range, OR c starts on exactly the
// same row as t (a group/multi-line comment stays reachable from its own FIRST
// row, e.g. after narrowing from group to line granularity — its rows all carry
// a 💬 marker, see commentRowSet, so it must not become unreachable there);
// and — when BOTH t and c are a single 'call' segment — the same call (seg).
// Deliberately NOT plain overlap: a wide comment must not surface under every
// row it happens to span, only under its start row (which is where the
// reviewer anchored it).
//
// A comment with an unknown anchor (rowStart < 0) has no aligned row left to
// contain, so the containment check above cannot run. Two different cases:
// - **`isStaleAnchor(c)`** (`anchorState === 'unpinned'`, reanchor.go): it
//   USED TO have a real row and lost it. It still carries the real source
//   `line` it once anchored on (see createComment/commentTarget's
//   startLine), so this falls through to `lineMatchesUnit`, a best-effort
//   match of that line against unit `t`'s own real line range. Reindert, on
//   an unpinned comment's "N hierboven" hint showing on every unrelated unit
//   of the block: "best-effort matchen op regel 157" — see "Best-effort line
//   matching for an unpinned comment" in comments-panel.md.
// - Every other rowStart < 0 comment (never anchored to any row in the first
//   place — a genuinely block-level comment, or a test fixture seeding a
//   plain `rowStart: -1` placeholder) keeps the ORIGINAL "shown within every
//   unit of this block" leniency: unlike an unpinned comment, its `line`
//   never meant "the exact row this was about" to begin with, so there is
//   nothing to best-effort match against.
//
// The seg check is deliberately limited to a comment that is ITSELF anchored on
// a call segment, because the filter is CONTAINMENT — call ⊂ line ⊂ group (see
// commentTarget in home.mjs, which stores exactly that). A line/group comment
// covering this row is about the whole line, so it stays reachable while the
// cursor zooms into one call inside that line; only another CALL's comment is
// out of scope. Reported bug: standing on the very `trans(...)` call an AI risk
// finding was written about (gran 'line', same row) made that finding disappear
// from the comment column — while its ⚠ badge stayed on the row, so the
// reviewer saw the marker and could not reach the comment. `s`/call
// granularity is exactly where a reviewer lands when approving that call, so
// this was the one granularity that hid a comment anchored on its own row.
//
// A comment that still fails all of the above (a real anchor, elsewhere in
// this block) gets one more, narrow fallback: shown while the selected unit
// is exactly the block's own first changed group. See the "pin to the first
// changed row" paragraph in comments-panel.md.
function commentUnder(c, t) {
  if (c.rowStart == null || c.rowStart < 0) return isStaleAnchor(c) ? lineMatchesUnit(c, t) : true
  if (c.rowStart !== t.rowStart && (c.rowStart < t.rowStart || c.rowEnd > t.rowEnd)) {
    // Fallback: a comment that is fully DISJOINT from the selected unit (it
    // sits on a genuinely different group of this block, no row overlap at
    // all) is still shown while the selection is exactly the block's own
    // FIRST changed group — the point most reviewers land on right after
    // stepping into the diff — so it doesn't simply vanish the moment scoping
    // narrows past its own real row. Deliberately does NOT follow any
    // further: a different (non-first) group, or narrowing this same first
    // group to line/call granularity, both fall through to the ordinary
    // `false` below. Reindert: "op de eerste aangepaste regel plaatsen,
    // dieper moet niet mee". Deliberately NOT for a comment that merely
    // OVERLAPS the unit without starting on it (c.rowEnd >= t.rowStart &&
    // c.rowStart <= t.rowEnd) — that is the pre-existing, deliberate
    // start-row-only exclusion above (see comment-range-first-row.spec.mjs),
    // and this fallback must not quietly override it just because the
    // overlapping unit happens to be the first group.
    const disjoint = c.rowEnd < t.rowStart || c.rowStart > t.rowEnd
    return disjoint && t.gran === 'group' && t.firstGroupRowStart != null && t.rowStart === t.firstGroupRowStart
  }
  if (t.gran === 'call' && c.gran === 'call') return c.seg === t.seg
  return true
}

// LINE_MATCH_SLACK — a small tolerance (in source lines) for lineMatchesUnit
// below. The comment's own recorded `line` was exact AT THE TIME it was
// placed; by the time its row can no longer be re-found (isStaleAnchor), the
// file has moved on, so an EXACT containment check would reject a unit that
// is still, in practice, "the same spot" (Reindert: "matchen op regel 157
// (ongeveer)"). 2 is deliberately small — just enough to absorb the kind of
// off-by-a-line drift a nearby edit causes, not enough to reattach a comment
// to a genuinely different part of the function.
const LINE_MATCH_SLACK = 2

// lineMatchesUnit reports whether line `n` falls (within LINE_MATCH_SLACK)
// inside the [start, end] range — false when the range itself is unknown
// (0/0, that side has no rows in the unit — see unitBothLineRanges) or `n`
// isn't a real line number.
function lineWithin(n, start, end) {
  return !!n && !!start && !!end && n >= start - LINE_MATCH_SLACK && n <= end + LINE_MATCH_SLACK
}

// lineMatchesUnit — the best-effort scoping for a comment whose own aligned
// row is gone (rowStart < 0: unpinned by reanchor.go, or legacy/seeded with
// none recorded at all). It has no row to contain any more, but it still
// carries the real source `line` it was placed on (see createComment/
// commentTarget's startLine) — this matches that line against unit t's own
// real line range, on EITHER side (t.oldStartLine/oldEndLine or
// t.newStartLine/newEndLine — c.line's own side isn't recorded, see
// createComment, so both are tried).
//
// Two deliberate escape hatches back to "show at every unit", both matching
// the PRE-existing behavior for a case this can't meaningfully scope:
// - `t` carries no line-range info at all (every one of the four fields is
//   0) — commentTarget's own "block has no navigable unit" fallback, where
//   there is no real per-unit line range to compare against either.
// - `c.line` itself is falsy — a genuinely legacy/seeded comment recorded
//   with no source line at all has nothing to best-effort match against.
function lineMatchesUnit(c, t) {
  if (!t.oldStartLine && !t.oldEndLine && !t.newStartLine && !t.newEndLine) return true
  if (!c.line) return true
  return (
    lineWithin(c.line, t.oldStartLine, t.oldEndLine) || lineWithin(c.line, t.newStartLine, t.newEndLine)
  )
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
  } else if (!s) {
    cs.view = anchored
  } else {
    const inBlock = anchored.filter((c) => c.file === s.file && c.label === s.label)
    let scoped = s.mode !== 'diff' || s.rowStart < 0 ? inBlock : inBlock.filter((c) => commentUnder(c, s))
    // s.onlyIds — set only while a "Comments op regels" index item's own
    // drilled anchor column owns the cursor (home.mjs's commentScope/
    // isCommentAnchorDrillActive): narrows the view down to exactly that
    // row's own comment(s), so a DIFFERENT comment thread that happens to
    // land under the same containment check (commentUnder) never shows next
    // to it. See "Comments op regels shows only its own comment" in
    // comments-panel.md.
    if (s.onlyIds) scoped = scoped.filter((c) => s.onlyIds.includes(c.id))
    cs.view = scoped
  }
  // One arrow per currently-rendered comment card, row → card — see
  // "Linking a comment card to its diff row" in comments-panel.md. Pushed
  // from here (not a separate watch) so it always stays in lockstep with
  // cs.view, whatever changed it (a scope move OR a comment list poll).
  setCommentArrows(
    cs.view
      .filter((c) => c.rowStart != null && c.rowStart >= 0)
      .map((c) => ({ row: c.rowStart, commentId: c.id })),
  )
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

// expandedCommentIndex is the index (within visibleComments()) of the ONE card
// that currently renders expanded — the exact same predicate commentCard uses
// below, in the same order, so the two can never disagree. -1 while nothing is
// expanded (the keyboard is on the diff, on 'code', or in the new-comment
// composer).
//
// Compared by id for the 'claude' case, not by index: chatAnchorComment() has
// its own fallback (an orphan/PR-wide comment whose conversation already has
// turns) that can point outside the current selection index — see its own doc
// comment.
function expandedCommentIndex() {
  if (cs.focus === 'comment' || cs.focus === 'thread') return selComment() ? selI() : -1
  if (cs.focus === 'claude') {
    const a = chatAnchorComment()
    return a ? visibleComments().findIndex((c) => c.id === a.id) : -1
  }
  return -1
}

// hiddenAboveCount — how many comment cards InlineComments leaves out above
// the expanded one. Reviewer request: "als je een comment selecteert hebt, dan
// wil ik de bovenstaande comments hiden, je mag een pijltje gebruiken om aan
// te geven dat er meer comments boven staan". This is the SINGLE source both
// the card filter and the ▲ hint read, so "what is hidden" and "what the hint
// claims" cannot drift apart.
//
// Deliberately derived from the EXPANDED card, not from the cursor: the card
// stays expanded once the keyboard moves on into the Claude column
// (cs.focus === 'claude', see commentCard), and re-showing the cards above at
// that moment would jump the whole column.
//
// While NOTHING is expanded yet (the diff still owns the keyboard, or the
// new-comment composer is open), a LEADING run of stale (isStaleAnchor)
// comments is folded too — reviewer request: "een verouderde comment mag
// nooit standaard zichtbaar zijn naast de diff, ook niet als ik nog niet
// naar de comments genavigeerd ben; hij mag alleen verscholen zitten achter
// het bestaande 'N hierboven'-label". An unpinned comment's row is unknown
// (see reanchor.go), so commentUnder falls back to a best-effort match on its
// recorded source line (see lineMatchesUnit) rather than row containment —
// without this fold it would sit there in full, at rest, on whichever unit
// that best-effort match happens to land on (the reported bug). Only a
// LEADING run: a stale comment that isn't first in
// visibleComments() already sits below whatever real comment came before it
// and keeps rendering as an ordinary (if field-reduced, see
// compactConversation) card — see "A stale (unpinned) comment is always
// folded..." in comments-panel.md for why a full reorder wasn't needed.
//
// Exception: cs.scope.onlyIds (a "Comments op regels" index item's own
// anchor drill, see isCommentAnchorDrillActive/commentAnchorOnlyIds in
// home.mjs) already narrows visibleComments() down to exactly the comment(s)
// that row stands for, and commentCard's own isAnchorOnlyComment forces a
// FULL thread for every one of them regardless of staleness — "als ik een
// comment in de blokken index selecteer, wil ik die altijd rechts zien, niet
// ingeklapt" (reviewer report). Folding it here anyway, purely because it
// happens to be stale, hid the very card that override exists to force open
// — the render loop below never even reaches isAnchorOnlyComment, since it
// starts at `i = hidden`. So a stale comment only ever folds in the ordinary,
// unscoped rest-position view, never while onlyIds has already scoped the
// list down to it on purpose.
function hiddenAboveCount() {
  const exp = expandedCommentIndex()
  if (exp >= 0) return exp
  if (cs.scope && cs.scope.onlyIds) return 0
  const list = visibleComments()
  let n = 0
  while (n < list.length && isStaleAnchor(list[n])) n++
  return n
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
    // Same exclusion as recomputeView's own `anchored` filter: an orphan lost
    // the code it was anchored to and is deliberately NOT in the block-scoped
    // index (it gets a "Start" row of its own, see indexComments). Marking a
    // row for it would promise a comment no cursor position can ever reach —
    // the marker layer and the index must never disagree about what exists.
    if (isOrphanComment(c)) continue
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
    // Orphan: excluded for the same reason as in commentRowSet/recomputeView —
    // it is not in the block-scoped index, so counting it here would badge a
    // line with an indicator that leads nowhere.
    if (isOrphanComment(c)) continue
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
export function alignToTopVertical(el) {
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
  cs.focus = 'code'
  cs.codeSel = 0
  cs.chipPath = []
  codeFromClaudeTail = false
  scrollCodeIntoView()
}

// enterRelatedFromClaudeChat is enterRelated's counterpart for a drilled
// column's own 'advance' sentinel (see handleRelatedKey's 'claude'-focus
// ArrowDown branch and home.mjs's onKeydown, which calls this instead of
// advanceToNextBlockFromClaudeChat while state.focusLevel > 0): exhausting a
// drilled unit's own Claude code-preview cards continues into THAT SAME
// unit's Onderliggende-code panel (its next sibling child, e.g.
// FindFirstSessionActivity::run below SessionFlow::run's own Claude
// conversation) instead of jumping the TOP-LEVEL block selection — reported
// bug: ↓ there landed on an unrelated block elsewhere in the PR. Marks
// codeFromClaudeTail so ↑ from the first child returns to the exact card the
// reviewer left, see that flag's own doc comment. Reads codePreviewCount()
// FIRST, before enterRelated() flips cs.focus away from 'claude'/'comment' —
// see codeFromClaudeTailPreviewPos's own doc comment for why that ordering
// is load-bearing.
export function enterRelatedFromClaudeChat() {
  codeFromClaudeTailPreviewPos = codePreviewCount()
  enterRelated()
  codeFromClaudeTail = true
}

// exitRelated releases the keyboard back to the diff and drops any input focus /
// half-typed new comment. Exported as leaveRelated for home.mjs: drillIntoChild
// calls it to hand a freshly-drilled column's keyboard to its own diff instead
// of landing on its Onderliggende-code panel (see the "Drillen" flow).
function exitRelated() {
  cs.focus = null
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
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  releaseFocus() // a focus request still in flight must not land after this
  // Only blur a field that actually lives INSIDE the detail panel (the
  // composer/reply field this function means to drop) — never whatever else
  // happens to hold DOM focus elsewhere on the page. This watch
  // (state.selected in home.mjs) also fires when the reviewer TYPES in the
  // blocks-index search box (setSearch resets state.selected), which made
  // document.activeElement the search box itself and blurred it after every
  // single keystroke — reported bug: "ik kan niet in de blokken index search
  // iets typen, want de focus gaat er gelijk uit als ik type".
  const el = document.activeElement
  const panel = document.querySelector('[data-testid="detail-panel"]')
  if (el && el.blur && panel && panel.contains(el)) el.blur()
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

// dsKey builds the localStorage key for one of the draft kinds below —
// prefixed with cs.pr (draftKeyFor/a comment id alone carry no PR identity,
// so two different PR's happening to share a file+label could otherwise
// collide) — see draftStorage.mjs's own doc comment for why localStorage and
// not the URL.
function dsKey(kind, id) {
  return kind + ':' + cs.pr + ':' + id
}

// getComposeDraft/setComposeDraft/deleteComposeDraft (and their reply/
// prReplyDraft/claudeDraft siblings below) are composeDrafts/replyDrafts/
// prReplyDrafts/claudeDrafts' only access points from here on — they keep
// the existing in-memory Map (same-session, instant) as the primary read,
// and fall back to the persisted localStorage copy (draftStorage.mjs) only
// when the Map itself has nothing, which is exactly the "just refreshed the
// page" case. A value found in storage is written back into the Map too, so
// the rest of this file's existing Map-based logic (never touched below)
// keeps working unchanged for the remainder of the session.
function getComposeDraft(key) {
  let v = composeDrafts.get(key)
  if (v == null) {
    v = loadDraft(dsKey('new', key))
    if (v) composeDrafts.set(key, v)
  }
  return v
}
function setComposeDraft(key, text) {
  composeDrafts.set(key, text)
  saveDraft(dsKey('new', key), text)
}
function deleteComposeDraft(key) {
  composeDrafts.delete(key)
  clearDraft(dsKey('new', key))
}

function getReplyDraft(id) {
  let v = replyDrafts.get(id)
  if (v == null) {
    v = loadDraft(dsKey('reply', id))
    if (v) replyDrafts.set(id, v)
  }
  return v
}
function setReplyDraft(id, text) {
  replyDrafts.set(id, text)
  saveDraft(dsKey('reply', id), text)
}
function deleteReplyDraft(id) {
  replyDrafts.delete(id)
  clearDraft(dsKey('reply', id))
}

function getPrReplyDraft(id) {
  let v = prReplyDrafts.get(id)
  if (v == null) {
    v = loadDraft(dsKey('prreply', id))
    if (v) prReplyDrafts.set(id, v)
  }
  return v
}
function setPrReplyDraft(id, text) {
  prReplyDrafts.set(id, text)
  saveDraft(dsKey('prreply', id), text)
}
function deletePrReplyDraft(id) {
  prReplyDrafts.delete(id)
  clearDraft(dsKey('prreply', id))
}

// claudeDrafts mirrors composeDrafts/replyDrafts for the SEPARATE embedded
// Claude chat composer (claude-chat-compose, ClaudeChat.mjs) — a field that,
// unlike every other composer here, is NOT anchor-keyed in its own DOM node:
// its mounted card is keyed only on read-only/read-write
// ('claude-chat-column:ro'/'rw', see ClaudeChatPanel), never on
// cc.commentId, so switching between two already-anchored conversations
// reuses the very same <textarea> instead of remounting a fresh, empty one.
// claudeChatDraftKey() is therefore read fresh on every restore rather than
// tracked in a variable like composeDraftKey: it mirrors whichever identity
// is authoritative right now — the real comment id once a conversation is
// anchored (cc.commentId), else the same composeDraftKey-style anchor
// identity a not-yet-anchored "chat before placing a comment" draft uses
// (see enterClaudeChatFromNew) — so a restore always resolves the SAME key
// composeDraftKey/cc.commentId would.
const claudeDrafts = new Map()
// attachmentOnlyBody mirrors chatAttachmentOnlyBody (chat_attachment.go) —
// the placeholder body a turn gets when the reviewer sent nothing but images.
// A literal duplicate across the two languages, the same precedent as
// CHECKOUT_CHOICE_OPEN_BODY above: keep the two in sync.
function attachmentOnlyBody(n) {
  return n > 1 ? '(afbeeldingen)' : '(afbeelding)'
}

function claudeChatDraftKey() {
  return cc.commentId != null ? 'id:' + cc.commentId : 'new:' + composeDraftKey
}
function getClaudeDraft(key) {
  let v = claudeDrafts.get(key)
  if (v == null) {
    v = loadDraft(dsKey('claude', key))
    if (v) claudeDrafts.set(key, v)
  }
  return v
}
function setClaudeDraft(key, text) {
  claudeDrafts.set(key, text)
  saveDraft(dsKey('claude', key), text)
}
function deleteClaudeDraft(key) {
  claudeDrafts.delete(key)
  clearDraft(dsKey('claude', key))
}

// restoreClaudeComposerDraft writes whatever draft matches the CURRENT
// claudeChatDraftKey() into the composer field — unlike every other
// composer's own "only prefill when there IS a draft" convention, this one
// must also actively CLEAR the field to '' when there is none, precisely
// because (per claudeDrafts' own doc comment) the DOM node is reused across
// conversations rather than remounted: without an explicit clear, switching
// from a conversation with unsent text to one with none would leave the
// PREVIOUS conversation's text sitting in the field — exactly the "must not
// travel to a different block" rule this feature exists to uphold, just one
// level deeper (a different Claude conversation instead of a different
// block/URL). retryLeft mirrors prefillField's own mount-not-ready retry
// (the composer may not be in the DOM yet on the very same tick this is
// called, e.g. right as the column first becomes visible) but — unlike
// prefillField — never calls .focus(): this fires on ordinary ↑/↓
// navigation, long before the reviewer has chosen to enter the Claude
// column at all, and must not steal the keyboard.
function restoreClaudeComposerDraft(retryLeft = FOCUS_FRAMES) {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=claude-chat-compose]')
    if (!el) {
      if (retryLeft > 0) restoreClaudeComposerDraft(retryLeft - 1)
      return
    }
    const text = getClaudeDraft(claudeChatDraftKey()) || ''
    if (el.value === text) return
    el.value = text
    autoGrowTextarea(el)
  })
}

// placeholderAnchorFor finds an EXISTING chat-anchor placeholder comment
// (see isChatAnchorPlaceholder) whose own anchor identity matches the given
// draftKey — i.e. draftKeyFor(c) === draftKey, reusing that same function
// since a stored comment carries the exact same file/label/gran/rowStart/
// rowEnd/seg fields commentTarget() does. Used by placeComment (below) to
// silently take over such a comment instead of creating a second one when
// the reviewer types their first real text on a line that already only has
// a Claude conversation on it — see "Overname zonder extra menu-item" in
// claude-chat-panel.md. Deliberately identity-based (the anchor's own
// fields), not the ephemeral claudeAutoAnchor session flag: that flag only
// ever matches within the SAME toNew() session that lazily created the
// anchor (ensureClaudeAnchorForNew) — closing the panel and reopening
// "Comment op deze regel" later on the exact same line used to fall through
// to createComment and post a SECOND, unrelated comment right next to the
// placeholder.
function placeholderAnchorFor(draftKey) {
  return cs.list.find((c) => isChatAnchorPlaceholder(c) && draftKeyFor(c) === draftKey) || null
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
  cs.focus = 'new'
  composeDraftKey = draftKeyFor(commentTargetFn ? commentTargetFn() : null)
  focusEl('[data-testid=comment-compose]')
  const draft = getComposeDraft(composeDraftKey)
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
  // Deliberately NOT clearing the previous conversation's live turn, busy
  // state or sendError: they keep living per conversation (claudeTurns.mjs,
  // keyed by the OLD commentId, not null), so the previous conversation stays
  // visible as an index pill / keeps its own sentence instead of vanishing
  // with this reset. ccSendError() below already reads '' for this fresh,
  // still-unanchored `cc.commentId === null` composer.
  // The embedded Claude composer's own draft (see claudeDrafts' doc
  // comment) must be resynced too, right here — the field can already be
  // visible (isNewChatUnanchored()) while cc.commentId was JUST reset to
  // null above, and its DOM node is reused across anchors rather than
  // remounted, so it would otherwise keep showing whatever the PREVIOUS
  // unit's Claude draft was.
  restoreClaudeComposerDraft()
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
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  focusEl('[data-testid=comment-compose]')
  const draft = getComposeDraft(composeDraftKey)
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
  cs.focus = 'comment'
  cs.threadPos = 0
  cs.threadPinned = true
  cs.claudeOptionSel = 0
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  scrollCommentIntoView()
  scrollCommentThreadToBottom()
  if (focusInput) {
    focusEl('[data-testid=reaction-compose]')
    // Restore whatever reply the reviewer was mid-typing on THIS comment
    // before navigating away (see replyDrafts above) — same mechanism/
    // reasoning as the new-comment composer's own composeDrafts.
    const c = selComment()
    const draft = c && getReplyDraft(c.id)
    if (draft) prefillField('[data-testid=reaction-compose]', draft)
  }
}

// hasVisibleComments reports whether the currently selected unit carries at
// least one comment conversation that is actually REACHABLE right now — the
// gate home.mjs' → (from the diff) uses before entering the inline comment
// block: it's only a REACHABLE stop via → when it actually has something to
// show (see keyboard-navigation.md). Deliberately `> hiddenAboveCount()`, not
// `> 0`: a unit whose only comment(s) are a stale, folded-away leading run
// (see hiddenAboveCount) has nothing AT REST to show either — → and the
// embedded Claude column (claudeChatVisible()) both skip straight past it,
// same as a genuinely comment-less unit; the stale comment stays reachable
// only through the "N hierboven" hint's own click handler, never through the
// ordinary ←/→/↑/↓ chain. See "A stale (unpinned) comment is always folded
// behind the ▲ hierboven hint" in comments-panel.md.
export function hasVisibleComments() {
  return visibleComments().length > hiddenAboveCount()
}

// hasAnyComments — unlike hasVisibleComments() above, this counts a comment
// EVEN WHILE it sits folded behind the "N hierboven" hint (hiddenAboveCount):
// "is there anything for InlineComments to render here at all", not "is
// something reachable at rest". A fully-stale (isStaleAnchor) unit still has
// exactly that hint to show — home.mjs's comment-claude-row wrapper and
// relatedColumnIsEmpty() (this file) both need this broader question, or the
// whole row (hint included) would hide itself as "nothing to show" the
// moment the only comment in scope became unreachable at rest, making the
// hint's own promised navigation route dead. See "A stale (unpinned)
// comment is always folded..." in comments-panel.md.
export function hasAnyComments() {
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
//
// A STALE (unpinned, isStaleAnchor) index-0 comment gets the exact same
// treatment, for the same reason: hasVisibleComments() only asks whether
// something is reachable AT ALL (it already excludes a unit whose comments
// are *entirely* a stale leading run, see hasVisibleComments' own doc
// comment) — it does NOT guarantee list[0] itself isn't stale, since a
// stale comment mixed in ahead of a real one on the SAME unit still sits at
// index 0 of visibleComments() even though hiddenAboveCount() folds it out
// of the at-rest rendering. Without this, → would land the reviewer
// straight on the very card the fold is meant to hide. Reviewer request:
// "als ik naar rechts ga, wil ik niet dat een verouderde comment gelijk
// geselecteerd is, selecteer eerst een comment eronder of een onderliggend
// codeblok" — see "A stale (unpinned) comment is always folded..." in
// comments-panel.md.
export function enterCommentsOrRelated(pr) {
  // cs.scope.onlyIds — a "Comments op regels" index item's own drilled
  // anchor column (see commentScope/isCommentAnchorDrillActive in
  // home.mjs). Reviewer request: "als ik dus 2x naar rechts ga, wil ik
  // altijd in die comment blok zitten" — the resolved/stale skip logic
  // below exists for ordinary code navigation, where landing on a DIFFERENT
  // comment or Underlying code instead is genuinely useful; here the whole
  // point of the row is this one comment, so → always lands on it
  // unconditionally, never skips past it.
  if (cs.scope && cs.scope.onlyIds && hasVisibleComments()) {
    enterCommentsHead()
    return
  }
  if (hasVisibleComments()) {
    const list = visibleComments()
    if (list[0].status !== 'resolved' && !isStaleAnchor(list[0])) {
      enterCommentsHead()
      return
    }
    // The default landing comment is resolved or stale — skip to the next
    // still-open, non-stale one if this unit has one (not necessarily
    // adjacent: a run of several resolved/stale comments ahead of it is
    // skipped in one step).
    const next = list.findIndex((c) => c.status !== 'resolved' && !isStaleAnchor(c))
    if (next >= 0) {
      cs.sel = next
      toComment()
      return
    }
    // Every comment on this unit is resolved/stale — try Underlying code instead.
    if (rc.children.length > 0) {
      enterRelated()
      return
    }
    // Nothing else to land on: show the resolved/stale comment anyway.
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
// naar het onderliggende-code-blok"). Reviewer request: when the unit's own
// Claude conversation has an "andere chats in deze PR" rung or code
// blocks of its own (otherClaudeChats / cp.items, walked by
// cs.claudeTasksPos / cs.previewPos — see "↓ walks the chat's own code
// blocks" in claude-chat-panel.md), walk those FIRST, exactly like ↓ already
// does from the chat's own rest position (tasks before cards, matching their
// on-screen order) — instead of skipping straight to Onderliggende code.
// This only changes the ENTRY point: once inside 'claude', the existing
// claudeTasksPos/previewPos/claudePos handling in handleRelatedKey is
// unchanged (further ↓ keeps walking the rest of that chain, then falls
// through exactly as it already does from there).
function advanceFromComment() {
  if (selI() < visibleComments().length - 1) {
    cs.sel += 1
    toComment()
  } else if (otherClaudeChats().length > 0) {
    cs.focus = 'claude'
    cs.claudeTasksPos = 1
    focusClaudeTaskRow()
  } else if (codePreviewCount() > 0) {
    cs.focus = 'claude'
    cs.previewPos = 1
    focusPreviewCard()
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
  const reactions = c.reactions || []
  // A bare Claude-chat anchor (isChatAnchorPlaceholder) whose reviewer has
  // since replied on its thread is taken over here: reviewer's own words,
  // "het is eigenlijk niet een reactie, het is een eerste comment (en er was
  // toevallig een claude gesprek)" — that reply IS the reviewer's real first
  // comment, not a reply to the synthetic placeholder root. Promoting it to
  // the front and dropping the placeholder origin means every consumer of
  // threadMessages (reactionCount, the ↑/↓ thread walk, editTargetId, every
  // render loop) sees exactly the messages a reviewer actually wrote, with
  // no separate "taken over" branch anywhere else. See "A taken-over
  // Claude-chat anchor reads as an ordinary comment" in comments-panel.md.
  const takeoverIdx = isChatAnchorPlaceholder(c) ? firstReviewerReplyIndex(reactions) : -1
  if (takeoverIdx === -1) return [origin, ...reactions]
  return [reactions[takeoverIdx], ...reactions.slice(0, takeoverIdx), ...reactions.slice(takeoverIdx + 1)]
}

// firstReviewerReplyIndex — the first reaction that is a genuine reviewer-
// authored reply: not a "/resolve"/"/reopen" status sentinel (threadStatusSentinel),
// and not a foreign/AI one (isOwnMessage) — confirmed scope: only the
// reviewer's OWN first reply takes an anchor over, never a Claude message
// (which lives in the chat transcript, not in c.reactions, anyway) or a
// GitHub reply from someone else.
function firstReviewerReplyIndex(reactions) {
  for (let i = 0; i < reactions.length; i++) {
    const r = reactions[i]
    if (threadStatusSentinel(r.body)) continue
    if (!isOwnMessage(r)) continue
    return i
  }
  return -1
}

// firstReviewerReplyOnPlaceholder — exported for callers outside the thread
// itself (the index-row label/snippet, the reaction-count meta line, the
// resolve/unresolve menu gate) that need to know whether a bare Claude-chat
// anchor has already been taken over, without re-deriving threadMessages'
// own reordering.
export function firstReviewerReplyOnPlaceholder(c) {
  if (!isChatAnchorPlaceholder(c)) return null
  const idx = firstReviewerReplyIndex(c.reactions || [])
  return idx === -1 ? null : c.reactions[idx]
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
  return t(' · {name} reageerde', { name: displayNameOf(last.author) })
}

// reactionCount is the number of bubbles the thread renders (opening + reactions)
// — the upper bound the keyboard walks to when stepping up through the history.
function reactionCount() {
  return threadMessages(selComment()).length
}

// commentItemEl finds a comment's own rendered card by id — see
// hiddenAboveCount for why an index into the comment-item NodeList is wrong.
function commentItemEl(c) {
  if (!c) return null
  return document.querySelector('[data-testid=comment-item][data-comment-id="' + CSS.escape(String(c.id)) + '"]')
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
    // By id, never by index into the NodeList: the cards ABOVE the expanded
    // one are not rendered at all (hiddenAboveCount), so the n-th DOM node is
    // not the n-th comment — the same "snapshot by stable ID, never by raw
    // array index" rule as .claude/rules/conventions.md.
    const el = commentItemEl(selComment())
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
// updateScrollHints.
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

// primeAnchorThreadScroll — home.mjs's openCommentAnchorDrill calls this right
// after it auto-expands a "Comments op regels" anchor's own thread
// (isAnchorOnlyComment in commentCard below), WITHOUT ever handing the
// keyboard into it (see openCommentAnchorDrill's own doc comment: "as if
// fully expanded", but no focus). Only toComment() used to reset
// threadPos/scroll the thread to its newest message — this auto-expand path
// never went through toComment() at all, so the freshly mounted
// [data-testid=comment-thread] div kept its DOM-default scrollTop (0, the
// TOP) instead of showing the newest reply. Reported bug: resolving a
// comment and landing on the next one (afterResolveAction/
// afterCommentRowRemoved, home.mjs) showed the top of a long thread instead
// of the bottom — the same gap exists for plain ↓/↑ through the blokken-index
// onto a comment row, since both go through this one function.
// threadPos is reset here too (not just re-pinned, unlike
// jumpToCommentThreadBottom) — a leftover threadPos from whichever OTHER
// thread the reviewer last had the keyboard in must never leak into this
// merely-auto-expanded one; the keyboard is never in it, so 0 (rest) is
// always the right value.
export function primeAnchorThreadScroll() {
  cs.threadPos = 0
  jumpToCommentThreadBottom()
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
const SCROLL_TO_BOTTOM_TITLE = t('Naar recente berichten')
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
// explicit way back down instead. Also updates the scroll hints directly,
// since a JS-driven scrollTop write isn't guaranteed to fire a native
// 'scroll' event in every browser.
function scrollCommentThreadToBottom() {
  if (cs.threadPos !== 0 || !cs.threadPinned) return
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=comment-thread]')
    if (!el) return
    el.scrollTop = el.scrollHeight
    updateScrollHints(el)
    // Same "a JS-driven scrollTop write isn't guaranteed to fire a native
    // 'scroll' event" reasoning as updateScrollHints just above — without this
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
  // "is a turn running / what is it doing / did the last send fail" are
  // deliberately NOT fields here: they live per conversation in
  // claudeTurns.mjs (ccBusy/ccProgress/ccSendError below read this
  // conversation's entry out of it). A reviewer can send a message, walk to
  // other code and start a second conversation there while the first is
  // still being answered — with a single slot on `cc` the second send would
  // queue behind the first one's turn, the first one's progress/answer would
  // be dropped the moment this panel re-anchored, and a rejected send's
  // sentence would attach to whichever conversation happens to be on screen
  // once the response arrives instead of the one it was actually about. See
  // "Parallel conversations" in .claude/docs/claude-chat-panel.md.
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

// ccBusy/ccProgress/ccSendError are "is a turn running / what did the last
// send do for the conversation THIS panel currently shows" — the
// per-conversation registry (claudeTurns.mjs) narrowed to cc.commentId.
// Everything in this file that used to read cc.busy/cc.progress/cc.sendError
// goes through these three, so a turn (or a rejected send) on another
// selection can never gate this conversation's composer, overwrite its status
// line, or show up under the wrong conversation.
function ccBusy() {
  return isTurnBusy(cc.commentId)
}

function ccProgress() {
  return turnProgress(cc.commentId)
}

function ccSendError() {
  return turnSendError(cc.commentId)
}

// queuedFor scopes the client-side queue to one conversation — each entry
// already carries the conversation it was typed against (see queueClaudeMessage).
function queuedFor(commentId) {
  return cc.queued.filter((q) => q.commentId === commentId)
}

// PENDING_CLAUDE_QUESTION_KINDS are every message kind claudeQuestionOptions
// (ClaudeChat.mjs) actually renders clickable option buttons for: an ordinary
// clarifying question, chat_checkout.go's more forceful directory decision,
// and a cancelled-turn cleanup choice — all three share the exact same
// Options/click mechanism (see claudeQuestionOptions' own doc comment), so
// pendingClaudeQuestion must recognize all three too, not just 'question'.
const PENDING_CLAUDE_QUESTION_KINDS = new Set(['question', 'directory_decision', 'cleanup_choice'])

// pendingClaudeQuestion returns the newest message when it is a still-open
// question with clickable options (one of PENDING_CLAUDE_QUESTION_KINDS, no
// answer yet, at least one option) — else null. Used by handleRelatedKey's
// 'claude' branch to fold the options into the ↑/↓ chain (see
// cs.claudeOptionSel's own doc comment) and by selectHighlightedClaudeOption
// below.
//
// Reported bug this widening fixes: a chat.KindDirectoryDecision/
// KindCleanupChoice turn rendered its options as ordinary clickable buttons
// (claudeQuestionOptions already handled those kinds) but ↑/↓/Enter did
// nothing on an otherwise-empty, focused composer — this function used to
// only ever recognize 'question', so handleRelatedKey's ArrowUp/ArrowDown
// branch (and selectHighlightedClaudeOption's Enter) silently treated the
// checkout consult as "nothing pending" and fell through to the ordinary
// "walk the transcript" behaviour instead of entering the options.
function pendingClaudeQuestion() {
  const total = cc.messages.length
  if (total === 0) return null
  const m = cc.messages[total - 1]
  return m && PENDING_CLAUDE_QUESTION_KINDS.has(m.kind) && !m.answer && m.options && m.options.length ? m : null
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
  // second writer of `cc` (see startPrCommentChat below, and
  // syncClaudeAnchorForSelection's own doc comment for why nothing else may
  // race it).
  if (s.none) return s.prComment || null
  const hasTurns = (id) => cc.conversations.indexOf(id) >= 0
  return cs.list.find((x) => x.file === s.file && x.label === s.label && hasTurns(x.id)) || null
}

// ccAnchorComment resolves the comment object for the conversation actually
// LOADED/SHOWN in the panel (the stable cc.commentId) rather than
// chatAnchorComment()'s index-based selComment() lookup. The two normally
// agree — syncClaudeAnchorForSelection keeps cc synced to chatAnchorComment()
// for every focus except 'claude'/'new', which is exactly when this matters:
// while cs.focus === 'claude', cs.sel (a raw INDEX into the comment list, see
// selComment()) can drift out from under an unrelated comment-poll reorder
// (conventions.md's "Snapshot a selection by stable ID, never by raw array
// index") without cc moving at all, since cc is deliberately not resynced in
// that state. Anything describing "the conversation the reviewer is actually
// looking at right now" (the "Selected: …" line, the otherClaudeChats
// exclusion below) must resolve through cc.commentId, not through the
// possibly-stale index. Falls back to chatAnchorComment() whenever nothing is
// anchored yet (cc.commentId == null) — the ordinary browsing state, where
// chatAnchorComment() IS the reliable source (cc simply doesn't exist yet).
function ccAnchorComment() {
  if (cc.commentId != null) {
    const c = cs.list.find((x) => String(x.id) === String(cc.commentId))
    if (c) return c
  }
  return chatAnchorComment()
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
  // A running turn deliberately does NOT hold this sync back (it used to —
  // see "The chat column is a function of the selected code" in
  // .claude/docs/claude-chat-panel.md): the panel is purely a function of the
  // selected code, and the turn itself survives the switch because it is
  // tracked per conversation (claudeTurns.mjs) instead of on `cc`.
  if (cs.focus === 'claude' || cs.focus === 'new') return
  const c = chatAnchorComment()
  const nextId = c ? c.id : null
  if (nextId === cc.commentId) return
  cc.commentId = nextId
  cc.messages = []
  cc.runId = null
  // The embedded Claude composer's own draft — see claudeDrafts' doc comment
  // for why this can't just rely on the field remounting (it doesn't, its
  // DOM node is reused across conversations). Resync right here, on every
  // real anchor change, so plain ↑/↓ navigation never leaves a PREVIOUS
  // conversation's unsent text sitting in the field for the new one.
  restoreClaudeComposerDraft()
  // Looking at it counts as seeing it: whatever landed here while the reviewer
  // was elsewhere no longer needs an index pill.
  clearTurnAnswered(nextId)
  cs.claudePinned = true // a different conversation always starts pinned to its own bottom
  // Deliberately NOT resetting a sendError here: it lives per conversation in
  // claudeTurns.mjs, and ccSendError() below already narrows to the NEW
  // cc.commentId — switching naturally shows nextId's own sentence (its last
  // real rejection, or '' if it never had one) instead of borrowing/discarding
  // whatever the previous conversation had.
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

// chatSeenAtCache — the most recently known server seen_at per conversation,
// refreshed by every loadChatMessages call regardless of applyDrafts, so the
// dwell timer below can compare against it without a second fetch.
const chatSeenAtCache = new Map()

// Marking a conversation "seen" requires the reviewer to have actually looked
// at it for a few continuous seconds — merely opening it and immediately
// navigating away (e.g. flicking through comments with ↑/↓) must not
// mark it read. scheduleChatSeenDwell (re)arms a timer for the CURRENT
// cs.focus==='claude' + cc.commentId pair; the watch below restarts it on
// every real focus/conversation change, which also cancels a stale timer for
// whatever was being viewed before. See "Marking it read" in
// claude-chat-panel.md.
const CHAT_SEEN_DWELL_MS = 5000
let chatSeenDwellTimer = null

function scheduleChatSeenDwell() {
  if (chatSeenDwellTimer) {
    clearTimeout(chatSeenDwellTimer)
    chatSeenDwellTimer = null
  }
  if (cs.focus !== 'claude' || cc.commentId == null) return
  const commentId = cc.commentId
  chatSeenDwellTimer = setTimeout(() => {
    chatSeenDwellTimer = null
    // Still genuinely viewing the SAME conversation after the full dwell?
    if (cs.focus !== 'claude' || cc.commentId !== commentId) return
    const lastAt = lastAssistantMessageAt(cc.messages)
    const seenAt = chatSeenAtCache.get(commentId) || ''
    if (lastAt && lastAt > seenAt) markChatSeenOnServer(commentId)
    setChatUnread(commentId, false)
  }, CHAT_SEEN_DWELL_MS)
}

watch(() => [cs.focus, cc.commentId], scheduleChatSeenDwell)

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
  clearTurnAnswered(commentId)
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
      // Stale — the reviewer already switched to a different conversation
      // while this POST was in flight; that switch already reset cc.status
      // for whatever it now shows, and this failure was never about that one.
      // Same guard loadChatMessages already applies to its own late arrivals.
      if (cc.commentId !== commentId) return
      cc.status = 'error'
      return
    }
    const json = await res.json()
    cc.runId = json.runId
    await loadChatMessages(commentId)
  } catch (_) {
    if (cc.commentId !== commentId) return
    cc.status = 'error'
  }
}

// appliedDraftReplyIds tracks which chat.KindDraftReply turns have already
// been merged into replyDrafts — an in-memory Set (mirrors replyDrafts
// itself) BACKED by draftStorage.mjs (isDraftReplyApplied/markDraftReplyApplied
// below), so a later re-render of the SAME turn (a poll, a resync, a page
// that happened to fetch the transcript twice) never re-appends the same
// text a second time. A genuinely NEW draft turn (a distinct id — see
// chatMessageID's turnID-derived, per-turn id in chat_workflow.go) always
// gets its own entry, so a follow-up Claude proposal in the SAME
// conversation still merges in — this is deliberately NOT a
// one-shot-then-frozen mechanism (Reindert's explicit request).
//
// The persistence is load-bearing, not defensive: a chat.KindDraftReply
// message stays in the transcript FOREVER (chat_workflow.go's
// saveChatDraftReply never deletes it), so a plain in-memory-only Set went
// back to empty on every fresh page load/reload — the very next time the
// reviewer reopened this conversation, applyPendingDraftReplies saw an
// "unseen" id again and rewrote the ALREADY-SENT draft straight back into
// the now-empty reply field (reviewer report: "als ik in de tree een
// comment verstuur is de input niet gelijk leeg (ik heb het laten genereren
// vanuit de chat)" — the field really was cleared right after sending, it
// just got refilled again the moment the conversation was reopened).
// draftKeyFor's own PR-scoped dsKey convention is reused via
// draftAppliedKey below so this can never collide across PRs.
const appliedDraftReplyIds = new Set()

function draftAppliedKey(msgId) {
  return dsKey('draftapplied', msgId)
}
function isDraftReplyApplied(msgId) {
  return appliedDraftReplyIds.has(msgId) || !!loadDraft(draftAppliedKey(msgId))
}
function markDraftReplyApplied(msgId) {
  appliedDraftReplyIds.add(msgId)
  saveDraft(draftAppliedKey(msgId), '1')
}

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
//      MID-TYPING an unsent follow-up in the Claude composer — never steal the
//      keyboard out from under an in-progress message. A merely-focused but
//      EMPTY Claude composer does not count as "in progress": the reviewer's
//      own send already clears that field (see ClaudeChat.mjs's Enter/"Stuur"
//      handlers) without blurring it, so right after sending, DOM focus still
//      sits there with nothing left to protect — and the reviewer explicitly
//      wants the focus to land in the comment field the moment this draft
//      arrives (see "Focus after placing a draft" in
//      .claude/docs/claude-chat-panel.md).
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
    if (m.kind !== 'draft_reply' || isDraftReplyApplied(m.id)) continue
    markDraftReplyApplied(m.id)
    const existing = getReplyDraft(commentId) || ''
    setReplyDraft(commentId, existing ? existing + '\n\n' + m.body : m.body)
    appended = true
    pure = !existing
  }
  if (!appended) return
  if (pure) pureChatDraftReplyIds.add(commentId)
  else pureChatDraftReplyIds.delete(commentId)
  const merged = getReplyDraft(commentId)
  const el = document.querySelector('[data-testid=reaction-compose]')
  if (!el) return // not currently mounted — replyDrafts already holds it for the next time this thread opens
  el.value = merged
  autoGrowTextarea(el) // .value= fires no input event, so the auto-grow needs an explicit nudge
  const active = document.activeElement
  const typingInClaude = !!(
    active &&
    active.matches &&
    active.matches('[data-testid=claude-chat-compose]') &&
    active.value.trim()
  )
  if (typingInClaude) return // never steal the keyboard out from under an in-progress, UNSENT follow-up message
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
    // Cache the server's seen_at unconditionally (not just when applyDrafts
    // is true) so the dwell timer above can read it later without its own
    // fetch. Marking as seen itself is NOT done here anymore — see
    // scheduleChatSeenDwell, which only fires after a genuine few-second
    // dwell on this exact conversation, never on a bare open.
    chatSeenAtCache.set(commentId, json.seenAt || '')
    if (applyDrafts) {
      applyPendingDraftReplies(commentId)
    }
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
    // A pushed event that landed WHILE this request was in flight is newer than
    // what the response describes, so it must win — otherwise a resync (which
    // runs on every reconnect, right next to the events it is catching up on)
    // could wipe a fresher snapshot and freeze the status line. Per
    // conversation, since a resync for one says nothing about another.
    if (lastTurnProgressAt(commentId) > startedAt) return
    applyChatProgress(commentId, json.running && json.progress ? json.progress : null)
  } catch (_) {
    // a missing snapshot just means "no live turn known" — the transcript stands
  }
}

// applyChatProgress writes one conversation's progress snapshot into the shared
// per-conversation store (claudeTurns.mjs, which stamps "when did we last learn
// something about this live turn" itself) and does the two things only the
// panel can do: keep the thread scrolled to the bottom of the conversation in
// view, and run the 1s elapsed-counter heartbeat.
function applyChatProgress(commentId, p) {
  setTurnProgress(commentId, p)
  if (commentId === cc.commentId) scrollClaudeThreadToBottom()
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
    return t(
      'Versturen geweigerd — de server kent deze actie niet. Herstart slash (de server draait een oudere versie dan deze pagina) en laad opnieuw.',
    )
  }
  if (status === 409) {
    return t('Dit gesprek is op de server afgesloten en neemt geen berichten meer aan. Wis het gesprek en begin opnieuw.')
  }
  return t('Versturen mislukt (HTTP {status}). Probeer het opnieuw.', { status })
}

// addPendingOwnMessage/removePendingOwnMessage — the reviewer's own
// just-sent text, shown the instant sendClaudeMessage fires, before the real
// network round trip (save + the chat.message SSE push, or this function's
// own belt-and-braces refetch) has a chance to land. Reported bug: "als ik
// vanuit het menu een chat start, zie ik mijn bericht niet gelijk, uiteindelijk
// wel" — most visible starting a BRAND NEW conversation (menu "Chat over deze
// regel"/"Chat over deze PR"), whose transcript is still empty right up to
// that point, so the reviewer stares at nothing for as long as that round trip
// takes. This entry is never persisted anywhere and carries a locally-minted
// id that can never collide with a real, server-issued one (chatMessageID,
// chat_workflow.go) — the very next loadChatMessages call REPLACES cc.messages
// wholesale with the real, already-saved transcript (saveChatMessage persists
// the reviewer's turn before the actual claude call even starts, see
// chat_workflow.go), so it is superseded automatically, never duplicated.
// Only a failed/unreachable send never reaches that replacement, which is why
// sendClaudeMessage explicitly removes it on both failure paths below.
let pendingOwnMessageSeq = 0
function addPendingOwnMessage(commentId, body, attachments = []) {
  if (commentId !== cc.commentId) return null
  pendingOwnMessageSeq += 1
  const id = '__pending__' + pendingOwnMessageSeq
  cc.messages = cc.messages.concat([
    { id, role: 'user', kind: '', body, conversationId: commentId, attachments },
  ])
  scrollClaudeThreadToBottom()
  return id
}
function removePendingOwnMessage(commentId, id) {
  if (!id || commentId !== cc.commentId) return
  cc.messages = cc.messages.filter((m) => m.id !== id)
}

async function sendClaudeMessage(text, action = '', context = '', target = null, bucket = '') {
  const trimmed = (text || '').trim()
  // 'commit'/'clear'/'retry' need no typed text — commit pushes whatever
  // Claude already changed, clear wipes the conversation, retry re-runs the
  // turn that finally failed from the workflow's own recorded input; none of
  // them asks anything new.
  const needsNoText = action === 'commit' || action === 'clear' || action === 'retry'
  const runId = target ? target.runId : cc.runId
  const commentId = target ? target.commentId : cc.commentId
  if (!runId) return
  // The images the reviewer attached to THIS message, taken out of the
  // composer before anything else can change under it. `bucket` is passed in
  // whenever it may DIFFER from commentId — a brand-new chat parks its
  // attachments under the composer draft key, since the conversation only
  // comes into existence one step earlier (see sendClaudeMessageFromNew and
  // chatAttachments.mjs). An action turn ('commit'/'clear'/'retry'/an answered
  // question) never carries any.
  const attachments = needsNoText ? [] : await takePendingAttachments(bucket || commentId, commentId)
  if (!needsNoText && !trimmed && !attachments.length) return
  setTurnBusy(commentId, true)
  setTurnSendError(commentId, '')
  // Images with no typed text are a complete message; the bubble the server
  // stores gets the same short placeholder body (chatAttachmentOnlyBody,
  // chat_attachment.go), so the optimistic one must read the same.
  const ownBody = trimmed || (attachments.length ? attachmentOnlyBody(attachments.length) : '')
  const pendingId = ownBody ? addPendingOwnMessage(commentId, ownBody, attachments) : null
  try {
    const res = await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'reviewer',
        body: trimmed,
        action: action || undefined,
        context: context || undefined,
        attachments: attachments.length ? attachments : undefined,
      }),
    })
    // A rejected Signal used to be swallowed whole: the response was never
    // read, so the reviewer got no bubble, no status line and no hint that
    // nothing had been sent — the column just sat there, inert. See
    // sendErrorText for the three ways this actually happens.
    if (!res.ok) {
      removePendingOwnMessage(commentId, pendingId)
      // The files themselves are on disk and fine — only the Signal was
      // refused — so the thumbnails come back rather than silently vanishing
      // with the message.
      restorePendingAttachments(bucket || commentId, commentId, attachments)
      setTurnSendError(commentId, sendErrorText(res.status))
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
    removePendingOwnMessage(commentId, pendingId)
    restorePendingAttachments(bucket || commentId, commentId, attachments)
    setTurnSendError(commentId, t('Geen verbinding met de server — draait slash nog?'))
  } finally {
    setTurnBusy(commentId, false)
    // Also nudges the ticker on: a turn that ends via this Signal round-trip
    // (rather than an SSE progress:false frame) still needs the "recently
    // finished" linger window to actually expire on screen — see
    // syncChatTicker/anyRecentlyFinishedTurn.
    syncChatTicker()
    // Whatever the reviewer typed meanwhile goes out now, one turn at a time
    // PER conversation.
    drainClaudeQueue()
  }
}

// CHECKOUT_CHOICE_OPEN_BODY is a literal duplicate of chat_workflow.go's own
// dead-end reply text (the "er staat nog een keuze open over de werkmap"
// sentence a write-turn ends with when a chatCheckoutDecision is still
// pending) — same "duplicate the exact string across the two languages"
// precedent as ClaudeChat.mjs's own NEED_WRITE_PARTIAL_PREFIX. Keep this in
// sync with chat_workflow.go's literal if that sentence ever changes.
const CHECKOUT_CHOICE_OPEN_BODY =
  'Ik kan nu geen code aanpassen: er staat nog een keuze open over de werkmap van deze PR. Maak die keuze en vraag het daarna opnieuw.'

// The two OTHER dead ends the very same write-turn branch produces
// (chat_workflow.go, right after prepareChatShellWorkDir returns !ok): no
// usable checkout at all, and a checkout whose own discovery reason is known
// (checkoutFailureReason — a variable sentence, hence a prefix rather than a
// literal). They are here for the same reason CHECKOUT_CHOICE_OPEN_BODY is:
// all three mean "this turn wanted to change code and never got a work
// directory", and assigning one is exactly what answering the werkmap choice
// does. Keep in sync with chat_workflow.go's own literals.
const NO_CHECKOUT_BODY =
  'Voor dit verzoek heb ik schrijftoegang tot een lokale werkmap nodig, maar die is er niet. Voeg een pad toe aan `chatCheckoutDirs` in settings.json of clone de repo lokaal, en vraag het opnieuw.'
const CHECKOUT_BLOCKED_PREFIX = 'Ik kan nu geen code aanpassen. '

// isCheckoutDeadEnd — "this transcript ends on a write turn that never got a
// work directory". Deliberately the LAST message only: an older dead-end with
// a real answer after it is a conversation that already carried on by itself
// and must not be poked again.
function isCheckoutDeadEnd(m) {
  if (!m || m.role !== 'assistant' || !m.noShell) return false
  const body = m.body || ''
  return body === CHECKOUT_CHOICE_OPEN_BODY || body === NO_CHECKOUT_BODY || body.startsWith(CHECKOUT_BLOCKED_PREFIX)
}

// resumeStuckClaudeAfterCheckout — called by home.mjs's sendCheckoutAction
// right after the reviewer answers the werkmap overlay (or the equivalent
// checkout-chip menu, both funnel through that one function) with a real
// picked option (`reply`, never for "Uit"/"Andere werkmap kiezen"/"Nu
// terugzetten", which don't resolve a decision the same way). Reviewer-report:
// the choice resolved the PR-wide decision, but the chat column that was
// stuck on CHECKOUT_CHOICE_OPEN_BODY showed nothing new and the turn never
// continued — the reviewer had to notice this and retype the original
// request by hand.
//
// PR-WIDE, not only the conversation on screen. The decision this answers is
// itself PR-wide (one work directory per PR, see chat_checkout.go), so one
// open choice dead-ends EVERY write turn of that PR — and a reviewer running
// several comment chats at once (the "Andere chats in deze PR" list) collects
// exactly that: one conversation resumed because it happened to be displayed,
// the rest left sitting on the dead-end forever. Reported on PR 13535, where
// three of Ricky's comment chats had answered "doe maar"/"retry" into a
// dead-end that never came back. So every conversation of this PR is checked:
// its transcript is fetched (the same read-only GET /api/chat?commentId=
// loadChatMessages uses) and resumed when — and only when — its LAST message
// is one of the checkout dead ends (isCheckoutDeadEnd). Anything else is left
// alone, which is what keeps this from turning into "poke every chat of this
// PR": a conversation that already carried on, is waiting on the reviewer, or
// never wanted write access at all never matches.
//
// A conversation with a turn running RIGHT NOW is skipped as well — its
// dead-end may already be the message the running turn is replacing, and the
// resume would only queue behind it (drainClaudeQueue) to say something that
// is no longer true.
//
// The displayed conversation keeps its own fast path off `cc.messages` (in
// memory already, and only that one can show the optimistic "Jij" bubble, see
// addPendingOwnMessage). The rest go out one at a time, in the PR's own
// conversation order: they all want the same per-checkout write slot
// (acquireCheckoutWriteSlot, chat_write_gate.go) and would only queue on each
// other anyway.
//
// Sending a real new "user" turn (rather than some purely local note) is
// deliberate: it both shows the reviewer's choice as an ordinary "Jij" bubble
// (via sendClaudeMessage's own addPendingOwnMessage) AND resumes the SAME
// Claude session, so the turn now succeeds (prepareChatShellWorkDir finds the
// resolved assignment) and carries on with whatever the reviewer originally
// asked for — mechanically identical to the reviewer retyping "ik heb de
// werkmap gekozen, ga verder" by hand.
export async function resumeStuckClaudeAfterCheckout(reply) {
  if (!reply) return
  const body = t('Werkmap gekozen: {dir}. Ga verder met mijn vorige verzoek.', { dir: reply })
  const shown = cc.commentId ? String(cc.commentId) : ''
  if (isCheckoutDeadEnd(cc.messages[cc.messages.length - 1])) await sendClaudeMessage(body)
  for (const id of await prConversationIds()) {
    const commentId = String(id)
    if (commentId === shown) continue
    if (isTurnBusy(commentId)) continue
    const p = turnProgress(commentId)
    if (p && p.running) continue
    try {
      const res = await fetch('/api/chat?commentId=' + encodeURIComponent(commentId) + repoParam())
      if (!res.ok) continue
      const json = await res.json()
      const msgs = (json && json.messages) || []
      if (!isCheckoutDeadEnd(msgs[msgs.length - 1])) continue
      // Its claude_chat Execution is ensured the ordinary way (idempotent
      // server-side via StartWorkflowID, see ensureAndLoadChat) purely to
      // learn the runId a Signal needs — this conversation is not on screen,
      // so nothing else here has one.
      const start = await fetch('/api/workflows/claude_chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr: cs.pr, repo: repoField(), commentId }),
      })
      if (!start.ok) continue
      const { runId } = await start.json()
      if (!runId) continue
      await sendClaudeMessage(body, '', '', { runId, commentId })
    } catch (_) {
      // Best-effort per conversation: one unreachable transcript must not
      // stop the others from being resumed.
    }
  }
}

// prConversationIds — every conversation of this PR, fetched fresh rather
// than read off cc.conversations: the checkout chip's own menu can answer the
// choice with no chat panel ever having been opened (so that set is still
// empty), and it is only refreshed on the comment poll's cadence anyway.
// Falls back to whatever cc already has if the read fails.
async function prConversationIds() {
  try {
    const res = await fetch('/api/chat?pr=' + encodeURIComponent(cs.pr) + repoParam())
    if (res.ok) {
      const json = await res.json()
      if (Array.isArray(json && json.conversations)) return json.conversations
    }
  } catch (_) {
    /* fall through to the cached set */
  }
  return cc.conversations || []
}

// queuedIdSeq numbers the client-side queue entries. A queued turn has no
// Signal id yet (the server mints that, see the message handler in
// tasks_api.go) but its bubble still needs a stable arrow.js key, so this is
// purely a render key — never sent anywhere.
let queuedIdSeq = 0

// steerClaudeMessage tries to hand `text` to the turn that is running RIGHT
// NOW instead of queueing it (chat_steer.go). Returns true only when the
// message really was accepted by the workflow, so every caller can fall back
// to the client-side queue on a false.
//
// Two round trips on purpose. The read (GET /api/chat/steerable) says whether
// a claude CLI call is genuinely in flight for this conversation — a turn can
// be "busy" while sitting in work-directory prep, the write-turn slot or a
// retry backoff, where there is nothing to steer. Only then does the write go
// out, and it goes out the ordinary sanctioned way: ensure the conversation's
// chat_steer Execution, then Signal it. It is deliberately NOT the
// conversation's own claude_chat run — that run's lock is held for the whole
// turn, so such a Signal would block for exactly as long as the turn it means
// to steer.
async function steerClaudeMessage(pr, commentId, text) {
  try {
    const check = await fetch('/api/chat/steerable?commentId=' + encodeURIComponent(commentId) + repoParam())
    if (!check.ok) return false
    const status = await check.json()
    if (!status.steerable) return false
    const start = await fetch('/api/workflows/chat_steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr, repo: repoField(), commentId }),
    })
    if (!start.ok) return false
    const { runId } = await start.json()
    if (!runId) return false
    const res = await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    })
    if (!res.ok) return false
    // The message is already stored as the reviewer's own turn by the Activity
    // that delivered it, so a refetch is what makes it appear — only for the
    // conversation actually in view, like every other late arrival here.
    if (commentId === cc.commentId) await loadChatMessages(commentId)
    return true
  } catch (_) {
    // Server unreachable — the queue below is the honest fallback.
    return false
  }
}

// queueClaudeMessage is the one entry point for a reviewer turn from the
// composer: send it straight away when nothing is running, hand it to the
// running turn when that turn can still take it, and only otherwise put it in
// cc.queued for drainClaudeQueue to send afterwards — the Claude CLI's own
// "keep typing while it works" behaviour. The composer is therefore no longer
// disabled while a turn runs (ClaudeChat.mjs), and a message typed during one
// is never silently swallowed.
//
// Steering (steerClaudeMessage above) is tried first because it is what the
// reviewer actually means by typing mid-turn: the CLI picks the message up at
// the running turn's next step boundary, so Claude changes course instead of
// finishing something the reviewer already corrected. It only works while a
// claude CLI call is really in flight; the queue stays for every other case.
//
// Each queued entry keeps the runId/commentId it was typed against so a
// conversation switch can't misroute it.
//
// Durability trade-off of the QUEUE, recorded in claude-chat-panel.md: the
// queued Signal only reaches the workflow history once the running turn
// finishes (tembed's SignalWorkflow holds the run lock while it drives the
// turn inline), so a queued message lives client-side until then and is lost
// if the server restarts mid-turn. A STEERED message does not share that
// trade-off — it is a Signal on its own Execution, recorded before anything is
// delivered. The reviewer sees a queued one sitting in the queue the whole
// time.
async function queueClaudeMessage(text, context = '') {
  const trimmed = (text || '').trim()
  const bucket = cc.commentId || claudeChatDraftKey()
  if (!trimmed && !hasPendingAttachments(bucket)) return
  if (!ccBusy()) return sendClaudeMessage(trimmed, '', context, null, bucket)
  if (!cc.runId) return
  const commentId = cc.commentId
  // Steering hands the text to the RUNNING turn's own stdin, which has no way
  // to carry a file — so a message with images always becomes an ordinary
  // queued turn instead.
  if (!hasPendingAttachments(bucket) && (await steerClaudeMessage(cs.pr, commentId, trimmed))) return
  queuedIdSeq += 1
  // Taken out of the composer NOW, at queue time: the reviewer keeps typing
  // their next message in the same field, and these images belong to this
  // one. They travel on the queue entry until it is actually sent.
  const attachments = await takePendingAttachments(bucket, commentId)
  cc.queued = cc.queued.concat([
    { id: 'q' + queuedIdSeq, body: trimmed || attachmentOnlyBody(attachments.length), context, commentId, runId: cc.runId, attachments },
  ])
}

// drainClaudeQueue sends the oldest queued turn of every conversation that has
// nothing in flight — called from sendClaudeMessage's own `finally`, so each
// conversation's queue drains itself one turn at a time (each send ends in
// another drain). Guarded on that conversation's own busy flag so two
// overlapping drains can never send the same entry twice; the entry is removed
// from the queue BEFORE it is sent, which is also what makes its "in de
// wachtrij" bubble give way to the ordinary user bubble the send produces.
function drainClaudeQueue() {
  const pending = cc.queued
  const seen = new Set()
  for (const next of pending) {
    // One in-flight turn per conversation, FIFO within it — but two different
    // conversations drain independently, so a queue on one never holds up the
    // other (see "Parallel conversations" in claude-chat-panel.md).
    if (seen.has(next.commentId)) continue
    seen.add(next.commentId)
    if (isTurnBusy(next.commentId)) continue
    cc.queued = cc.queued.filter((q) => q.id !== next.id)
    // A queued turn's images were already uploaded when it was queued, so they
    // are put straight back into that conversation's own bucket for the send
    // to pick up again.
    restorePendingAttachments(next.commentId, next.commentId, next.attachments || [])
    sendClaudeMessage(next.body, '', next.context, { runId: next.runId, commentId: next.commentId })
  }
}

// clearClaudeChat sends the "clear" ChatMessageSignal (chatActionClear in
// chat_workflow.go) — wipes the transcript + the stored claude session, and
// best-effort removes the conversation's agentic-edit shadow worktree
// (chat_shadow.go's clearChatShadow). Only ever reached from the command
// palette's "Wis Claude-gesprek" item (home.mjs), which runs straight away
// unless the pending-work check below (claudeChatShadowWarning) reports
// unsaved agentic-edit work in the shadow worktree — that is the one case it
// still puts a confirm submenu in front. Either way the decision is already
// made by the time we get here, so this itself asks for nothing further.
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

// isChatFailureTurn — "does this LAST message mean the turn needs a manual
// retry?" — the exact same condition claudeBubble's own `canRetry` uses
// (kind 'error', an exhausted automatic backoff ladder, or 'cancelled', the
// reviewer's own Stop): both offer "Opnieuw proberen" on that one bubble, so
// both count as "gefaald" for the bulk action below.
function isChatFailureTurn(msg) {
  return !!msg && (msg.kind === 'error' || msg.kind === 'cancelled')
}

const retryAllState = reactive({ busy: false })

// isRetryingAllFailedClaudeChats — drives "Ook andere opnieuw proberen"'s own
// disabled state (ClaudeChat.mjs), the same idea as ccBusy/busy() for the
// per-turn retry button.
export function isRetryingAllFailedClaudeChats() {
  return retryAllState.busy
}

// retryAllFailedClaudeChats — "Ook andere opnieuw proberen", next to the
// per-turn "Opnieuw proberen" (retryClaudeTurn, which only ever touches the
// ONE conversation on screen). Reviewer request: retry EVERY failed Claude
// chat of this PR in one click, including the one currently open.
//
// A failed claude_chat turn does NOT fail the workflow itself
// (chat_workflow.go loops back to WaitSignal on a chat.KindError/
// KindCancelled message, see runOneClaudeTurn's own doc comment), so this
// cannot be read off GET /api/problems the way an ordinary task failure can
// — "failed" here is a property of the TRANSCRIPT's last message, not of the
// workflow run's status. Nor can it reuse otherClaudeChatsAll(): that list
// deliberately drops a chat once it is both 'seen' and answered
// (otherTaskAnswered counts ANY assistant-role message, including a
// chat.KindError one) — a failed chat the reviewer already looked at once
// must still be retried here. So this walks prConversationIds() (every
// conversation of this PR, fetched fresh) the same way
// resumeStuckClaudeAfterCheckout above does, fetching each transcript
// (GET /api/chat?commentId=, the same read loadChatMessages uses) and
// checking only its last message.
//
// A conversation with a turn running RIGHT NOW is skipped — nothing to
// retry, and poking it would only queue behind whatever is already in
// flight (drainClaudeQueue). The open conversation's own turn goes out
// first via the already-loaded cc.messages/cc.runId (no extra GET needed,
// mirrors sendClaudeMessage's own fast path for the displayed chat); every
// other conversation resumes one at a time, in the PR's own conversation
// order, via the same idempotent "ensure the run, then signal retry"
// two-step resumeStuckClaudeAfterCheckout already uses (a conversation not
// on screen has no runId of its own to signal against).
export async function retryAllFailedClaudeChats() {
  if (retryAllState.busy) return
  retryAllState.busy = true
  try {
    if (cc.runId && isChatFailureTurn(cc.messages[cc.messages.length - 1])) {
      await sendClaudeMessage('', 'retry')
    }
    const shown = cc.commentId ? String(cc.commentId) : ''
    for (const id of await prConversationIds()) {
      const commentId = String(id)
      if (commentId === shown) continue
      if (isTurnBusy(commentId)) continue
      const p = turnProgress(commentId)
      if (p && p.running) continue
      try {
        const res = await fetch('/api/chat?commentId=' + encodeURIComponent(commentId) + repoParam())
        if (!res.ok) continue
        const json = await res.json()
        const msgs = (json && json.messages) || []
        if (!isChatFailureTurn(msgs[msgs.length - 1])) continue
        // Its claude_chat Execution is ensured the ordinary way (idempotent
        // server-side via StartWorkflowID, see ensureAndLoadChat) purely to
        // learn the runId a Signal needs — this conversation is not on
        // screen, so nothing else here has one.
        const start = await fetch('/api/workflows/claude_chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pr: cs.pr, repo: repoField(), commentId }),
        })
        if (!start.ok) continue
        const { runId } = await start.json()
        if (!runId) continue
        await sendClaudeMessage('', 'retry', '', { runId, commentId })
      } catch (_) {
        // Best-effort per conversation: one unreachable transcript must not
        // stop the others from being resumed.
      }
    }
  } finally {
    retryAllState.busy = false
  }
}

// cancelClaudeTurn stops the ONE running turn on the currently anchored
// conversation right now — POST /api/chat/cancel (chat_cancel.go), never a
// workflow Signal (see that file's own doc comment for why a cancel cannot
// be one: SignalWorkflow would block for exactly as long as the turn it is
// trying to interrupt). Two entry points, one function, per
// .claude/docs/mouse-navigation.md: the "Stop" control next to
// claude-chat-status (RelatedPanel.mjs's CommentClaudeFooter) and the
// Enter-palette item (claudeChatCommandsFor in home.mjs). A no-op, silently,
// when nothing is running — mirrors retryClaudeTurn's own "nothing to do"
// tolerance, since the workflow/endpoint already degrade the same way.
export async function cancelClaudeTurn() {
  if (!cc.commentId) return
  try {
    await fetch('/api/chat/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId: cc.commentId }),
    })
  } catch (_) {
    // Best-effort: the reviewer already sees the turn's OWN outcome bubble
    // once the cancel actually lands (chat.message, SSE); a dropped request
    // here just means "Stop" itself silently did nothing, same class of
    // failure as any other network hiccup in this panel.
  }
}

// resolveCancelCleanup answers a chat.KindCleanupChoice bubble (the "what do
// you want to do with what a cancelled turn left in the checkout?" follow-up,
// offerCancelCleanupIfDirty in chat_workflow.go) with the reviewer's chosen
// option — the dedicated "cleanup" Signal action (chatActionCleanup), NEVER
// the ordinary answer/resume round trip a ‘question’/‘directory_decision’
// turn uses: resolving THIS must never silently start a new Claude call (see
// applyCancelCleanup's own doc comment, chat_checkout.go).
export async function resolveCancelCleanup(choice) {
  await sendClaudeMessage(choice, 'cleanup')
}

// clearClaudeChat wipes the conversation AND — reviewer request — its
// backing comment when that comment counts as "empty": still exactly
// CLAUDE_ANCHOR_PLACEHOLDER, never replaced with the reviewer's own text
// ("ik zie het ook als een leeg veld als ik '(Nog geen eigen comment getypt —
// gesprek met Claude gestart.)' zie"). Deliberately keyed on the comment's
// CONTENT, not on which menu/gate the reviewer used to reach "Wis
// Claude-gesprek" — a comment that already carries real reviewer text always
// survives, regardless of entry point.
//
// Returns whether the backing comment/index row was actually removed
// (true only for the placeholder branch) — home.mjs's callers use this to
// decide whether a blokken-index comment/chat row just disappeared and
// therefore whether to navigate on to the next one (afterCommentRowRemoved,
// see comments-panel.md): clearing a chat that hangs off a REAL reviewer
// comment leaves that row in place, so nothing should navigate away from it.
//
// Focus after clearing (reviewer request): the Claude column itself is now
// empty, so it's never left as the keyboard's resting place. If the anchor
// comment SURVIVES (real reviewer/AI text), step onto it (toComment(), same
// helper the plain ← out of 'claude' already uses — lands on the card and
// drops the caret in the reply field). If nothing is left to land on — the
// anchor was a placeholder and got deleted above, or there was no anchor at
// all — fall back to exitRelated(), same as before.
//
// The ONE exception: the general (PR-wide, code-less) chat. Its anchor is
// ALWAYS exactly CLAUDE_ANCHOR_PLACEHOLDER (see startPrGeneralChat/
// isGeneralChatAnchor — nothing ever replaces its body except "Comment
// hiervan maken", which turns it into an ordinary comment and thus off this
// path entirely), and its own composer stays open and visible the whole
// time (the general-chat overlay, generalChatOverlay.mjs — "esc moet alles
// weer hidden" is the only thing that closes it). So exitRelated() here
// would leave that still-open composer pointed at a conversation id that no
// longer exists — reviewer request ("ik wil algemene chat kunnen
// verwijderen... nieuwe chat moet met schone lei beginnen") asks for the
// OPPOSITE: a fresh, empty conversation ready right away, not a dead
// composer. `cs.generalOverlay` (set by setGeneralChatOverlayVisible) is the
// only surface that can ever anchor there, so it doubles as a safe,
// no-import-cycle gate (see its own doc comment: "the overlay imports this
// module, never the other way round"). startPrGeneralChat only ever reads
// `state.pr`, so a minimal `{ pr: cs.pr }` is enough — no need to thread the
// real home.mjs `state` object through here.
export async function clearClaudeChat() {
  await sendClaudeMessage('', 'clear')
  // Belt-and-braces local reset, same reasoning as sendClaudeMessage's own
  // refetch: chat.message (SSE) already triggers loadChatMessages elsewhere,
  // but the reviewer's OWN action shouldn't wait on that round trip.
  setTurnProgress(cc.commentId, null)
  cs.claudePos = 0
  cs.claudePinned = true
  cs.claudeOptionSel = 0
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  const anchor = cc.commentId != null ? commentById(cc.commentId) : null
  if (anchor && anchor.body === CLAUDE_ANCHOR_PLACEHOLDER) {
    const wasGeneral = cs.generalOverlay && isGeneralChatAnchor(anchor)
    await deleteComment(anchor)
    await loadComments(cs.pr)
    if (wasGeneral) {
      await startPrGeneralChat({ pr: cs.pr }) // schone lei: a brand-new anchor/conversation, right away
    } else {
      exitRelated() // nothing left to focus — hand the keyboard back to the diff
    }
    return true
  }
  if (anchor) {
    toComment() // the comment survives the clear — step the keyboard onto it
  } else {
    exitRelated() // no comment behind this conversation — hand the keyboard back to the diff
  }
  return false
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
  const summarizingPlaceholder = t('Claude schrijft een samenvatting…')
  prefillField('[data-testid=message-edit-compose]', summarizingPlaceholder)
  await requestChatSummary(c.id, cc.messages.length)
  await pollChatSummary(c.id, want)
  if (want !== focusToken) return
  const el = document.querySelector('[data-testid=message-edit-compose]')
  if (!el || el.value.trim() !== summarizingPlaceholder) return // reviewer already started typing
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
// claudeChatShadowWarning below can answer SYNCHRONOUSLY — home.mjs decides at
// Enter/openMenu time whether "Wis Claude-gesprek" clears straight away or
// gets a confirm submenu first (plain, non-reactive code, mirroring
// commentCommandsFor's own focusedCommentGithubId snapshot read), and cannot
// itself await a fetch. A check that failed or hasn't landed yet therefore
// reads as "nothing pending" and the clear runs on the first Enter.
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
      shadowWarning = t(
        'Let op: er staat nog niet-gepushte Claude-code in de shadow-worktree van dit gesprek — die gaat verloren bij het wissen.',
      )
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
// currently on. Returns '' only when there is NO target at all (or a target
// without a file), which sendClaudeMessage/sendClaudeMessageFromNew treat as
// "send nothing extra". A target with a file but no code (commentTarget's own
// `!unit` fallback) still gets a context block of its own — see the second
// branch below for why that emptiness was the most harmful case, not the
// least.
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
      // proposedCode — the reviewer's own inline-edited draft (Block.mjs's
      // inline editor, "Opslaan"), set only by home.mjs's saveInlineEdit.
      // Every other caller's target has no proposedCode, so this branch is a
      // pure addition for every existing chat entry point (startClaudeChat/
      // startComment/etc.) — unchanged behaviour there. Deliberately sent as
      // plain, visible-to-Claude context (not the reviewer's own typed
      // message, see the file header) so the reviewer's own follow-up
      // question ("pas dit ook op andere plekken aan") is what they typed,
      // nothing more.
      if (t.proposedCode) {
        lines.push('Door de reviewer voorgestelde nieuwe code (nog niet doorgevoerd):', '```php', t.proposedCode, '```')
        // proposedStale — set true only when home.mjs's saveInlineEdit found
        // the new-side source had genuinely changed since this edit started
        // (a landing in between, this reviewer's own or a colleague's) — a
        // precise, computed fact, never a guess, see blockNewSourceText's own
        // doc comment (inlineEdit.mjs).
        if (t.proposedStale)
          lines.push(
            'Let op: dit voorstel is getypt tegen een eerdere versie van dit bestand — de huidige code hierboven kan intussen zijn gewijzigd.',
          )
      }
      parts.push(lines.join('\n'))
    } else if (t && t.file) {
      // A block WITHOUT navigable changes (commentTarget's own `!unit`
      // branch: code '', startLine 0) — in practice a drilled
      // Onderliggende-code column on an unchanged block, e.g. a class
      // member/constant. This used to fall through to '' and send the turn
      // with NO context at all, so a first message like "waar gebruiken we
      // dit?" had no referent whatsoever and Claude answered about whatever
      // the PR happens to be about instead of about the selected symbol
      // (reported bug, PR 13451 / SessionEnricher::DEFAULT_UTM_VALUES).
      // Naming the file + symbol is enough: deliberately NO source code, for
      // the same reason claudeRangeContextBlock sends none — Claude has read
      // access to this checkout and can open the exact spot itself.
      const lines = [
        'Context van de reviewer-selectie (niet door de reviewer getypt):',
        'Bestand: ' + t.file,
      ]
      if (t.label) lines.push('Onderdeel: ' + t.label)
      if (t.line) lines.push('Regel: ' + t.line)
      lines.push(
        'Dit onderdeel heeft in deze PR geen gewijzigde regels, dus er gaat geen voorbeeldcode mee — ' +
          'open het bestand zelf (je hebt hier leestoegang) als je de code nodig hebt.',
      )
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
// this unit (visibleComments()), chronologically (createdAt) — the order used
// to number each message's own fenced code blocks on screen (see
// threadFenceStartIndexes below): a "Codeblok N" badge the reviewer sees on
// one comment card keeps counting on from the previous comment card in the
// same block/line, purely a display convenience.
//
// Deliberately NO LONGER what claudeThreadContextBlock sends to Claude (see
// its own doc comment) — that used to be exactly this cross-thread scope, but
// each comment has its own, separate claude_chat Execution (Run ID = comment
// id, see workflows-comments.md), so a chat on comment A must not see
// comment B's text merely because both sit on the same line. This function
// itself still stays cross-thread: it is purely a rendering concern now
// (badge numbering), decoupled on purpose from what a chat is told — see
// "Codeblok numbering diverges from chat context (on purpose)" in
// claude-chat-panel.md before "fixing" this back into claudeThreadContextBlock.
// Skips CLAUDE_ANCHOR_PLACEHOLDER (see ensureClaudeAnchorForNew) since that is
// not a real message the reviewer wrote.
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
// as `orderedThreadMessages` when `c` is part of that scope (the ordinary
// block-scoped case) — purely a display convenience, so a reviewer scanning
// several comment cards on the same line sees one continuously numbered
// sequence of badges. This numbering is deliberately NOT what any one
// claude_chat conversation is told (see claudeThreadContextBlock and
// "Codeblok numbering diverges from chat context (on purpose)" in
// claude-chat-panel.md) — and falls back to `c`'s own thread in isolation
// otherwise (e.g. a PR-wide comment-index item's detail card, which has no
// cross-thread scope to match), so numbering is always at least continuous
// within one thread even there.
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

// claudeThreadContextBlock summarizes every already-written message on THIS
// conversation's own anchor comment only (chatAnchorComment(): its opening
// body plus every reaction/reply, via threadMessages) — never any OTHER
// comment thread that happens to sit on the same block/line. Each comment has
// its own, separate claude_chat Execution (Run ID = comment id, see
// workflows-comments.md), so a chat hanging on comment A must never learn
// about comment B's text just because a reviewer placed both on the same
// selection. Explicit product decision (Reindert, not a guess) — see
// "Codeblok numbering diverges from chat context (on purpose)" in
// claude-chat-panel.md for the accepted trade-off this creates against the
// still-cross-thread on-screen "Codeblok N" badges
// (threadFenceStartIndexes/orderedThreadMessages above): don't reunify the
// two scopes without re-reading that note.
//
// Ordered exactly as threadMessages(c) returns them (opening, then every
// reply/reaction in stored order — already chronological, unlike
// orderedThreadMessages' cross-thread merge, this needs no separate sort),
// and the LAST message is explicitly tagged as the most recent one the
// conversation builds on — an unordered dump left it unclear which remark is
// the standing one to react to (explicit reviewer request).
//
// Every fenced code block in every message is also annotated with the same
// "[Codeblok N]"/"[Suggestie N]" marker its visual badge shows
// (annotateFenceNumbers, markdown.mjs), numbered from 0 within this thread
// alone — which no longer necessarily matches the on-screen badge number for
// the SAME message when that card's badge continues a cross-thread count from
// a sibling comment (see threadFenceStartIndexes' own doc comment): a
// reviewer referencing "codeblok N" from a DIFFERENT comment's thread is no
// longer something this chat can resolve, an accepted consequence of scoping
// the context to just this thread.
function claudeThreadContextBlock() {
  const msgs = threadMessages(chatAnchorComment()).filter(
    (m) => m.body && m.body !== CLAUDE_ANCHOR_PLACEHOLDER,
  )
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
function clearFinishedChatProgress(commentId = cc.commentId) {
  const p = turnProgress(commentId)
  if (p && !p.running) applyChatProgress(commentId, null)
}

// syncChatTicker runs a 1s heartbeat only while a turn is actually running OR
// something is still inside its "recently finished" linger window (see
// anyRecentlyFinishedTurn/otherClaudeChats), so the elapsed-seconds
// counter advances AND a lingering "Andere chats in deze PR" row actually expires on
// screen, without a permanent timer on the page.
let chatTickTimer = null
function syncChatTicker() {
  const running = anyTurnRunning() || anyRecentlyFinishedTurn()
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
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  await ensureAndLoadChat(pr, c.id)
  if (token !== focusToken) return
  ensureChatEvents(pr)
  loadChatProgress(c.id)
  restoreClaudeComposerDraft()
  focusClaudeComposer()
  // Fire-and-forget: the "Wis Claude-gesprek" palette command's confirm gate
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
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  restoreClaudeComposerDraft()
  focusClaudeComposer()
}

// enterClaudeChatOrFromNew — the shared "hand the keyboard to the Claude
// column, whichever shape it's currently in" entry point. Extracted from
// ClaudeChatPanel's own read-only-card click handler (`enterFromReadOnly`,
// below — now calls this instead of duplicating the ternary) and exported
// for dictation.mjs's F5 tier-1 open (`openChatFn` in home.mjs):
// `claudeColumnVisible()` can be true purely because `cs.focus === 'new'`
// (a still-open, not-yet-placed comment draft — see enterClaudeChatFromNew's
// own doc comment above), and plain `enterClaudeChat` silently no-ops in
// that case (`chatAnchorComment()` is null for an unposted draft, so its own
// `if (!c) return` guard fires) — F5 pressed while dictating into a fresh
// comment used to do nothing at all instead of handing the keyboard to the
// already-visible Claude column. See "A second way to end a recording" in
// .claude/docs/dictation.md.
export function enterClaudeChatOrFromNew(pr) {
  if (cs.focus === 'new') enterClaudeChatFromNew()
  else enterClaudeChat(pr)
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
// A RUNNING turn is deliberately NOT a reason to keep this column visible
// (it was, until the reviewer reversed that: "een comment is gekoppeld aan
// code, chat aan comment, zo is een chat altijd gekoppeld aan code. laat het
// alleen in beeld als code is geselecteerd waar die chat over gaat"). The
// column is purely a function of the selected code; navigating elsewhere hides
// it as if no conversation existed, and the still-running turn reports itself
// through the index pill of its OWN code instead (claudeTurns.mjs). See "The
// chat column is a function of the selected code" in claude-chat-panel.md —
// don't reintroduce the stay-open branch here.
//
// isActiveAnchorGoneFromView is the one narrow exception, added for a
// reported bug: `hasVisibleComments()` reads `cs.view`, which recomputeView
// unconditionally drops an ORPHANED comment from (`isOrphanComment`,
// re-anchor.go's re-anchor pass — the code its row anchor matched by SNIPPET
// is no longer findable under the block's current label, e.g. a commit
// landed elsewhere that renamed it) — the SAME every-5s comment poll
// (refreshTimer) that keeps `cs.list`/`cs.view` fresh. While the reviewer is
// mid-conversation (cs.focus === 'claude', cc.commentId already anchored) on
// the EXACT SAME unit the whole time, that reclassification landing made the
// entire comment/Claude column (and a half-typed, unsent message with it)
// vanish out from under them a few seconds after entering it — with no
// navigation having happened at all. That reads as a bug, not as "navigating
// elsewhere": `cs.focus` only ever leaves 'claude' via an explicit
// leaveRelated()/block switch (see lastSelectedBlockRef in home.mjs), so
// `cs.focus === 'claude'` on its own already proves the reviewer never left
// this unit — the orphan reclassification is the only thing that changed.
// `ccAnchorComment()`'s own `cc.commentId != null` branch resolves through
// the UNFILTERED `cs.list` (see its own doc comment, written for the exact
// same "don't trust the possibly-stale filtered index while cc.focus is
// 'claude'" reason), so a merely-orphaned (not actually deleted) comment
// still resolves here.
function isActiveAnchorGoneFromView() {
  return cs.focus === 'claude' && cc.commentId != null && ccAnchorComment() != null
}
export function claudeChatVisible() {
  return hasVisibleComments() || isPrCommentScope() || isNewChatUnanchored() || isActiveAnchorGoneFromView()
}

// isPrCommentScope — an unanchored comment-index item (a PR-wide comment, an
// orphan, or an ai_warning that resolves to no block) is selected: home.mjs's
// commentScope sentinel, `{ none: true, prComment: c }`. Such an item has no
// code unit, so cs.view is empty by design (recomputeView) — but it DOES have
// a comment, and therefore a conversation worth showing.
//
// Reviewer request: "ik wil hetzelfde blokje zien als normaal rechts. Bij alle
// algemene comments en ai waarschuwingen." So the ordinary right-hand Claude
// column shows here too, anchored by chatAnchorComment's own `s.none` branch —
// the same component, in the same place, as for any block-scoped comment.
// This REPLACED an embedded copy inside the item's own detail card that only
// appeared after the "Chat met Claude" command (the `pcc` toggle); one chat,
// one surface.
//
// Exported so home.mjs's DetailPanel can hide the top-level block-column
// entirely for this case too (see "The comment-detail card moved into the
// merged comment-claude-row" in comments-panel.md) — the same "leading
// column" treatment isCommentAnchorDrillActive already gets for an ANCHORED
// comment-index item, just without a drilled column of its own.
export function isPrCommentScope() {
  const s = cs.scope
  return !!(s && s.none && s.prComment)
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
  return !cs.prWideCompose && !cs.generalOverlay && claudeChatVisible()
}

// setGeneralChatOverlayVisible — called by generalChatOverlay.mjs on open and
// close. Deliberately routed through the column's OWN existing visibility gate
// rather than toggling ClaudeChatPanel at its mount site in home.mjs: that
// turned the mount into a keyed-template <-> '' toggling slot, which silently
// broke the column's event bindings (Escape-to-cancel stopped reaching the
// composer) — the disposal hazard described in
// .claude/rules/arrowjs-pitfalls.md.
export function setGeneralChatOverlayVisible(v) {
  cs.generalOverlay = !!v
}

// commentSideFocused — "is the keyboard currently on the LEFT (comment)
// half of the merged comment-claude-row": an existing conversation's
// 'comment'/'thread' cursor, or the still-open, not-yet-placed 'new'
// composer. Drives the read-only shrink below (Claude goes read-only/1/3
// while this is true) together with its mirror, isClaudeChatFocused()
// (already exported above) for the comment side's own read-only shrink.
// Reviewer's own words, and explicitly confirmed to include 'new': "als ik
// in de selectie zit van een comment, laat dan de claude chat ... " — see
// "Read-only, not a rail" in .claude/docs/comments-panel.md for the current
// shape of this feature (superseding an earlier rail-collapse cut).
function commentSideFocused() {
  return cs.focus === 'comment' || cs.focus === 'thread' || cs.focus === 'new'
}

// claudeColumnReadOnly / commentColumnReadOnly — only true below this row's
// OWN width threshold (state.commentClaudeNarrow, COMMENT_CLAUDE_WIDE_BREAKPOINT_PX
// in home.mjs — a DELIBERATELY separate, wider cutoff than Tailwind's
// app-wide `narrow` screen, 1399px; see state.commentClaudeNarrow's own doc
// comment in home.mjs for why the two must not be merged) AND only while the
// SIBLING half owns the keyboard. Answers TWO questions at once, since they
// always coincide for this feature: does this half shrink to 1/3 width
// (columnPairScale below), and does it render its read-only content instead
// of its interactive one (ClaudeChatPanel/InlineComments below) — no
// separate "collapsed" concept any more, this half still shows everything
// that was said, just without any composer/button/in-body-link
// interactivity (see "Read-only, not a rail" in
// .claude/docs/comments-panel.md — this superseded an earlier cut that
// collapsed the sibling to a bare rail, `railButtonHTML`/`RAIL_WIDTH_REM`;
// that idiom is unchanged and still used elsewhere, see
// src/collapsedRail.mjs's own doc comment, just no longer for this pair).
// Exported so home.mjs's own `.key(...)` calls for these two columns can
// fold the read-only/interactive state into the key (a keyed node that
// silently switches shape without a fresh key is the "keyed node reused
// without re-running its bindings" pitfall, see
// .claude/rules/arrowjs-pitfalls.md).
export function claudeColumnReadOnly(state) {
  return !!(state && state.commentClaudeNarrow) && commentSideFocused()
}
export function commentColumnReadOnly(state) {
  return !!(state && state.commentClaudeNarrow) && isClaudeChatFocused()
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
// focusPreviewCard is focusClaudeComposer's counterpart for the code-preview
// cursor (cs.previewPos, see its own doc comment): it blurs the composer — the
// highlighted CARD, not the empty text field, should read as focused, exactly
// like the options/transcript rungs above — and keeps the card in view.
// scrollIntoViewVertical, never scrollIntoView itself: the cards sit inside
// <main>'s horizontally scrolling column flow (the axis rule in
// arrowjs-pitfalls.md).
function focusPreviewCard() {
  releaseFocus()
  const want = focusToken
  // Blur synchronously — see the identical comment in focusClaudeComposer
  // above for why this can't wait for the requestAnimationFrame below.
  const composeAtCall = document.querySelector('[data-testid=claude-chat-compose]')
  if (composeAtCall && document.activeElement === composeAtCall) composeAtCall.blur()
  requestAnimationFrame(() => {
    if (want !== focusToken) return
    const input = document.querySelector('[data-testid=claude-chat-compose]')
    if (input && document.activeElement === input) input.blur()
    const el = document.querySelectorAll('[data-testid=code-preview-card]')[cs.previewPos - 1]
    // alignToTopVertical, not scrollIntoViewVertical: a card can be much
    // taller than its scroller once expanded (a full pane of code), so
    // "nearest edge" leaves the OTHER edge — including the card's own
    // selection border/title, the part that actually answers "where is my
    // selection" — off-screen depending on which direction the cursor came
    // from (reported bug: ↑ walked the selection out of view). Same fix as
    // scrollCommentIntoView/scrollCodeIntoView already apply to comment
    // cards/Onderliggende-code children for the identical reason.
    if (el) alignToTopVertical(el)
  })
}
// focusClaudeTaskRow mirrors focusPreviewCard for the "other running Claude
// tasks" rung (cs.claudeTasksPos, see its own doc comment): blurs the
// composer and keeps the highlighted row in view. scrollIntoViewVertical,
// never scrollIntoView itself — same axis rule as focusPreviewCard.
function focusClaudeTaskRow() {
  releaseFocus()
  const want = focusToken
  // Blur synchronously — see the identical comment in focusClaudeComposer
  // above for why this can't wait for the requestAnimationFrame below.
  const composeAtCall = document.querySelector('[data-testid=claude-chat-compose]')
  if (composeAtCall && document.activeElement === composeAtCall) composeAtCall.blur()
  requestAnimationFrame(() => {
    if (want !== focusToken) return
    const input = document.querySelector('[data-testid=claude-chat-compose]')
    if (input && document.activeElement === input) input.blur()
    const el = document.querySelectorAll('[data-testid=claude-task-row]')[cs.claudeTasksPos - 1]
    if (el) scrollIntoViewVertical(el)
  })
}

// tasksFromFocus remembers which panel boundary the reviewer entered the
// footer's "andere chats in deze PR" rung from ('code' or 'thread', see
// enterFooterTasks/exitFooterTasks below) — a plain module variable in the
// same vein as codeFromClaudeTail (Onderliggende-code's own "remember where
// I came from" flag), so stepping back out lands exactly where the reviewer
// left, not at a fixed destination.
let tasksFromFocus = 'code'

// enterFooterTasks lands the keyboard on CommentClaudeFooter's own
// otherClaudeChats list with NO comment/claude column open beneath
// it — the footer-only card (hasCommentClaudeFooter() true,
// claudeChatVisible() false: no anchor exists for the current unit at all,
// but another conversation is running elsewhere in the PR). Deliberately its
// own cs.focus value ('tasks'), never a bare cs.focus = 'claude' with no
// anchor: claudeChatVisible()'s own third branch would then wrongly render
// the composer/chat column for a unit that genuinely has no comment.
// Reached from the panel's own top boundary — see the 'code' and 'thread'
// branches of handleRelatedKey below. Lands on the LAST row, closest to the
// boundary the reviewer just came from, mirroring codeFromClaudeTail's own
// "land at the tail" convention.
function enterFooterTasks(fromFocus) {
  tasksFromFocus = fromFocus
  cs.focus = 'tasks'
  cs.claudeTasksPos = otherClaudeChats().length
  focusClaudeTaskRow()
}

// exitFooterTasks reverses enterFooterTasks: back to 'code' (the ordinary
// case) or back to 'thread' at its own oldest message (reactionCount(),
// mirroring how the 'thread' branch itself landed there) when reached from
// there instead — cs.sel never changed while browsing the footer's list, so
// the same conversation's thread is still the right one to return to.
function exitFooterTasks() {
  cs.claudeTasksPos = 0
  if (tasksFromFocus === 'thread') {
    cs.focus = 'thread'
    cs.threadPos = reactionCount()
    focusThread()
  } else {
    cs.focus = 'code'
    scrollCodeIntoView()
  }
}

// isFooterTasksFocused — home.mjs's own Enter guard (mirrors
// isClaudeChatFocused) needs to widen to this state too, since
// selectHighlightedClaudeTask() below is reachable from here as well as from
// 'claude'.
export function isFooterTasksFocused() {
  return cs.focus === 'tasks'
}

function focusClaudeComposer() {
  releaseFocus()
  const want = focusToken
  // Blur the composer SYNCHRONOUSLY, right here, whenever the cursor is
  // moving onto a nested rung (an option/task/card — anywhere claudePos/
  // claudeOptionSel isn't the rest position) — not deferred into the
  // requestAnimationFrame below. A still-focused composer keeps its own
  // `@keydown` (ClaudeChat.mjs) as the EVENT TARGET, so a keypress fired in
  // the up-to-one-frame window before that deferred blur ran (Playwright's
  // back-to-back key presses easily land inside it; a fast real keystroke
  // can too) was intercepted by the composer's own Enter handling — treating
  // it as "send"/"open the menu on an empty field" — instead of ever
  // reaching home.mjs's document-level handler for the rung the reviewer had
  // already (per this reactive state) navigated onto. Reported bug: Enter
  // right after ↓ into "Andere chats in deze PR" sometimes opened the Claude menu
  // instead of jumping to the highlighted task. See
  // tests/claude-chat-other-tasks.spec.mjs.
  if (!(cs.claudePos === 0 && cs.claudeOptionSel === 0)) {
    const input = document.querySelector('[data-testid=claude-chat-compose]')
    if (input && document.activeElement === input) input.blur()
  }
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

// CLAUDE_BUBBLE_SCROLL_LINES — reviewer request: "de chat venster is niet
// heel hoog... als ik naar boven ga, wil ik per 4 line breaks naar boven
// kunnen drukken" (briefly tried at 10 in the same conversation, then
// corrected back to 4). A long Claude answer is often a SINGLE bubble taller than
// the `max-h-[38vh]` thread (see the huge bulleted list in the reported
// screenshot), so before this, ↑/↓ on cs.claudePos could only ever jump a
// WHOLE bubble at a time — reading it required scrolling by hand with the
// mouse. "4 regels" means 4 rendered/word-wrapped lines as they sit on
// screen, not literal `\n` characters — measured off the bubble's own
// computed line-height.
const CLAUDE_BUBBLE_SCROLL_LINES = 4

// activeClaudeBubbleEl resolves the DOM node of the bubble cs.claudePos
// currently points at (the one claudeBubble() renders with `active: true`),
// or null at the rest position (cs.claudePos === 0, no turn selected — see
// claudeBubble's own `active = claudePos() === total - i`). Mirrors
// scrollClaudeMessageIntoView's own index math.
function activeClaudeBubbleEl() {
  if (cs.claudePos < 1) return null
  const j = cc.messages.length - cs.claudePos
  return document.querySelectorAll('[data-testid=claude-message]')[j] || null
}

// activeClaudeMessageBody mirrors activeClaudeBubbleEl's own index math but
// returns the active turn's raw text (cc.messages[j].body) instead of its
// DOM node — used by Cmd+C (home.mjs's onKeydown) to copy the selected
// bubble's own text without depending on an actual DOM text selection. Same
// null-at-rest contract as activeClaudeBubbleEl (cs.claudePos < 1).
export function activeClaudeMessageBody() {
  if (cs.claudePos < 1) return null
  const j = cc.messages.length - cs.claudePos
  const m = cc.messages[j]
  return (m && m.body) || null
}

// scrollClaudeMessageWithinBubble scrolls the transcript scroller by
// CLAUDE_BUBBLE_SCROLL_LINES lines of the ACTIVE bubble's own text, in `dir`
// ('up' walks earlier text, 'down' walks later text) — called from
// handleRelatedKey BEFORE it steps cs.claudePos onto a different bubble, so a
// long bubble is read through 4 lines at a time first. Returns true once it
// actually moved the scroller (the caller then skips its own cs.claudePos
// step for this keypress); false the moment the requested edge of the
// bubble is already visible (its own top for 'up', its own bottom for
// 'down') — the ordinary per-bubble step then takes back over exactly where
// it always did. A short bubble that already fits entirely in the thread
// (the common case, unchanged behaviour) always returns false immediately.
function scrollClaudeMessageWithinBubble(dir) {
  const el = activeClaudeBubbleEl()
  const scroller = el && verticalScroller(el)
  if (!el || !scroller) return false
  const eRect = el.getBoundingClientRect()
  const sRect = scroller.getBoundingClientRect()
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18
  const delta = lineHeight * CLAUDE_BUBBLE_SCROLL_LINES
  if (dir === 'up') {
    if (eRect.top >= sRect.top - 0.5) return false
    scroller.scrollTop = Math.max(0, scroller.scrollTop - delta)
    return true
  }
  if (eRect.bottom <= sRect.bottom + 0.5) return false
  scroller.scrollTop = scroller.scrollTop + delta
  return true
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
    // event in every browser, so update the scroll hints directly too (see
    // scrollFade.mjs / "A capped, fading thread" in comments-panel.md) — and,
    // for the same reason, resync claudePinned directly too: otherwise a
    // stale `false` left over from a transient scroll during layout/focus
    // would have nothing to ever flip it back, permanently suppressing this
    // very function.
    updateScrollHints(el)
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
  loadRunningTurns(pr)
  // Every frame of this PR is accepted, not just the conversation on screen:
  // a turn running on other code is exactly what the index pill reports (see
  // claudeTurns.mjs).
  onEvent('chat.progress', (ev) => {
    if (!ev.key) return
    applyChatProgress(ev.key, ev.data || null)
    const p = turnProgress(ev.key)
    if (p && !p.running) {
      if (ev.key === cc.commentId) {
        // The turn ended. Keep the partial visible for a moment so the bubble
        // doesn't blink out before the real message has been refetched — the
        // chat.message right behind this normally clears it within one fetch;
        // this timer is only the safety net for when that never arrives.
        setTimeout(() => clearFinishedChatProgress(ev.key), 4000)
      } else {
        // Nothing on screen to protect, and the reviewer has an answer waiting
        // on code they are not looking at — that is what the pill is for.
        applyChatProgress(ev.key, null)
        markTurnAnswered(ev.key)
      }
    }
  })
  onEvent('chat.message', (ev) => {
    if (!ev.key) return
    if (ev.key === cc.commentId) {
      loadChatMessages(cc.commentId).then(() => clearFinishedChatProgress(cc.commentId))
      return
    }
    // A transcript change on a conversation we know had a turn going: mark it
    // so its index pill says an answer landed. Never trusted as content — the
    // transcript itself is only ever refetched for the conversation in view.
    if (turnProgress(ev.key) || isTurnBusy(ev.key)) markTurnAnswered(ev.key)
    // Drop any cached "andere chats in deze PR" title for it too — this
    // conversation's own last message may have just changed, so the next
    // render's ensureOtherTaskTitle (otherClaudeChats) refetches a
    // fresh one on demand instead of keeping a stale string forever.
    if (otherTaskTitles.byId[ev.key] !== undefined) {
      const next = { ...otherTaskTitles.byId }
      delete next[ev.key]
      otherTaskTitles.byId = next
    }
    // Same drop-and-refetch-on-demand for the unread cache (see
    // chatUnread.mjs) — a foreign conversation's transcript just changed, so
    // the next render's ensureChatUnread re-derives it against the fresh
    // last-message time instead of keeping a stale answer forever.
    dropChatUnreadCache(ev.key)
  })
  onEventsResync(() => {
    loadRunningTurns(cs.pr)
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
    // Which conversation the composer's pasted/dragged images belong to, and
    // — while there is none yet ("Chat over deze regel", whose anchor comment
    // is only created by the first message) — the composer draft key they are
    // parked under until there is. See chatAttachments.mjs's bucket note and
    // "Afbeeldingen meesturen" in .claude/docs/claude-chat-panel.md.
    conversationId: () => cc.commentId || '',
    attachmentBucket: () => cc.commentId || claudeChatDraftKey(),
    status: () => cc.status,
    busy: () => ccBusy(),
    // Whether the "Ook andere opnieuw proberen" bulk retry is currently
    // running — disables both retry buttons while it walks the PR's other
    // conversations (see retryAllFailedClaudeChats).
    retryAllBusy: () => isRetryingAllFailedClaudeChats(),
    // Whether there is a turn to cancel right now (busy, or still starting
    // up, or waiting in the queue) — the same gate the visible "Stop" button
    // (claudeActive/hasActiveClaudeTurn, CommentClaudeFooter above) already
    // uses, deliberately WIDER than the bare `busy` getter above. The
    // composer's own Escape-to-cancel branch reads this — see "Cancelling a
    // running turn" in .claude/docs/claude-chat-panel.md.
    active: () => hasActiveClaudeTurn(),
    // The last send that never made it to the workflow — '' when there is
    // none. Per conversation (claudeTurns.mjs), narrowed to cc.commentId. See
    // sendClaudeMessage/sendErrorText.
    sendError: () => ccSendError(),
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
      return t('{label} · regel {n}', { label: t(GRAN_LABEL[c.gran] || 'deze context'), n: c.line })
    },
    // The live turn: null when nothing is running. See ccProgress.
    progress: () => ccProgress(),
    // The reviewer's own not-yet-sent turns, oldest first — scoped to the
    // conversation in view, since an entry keeps the one it was typed against
    // (see queueClaudeMessage).
    queued: () => queuedFor(cc.commentId),
    // Seconds since the running turn started. cc.tick is read purely to
    // register the reactive dependency that makes this re-render every second
    // (the value itself is irrelevant — the real number comes from the clock).
    elapsed: () => {
      const p = ccProgress()
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
    // "Ook andere opnieuw proberen" — see retryAllFailedClaudeChats' own doc
    // comment for what "gefaald" means here and why it can't reuse
    // otherClaudeChatsAll().
    onRetryAll: () => retryAllFailedClaudeChats(),
    onCleanup: (choice) => resolveCancelCleanup(choice),
    // Escape pressed in the composer while a turn is running (ClaudeChat.mjs's
    // own @keydown, gated on view.active()) — reuses the exact same
    // cancelClaudeTurn() the "Stop" button and the Enter-palette item call.
    onCancel: () => cancelClaudeTurn(),
    onFocus: () => onClaudeComposeFocus(),
    onEmptyEnter: () => openClaudeMenuFromComposer(),
    // The composer's own draft (claudeDrafts, see its doc comment) — kept in
    // sync per keystroke exactly like every other composer's own @input
    // handler in this file, and cleared once the typed text actually goes
    // out as a real turn (ClaudeChat.mjs calls this right after it clears
    // the field on send).
    onInput: (text) => setClaudeDraft(claudeChatDraftKey(), text),
    onSent: () => deleteClaudeDraft(claudeChatDraftKey()),
    // The pane's own @scroll handler (see updateClaudeThreadPinned) and its
    // "scroll to recent" button's click handler — both live here, never in
    // ClaudeChat.mjs itself, since that file never imports this one back.
    onThreadScroll: (el) => updateClaudeThreadPinned(el),
    onJumpToBottom: () => jumpToClaudeThreadBottom(),
    // Mouse entry point into claudeChatCommandsFor() ("Wis Claude-gesprek",
    // "Comment hiervan maken", "Probeer de mislukte turn opnieuw") — reuses
    // the exact same opener the composer's own blank-Enter already calls.
    // `opts` forwards straight through (a right-click on claude-chat-card
    // passes {native,x,y} — see "The right-click context menu" in
    // command-palette.md).
    onOpenMenu: (opts) => openClaudeMenuFromComposer(opts),
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
function openClaudeMenuFromComposer(opts) {
  if (claudeMenuOpener) claudeMenuOpener(opts)
}

// commentMenuOpener/prCommentMenuOpener — same cross-module pattern as
// claudeMenuOpener above, for postThreadReply/postPrCommentReply below:
// after a reply actually lands, the reviewer should see the row's own action
// menu (Resolve/etc.), not the diff — reviewer report: "als ik een reactie
// plaats op een comment, wil ik niet daarna gelijk naar de diff, ik wil het
// menu zien waar ik kan bijvoorbeeld resolven". See "A reply opens the
// comment's own menu instead of releasing to the diff" in comments-panel.md.
let commentMenuOpener = null
export function setCommentMenuOpener(fn) {
  commentMenuOpener = fn
}
let prCommentMenuOpener = null
export function setPrCommentMenuOpener(fn) {
  prCommentMenuOpener = fn
}

// selectHighlightedClaudeOption — the Enter-key counterpart of clicking a
// claudeQuestionOption button (see the ↑/↓ chain in handleRelatedKey's
// 'claude' branch above): sends whichever option cs.claudeOptionSel is
// currently pointing at, through the exact same path a click already uses,
// and resets the highlight. A no-op — returning false — when nothing is
// highlighted (cs.claudeOptionSel === 0) or the question the highlight was
// built against is no longer the pending one (answered/superseded
// meanwhile), so home.mjs's caller can fall through to whatever Enter would
// otherwise do in the Claude column.
//
// A 'cleanup_choice' question routes through resolveCancelCleanup — the
// dedicated "cleanup" Signal action, NEVER the ordinary answer/resume round
// trip — exactly like its own click handler (claudeQuestionOptions' onCleanup
// branch, ClaudeChat.mjs); every other kind ('question'/'directory_decision')
// goes through sendClaudeMessageFromNew, same as a click's onSend branch.
// hasHighlightedClaudeOption — true exactly when Enter would hit the branch
// above (a reviewer-navigated, still-pending inline option), without actually
// sending anything. Exported so home.mjs's onKeydown can let THIS Enter win
// over the werkmap overlay (isWorkDirOverlayOpen()), which otherwise owns
// every keypress unconditionally the moment a PR-wide checkout decision is
// also open — see "Enter on a keyboard-highlighted inline question option
// must not be swallowed by an unrelated, PR-wide werkmap overlay" below for
// the reported bug this guards against. Deliberately the exact same
// condition as selectHighlightedClaudeOption's own early return (mirrored,
// not shared, so this stays a pure read with no cs.claudeOptionSel reset).
export function hasHighlightedClaudeOption() {
  return cs.focus === 'claude' && cs.claudePos === 0 && cs.claudeOptionSel > 0 && !!pendingClaudeQuestion()
}

export function selectHighlightedClaudeOption(state, commentTarget) {
  if (cs.focus !== 'claude' || cs.claudePos !== 0 || cs.claudeOptionSel === 0) return false
  const q = pendingClaudeQuestion()
  if (!q) return false
  const idx = q.options.length - cs.claudeOptionSel
  const text = q.options[idx]
  if (text == null) return false
  cs.claudeOptionSel = 0
  focusClaudeComposer()
  if (q.kind === 'cleanup_choice') {
    resolveCancelCleanup(text)
  } else {
    sendClaudeMessageFromNew(state, commentTarget, text)
  }
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
  if (cs.busy) return t('Bezig…')
  if (cs.replySent) return t('Verstuurd')
  return ''
}

// hasActiveClaudeTurn — true whenever the currently ANCHORED conversation has
// a turn in flight: a send/Signal round-trip actually running, a live progress
// snapshot pushed over SSE, or a reviewer message waiting in the client-side
// queue (see queueClaudeMessage). Strictly per conversation: a turn running on
// another selection is not "active" here — it reports itself through its own
// index pill (claudeTurns.mjs) — which is also why this no longer decides
// whether the column stays VISIBLE (see claudeChatVisible below and "The chat
// column is a function of the selected code" in
// .claude/docs/claude-chat-panel.md). Its remaining job is the footer's status
// line.
export function hasActiveClaudeTurn() {
  return ccBusy() || !!ccProgress() || queuedFor(cc.commentId).length > 0
}

// chatTaskTitle — the OLD, thread-based fallback title: the most recent
// message of the underlying comment thread a conversation hangs on
// (threadMessages already puts the root comment's own body first, so with
// zero replies "the last message" IS the root comment). Superseded as the
// PRIMARY title by ownMessageTitle below (the reviewer explicitly wants their
// own last Claude message, not the comment thread) — kept only as the
// fallback otherTaskTitleFor uses while a row's own fetch hasn't resolved
// anything better yet (see its own doc comment), so a running task's row is
// never blank. One line, same truncation length as commentBlockItem's own
// index-row snippet (home.mjs), for the same reason: a full comment body
// would blow up this compact row.
function chatTaskTitle(c) {
  if (!c) return ''
  const msgs = threadMessages(c)
  const last = msgs.length ? msgs[msgs.length - 1] : c
  return ((last && last.body) || c.body || '').trim().replace(/\s+/g, ' ').slice(0, 60)
}

// firstSentence — one sentence, plain text: trims, collapses newlines/runs of
// whitespace into single spaces, and cuts at the first `.`/`!`/`?` followed by
// whitespace or the end of the string (a simple heuristic, not a real
// sentence tokenizer — good enough for a reviewer's own short chat message).
// A capped length (80 chars) is the fallback for a sentence with no
// punctuation at all, so one long run-on message can't blow up the row/line
// it titles.
function firstSentence(text) {
  if (!text) return ''
  const flat = text.trim().replace(/\s+/g, ' ')
  const m = flat.match(/^.*?[.!?](?=\s|$)/)
  return (m ? m[0] : flat).slice(0, 80)
}

// ownMessageTitle — "the reviewer's own last message in that conversation,
// first sentence" (explicit reviewer request, replacing the thread-based
// chatTaskTitle above as the PRIMARY title everywhere it's shown): the newest
// entry of `messages` with `role === 'user'` — never Claude's own answer.
// Falls back to the anchor comment's own text when nothing has been typed
// into Claude yet but the comment itself is real, i.e. not the auto-created
// anchor placeholder (isChatAnchorPlaceholder) — that placeholder sentence is
// exactly the unusable text the reviewer reported ("Selected: (Nog geen eigen
// comment getypt…"). Returns '' when there is genuinely nothing of the
// reviewer's own to show yet; callers decide what that means for THEM (the
// "Selected: …" line hides entirely, see CommentClaudeFooter; a task-list row
// falls back further to chatTaskTitle, see otherTaskTitleFor).
function ownMessageTitle(messages, c) {
  const own = (messages || []).filter((m) => m.role === 'user')
  if (own.length) return firstSentence(own[own.length - 1].body)
  if (c && !isChatAnchorPlaceholder(c)) return firstSentence(c.body)
  return ''
}

// otherTaskTitles — per-conversation cache of ownMessageTitle's result for a
// conversation that is NOT the one currently anchored/loaded here (`cc` only
// ever holds ONE conversation's transcript at a time — see "Parallel
// conversations" in .claude/docs/claude-chat-panel.md — so a task list built
// from OTHER running conversations has no transcript to read `role: 'user'`
// from without its own fetch). Reassigned as a whole object on every update
// (never mutated in place), same pattern as claudeTurns.mjs's own
// `turns.byId`, so the reactive binding reading it re-renders. `undefined` =
// never fetched; an explicit `''` is itself a valid "fetched, nothing of the
// reviewer's own to show" result — both are told apart in ensureOtherTaskTitle's
// own guard below.
const otherTaskTitles = reactive({ byId: {} })

// otherTaskTitlesFetching — plain (non-reactive) de-dup guard: otherClaudeChats
// calls ensureOtherTaskTitle on every relevant render, so without this a
// conversation whose fetch is still in flight would fire a second (and third,
// …) concurrent request for the same id.
const otherTaskTitlesFetching = new Set()

// otherTaskAutoStarted / otherTaskAnswered — two more facts read off the SAME
// transcript fetch ensureOtherTaskTitle already does, cached the same way
// (undefined = not yet known → a row stays visible until its own fetch
// resolves, never hidden speculatively). Reviewer requests, both about
// "Andere chats in deze PR": "ik wil hier niet de chats zien die automatisch
// zijn gestart" (a kilo-code auto-check turn, chat.KindAutoCheck /
// chatActionAutoCheck in chat_workflow.go — its first user message carries
// kind 'auto_check') and "ik wil daar ook niet chats zien die antwoord hebben
// gegeven en die ik bekeken heb" (chatStateOf's existing 'seen' state, but
// ONLY once there is actually an answer — a chat nobody has replied to yet
// falls into 'seen' too and must stay visible). See otherClaudeChatsAll's own
// filter below.
const otherTaskAutoStarted = reactive({ byId: {} })
const otherTaskAnswered = reactive({ byId: {} })

// ensureOtherTaskTitle lazily fetches `c`'s own transcript (the same
// read-only GET /api/chat?commentId= loadChatMessages already uses) purely to
// compute its title, exactly once per id until invalidated. Invalidation is
// the existing `chat.message` SSE handler (below, in ensureChatEvents) —
// dropping the cached entry for a FOREIGN conversation the moment its
// transcript actually changes, so "alleen opnieuw ophalen als er iets
// veranderd is" holds without a poller of its own. Explicitly accepted cost
// (the reviewer's own call, given the alternative — the old thread-text
// title — read as unusable): one extra GET per conversation that is both
// running AND appears in this list, refetched only on a real transcript
// change.
function ensureOtherTaskTitle(c) {
  if (!c || otherTaskTitles.byId[c.id] !== undefined || otherTaskTitlesFetching.has(c.id)) return
  otherTaskTitlesFetching.add(c.id)
  fetch('/api/chat?commentId=' + encodeURIComponent(c.id) + repoParam())
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      const title = ownMessageTitle(json && json.messages, c)
      otherTaskTitles.byId = { ...otherTaskTitles.byId, [c.id]: title }
      // The very same payload already answers "has this chat an answer the
      // reviewer hasn't looked at for the full 5s dwell yet" (seen_at vs the
      // newest assistant turn, see chatUnread.mjs), which chatStateOf reads
      // for its own 'nieuw' state word — so it is filled in from here rather
      // than through a second, identical GET per row (ensureChatUnread's own
      // fetch). Same cache, same invalidation: the chat.message SSE handler
      // drops both entries together.
      if (json) {
        setChatUnread(c.id, unreadFromTranscript(json))
        const firstUser = (json.messages || []).find((m) => m.role === 'user')
        otherTaskAutoStarted.byId = {
          ...otherTaskAutoStarted.byId,
          [c.id]: !!firstUser && firstUser.kind === 'auto_check',
        }
        otherTaskAnswered.byId = {
          ...otherTaskAnswered.byId,
          [c.id]: !!lastAssistantMessageAt(json.messages),
        }
      }
    })
    .catch(() => {
      // Left unresolved on a failed fetch — otherTaskTitleFor's own
      // chatTaskTitle(c) fallback covers it meanwhile, and either a later
      // render or the next chat.message event tries again.
    })
    .finally(() => otherTaskTitlesFetching.delete(c.id))
}

// unreadFromTranscript — "not yet viewed for the full dwell": the newest
// assistant turn is newer than the durable seen_at the 5s dwell writes
// (scheduleChatSeenDwell → the chat 'seen' Signal). Same expression
// ensureChatUnread uses, lifted out so ensureOtherTaskTitle can reuse the
// transcript it already fetched instead of asking for it twice.
function unreadFromTranscript(json) {
  const lastAt = lastAssistantMessageAt(json.messages)
  return !!lastAt && lastAt > (json.seenAt || '')
}

// otherTaskTitleFor — claudeTaskRow's own title getter: the fetched "own last
// message" once known (falls through on an explicit '' too — "nothing of the
// reviewer's own" is exactly when the old fallback earns its keep), otherwise
// chatTaskTitle(c) — so a row is never blank while its fetch is still in
// flight or came back with nothing better. This is the one deliberate
// asymmetry with the "Selected: …" line (which hides entirely instead, see
// CommentClaudeFooter): a list row represents a conversation that is
// genuinely running right now and must stay visible, unlike a label that can
// simply not exist.
function otherTaskTitleFor(c) {
  return otherTaskTitles.byId[c.id] || chatTaskTitle(c)
}


// otherClaudeChats — EVERY other Claude conversation of this PR, not just the
// ones with a turn running right now. Reviewer report on the old behaviour:
// "ik zie maar 1 andere chat, maar er zijn veel meer chats bezig op dat
// moment ... laat een hele lijst zien van alle chats", answered with "alle
// chats van deze pr en chats die ik nog niet x seconden heb bekeken (ik denk
// 5 seconden)". So the list is now:
//
//   - every conversation of this PR (cc.conversations — "here a Claude
//     conversation really happened" — plus this PR's own general-chat anchor,
//     exactly the source openChatComments' index section already uses), PLUS
//   - any conversation with a turn running right now, even one whose comment
//     hasn't landed in cs.list yet,
//   - minus the conversation currently anchored/shown by name (the
//     "Selected: …" line in CommentClaudeFooter).
//
// Ordering is by chatStateOf's own rank (bezig → klaar → nieuw → bekeken),
// which is also what implements the "nog niet 5 seconden bekeken" criterion:
// a chat the reviewer has genuinely dwelt on (scheduleChatSeenDwell's 5s
// timer writes the durable seen_at) sinks to 'bekeken', while anything with
// an unseen answer stays up top as 'nieuw'. That REPLACES the old hard
// 2-minute "recently finished" linger as the inclusion rule (the linger
// itself still exists, purely for the "Klaar" state below).
//
// Two more reviewer requests narrow this further, both a hard EXCLUSION
// rather than a ranking: an automatically started chat (kilo's own
// auto-check turn, see otherTaskAutoStarted above) never appears here at all,
// and a chat that reached 'bekeken' AND actually has an answer
// (otherTaskAnswered) is dropped too — "ik wil hier niet de chats zien die
// automatisch zijn gestart" / "ik wil daar ook niet chats zien die antwoord
// hebben gegeven en die ik bekeken heb". A chat nobody has replied to yet is
// ALSO 'bekeken' by chatStateOf's fallback, but stays visible: only the
// answered+bekeken combination is filtered. See the `filtered` step below.
//
// Resolves each id to its own comment via cs.list (the PR-wide comment list
// this panel already keeps loaded) so a row can show a title
// (otherTaskTitleFor) and jump to it (selectHighlightedClaudeTask); an id
// whose comment hasn't loaded yet is simply skipped, not shown as a blank
// row. Also the ONE trigger point for ensureOtherTaskTitle — this function
// already runs on every render that needs the list anyway, and the fetch is
// self-deduping, so no separate watch/poller is needed just to kick it off.
//
// The excluded id is resolved via ccAnchorComment() — the conversation
// actually loaded/shown in the panel (cc.commentId) — rather than a bare
// chatAnchorComment(), see ccAnchorComment's own doc comment for why the two
// can diverge while cs.focus === 'claude' (a comment-poll reorder shifting
// cs.sel, a raw index, out from under an unchanged cc). Excluding by the
// stale, index-derived id then failed to exclude the REAL open conversation,
// so it showed up as its own "elders lopend" row — with a title/status that
// were correct for that id, which is exactly why they matched the
// "Selected: …" line above: it was the same conversation. Reported bug, not
// a hypothetical — see .claude/docs/claude-chat-panel.md.

// MAX_CHAT_ROWS caps how many rows actually render; the rest is reported as
// one plain "+n meer" line (claudeMoreChatsNote). A PR-wide list has no
// natural bound any more now that it is not limited to running turns, and
// both the footer height and the ↓/↑ rung walking these rows have to stay
// usable.
const MAX_CHAT_ROWS = 12

// chatStateOf — one row's own state, in priority order. 'busy' wins (it is
// the newest fact), then the 2-minute "just finished" window, then "has an
// answer you have not looked at for the full 5s dwell yet" (isChatUnread,
// chatUnread.mjs), otherwise 'seen'. Every state renders as a WORD plus its
// own glyph in claudeTaskRow — never a bare colour, per the colourblind rule.
function chatStateOf(c) {
  if (!c) return 'seen'
  const id = String(c.id)
  const p = turnProgress(c.id)
  if (isTurnBusy(c.id) || (p && p.running)) return 'busy'
  if (isTurnRecentlyFinished(c.id)) return 'done'
  if (isChatUnread(c)) return 'unread'
  return 'seen'
}

const CHAT_STATE_RANK = { busy: 0, done: 1, unread: 2, seen: 3 }

// isChatSeenAndAnswered — "bekeken en zonder vervolg": the chat has settled
// (chatStateOf === 'seen', the 5s dwell passed with nothing busy/unread/
// just-finished left) AND it actually got an answer at some point
// (otherTaskAnswered — a chat nobody replied to yet stays 'seen' too but
// must NOT count as "done with", see otherClaudeChatsAll's own filter
// below). Both facts are `undefined` until ensureOtherTaskTitle's fetch
// resolves, so this reads `false` (not yet known to qualify) rather than
// `true` before that — same fail-open reasoning as the inline filter this
// was extracted from. Exported so home.mjs's chatItems (recomputeLeftList,
// the "Openstaande chats" sidebar row) can apply the SAME "bekeken en zonder
// vervolg" rule to a chatOnly ORPHAN row instead of inventing a second
// mechanism — see "opgeruimd zodra bekeken" in claude-chat-panel.md.
export function isChatSeenAndAnswered(c) {
  return chatStateOf(c) === 'seen' && !!otherTaskAnswered.byId[c.id]
}

// otherClaudeChatsAll is the uncapped list; otherClaudeChats (below) is what
// renders. Kept apart so the "+n meer" line can name the difference without
// a second, differently-filtered walk.
function otherClaudeChatsAll() {
  const anchor = ccAnchorComment()
  const excludeId = anchor ? String(anchor.id) : null
  // cc.tick is read purely to force this to re-evaluate every second while a
  // turn runs or something is still inside its "Klaar" window, so a row's own
  // word changes on screen instead of only on the next unrelated re-render —
  // same "read purely to force a re-run" trick the elapsed-seconds counter
  // itself already relies on.
  void cc.tick
  const seen = new Set()
  const out = []
  const add = (c) => {
    if (!c) return
    const id = String(c.id)
    if (id === excludeId || seen.has(id)) return
    seen.add(id)
    out.push(c)
  }
  // Running turns first, so a turn whose comment IS in cs.list can never be
  // missed even if cc.conversations hasn't caught up with it yet (that set is
  // refreshed on the comment poll's cadence, a turn can start between two
  // polls).
  runningTurnIds(excludeId).forEach((id) => add(cs.list.find((c) => String(c.id) === id)))
  // Same reason for a chat that JUST finished: cc.conversations below is only
  // refreshed on the comment poll's cadence, so without this a finished chat
  // would enter the list up to a poll late — long enough for the ↓/↑ cursor
  // to have looked for it already (see recentlyFinishedTurnIds).
  recentlyFinishedTurnIds(excludeId).forEach((id) => add(cs.list.find((c) => String(c.id) === id)))
  cs.list.forEach((c) => {
    if (cc.conversations.indexOf(c.id) >= 0 || isGeneralChatAnchor(c)) add(c)
  })
  // Titles (and, from the same payload, the unread state chatStateOf sorts
  // on) are ensured for the WHOLE list, not only the rows that survive
  // MAX_CHAT_ROWS: the cap is applied AFTER the sort, so a chat with an
  // unseen answer must be able to rise into view. Self-deduping and cached
  // per id, so this is one GET per chat once, not per render.
  out.forEach(ensureOtherTaskTitle)
  // Drop an automatically started chat (kilo's own auto-check turn) — always,
  // regardless of its state — and a chat that already has an answer AND was
  // already viewed ("bekeken en zonder vervolg", see isChatSeenAndAnswered's
  // own doc comment for why a chat with no answer yet must NOT be hidden by
  // this).
  const filtered = out.filter((c) => {
    if (otherTaskAutoStarted.byId[c.id]) return false
    if (isChatSeenAndAnswered(c)) return false
    return true
  })
  // Stable sort (guaranteed in every browser this app targets), so rows only
  // move when their own state really changes.
  filtered.sort((a, b) => CHAT_STATE_RANK[chatStateOf(a)] - CHAT_STATE_RANK[chatStateOf(b)])
  return filtered
}

function otherClaudeChats() {
  return otherClaudeChatsAll().slice(0, MAX_CHAT_ROWS)
}

// claudeMoreChatsNote — the plain "+n meer" text for whatever MAX_CHAT_ROWS
// cut off, '' when nothing was. Deliberately not a row: it is not navigable
// and must not shift the ↓/↑ cursor's own indexing.
function claudeMoreChatsNote() {
  const hidden = otherClaudeChatsAll().length - MAX_CHAT_ROWS
  return hidden > 0 ? '+' + hidden + ' ' + t('meer') : ''
}

// claudeTaskJump — the "go there" action for a highlighted row of
// otherClaudeChats (Enter, or a click), registered once by home.mjs
// (setClaudeTaskJump) since it needs to move state.selected/state.mode —
// state this module never touches directly. See setClaudeTaskJump's own
// doc comment for why this indirection exists instead of a direct import.
let claudeTaskJump = null
export function setClaudeTaskJump(fn) {
  claudeTaskJump = fn
}

// selectHighlightedClaudeTask — Enter while the "andere chats in deze PR"
// rung is highlighted (cs.claudeTasksPos > 0, see handleRelatedKey's 'claude'
// branch above, or the 'tasks' branch/enterFooterTasks for the no-anchor
// case). Mirrors selectHighlightedClaudeOption's own shape: returns false (a
// no-op) at rest so home.mjs's onKeydown can fall through to the ordinary
// Claude-column menu Enter right after it.
export function selectHighlightedClaudeTask() {
  if ((cs.focus !== 'claude' && cs.focus !== 'tasks') || cs.claudeTasksPos === 0) return false
  const c = otherClaudeChats()[cs.claudeTasksPos - 1]
  activateClaudeTask(c)
  return true
}

// activateClaudeTask — the mouse action for one row of otherClaudeChats,
// shared with the Enter path above (selectHighlightedClaudeTask): per
// mouse-navigation.md's rule ("a click runs the same function a key runs"),
// clicking a row does exactly what walking onto it with ↓ and pressing Enter
// would.
export function activateClaudeTask(c) {
  cs.claudeTasksPos = 0
  if (c && claudeTaskJump) claudeTaskJump(c)
}

// hasCommentClaudeFooter — true exactly when CommentClaudeFooter itself would
// render something (comment side busy/replySent, a Claude turn running/
// reporting progress on the conversation shown here, or another conversation
// running ELSEWHERE in the PR — reviewer request: that last one must show
// "zodra er iets elders loopt, ook als de huidige conversatie zelf niets aan
// het doen is"). Exported so home.mjs can fold away the whole
// comment-claude-row card (border/bg wrapper around InlineComments +
// ClaudeChatPanel + this footer) when NEITHER a visible conversation/composer
// (claudeChatVisible()) NOR this footer has anything to show — otherwise that
// bordered card still rendered with zero-height content on every line with no
// comments/Claude chat and nothing in flight, showing as a bare thin gray bar
// above Onderliggende code (see .claude/docs/comments-panel.md).
export function hasCommentClaudeFooter() {
  return !!commentFooterText() || hasActiveClaudeTurn() || otherClaudeChats().length > 0
}

// claudeQueueNote — the Claude half's queue suffix ("· nog 2 berichten in de
// wachtrij"): what the reviewer typed ahead while a turn was running, in words
// (never a colour or a bare count badge, per the colourblind rule). '' when
// nothing is waiting.
function claudeQueueNote() {
  const n = claudeChatView().queued().length
  if (n === 0) return ''
  return n === 1 ? t(' · nog 1 bericht in de wachtrij') : t(' · nog {n} berichten in de wachtrij', { n })
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
// is working on it, the same live-status formatter (claudeStatusText) that a
// chat turn uses renders the same kind of "Claude leest src/x.php" sentence
// here, and afterwards it keeps the one-line outcome ("verwerkt: …" /
// "overgeslagen: …") — its OWN span (`comment-batch-status`), not the live
// chat turn's `claude-chat-status`. Only commentDetailCard passes it (an
// index/PR-wide comment row, the card the reviewer lands on when a batch
// starts).
//
// `opts.batchOnly` (also only ever passed by commentDetailCard, next to
// `commentId`) narrows this SAME call down to just that one batch line —
// dropping the "Selected: …" title, the live-turn `claudeActive()` block and
// "Andere chats in deze PR". Those three describe the globally anchored conversation
// (`cc`/`hasActiveClaudeTurn()`), not anything scoped to `commentId`, so
// without this flag they render byte-for-byte identically a second time
// inside commentDetailCard's own small card — the wide comment-claude-row
// footer (home.mjs, no commentId, batchOnly left off) already shows them
// once. Reported bug: "status van draaiende chat vraag moet onderin de blok
// staan, niet onderin de comment blokje" — the running "Claude denkt na…" +
// Stop button showed twice, once in each of the two footers.
// commentClaudeShortcutHints — the contextual key-hint line (ShortcutHintBar,
// shortcutHints.mjs) for whichever half of comment-claude-row currently owns
// the keyboard. Mirrors home.mjs's own blockShortcutHints for the diff side —
// deliberately the handful of keys a reviewer actually reaches for here, not
// every documented micro-state (see "The chain, key by key" in
// .claude/docs/claude-chat-panel.md for the full picture). Empty while the
// keyboard is still on the diff (cs.focus === null) — that side shows its own
// hints instead.
export function commentClaudeShortcutHints() {
  // 'Shift+Enter' -> 'nieuwe regel' is added on every state whose own field
  // actually has DOM focus at rest (reaction-compose for 'comment'/'thread',
  // the new-comment composer for 'new', the Claude composer for 'claude') —
  // reviewer request, alongside the same key already working in the Claude
  // composer (ClaudeChat.mjs) and, since this task, the comment composer's
  // own local @keydown too (see newCommentComposer/reaction-compose).
  switch (cs.focus) {
    case 'comment':
      return [
        { key: '→', label: t('Claude') },
        { key: 'Enter', label: t('menu') },
        { key: 'Shift+Enter', label: t('nieuwe regel') },
      ]
    case 'thread':
      return [
        { key: '→', label: t('Claude') },
        { key: '←', label: t('terug') },
        { key: 'Enter', label: t('menu') },
        { key: 'Shift+Enter', label: t('nieuwe regel') },
      ]
    case 'claude':
      return [
        { key: '←', label: t('terug') },
        { key: 'Enter', label: t('versturen') },
        { key: 'Shift+Enter', label: t('nieuwe regel') },
      ]
    case 'new':
      return [
        { key: 'Enter', label: t('plaatsen') },
        { key: 'Shift+Enter', label: t('nieuwe regel') },
        { key: '→', label: t('naar Claude') },
      ]
    default:
      return []
  }
}

// claudeTaskRow renders one row of otherClaudeChats: a title (the reviewer's
// own last message, see otherTaskTitleFor/chatTaskTitle) plus its own state
// as a WORD — 'bezig' (the live claudeStatusText line), 'Klaar', 'nieuw'
// (there is an answer the reviewer hasn't dwelt on for the full 5s yet) or
// 'bekeken' — with a glyph next to it, never a bare colour, per the
// colourblind rule (the pulsing dot on a running row is decoration on top
// only). Highlighted state mirrors claudeQuestionOptions' own convention
// exactly: a ring PLUS a leading "› " glyph, never colour alone.
//
// LAYOUT, reported bug: the state text used to be `shrink-0` while the title
// could shrink, so a long status ("Claude leest <full worktree path>") pushed
// the title to zero width and the row read as a bare path with no idea which
// chat it was. The title now takes the flexible half (`min-w-0 flex-1`) and
// the state text is the one that truncates, capped at 45% of the row.
function claudeTaskRow(c, i) {
  const active = () => cs.claudeTasksPos === i + 1
  // state — see chatStateOf: 'busy' | 'done' | 'unread' | 'seen'. 'done' is
  // the 2-minute window after a turn stopped (isTurnRecentlyFinished); it no
  // longer decides whether the row EXISTS, only what it says.
  const state = () => chatStateOf(c)
  const done = () => state() === 'done'
  const glyph = () => (done() ? '✓' : state() === 'unread' ? '!' : state() === 'seen' ? '○' : '')
  const stateText = () => {
    switch (state()) {
      case 'done':
        return t('Klaar')
      case 'unread':
        return t('nieuw')
      case 'seen':
        return t('bekeken')
      default:
        return claudeStatusText(turnProgress(c.id), 0)
    }
  }
  return html`
    <button
      type="button"
      class="${() =>
        'flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left ' +
        (active()
          ? 'border-indigo-300 ring-2 ring-indigo-200 bg-indigo-50 dark:border-indigo-400 dark:ring-indigo-500/40 dark:bg-indigo-500/10'
          : 'border-slate-200 hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50')}"
      data-testid="claude-task-row"
      data-active="${() => (active() ? 'true' : 'false')}"
      data-done="${() => (done() ? 'true' : 'false')}"
      data-state="${() => state()}"
      @click="${() => activateClaudeTask(c)}"
    >
      <span
        class="${() =>
          state() === 'busy'
            ? 'inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400'
            : 'inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full text-[8px] font-bold leading-none ' +
              (done()
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                : state() === 'unread'
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-500')}"
        >${() => glyph()}</span
      >
      <span class="min-w-0 flex-1 truncate font-medium text-slate-600 dark:text-zinc-300">
        ${() => (active() ? '› ' : '') + (otherTaskTitleFor(c) || t('(leeg comment)'))}
      </span>
      <span class="min-w-0 max-w-[45%] truncate text-right text-slate-400 dark:text-zinc-500">
        ${() => stateText()}
      </span>
    </button>
  `.key('claude-task:' + c.id)
}

export function CommentClaudeFooter(commentId = '', opts = {}) {
  const batchOnly = !!opts.batchOnly
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
  // "Selected: …" — the reviewer's own last Claude message in the
  // conversation currently anchored here (first sentence, see
  // ownMessageTitle), so a reviewer glancing at the "andere chats in deze PR" list
  // below never confuses it with the one they're currently looking at.
  // Resolved via ccAnchorComment() (cc.commentId, the conversation actually
  // loaded here), not a bare chatAnchorComment() — see that function's own
  // doc comment for why the two can diverge mid-chat. '' whenever there is
  // nothing of the reviewer's own to show yet — no anchor at all, or a bare,
  // still-placeholder anchor with no Claude message sent either (the
  // unusable placeholder sentence this line used to show) — and the whole
  // line then simply doesn't render, rather than falling back to
  // that placeholder text.
  //
  // The reused `staleAnchorBadge` sits right next to this line (not just in
  // the comment thread/index list, see staleAnchorBadge's own doc comment):
  // jumping here from an ORPHAN row of "Andere chats in deze PR"
  // (jumpToClaudeConversation, home.mjs) opens that conversation's own real
  // transcript even though its code is gone (reviewer request: "als je het
  // opent dan wil de chat zien, maar met ergens de duidelijkheid dat
  // gerelateerde code niet meer aanwezig is") — this is the one place that's
  // visible regardless of whether the comment-thread column itself is in
  // view, since it sits in the full-width bar under both columns.
  //
  // staleBadge() must ALSO gate whether this whole footer/"Selected: …" line
  // renders at all — not only decorate it once some OTHER condition already
  // showed it. The most common case for wanting this exact badge is the
  // reviewer looking at ONLY this one (orphaned) conversation, nothing else
  // running/finished elsewhere and no own message sent yet — every other
  // existing condition below (commentFooterText/claudeActive/batchText/
  // otherClaudeChats().length) is then false and the footer used to render
  // NOTHING, silently dropping the one thing this fix exists to show.
  const staleBadge = () => staleAnchorBadge(ccAnchorComment())
  const selectedTitle = () => ownMessageTitle(cc.messages, ccAnchorComment())
  return html`
    <div class="contents">
      ${() =>
        (batchOnly
          ? !!batchText()
          : commentFooterText() ||
            claudeActive() ||
            batchText() ||
            otherClaudeChats().length > 0 ||
            !!staleBadge())
          ? html`
              <div
                class="flex w-0 min-w-full flex-col gap-1 border-t border-slate-100 dark:border-zinc-800/60 px-3 py-1.5 text-[11px] text-slate-500 dark:text-zinc-500"
                data-testid="comment-claude-footer"
              >
                ${() =>
                  !batchOnly && (selectedTitle() || staleBadge())
                    ? html`<span class="flex min-w-0 items-center gap-1.5" data-testid="claude-selected-line">
                        ${() =>
                          selectedTitle()
                            ? html`<span class="min-w-0 truncate">
                                <span class="font-medium text-slate-600 dark:text-zinc-400">Selected:</span>
                                ${() => selectedTitle()}
                              </span>`
                            : ''}
                        ${() => staleBadge()}
                      </span>`
                    : ''}
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                ${() =>
                  !batchOnly && commentFooterText()
                    ? html`<span class="flex items-center gap-1.5" data-testid="comment-claude-footer-comment">
                        <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400"></span>
                        <span class="truncate">${() => commentFooterText()}</span>
                      </span>`
                    : ''}
                ${() =>
                  !batchOnly && claudeActive()
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
                        <button
                          type="button"
                          class="shrink-0 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          data-testid="claude-chat-cancel"
                          title="${t('Stop deze Claude-beurt')}"
                          @click="${() => cancelClaudeTurn()}"
                        >
                          ${t('Stop')}
                        </button>
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
                <div class="contents">
                  ${() =>
                    !batchOnly && otherClaudeChats().length > 0
                      ? html`
                          <div
                            class="flex flex-col gap-1 border-t border-slate-100 pt-1 dark:border-zinc-800/60"
                            data-testid="claude-other-tasks"
                          >
                            <span class="text-[10px] font-medium text-slate-400 dark:text-zinc-500">
                              ${() => t('Andere chats in deze PR ({n}):', { n: otherClaudeChatsAll().length })}
                            </span>
                            ${() => otherClaudeChats().map((c, i) => claudeTaskRow(c, i))}
                            <span
                              class="${() =>
                                'text-[10px] text-slate-400 dark:text-zinc-500' +
                                (claudeMoreChatsNote() ? '' : ' hidden')}"
                              data-testid="claude-more-chats"
                              >${() => claudeMoreChatsNote()}</span
                            >
                          </div>
                        `
                      : ''}
                </div>
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
  // enterFromReadOnly is the SAME → hand-off the keyboard already uses from
  // 'comment'/'thread'/'new' (enterClaudeChat/enterClaudeChatFromNew) —
  // "a click runs the same function a key runs" — now reached by clicking
  // ANYWHERE on the read-only card itself (claudeChatColumn's own root, see
  // ClaudeChat.mjs), the one exception to "nothing in it is clickable" per
  // "Read-only, not a rail" in .claude/docs/comments-panel.md.
  const enterFromReadOnly = () => enterClaudeChatOrFromNew(state.pr)
  return html`
    <div class="contents">
      ${() =>
        !claudeColumnVisible()
          ? ''
          : html`<div
              class="${() => 'relative flex min-h-0 flex-col shrink-0 ' + claudeColumnWidthCls(state)}"
              style="${() => colWidthStyle(state, widthKey())}"
              data-testid="claude-chat-column"
              data-col-resize-root
            >
              ${() =>
                widthKey()
                  ? resizeHandle(
                      (e) =>
                        startColumnResize(e, state, widthKey(), () => parseAutoWidthPx(claudeColumnWidthCls(state))),
                      () => resetColumnWidth(state, widthKey()),
                    )
                  : ''}
              ${() =>
                claudeChatColumn(view, callbacks, claudeColumnReadOnly(state), enterFromReadOnly).key(
                  'claude-chat-column:' + (claudeColumnReadOnly(state) ? 'ro' : 'rw'),
                )}
            </div>`}
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
const cp = reactive({ items: [], expandedOverride: {} })

// codePreviewCount — how many code-preview cards the reviewer can currently
// walk with ↓/↑ from the bottom of the Claude chat (cs.previewPos, see its own
// doc comment and handleRelatedKey's 'claude' branch).
function codePreviewCount() {
  return cp.items.length
}

// getCommentTarget is set once by CodePreviewPanel (see below) to the same
// live-cursor getter InlineComments/ClaudeChatPanel already receive from
// home.mjs — recomputeCodePreviews needs it every time it reruns (a
// MutationObserver callback, not a template binding), so it can't just be a
// function parameter threaded through like `commentTarget` is everywhere
// else in this file.
let getCommentTarget = () => null

// classNamesIn(code) — the class names a code-preview card's snippet
// declares, top-level only ("\bclass Name" — traits/interfaces/functions are
// deliberately not counted, since the reviewer asked specifically about
// classes). Used only to make the card TITLE more informative
// (`titleDetail`, below); the per-segment in-pane labels this feeds live in
// CodePreview.mjs (`splitCodeByClasses`), which needs the actual source
// positions, not just the names — see its own doc comment there.
function classNamesIn(code) {
  const re = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g
  const names = []
  let m
  while ((m = re.exec(code || ''))) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

// classDetail(code) — the card's own title text, ONLY when the snippet
// declares a detected class: one class → its name; two or more → every name,
// in source order, joined with ", " (the reviewer explicitly wants the names
// themselves, not a bare count) — CodePreview.mjs's `truncate` class still
// clips the line if that gets long. No class detected → '' (no title line at
// all). This USED to fall back to a bare "Codeblok N · PHP"/"· <LANG>"
// header — dropped on later reviewer request ("Codeblok 1 · PHP mag weg"):
// that fallback said nothing a reviewer didn't already read off the SAME
// fence's own inline badge in the chat bubble above (markdown.mjs's
// `fenceLabel`/`data-fence-label`), so the redundant copy here is gone; only
// genuinely new information (a detected class name) still earns a title
// line on this card.
function classDetail(code) {
  const names = classNamesIn(code)
  return names.length ? names.join(', ') : ''
}

// cp.expandedOverride — a plain (non-`cp.items`) map, `fence key -> bool`,
// surviving `recomputeCodePreviews`' wholesale item-array reassignment so a
// manual toggle isn't lost the next time an unrelated fence changes. Default
// state (no entry yet) is `it.isLast`: only the cards belonging to the most
// recent chat message/comment start expanded, everything older starts
// collapsed — reviewer request, "zo kan ik blokken langslopen … maar oudere
// mogen ingeklapt zijn". `isPreviewExpanded`/`toggleCodePreviewExpanded` are
// the only things touching it; CodePreview.mjs never reads `cp` directly
// (mirrors the rest of this split, see the header comment in
// CodePreview.mjs).
function isPreviewExpanded(it) {
  return it.key in cp.expandedOverride ? cp.expandedOverride[it.key] : it.isLast
}
export function toggleCodePreviewExpanded(key) {
  const it = cp.items.find((x) => x.key === key)
  if (!it) return
  // Reassign the whole map (never mutate it in place) — same "plain object,
  // replaced wholesale" discipline as `cp.items` itself, so the reactive
  // property-set notification (`Gt`, see arrowjs-pitfalls.md) reliably fires
  // regardless of whether a nested plain object gets deep-proxied.
  cp.expandedOverride = { ...cp.expandedOverride, [key]: !isPreviewExpanded(it) }
  // The now-expanded pane mounts a fresh `[data-scroll-body]` host with
  // nothing yet to measure it (mirrors the same call right after
  // `cp.items` itself is reassigned, a few lines below).
  refreshScrollHints()
}
// activeCodePreviewKey() — the fence key under the ↓/↑ cursor (cs.previewPos),
// or null off it. home.mjs's Enter branch (isClaudeChatFocused() &&
// cs.previewPos > 0) uses this to toggle that ONE card without importing `cp`
// itself — home.mjs never reads this module's own state directly, same split
// as everywhere else in this file.
export function activeCodePreviewKey() {
  const it = cp.items[cs.previewPos - 1]
  return it ? it.key : null
}

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
// `classLabel` is deliberately NOT the fence's "Codeblok N"/"Suggestie N"
// label any more — that number/word already shows on the SAME fence's own
// inline badge in the chat bubble above (markdown.mjs's `fenceLabel`/
// `data-fence-label`), so repeating it here as a SECOND title row was pure
// clutter (reviewer report, see classDetail's own comment). Only a detected
// class name still earns a title line on this card.
//
// `label` (added later, reviewer report: the bottom preview card's own
// pane header just said the bare word "Codeblok", no number/language, unlike
// the exact same fence's header above it in the chat) is that SAME
// `data-fence-label` text, read straight off the wrapper. This is NOT the
// clutter the paragraph above is about: it replaces text the pane header
// already showed unconditionally (`pane()`'s own title bar in
// CodePreview.mjs), it doesn't add a new row.
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
  //
  // A fence inside the live streaming answer (`claudePartialBubble`,
  // ClaudeChat.mjs, `data-testid="claude-partial"`) is ALSO excluded —
  // reviewer report: the code-preview column below the chat showed a card
  // whose trailing text abruptly stopped mid-sentence ("Eén ding om te
  // checken vo…"), even though the chat bubble right above it already showed
  // the full, final answer. Root cause: that partial bubble is deliberately
  // kept mounted for a moment AFTER the real, complete message has already
  // landed (see the "Keep the partial visible…" comment on the chat.progress
  // handler below) — a genuine, on-purpose overlap window, not a race — so
  // its own (necessarily mid-stream, therefore truncated) fence was still
  // discoverable here and could render as its own stale card, or even take
  // the place the real fence's card should have had. The partial is
  // explicitly "a THROWAWAY render of throwaway data… never part of the
  // message list" (see its own doc comment), so it must never contribute a
  // preview card of its own — the real message's fence always supersedes it.
  const fences = root
    ? Array.from(root.querySelectorAll('[data-testid="code-fence"]')).filter((el) => {
        if (el.closest('[data-testid="claude-partial"]')) return false
        const card = el.closest('[data-testid="comment-item"]')
        return !card || card.dataset.expanded === 'true'
      })
    : []
  const t = getCommentTarget()
  const currentCode = t && t.file && t.code ? t.code : null
  // "belongs to the last answer" (reviewer request, see "Default-collapsed
  // cards" below): compared by the fence's own nearest message/comment
  // container element, not by index — a fence keeps its container across an
  // unrelated re-render, an index wouldn't. `null` (no such ancestor at all)
  // still compares equal to `null`, so a fence found with no ancestor at all
  // is never wrongly hidden just because that ancestor lookup came up empty.
  const containers = fences.map((el) => el.closest('[data-testid="claude-message"], [data-testid="comment-item"]'))
  const lastContainer = containers.length ? containers[containers.length - 1] : undefined
  // containerKey(c) — a STABLE id for the fence's owning message/comment
  // (its own `data-message-id`/`data-comment-id`, prefixed so the two id
  // spaces can never collide with each other), used to build each fence's
  // `key` below instead of its raw position in `fences`. Bug report: "eerder
  // had ik iets anders ingeklapt, dat moet niet effect hebben op andere
  // blokken" — collapsing one card leaked onto an unrelated one. Root cause
  // was that `key` used to be the bare loop index (`'fence:' + i`), and
  // `cp.expandedOverride` (below) is keyed by that string — but `next` is
  // re-SORTED right after this map ("most-recently-generated … renders at
  // the TOP"), so a fresh message arriving reshuffles which fence sits at
  // which index. A later recompute's index `0` can end up pointing at a
  // completely different fence than the one the reviewer actually toggled,
  // silently inheriting its manual override. A composite key of (which
  // message/comment, which fence within it) is stable across that reorder,
  // because a message/comment's OWN body never reorders itself once
  // rendered. `null` (no matching ancestor at all — not expected in
  // practice, since every fence sits inside a comment or a Claude bubble,
  // but kept as a safety net) falls back to the old index-based key, same
  // as before this fix.
  const containerKey = (c) => {
    if (!c) return null
    if (c.dataset.commentId != null) return 'c' + c.dataset.commentId
    if (c.dataset.messageId != null) return 'm' + c.dataset.messageId
    return null
  }
  const next = fences.map((el, i) => {
    const code = el.dataset.fenceCode || ''
    const lang = el.dataset.fenceLang || ''
    const context = el.dataset.fenceContext || ''
    const trailing = el.dataset.fenceTrailing || ''
    const label = el.dataset.fenceLabel || ''
    const isPhp = !lang || lang.toLowerCase() === 'php'
    const suggestion = el.dataset.fenceSuggestion === 'true'
    const ck = containerKey(containers[i])
    // The fence's own position AMONG its container's own fences — stable
    // regardless of where that container itself ends up after the
    // newest-group-first sort below, unlike the raw loop index `i`.
    const localIdx = containers[i]
      ? Array.from(containers[i].querySelectorAll('[data-testid="code-fence"]')).indexOf(el)
      : i
    return {
      key: ck != null ? 'fence:' + ck + ':' + localIdx : 'fence:' + i,
      // '' when the snippet declares no detected class — CodePreview.mjs
      // then renders no title line at all, see classDetail's own comment.
      classLabel: classDetail(code),
      context,
      // trailing — the text after the LAST fence of this message (only ever
      // set on that fence's own item, see markdown.mjs's `data-fence-
      // trailing`), rendered below the code in CodePreview.mjs.
      trailing,
      label,
      lang,
      code,
      oldCode: suggestion && isPhp ? currentCode : null,
      isLast: containers[i] === lastContainer,
    }
  })
  // Most-recently-generated message/comment renders at the TOP (reviewer
  // request: "recente gegenereerde code blokken moeten boven niet recente
  // staan") — grouped by the SAME container lookup `isLast` already uses,
  // reordering only whole GROUPS, never the fences within one: a single
  // message with 2+ fences must keep them in their own authored order (see
  // the existing "only a suggestion fence…" test, one comment body with a
  // plain fence followed by a suggestion fence, asserted in that exact
  // order). `containerOrder` is every distinct container in first-appearance
  // (i.e. chronological) order; `.sort` is a stable sort (guaranteed since
  // ES2019), so two items with the same rank never swap.
  const containerOrder = []
  containers.forEach((c) => {
    if (!containerOrder.includes(c)) containerOrder.push(c)
  })
  next.forEach((it, i) => {
    it._groupRank = containerOrder.indexOf(containers[i])
  })
  next.sort((a, b) => b._groupRank - a._groupRank)
  // groupWithPrev — does this item share its container (i.e. its own chat
  // message/comment, or the shared `null`/no-ancestor bucket) with the item
  // right before it in the RENDERED (sorted) order? CodePreview.mjs uses
  // this to draw a dashed divider (and no gap) between two cards from the
  // same message, while keeping the normal gap between different messages —
  // reviewer request: "de blokken die uit dezelfde message komen, moeten …
  // gescheiden worden met een horizontale stippellijn, voor de rest mogen
  // die aan elkaar plakken". `_groupRank` (not the raw container reference)
  // is compared here, since it is still present on every item at this point
  // and already encodes exactly that same grouping.
  next.forEach((it, i) => {
    it.groupWithPrev = i > 0 && next[i - 1]._groupRank === it._groupRank
  })
  next.forEach((it) => {
    delete it._groupRank
  })
  const unchanged =
    next.length === cp.items.length &&
    next.every(
      (it, i) =>
        it.code === cp.items[i].code &&
        it.lang === cp.items[i].lang &&
        it.classLabel === cp.items[i].classLabel &&
        it.label === cp.items[i].label &&
        it.context === cp.items[i].context &&
        it.trailing === cp.items[i].trailing &&
        it.oldCode === cp.items[i].oldCode &&
        it.isLast === cp.items[i].isLast &&
        it.groupWithPrev === cp.items[i].groupWithPrev,
    )
  if (!unchanged) {
    cp.items = next
    // A fresh set of preview cards renders on its own next microtask, with
    // nothing else to re-measure its (new) scroll-hint hosts — see
    // refreshHints' own comment in home.mjs.
    refreshScrollHints()
  }
  // Keep the ↓/↑ cursor inside the (possibly shrunk, possibly emptied) set —
  // a fence disappearing while the keyboard sits on its card must not leave
  // the cursor pointing at nothing. Clamped rather than reset, so an unrelated
  // fence vanishing above/below keeps the reviewer in the cards.
  if (cs.previewPos > next.length) cs.previewPos = next.length
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

// CodePreviewPanel(state, commentTarget) — mounted by home.mjs directly BELOW
// comment-claude-row, inside the same comments-and-related stack (see "A
// full-size code-preview column" in claude-chat-panel.md for exactly where in
// the layout). Wrapped in a stable
// `contents` root, not a bare toggling expression, mirroring
// ClaudeChatPanel's own guard against the arrow.js "bare toggling
// expression" pitfall; the inner list itself is always an array (empty or
// not), never alternating with a scalar, so the single↔array pitfall in
// arrowjs-pitfalls.md doesn't apply either.
//
// `state` (added alongside `commentTarget`) is only threaded through to
// `commentClaudeRowWidthCls(state)` — the column's own width bound, see that
// function's doc comment — so this card can never spill wider than
// comment-claude-row above it.
// `opts.inOverlay` marks the copy the general-chat overlay mounts
// (generalChatOverlay.mjs). The tree's own copy renders nothing while that
// overlay is up — it would be the same fences twice, once behind a partly
// transparent overlay. Toggled INSIDE the existing `contents` root rather
// than at the mount site, for the reason spelled out on
// setGeneralChatOverlayVisible above.
export function CodePreviewPanel(state, commentTarget, opts = {}) {
  getCommentTarget = commentTarget
  ensureCodePreviewObserver()
  const hidden = () => cs.generalOverlay && !opts.inOverlay
  // The second argument is the keyboard cursor (cs.previewPos, only ever
  // non-zero while the chat itself owns the keyboard) — a getter per card, so
  // walking with ↓/↑ only re-applies that card's own class/data-active slots,
  // see previewCard in CodePreview.mjs. The third is the collapse/expand
  // state (isPreviewExpanded, above) — a getter too, per card, for the same
  // reason: toggling ONE card must not re-key/re-Prism-highlight the rest.
  // The fifth (getWidthCls) is a getter too, for the same reason as the
  // others: a focus/narrow-breakpoint change must re-apply just this class
  // slot, not rebuild the whole card list.
  return html`<div class="contents">
    ${() =>
      cp.items.length && !hidden()
        ? codePreviewColumn(
            () => cp.items,
            (i) => cs.focus === 'claude' && cs.previewPos === i + 1,
            // `it`, not a re-derived `cp.items[i]` — see the
            // "MEASURED CRASH" note above CodePreview.mjs's previewCard: a
            // reused keyed card's closure freezes its captured index forever,
            // and once the list shrinks/reorders that index can point past
            // the end, which crashed on every re-render (832 caught arrow.js
            // throws in one real session, .claude/rules/arrowjs-pitfalls.md).
            (it) => isPreviewExpanded(it),
            toggleCodePreviewExpanded,
            () => commentClaudeRowWidthCls(state),
          )
        : ''}
  </div>`
}

// reapplyNewComposerDraftOnceTargetReady — a refresh that restores straight
// onto the still-open "Comment op deze regel" composer (applyRelRestore's own
// 'new' branch below) runs `toNew()` before `getCommentTarget()` (the live
// cursor CodePreviewPanel registers — see its own doc comment) necessarily
// resolves to a real unit yet: `commentTarget()` (home.mjs) depends on the
// selected block's diff/change-group data, which can still be loading at this
// exact synchronous moment, unlike rc.children/cs.list (what applyRelRestore's
// OTHER branches already gate on). `toNew()` therefore first opens with
// `composeDraftKey` falling back to `draftKeyFor(null)` ('__none__') — right
// away, so the composer itself isn't delayed — and this poll (same
// few-frames-then-give-up shape as prefillField's own DOM-not-mounted retry)
// re-resolves the REAL key and re-applies the correct draft the moment
// `getCommentTarget()` stops returning null, without repeating `toNew()`'s
// broader cc/claude reset a second time.
function reapplyNewComposerDraftOnceTargetReady(retryLeft = FOCUS_FRAMES) {
  const t = getCommentTarget()
  if (!t) {
    if (retryLeft > 0) requestAnimationFrame(() => reapplyNewComposerDraftOnceTargetReady(retryLeft - 1))
    return
  }
  composeDraftKey = draftKeyFor(t)
  const draft = getComposeDraft(composeDraftKey)
  if (draft) prefillField('[data-testid=comment-compose]', draft)
  // The embedded Claude composer's own (unanchored) draft key is derived
  // from the very same composeDraftKey when cc.commentId is still null — see
  // claudeChatDraftKey()'s own doc comment — so it needs the same resync.
  restoreClaudeComposerDraft()
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
  // 'tasks' (see enterFooterTasks) needs the same children as 'code' to land
  // on anything at all.
  if (want.focus === 'tasks' && children === 0) return
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
    // getCommentTarget() (the same live-cursor getter CodePreviewPanel
    // registered, see its own doc comment) — without it toNew() falls back
    // to draftKeyFor(null), which resolves to a shared '__none__' draft
    // instead of this unit's own one. Harmless before drafts survived a
    // refresh (both reads were the transient session-only Map), but a
    // restore reaching here IS always a fresh page load — the one case that
    // now needs the real per-unit key to find the persisted draft again.
    toNew()
    reapplyNewComposerDraftOnceTargetReady()
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
  } else if (want.focus === 'tasks') {
    // Which task/row was highlighted (cs.claudeTasksPos) is deliberately not
    // restored, same as the 'claude'-anchored version of this rung
    // (claudeTasksPos's own doc comment: other people's live, constantly
    // changing turns aren't worth restoring) — land back on 'code' instead,
    // the far more common way into this rung.
    releaseFocus()
    cs.focus = 'code'
    scrollCodeIntoView()
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
//    turns exactly like 'thread' does (its own claudePos cursor). Before
//    stepping onto a DIFFERENT bubble, ↑/↓ first scroll the CURRENTLY active
//    one by 4 rendered lines in that direction if it is taller than the
//    thread's own viewport (scrollClaudeMessageWithinBubble) — otherwise a
//    single long answer was only ever readable a whole bubble at a time. When
//    the
//    NEWEST turn is a still-open, unanswered question with clickable options
//    (pendingClaudeQuestion()), that cursor grows one extra rung: composer
//    (claudePos 0, claudeOptionSel 0) → the question's own options, bottom to
//    top (claudeOptionSel 1..N, claudePos still 0) → the question bubble
//    itself (claudePos 1, claudeOptionSel back to 0, same as an ordinary
//    turn) → older turns (claudePos 2..). ↑/↓ walk this ONE continuous chain
//    in both directions (reviewer request — not two disjoint modes); Enter
//    while an option is highlighted sends it (selectHighlightedClaudeOption,
//    home.mjs), exactly like clicking it. BELOW the composer the same chain
//    continues DOWNWARD through the "andere chats in deze PR" rung, then
//    the chat's own code blocks: ↓ at the rest position (claudePos === 0 &&
//    claudeOptionSel === 0) first steps onto the "Andere chats in deze PR" rows
//    (cs.claudeTasksPos 1..n, otherClaudeChats — see below), matching
//    the on-screen order (that block renders ABOVE the code-preview cards),
//    then onto the first code-preview card (cs.previewPos 1..n, top to
//    bottom — the cards stacked under this row, see CodePreviewPanel/
//    CodePreview.mjs); ↑ walks them back up, cards first, into the composer.
//    Only ↓ past the LAST card (or ↓ at rest when there are neither other
//    tasks nor code blocks at all) still does NOT fall into the
//    Onderliggende-code panel (explicit request: that read as an unwanted
//    extra "menu" in the way of continuing to review) — it releases the panel
//    focus and returns the 'advance' sentinel so home.mjs's onKeydown can
//    select the next visible block and step straight into its diff (see
//    advanceToNextBlockFromClaudeChat, home.mjs) — UNCHANGED even when this
//    conversation has no anchor comment yet (reached via enterClaudeChatFromNew
//    below): the still-open composer's typed text stays put in composeDrafts
//    regardless (exitRelated never touches it), so advancing away loses
//    nothing. ← (and Escape) step back directly to the 'comment' level (not
//    to 'thread' — mirrors 'comment'.ArrowRight reaching 'claude' directly) —
//    OR, when this conversation has no anchor yet (cc.commentId == null, see
//    enterClaudeChatFromNew), back to the still-open composer ('new',
//    toNewFocus) instead, since there is no comment to land 'comment' on —
//    and, for an unanchored comment-index item (isPrCommentScope), back into
//    that item's OWN thread (the pct cursor, enterPrCommentThread), which is
//    the → this conversation was entered through there. →
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
    if (key === 'ArrowUp' && (cs.previewPos > 0 || cs.claudeTasksPos > 0)) {
      // Walking the code-preview cards back up first (if we're in them — see
      // cs.previewPos), then the "andere chats in deze PR" rung (see
      // otherClaudeChats/claudeTasksPos), toward the composer (0 = the
      // composer itself again). Mirrors the ArrowDown order below: whichever
      // rung ↓ visits LAST is the one ↑ leaves FIRST. cs.claudeTasksPos is
      // kept at 0 for the entire time cs.previewPos > 0 (see the ArrowDown
      // branch's own reset), so leaving the LAST card must explicitly
      // restore it to the tail of the tasks rung (otherClaudeChats()
      // .length) rather than reading a stale value — mirrors
      // codeFromClaudeTailPreviewPos's own "don't trust a value you didn't
      // just set" reasoning.
      if (cs.previewPos > 0) {
        cs.previewPos -= 1
        if (cs.previewPos > 0) {
          focusPreviewCard()
        } else {
          const tasks = otherClaudeChats()
          if (tasks.length > 0) {
            cs.claudeTasksPos = tasks.length
            focusClaudeTaskRow()
          } else {
            focusClaudeComposer()
          }
        }
      } else {
        cs.claudeTasksPos -= 1
        if (cs.claudeTasksPos === 0) focusClaudeComposer()
        else focusClaudeTaskRow()
      }
      return true
    }
    if (
      key === 'ArrowDown' &&
      (cs.previewPos > 0 || cs.claudeTasksPos > 0 || (cs.claudePos === 0 && cs.claudeOptionSel === 0))
    ) {
      // The "andere chats in deze PR" rung is the next rung below the
      // composer (reviewer request: it should be reachable before the code
      // blocks, matching its on-screen position ABOVE the code-preview
      // cards) — ↓ walks it top to bottom. Only once THAT is exhausted (or
      // there was nothing to walk there at all) does ↓ move onto this chat's
      // own code-preview cards (cs.previewPos), and only past the LAST one of
      // those does the "advance to the next block" exit below take over (see
      // the doc comment above). cs.claudeTasksPos is reset to 0 the moment
      // cs.previewPos starts moving — the two are mutually exclusive (each
      // card's/row's own `data-active` binding keys off its OWN cursor being
      // non-zero, see CodePreviewPanel/claudeTaskRow), so a stale non-zero
      // leftover would otherwise keep the last task row marked active at the
      // same time as a code-preview card.
      const tasks = otherClaudeChats()
      if (cs.claudeTasksPos < tasks.length) {
        cs.claudeTasksPos += 1
        focusClaudeTaskRow()
        return true
      }
      if (cs.previewPos < codePreviewCount()) {
        cs.claudeTasksPos = 0
        cs.previewPos += 1
        focusPreviewCard()
        return true
      }
      cs.previewPos = 0
      cs.claudeTasksPos = 0
      exitRelated()
      return 'advance'
    }
    if (key === 'ArrowUp') {
      // Read a tall active bubble 4 lines at a time before stepping onto an
      // OLDER one — see scrollClaudeMessageWithinBubble's own doc comment.
      // Never intervenes at the rest position (cs.claudePos === 0, no active
      // bubble at all) or while walking the question options.
      if (cs.claudePos >= 1 && scrollClaudeMessageWithinBubble('up')) return true
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
      // Symmetric to the ArrowUp case above — walk a tall active bubble's own
      // later text 4 lines at a time before stepping onto a NEWER one.
      if (cs.claudePos >= 1 && scrollClaudeMessageWithinBubble('down')) return true
      if (cs.claudePos === 0 && cs.claudeOptionSel > 0) {
        // Walking the options back down, toward the composer.
        cs.claudeOptionSel -= 1
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
      if (isPrCommentScope()) {
        // Reached via → out of a comment-index item's own thread
        // (handlePrCommentThreadKey's ArrowRight, the pct cursor) — the
        // 'comment' level below does not exist here: cs.view is empty for
        // such an item by design (recomputeView) and its comment column is
        // even `hidden`, so toComment() would land the keyboard on nothing
        // and ← would need a second press to get anywhere visible. Step
        // straight back into that same thread instead, the exact mirror of
        // the → that got here.
        exitRelated()
        enterPrCommentThread(cs.scope.prComment)
      } else if (cc.commentId == null) {
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
  if (cs.focus === 'tasks') {
    // The footer's "andere chats in deze PR" rung, reached from the
    // panel's own top boundary with NO anchor at all (see enterFooterTasks) —
    // ↑/↓ walk it exactly like the 'claude'-anchored version of this same
    // rung (cs.claudeTasksPos, top to bottom), and ↓ past the last row / ←
    // both step back to wherever the reviewer came from (exitFooterTasks),
    // never all the way out — Escape (handled above, unconditionally) is the
    // "leave the panel entirely" gesture here.
    if (key === 'ArrowUp') {
      if (cs.claudeTasksPos > 1) {
        cs.claudeTasksPos -= 1
        focusClaudeTaskRow()
      } else {
        // Already at the topmost task — this rung has nothing above it.
        exitRelated()
        return 'exit'
      }
    } else if (key === 'ArrowDown') {
      const tasks = otherClaudeChats()
      if (cs.claudeTasksPos < tasks.length) {
        cs.claudeTasksPos += 1
        focusClaudeTaskRow()
      } else {
        exitFooterTasks()
      }
    } else if (key === 'ArrowLeft') {
      exitFooterTasks()
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
        // further up in the ordinary chain, but the footer's own "other
        // running Claude tasks" rung (see enterFooterTasks) may still have
        // something to show (a different conversation running elsewhere in
        // this PR) — reachable from here too, not just from 'code''s own top.
        if (otherClaudeChats().length > 0) {
          enterFooterTasks('thread')
        } else {
          exitRelated()
          return 'exit'
        }
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
        // Nothing further up in this list — step back to wherever the
        // reviewer came from. Reached via enterRelatedFromClaudeChat (a
        // drilled column's own Claude code-preview cards, exhausted going
        // down) → land back on the exact card just left, at 'claude''s own
        // tail, rather than the ordinary comment/exit landing below.
        // Otherwise: step back to the last comment conversation of the unit,
        // if there is one, else leave the panel entirely (there's no trigger
        // stop above it any more — see the removed enterTrigger). ← (below)
        // is deliberately NOT the mirror of this: it always exits straight
        // to the diff, regardless of codeSel or comments — see its own
        // branch below.
        if (codeFromClaudeTail) {
          codeFromClaudeTail = false
          cs.focus = 'claude'
          // codeFromClaudeTailPreviewPos, not a fresh codePreviewCount() —
          // see that field's own doc comment: re-reading it here would
          // already see the now-collapsed comment's empty cp.items.
          if (codeFromClaudeTailPreviewPos > 0) {
            cs.previewPos = codeFromClaudeTailPreviewPos
            focusPreviewCard()
          } else {
            cs.previewPos = 0
            cs.claudeTasksPos = 0
            focusClaudeComposer()
          }
        } else if (hasVisibleComments()) {
          enterCommentsTail()
        } else if (otherClaudeChats().length > 0) {
          // No comment on this unit at all (no 'claude'/'comment' stop to
          // return to), but another conversation is running elsewhere in
          // this PR — the footer-only card (CommentClaudeFooter) shows that
          // list above this one, so land the keyboard on it instead of
          // leaving the panel. Reviewer report: ↑ used to always exit here.
          enterFooterTasks('code')
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
  const draft = getComposeDraft(PRWIDE_DRAFT_KEY)
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

// ── The general (PR-wide, code-less) chat ───────────────────────────────────
// Reviewer request: "hier wil ik een algemene chat kunnen starten, net zo
// werken als chat op regel. het moet dan ook los in de blokken index komen
// zonder dat het gekoppeld is aan code" — plus, later: "Eén per PR,
// hergebruiken … ik vind het mooi als die chat een overlay is over alles
// heen, rechts daarvan mag je gegeneerde blokken uit de chat tonen. esc moet
// alles weer hidden".
//
// A conversation always needs a comment to hang on (the backend's own
// constraint, see "Product decision" in claude-chat-panel.md), so a general
// chat reuses the PR-WIDE comment shape (kind 'issue', no file/line — the
// same thing startPrWideComment/placeComment already write) with the existing
// CLAUDE_ANCHOR_PLACEHOLDER body and always `local: true`. That combination
// is deliberate: isChatAnchorPlaceholder already excludes such a comment from
// indexComments/"Zet op GitHub"/every title fallback, so the anchor stays
// invisible AS A COMMENT and only ever shows up as its own "Openstaande
// chats" row (openChatComments above). Nothing is posted to GitHub, ever.

// isGeneralChatAnchor — that exact comment: PR-wide (no code anchor) AND
// still nothing but the placeholder body. One definition, used by
// openChatComments here and by home.mjs's index row/label.
export function isGeneralChatAnchor(c) {
  return !!c && !!c.kind && isChatAnchorPlaceholder(c)
}

// generalChatAnchor — the ONE general chat of this PR, if it already exists.
// "Eén per PR, hergebruiken": startPrGeneralChat never creates a second one.
export function generalChatAnchor() {
  return cs.list.find(isGeneralChatAnchor) || null
}

// startPrGeneralChat opens (creating it only the first time) this PR's one
// general conversation and leaves the keyboard in its composer. `text`, when
// given, is sent straight away as the first turn — the `/`-menu's no-match
// fallback behaves exactly like the block palette's own "Chat over deze
// regel" there (reviewer: direct versturen).
//
// cs.focus = 'claude' is load-bearing, not cosmetic: syncClaudeAnchorForSelection
// (the passive "the chat column is a function of the selected code" sync)
// returns early on that focus, so the overlay's transcript is never re-anchored
// out from under it by an unrelated comment poll while it sits open.
export async function startPrGeneralChat(state, text) {
  if (!state) return null
  let c = generalChatAnchor()
  if (!c) {
    const ok = await createComment({
      pr: state.pr,
      repo: repoField(),
      file: '',
      line: 0,
      body: CLAUDE_ANCHOR_PLACEHOLDER,
      kind: 'issue',
      local: true,
    })
    if (!ok) return null
    c = generalChatAnchor()
    if (!c) return null
  }
  cs.focus = 'claude'
  cs.claudePos = 0
  await ensureAndLoadChat(state.pr, c.id)
  ensureChatEvents(state.pr)
  restoreClaudeComposerDraft()
  focusEl('[data-testid=claude-chat-compose]')
  if (text) await sendClaudeChatText(state, () => null, text)
  return c
}

// GeneralChatCard renders the SAME chat card the tree's own Claude column
// renders (claudeChatColumn, ClaudeChat.mjs — identical view/callbacks, so
// identical streaming, werkmap choice, menu and send path), just without
// ClaudeChatPanel's claudeColumnVisible()/width/resize wrapper: inside the
// overlay the column IS the surface, its visibility is the overlay's own
// open flag, and there is no neighbouring tree column to resize against.
export function GeneralChatCard(state) {
  ensureChatEvents(state.pr)
  // `{ inOverlay: true }` drops claudeChatColumn's tree-only `max-h-[38vh]`
  // cap — the overlay already has a real, bounded height, so the thread
  // should fill it and only scroll on real overflow. See the opts.inOverlay
  // doc comment above claudeChatColumn (ClaudeChat.mjs).
  return claudeChatColumn(claudeChatView(), claudeChatCallbacks(state, () => null), false, () => {}, {
    inOverlay: true,
  })
}

// sendClaudeChatText sends `text` as the conversation's actual turn, reusing
// the exact send path the composer's own Enter/"Stuur" uses
// (sendClaudeMessageFromNew) — the counterpart to selectHighlightedClaudeOption
// above, for a caller that already has the text in hand (the no-match palette
// fallback's "Chat over deze regel" item, home.mjs) instead of reading it off
// the DOM. Call it once the composer is already entered (startClaudeChat).
export function sendClaudeChatText(state, commentTarget, text) {
  return sendClaudeMessageFromNew(state, commentTarget, text)
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
  cs.focus = 'new'
  composeDraftKey = draftKeyFor(warningOverride.target)
  // Prefer a draft the reviewer already started editing (e.g. left and came
  // back to the SAME conversion via the menu again) over the finding's
  // original body — see composeDrafts above.
  prefillField('[data-testid=comment-compose]', getComposeDraft(composeDraftKey) || c.body || '')
}

// isComposeOpen reports whether the new-comment composer is currently open, so
// home.mjs's keydown handler can catch Enter on a filled composer and open the
// comment-kind menu (Claude / Git / private / Jira) instead of placing directly.
export function isComposeOpen() {
  return cs.focus === 'new'
}

// composeHasText reports whether the composer textarea holds non-whitespace text
// — the gate for opening the comment-kind menu (an empty composer + Enter does
// nothing). Reads the DOM (home.mjs has no access to the textarea otherwise).
export function composeHasText() {
  const el = document.querySelector('[data-testid=comment-compose]')
  return !!el && el.value.trim() !== ''
}

// isConvertingAiWarning reports whether the currently open composer was
// opened via convertWarningToComment ("Comment hiervan maken" on an AI-
// controle finding, see warningOverride above) rather than an ordinary
// "+ Nieuwe comment"/startComment/startRangeComment open. home.mjs's Enter
// (and the composer's own "Plaats…" button) use this to decide whether a
// filled composer still goes through the comment-kind menu (true — the
// reviewer is turning an AI finding into a real comment, worth one more
// look before it becomes public) or posts straight away (false — an
// ordinary comment, even one on a line that happens to already carry an
// unrelated AI warning, per Reindert's explicit narrowing of this rule).
export function isConvertingAiWarning() {
  return !!warningOverride
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

// focusedCommentEl is the focused comment row's own DOM node, for anchoring the
// delete/publish menu under the right element (home.mjs has no access to cs
// directly). Used to be a bare INDEX (commentSelIndex) home.mjs looked up in
// the comment-item NodeList — wrong since the cards above the expanded one
// stopped being rendered (hiddenAboveCount), which makes DOM position and list
// index disagree.
export function focusedCommentEl() {
  return commentItemEl(selComment())
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

// deleteAllAiWarnings deletes EVERY code_warning finding of the current PR in
// one action — the "warnings weghalen" half of the "/" PR menu's "Alle code
// aanpassingen goedkeuren + warnings weghalen" (home.mjs's PR_COMMANDS).
// Which comments count is isAiComment's own rule (home.mjs), duplicated here
// rather than imported to keep the module dependency one-way: an anchored
// finding carries Source "ai" (code_warning.go), an unanchored one
// additionally Kind "ai_warning".
//
// DELETE, not resolve, deliberately: resolving is a conversation concept that
// does not apply to a machine finding, and both comment menus already drop
// their resolve/unresolve slot entirely for one ("ai comments wil ik niet
// resolven, maar wil ik verwijderen") — see isAiComment. Reuses the ordinary
// per-comment delete Signal (deleteComment above), one Signal per finding,
// never a batch write — the same shape as approveAllForPr's one-Signal-per-
// block persistence, and no new backend code. Sequential rather than
// parallel: each Signal drives its own Execution inline in the engine, so
// firing them all at once buys nothing and only makes a partial failure
// harder to read.
//
// Consequence, explicitly agreed with the reviewer: a delete by the reviewer
// (Source not "ai") records the finding as DISMISSED for good
// (recordWarningDismissed → modules/warndismiss, workflows.go), so a later
// code_warning run will not raise the same remark again. "Weghalen" means
// permanently gone here, not "hide until the next commit".
//
// One reload at the end, not per delete: loadComments is the panel's only
// refresh path and re-clamps cs.sel/cs.focus itself.
export async function deleteAllAiWarnings() {
  const targets = commentListSnapshot().filter((c) => c && ((c.source || '') === 'ai' || c.kind === 'ai_warning'))
  if (!targets.length) return
  cs.busy = true
  try {
    for (const c of targets) await deleteComment(c)
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

// ── Comment titles (the comment_titles workflow) ─────────────────────────────
// A long, multi sentence comment used to show its own first lines as if they
// were a heading — an AI-controle finding of three sentences filled the whole
// card and a comment column could not be scanned at all. The comment_titles
// workflow (see comment_titles.go, .claude/docs/workflows-analysis.md) writes a
// short Dutch title of at most 6 words onto the comment, which
// commentTitleLine below renders above the (then clamped) body.
//
// The request is lazy and made from here, mirroring explain_code's own
// frontend-driven start: whatever is on screen gets a title, nothing else, and
// comments that existed long before this feature are covered by the very same
// path — so there is no backfill migration anywhere.

// TITLE_MIN_BODY — below this many characters a comment IS its own title
// already; asking a model to shorten "typo hier" gains nothing and costs a
// call.
const TITLE_MIN_BODY = 90

// commentBodyLen counts code POINTS, matching the Go side's len([]rune(body)) — an
// emoji must not make the two disagree and re-request forever.
function commentBodyLen(c) {
  return [...(c.body || '')].length
}

// commentTitleOf returns the title to show for a comment, or '' — empty while
// none was ever generated AND when the stored one describes an older version of
// the body (the reviewer edited it, see comments.Comment.TitleBodyLen).
export function commentTitleOf(c) {
  if (!c || !c.title) return ''
  return c.titleBodyLen === commentBodyLen(c) ? c.title : ''
}

// needsTitle — this comment deserves a title and doesn't have a usable one yet.
// A terminal 'failed' for this exact body is deliberately never retried (same
// rule as explain_code's failed row): the deterministic Run ID would dedup it
// anyway, and re-asking on every poll would be a call per tick.
function needsTitle(c) {
  if (!c || commentTitleOf(c)) return false
  if (isChatAnchorPlaceholder(c)) return false
  if (commentBodyLen(c) <= TITLE_MIN_BODY) return false
  if (c.titleStatus === 'searching') return false
  if (c.titleStatus === 'failed' && c.titleBodyLen === commentBodyLen(c)) return false
  return true
}

// lastTitleRunKey — the batch we last POSTed. The deterministic Run ID already
// makes a repeat a server-side no-op, but loadComments runs every 5s and a
// pointless request per tick is still a request per tick (same guard idea as
// home.mjs' lastFiredSelectionRef).
let lastTitleRunKey = ''

// requestCommentTitles starts (idempotently) one comment_titles Execution for
// every comment in the freshly loaded list that still needs a title. Gated on
// the "Live AI assistent" switch: this is automatic, unasked-for Claude work,
// exactly like the AI risk check and the footer description (see autowarn.mjs).
function requestCommentTitles(pr, list) {
  if (pr == null || !autoWarn.enabled) return
  const items = list
    .filter(needsTitle)
    .map((c) => ({ id: c.id, bodyLen: commentBodyLen(c) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (items.length === 0) return
  const key = pr + '|' + items.map((it) => it.id + ':' + it.bodyLen).join('|')
  if (key === lastTitleRunKey) return
  lastTitleRunKey = key
  fetch('/api/workflows/comment_titles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr, ...repoField(), items }),
  }).catch(() => {
    // Best-effort: on a transient failure the next poll simply tries again
    // (the guard key is reset so it isn't skipped as "already sent").
    lastTitleRunKey = ''
  })
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
      // Which code each conversation hangs on, for the index pill of a turn
      // running on code the reviewer is not looking at (claudeTurns.mjs owns
      // the turns, this file owns the comments — so the mapping is handed over
      // here, on the comment poll's own cadence).
      setTurnScopes(list.filter((c) => !c.kind).map((c) => [c.id, c.file + '|' + c.label]))
      recomputeView()
      // Ask for a short title for every long comment that still lacks one —
      // idempotent, gated on the AI switch, see requestCommentTitles.
      requestCommentTitles(pr, list)
      // Which comments already carry a Claude conversation decides whether the
      // chat column exists at all (claudeChatVisible), so it is refreshed on the
      // same cadence as the comments themselves — one extra read-only GET per
      // poll, no bodies. Not awaited: the column simply appears a moment later
      // if this lands after the comment rows, since cc.conversations is reactive.
      loadChatConversations(pr)
      // Same cadence, same reason, for WHICH of those conversations has a turn
      // running right now: a turn started in ANOTHER tab (or one whose
      // chat.progress frame this tab missed) was otherwise invisible until the
      // next SSE (re)connect, since loadRunningTurns only ran on connect/
      // resync — reported as "er zijn veel meer chats bezig dan ik zie". One
      // extra read-only, in-memory-backed GET per poll (see
      // .claude/docs/server-events.md).
      loadRunningTurns(pr)
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

// isChatAnchorPlaceholder — a comment that exists ONLY to give a Claude
// conversation something to hang on (the backend's CommentID constraint, see
// ensureClaudeAnchorForNew) and that the reviewer never replaced with their
// own text. Nobody wrote it, so it gets no row in the blokken-index and no
// detail card of its own: both prWideComments (which feeds the PR-comments
// section AND commentDetailCard) and indexComments skip it. Reviewer request:
// "Nog geen eigen comment... moet niet in de index, moet ook gewoon niet
// zichtbaar zijn."
//
// Deliberately scoped to the INDEX side only. The block-scoped thread bubble
// on the unit it hangs on stays exactly as it was: it is the origin message of
// the running conversation, the thing "Comment hiervan maken" edits into a real
// comment, and the anchor chatAnchorComment/ensureClaudeAnchorForNew resolve
// against — hiding it there breaks the very first send that creates it
// (cc.runId never populates). Practical consequence of the split: a placeholder
// whose anchor still resolves stays reachable through its block, and an
// ORPHANED one (code gone) is simply gone from view, which is what the report
// was about.
export function isChatAnchorPlaceholder(c) {
  return !!c && c.body === CLAUDE_ANCHOR_PLACEHOLDER
}

// anchorLineFor picks the source line a new comment/Claude anchor hangs on,
// given the current navigation target `t` (commentTarget(), home.mjs) and the
// TOP-LEVEL selected block `b`. Order: the unit's own real source line
// (t.startLine), else the FOCUSED block's own start line (t.line) — which is
// the drilled column's block whenever one owns the keyboard, since
// commentTarget() follows focusedBlock() — and only then the top-level
// block's line as a last resort.
//
// That middle step is the whole point: a drilled Underlying-code column on an
// UNCHANGED block has no navigable unit, so t.startLine is 0 (see
// commentTarget's own `!unit` branch), and falling straight through to
// `b.line` anchored the comment on the top-level block instead — e.g. a chat
// started on `SessionEnricher::DEFAULT_UTM_VALUES` (line 29) landed on its
// `<class-header>` parent (line 28). `t.line` already describes the block the
// reviewer is actually looking at.
function anchorLineFor(t, b) {
  return (t && (t.startLine || t.line)) || (b && b.line) || 0
}

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
    line: anchorLineFor(t, b),
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
  if (ccBusy() && !action) return queueClaudeMessage(text)
  // Captured BEFORE the anchor step: creating the anchor sets cc.commentId,
  // which moves the composer's attachment bucket from the draft key to that
  // id — while the images the reviewer already pasted still sit under the old
  // one (see chatAttachments.mjs's bucket note).
  const bucket = cc.commentId || claudeChatDraftKey()
  const c = await ensureClaudeAnchorForNew(state, commentTarget)
  if (c) await ensureAndLoadChat(state.pr, c.id)
  await sendClaudeMessage(text, action, claudeContextBlock(commentTarget), null, bucket)
}

// placeComment submits the composer's text as a comment on the current unit.
// Exported so the comment-kind menu (home.mjs COMPOSE_COMMANDS) can place it;
// the composer button routes through the menu too. `opts.local` is still
// supported (a generic, shared parameter — `ensureClaudeAnchorForNew` below
// always creates its Claude-chat anchor comment with `local:true`), but no
// COMPOSE_COMMANDS item passes it true anymore: the one UI entry point that
// did, "Alleen voor mijzelf", was removed on request — see the doc comment
// above COMPOSE_COMMANDS in home.mjs.
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
  if (items.length > MAX_LISTED) list += t(' en {n} meer', { n: items.length - MAX_LISTED })
  return items.length === 1
    ? t('_Comment over {n} blok: {list}_\n\n', { n: items.length, list })
    : t('_Comment over {n} blokken: {list}_\n\n', { n: items.length, list })
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
      deleteComposeDraft(PRWIDE_DRAFT_KEY)
      clearSendFailed(key)
      // Land the sidebar selection on the brand-new index row. It is
      // populated by the comment list, not by loadBlocks, so it may not exist
      // for another tick — blockRefPending is exactly the existing
      // "resolve this comment ref as soon as it turns up" retry
      // (applyCommentRefRestore, home.mjs), reused rather than duplicated.
      if (lastCreatedCommentId && commentSelectRequest) commentSelectRequest(lastCreatedCommentId)
    } else {
      markSendFailed(key)
      setComposeDraft(PRWIDE_DRAFT_KEY, body)
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

  // A Claude conversation already lazily created the ONE backing comment for
  // this exact unit — either just now, in THIS composing session
  // (ensureClaudeAnchorForNew, tracked by claudeAutoAnchor) or earlier, in a
  // session the reviewer has since left and reopened (placeholderAnchorFor,
  // an identity lookup that survives that gap) — "Plaats…" must not start a
  // SECOND Execution next to it. There is no "edit body" Signal (a comment's
  // body is fixed at Execution start), so "updating" it means posting the
  // reviewer's own typed text as a reply on that same thread — the same
  // Signal an ordinary thread reply (sendReaction) already uses — instead of
  // creating a new one. The anchor's own local-ness (fixed at creation,
  // always private, see ensureClaudeAnchorForNew) wins over opts.local here:
  // chatting with Claude first already made this a private thread.
  if (claudeAutoAnchor && claudeAutoAnchor.draftKey === draftKey) claudeAutoAnchor = null
  const placeholderAnchor = placeholderAnchorFor(draftKey)
  if (placeholderAnchor) {
    const c = placeholderAnchor
    if (c.runId) {
      deleteComposeDraft(draftKey)
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
          setReplyDraft(c.id, body)
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
    line: anchorLineFor(t, b),
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
    deleteComposeDraft(draftKey)
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
        <span class="font-medium">${() => t(GRAN_LABEL[target.gran] || target.gran)}</span>
        <span class="text-indigo-300 dark:text-indigo-500">·</span>
        <span class="truncate font-mono font-semibold">${() => target.label}</span>
      </div>
      ${() =>
        // The composer's own "file:line" used to sit next to its heading
        // (see newCommentComposer's removed `target()` helper) — moved here
        // so it's shown once, right under the gran/label line, for both the
        // new-comment composer and an expanded existing conversation alike.
        // Only present when the target actually carries a file (a
        // PR-wide/`hele PR` compose or an existing-conversation target
        // built from just {gran,label,code} has none — see
        // activeComposeTargetHint's second branch).
        target.file
          ? html`<p class="mt-0.5 truncate font-mono text-indigo-400 dark:text-indigo-500">
              ${() => target.file + ':' + (target.startLine || target.line)}
            </p>`
          : ''}
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
//
// `chatAnchor` is true while the target is still a BARE Claude-chat anchor
// (isChatAnchorPlaceholder) that the reviewer has never taken over with a
// real first reply (firstReviewerReplyOnPlaceholder) — i.e. its root body is
// only the auto-generated CLAUDE_ANCHOR_PLACEHOLDER sentence, never anything
// the reviewer wrote. replyPublishCommandsFor (home.mjs) reads this to drop
// the "Ook mijn comment op GitHub" item in that case: there is no reviewer-
// authored "eigen comment" to publish alongside the reply, so offering that
// choice is nonsensical (and would, if picked, post the placeholder sentence
// itself to GitHub). Once the reviewer's own first reply takes the thread
// over, this flips back to false and the item reappears — see "A bare
// Claude-chat thread's publish menu never offers ..." in
// .claude/docs/command-palette.md.
export function pendingPublishInfo() {
  if (!pendingPublish) return null
  const c = commentById(pendingPublish.commentId)
  return {
    ...pendingPublish,
    source: c ? c.source || 'ui' : 'ui',
    localReplies: localReplyCount(c),
    chatAnchor: !!c && isChatAnchorPlaceholder(c) && !firstReviewerReplyOnPlaceholder(c),
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
  // A bare, still-untaken-over Claude-chat anchor (see pendingPublishInfo's
  // own `chatAnchor` doc comment) never has a real CHOICE to ask about: its
  // root carries no reviewer-authored text to optionally publish alongside
  // the reply, and (because it's still un-taken-over) it can never yet hold
  // an earlier local reply either — so the publish menu would only ever show
  // one real destination next to "Sluit menu". Reviewer request: "als ik
  // eigenlijk maar 1 optie heb (- sluiten) dan wil ik geen menu zien" — skip
  // the menu and send straight to GitHub as that one destination
  // (`publish:'reply'`, no history to bring along), exactly like the pure-
  // Claude-draft case just above. Once this reply lands, the thread IS taken
  // over (firstReviewerReplyOnPlaceholder) and a LATER reply goes through the
  // ordinary flow, menu included, since "Ook mijn comment op GitHub" is a
  // real choice again by then.
  if (needsPublishChoice(c) && isChatAnchorPlaceholder(c) && !firstReviewerReplyOnPlaceholder(c)) {
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
// A reply keeps the keyboard on the thread (cs.focus is left untouched, never
// set to null the way exitRelated would) but does NOT open the comment's own
// action menu anymore. It used to (commentMenuOpener, home.mjs's
// openMenu('comment')), on an earlier reviewer request ("als ik een reactie
// plaats op een comment, wil ik niet daarna gelijk naar de diff, ik wil het
// menu zien waar ik kan bijvoorbeeld resolven") — reversed again on a later
// one: "als ik een comment plaat, komt het direct erop (goed), maar ik zie
// dan ook gelijk een menu, dat wil ik niet". The reply still lands
// immediately (optimistic UI, field cleared/blurred before the Signal POST +
// GET even start, mirroring placeComment's own doc comment); the reviewer can
// still open the menu themselves (Enter on the now-empty reply field) if they
// want to resolve/delete/etc. cs.replySent's brief flash still fires:
// commentFooterText() reads it regardless of cs.focus, so it's still visible
// in the shared comment/Claude footer for as long as the reviewer is still
// looking at this unit.
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
  cs.claudeOptionSel = 0
  cs.previewPos = 0
  cs.claudeTasksPos = 0
  releaseFocus() // a focus request still in flight must not land after this
  if (el && el.blur) el.blur()
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
      deleteReplyDraft(c.id)
      clearSendFailed('reply:' + c.id)
      cs.replySent = true
      setTimeout(() => {
        cs.replySent = false
      }, 1200)
      await loadComments(cs.pr)
    } else {
      markSendFailed('reply:' + c.id)
      setReplyDraft(c.id, body)
      // Unlike the old "closes back to the diff" flow, the reply field
      // never unmounts any more (see the doc comment above) — nothing else
      // would re-mount it to pick the draft up from replyDrafts, so restore
      // the failed text into the still-visible field directly.
      if (el) {
        el.value = body
        autoGrowTextarea(el)
      }
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
    ${t('Geldt voor het hele blok')}</span
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
    title="${t('Opgelost')}"
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
    >${t('bron: github')}</span
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
    ${t('AI-risicowaarschuwing')}</span
  >`
}

// isStaleAnchor — a comment whose exact row could no longer be re-found by the
// re-anchor pass (reanchor.go's AnchorUnpinned, "verouderd — regel gewijzigd";
// see staleAnchorBadge). Deliberately NOT the 'orphan' case too: an orphan's
// whole block is gone, so it never resolves into this block-scoped list at all
// (recomputeView's own `anchored` filter excludes it) — this predicate only
// ever matters for a comment that DOES still render here. Used by
// hiddenAboveCount/hasVisibleComments (fold it behind the "N hierboven" hint
// instead of showing it at rest) and enterCommentsOrRelated (→ skips it as a
// default landing, same as an already-resolved comment) — see "A stale
// (unpinned) comment is always folded behind the ▲ hierboven hint" in
// comments-panel.md.
function isStaleAnchor(c) {
  return !!c && c.anchorState === 'unpinned'
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
//
// Also called (via ccAnchorComment(), not c) next to CommentClaudeFooter's
// own "Selected: …" line — jumping to an orphan row of "Andere chats in deze
// PR" opens that conversation's real transcript (jumpToClaudeConversation,
// home.mjs), and this badge is what tells the reviewer, right there, that the
// code it was about is gone — not only in the comment thread/index list this
// function was originally written for.
function staleAnchorBadge(c) {
  if (!c) return ''
  const label = c.anchorState === 'orphan' ? t('verouderd — code verdwenen') : ''
  const unpinned = isStaleAnchor(c) ? t('verouderd — regel gewijzigd') : ''
  const text = label || unpinned
  if (!text) return ''
  return html`<span
    class="inline-flex shrink-0 items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
    data-testid="comment-stale-anchor"
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
    >${label || t('verzenden mislukt — probeer opnieuw')}</span
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
          ${t('Opslaan')}
        </button>
        <button
          type="button"
          class="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300"
          data-testid="message-edit-cancel"
          @click="${() => cancelEditMessage()}"
        >
          ${t('Annuleer')}
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
// `bare` (default false) drops the avatar+name identity span and the
// bordered/tinted bubble box — used by commentDetailCard's origin message
// only, whose card already shows that identity once in its own header (see
// its own doc comment): without this, the origin repeated the avatar+name a
// second time inside its own box. The edit pencil (own messages only) stays
// reachable regardless — editing your own root comment must not silently
// disappear along with the chrome.
// `readOnly` (see expandedConversation's own doc comment) drops the edit
// pencil and makes the body's own links/mentions/images/code-fence
// triggers inert (pointer-events-none) — the click that reaches the OUTER
// card instead (per hit-testing rules, an ancestor's own click handler still
// fires once a descendant opts out of pointer events) is what hands the
// keyboard back, not anything inside this bubble.
function reactionBubble(c, r, i, total, isActive, bare, readOnly) {
  return html`<div class="contents">${() => (isEditingMessage(c, r) ? editingBubble(c, r) : viewingBubble(c, r, i, total, isActive, bare, readOnly))}</div>`
}

function viewingBubble(c, r, i, total, isActive, bare, readOnly) {
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
  // The origin bubble of a bare Claude-chat anchor (see isChatAnchorPlaceholder)
  // must not read as a message the reviewer wrote — same treatment as
  // compactConversation's own author line, see chatAnchorAuthorLine's doc
  // comment. The edit pencil below stays reachable regardless: editing this
  // bubble IS one of the two ways ("Comment hiervan maken" is the other) to
  // turn it into a real comment.
  const isAnchorOrigin = r.id === 'origin:' + c.id && isChatAnchorPlaceholder(c)
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
        ${() =>
          bare
            ? ''
            : isAnchorOrigin
              ? html`
                  <span class="contents">
                    <span
                      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300"
                      aria-hidden="true"
                    >
                      ${chatAnchorGlyph()}
                    </span>
                    <span
                      class="whitespace-nowrap text-[11px] font-medium italic leading-5 text-slate-500 dark:text-zinc-400"
                      data-testid="reaction-author"
                      >${t('Claude gesprek')}</span
                    >
                  </span>
                `
              : html`
                  <span class="contents">
                    ${avatarHTML(who.name, who.avatarUrl, 'h-5 w-5')}
                    <span
                      class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400"
                      data-testid="reaction-author"
                      >${who.name || t('onbekend')}</span
                    >
                  </span>
                `}
        ${() =>
          isOwnMessage(r) && !status && !readOnly
            ? html`<button
                type="button"
                class="text-slate-400 hover:text-indigo-600 dark:text-zinc-600 dark:hover:text-indigo-400"
                data-testid="reaction-edit"
                title="${t('Bewerk bericht')}"
                @click="${() => startEditMessage(c, r)}"
              >
                ${editPencilIcon()}
              </button>`
            : ''}
      </div>
      <div
        class="${() => {
          const sel = active()
          if (bare) {
            // No border/tint box at all — commentDetailCard's origin message
            // reads as plain text under its own already-shown header, exactly
            // like a line comment's body (compactConversation).
            return (
              'rounded-md text-xs font-medium text-slate-800 dark:text-zinc-200 [overflow-wrap:anywhere] ' +
              (sel ? 'ring-2 ring-indigo-400' : '')
            )
          }
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
        style="${() => (readOnly ? 'pointer-events:none' : '')}"
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
      <span class="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-indigo-400" aria-hidden="true" title="${t('Bezig met plaatsen…')}"></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="flex min-w-0 items-center gap-2">
          ${avatarHTML(who.name, who.avatarUrl, 'h-4 w-4')}
          <span class="truncate text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">${who.name || t('Jij')}</span>
        </span>
        <span class="line-clamp-3 [overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200">${p.body}</span>
        <span class="text-[11px] leading-snug text-slate-500 dark:text-zinc-500">${t('Bezig met plaatsen…')}</span>
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

// chatAnchorGlyph — a plain chat-bubble outline, decoration only (the WORD
// "Claude gesprek" next to it carries the meaning, per the colourblind
// rule) — used by chatAnchorAuthorLine below.
function chatAnchorGlyph() {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="h-3 w-3"
    aria-hidden="true"
  ><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`
}

// chatAnchorAuthorLine replaces the ordinary avatar+name author line
// (compactConversation/viewingBubble's own author-line span, see their call
// sites below) for a bare Claude-chat anchor (isChatAnchorPlaceholder) —
// "Comment hiervan maken" is a review request; this bubble was never typed
// by anyone, so it must read as "an ongoing Claude conversation" rather than
// as a message from the reviewer with no avatar/name that would otherwise
// suggest Reindert wrote it. Paired with CHAT_ANCHOR_NOTE_HTML (commentBody)
// below, which replaces the body text the same way. See "A bare Claude-chat
// anchor reads as a conversation, not as a comment" in comments-panel.md.
function chatAnchorAuthorLine() {
  return html`
    <span class="flex min-w-0 items-center gap-2" data-testid="comment-author-line" data-chat-anchor="true">
      <span
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300"
        aria-hidden="true"
      >
        ${chatAnchorGlyph()}
      </span>
      <span
        class="truncate text-[11px] font-medium italic leading-5 text-slate-500 dark:text-zinc-400"
        data-testid="comment-author"
        >${t('Claude gesprek')}</span
      >
    </span>
  `
}

// commentTitleLine — the comment's short generated heading (commentTitleOf),
// or nothing at all. Deliberately plain text, not markdown: it is one short
// sentence and a half-rendered `**` in a truncated heading looks worse than
// none (same reasoning as the other truncate/line-clamp title contexts, see
// conventions.md). Nothing is rendered while a run is still in flight either —
// a "titel genereren…" placeholder would only add a second layout jump.
function commentTitleLine(c) {
  const title = commentTitleOf(c)
  if (!title) return ''
  return html`<span
    class="truncate text-xs font-semibold leading-5 text-slate-900 dark:text-zinc-100"
    data-testid="comment-title"
    >${title}</span
  >`
}

// titleKeyOf feeds the comment card's .key() so a title that lands LATER (the
// workflow needs a couple of seconds; the 5s poll then replaces cs.list with
// fresh objects) really rebuilds the card. Without it arrow.js reuses the
// mounted node and its bindings keep reading the OLD comment object, which
// never gains a title — the same reason the block card's key encodes
// load/code/err, see .claude/rules/arrowjs-pitfalls.md.
function titleKeyOf(c) {
  const title = commentTitleOf(c)
  return title ? 't' + title.length : c.titleStatus || '-'
}

// stale (isStaleAnchor(c)) reduces this card to exactly avatar + name + the
// staleAnchorBadge label + the title, everything else omitted (the status
// mark, the source/AI-warning/block-wide/send-failed badges, the body
// preview, the file:line/reactions meta line). Reviewer request: "als er
// staat 'verouderd - regel gewijzigd', laat dan alleen avatar, naam, label en
// titel zien" — the stored snippet/body no longer describes anything the
// reviewer can still see in the diff, so showing it in full reads as
// misleading detail about code that has moved. Only `compactConversation`
// (the at-rest card): `expandedConversation` — reached deliberately, via the
// "N hierboven" hint or an explicit ↑/click — is left exactly as it always
// was, so the reviewer can still read the full thread once they choose to.
// See "A stale (unpinned) comment is always folded..." in comments-panel.md.
// `stale` is a plain (non-reactive) value fixed for this component's whole
// lifetime — the caller's `.key()` includes `c.anchorState` precisely so a
// later transition rebuilds this card instead of reusing a stale binding
// (arrowjs-pitfalls.md's "a keyed node is reused without re-running its
// bindings"). Every toggle below still goes through a `${() => …}` function
// slot regardless, not a bare ternary — the "statically interpolated
// template↔string" pitfall in arrowjs-pitfalls.md applies across DIFFERENT
// instances of this same template shape (one per comment), not just re-runs
// of one instance.
function compactConversation(c, i, full, openCommentMenu) {
  const who = identityOf(c.source, c.author, c.avatarUrl)
  const stale = isStaleAnchor(c)
  return html`
    <button
      class="${() =>
        // mx-1: a small horizontal outer margin — this column has no padding
        // of its own (see InlineComments' doc comment), so a bare w-full
        // button used to touch the shared card's left/right border directly.
        'mx-1 flex items-start gap-2 rounded-xl border border-slate-300 dark:border-zinc-700 px-2.5 py-2 text-left ring-1 ring-black/5 transition ' +
        (c.status === 'resolved'
          ? 'bg-emerald-50 dark:bg-emerald-500/15 hover:border-indigo-200 dark:hover:border-indigo-500/40'
          : 'bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      data-testid="comment-item"
      data-comment-id="${c.id}"
      data-expanded="false"
      data-stale-anchor="${stale ? 'true' : 'false'}"
      @click="${() => {
        cs.sel = i
        toComment()
        beat()
      }}"
      @contextmenu="${(e) => {
        // Right-click lands on this (not-yet-focused) thread row exactly like
        // the @click above, then opens the comment-scoped menu at the cursor
        // — see "The right-click context menu" in command-palette.md.
        if (!openCommentMenu) return
        e.preventDefault()
        cs.sel = i
        toComment()
        beat()
        openCommentMenu({ native: true, x: e.clientX, y: e.clientY })
      }}"
    >
      ${() => (stale ? '' : commentStatusMark(c, 'mt-1'))}
      <span class="flex min-w-0 flex-col gap-0.5">
        ${() =>
          isChatAnchorPlaceholder(c) && !firstReviewerReplyOnPlaceholder(c)
            ? chatAnchorAuthorLine()
            : html`
                <span class="flex min-w-0 items-center gap-2" data-testid="comment-author-line">
                  ${authorAvatarStack(c, who)}
                  <span class="truncate text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400" data-testid="comment-author"
                    >${who.name || t('onbekend')}</span
                  >
                  ${() => (stale ? '' : sourceBadge(c))}
                  ${() => (stale ? '' : aiWarningBadge(c))}
                  ${() => (stale ? '' : blockWideBadge(c))}
                  ${() => staleAnchorBadge(c)}
                  ${() => (stale ? '' : sendFailedBadge('reply:' + c.id))}
                </span>
              `}
        ${() => commentTitleLine(c)}
        ${() =>
          stale
            ? ''
            : html`<span
                class="${full && !commentTitleOf(c)
                  ? '[overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200'
                  : 'line-clamp-3 [overflow-wrap:anywhere] text-xs font-medium text-slate-800 dark:text-zinc-200'}"
                .innerHTML="${commentBody(c, threadFenceStartIndexes(c).get('origin:' + c.id) ?? 0)}"
              ></span>`}
        ${() =>
          stale
            ? ''
            : html`<span class="truncate text-[11px] leading-snug text-slate-500 dark:text-zinc-500" data-testid="comment-meta"
                >${() => truncateMiddle(c.file) + ':' + c.line + ' · ' + commentReactionStatusLine(c)}</span
              >`}
      </span>
    </button>
  `
}

// commentReactionStatusLine — the "N reacties · status" tail of a comment's
// meta line, extracted out of compactConversation so commentDetailCard (a
// general/PR-wide comment's own detail card) can reuse the exact same
// wording/shape instead of inventing its own — see "look more like a line
// comment" in comments-panel.md.
function commentReactionStatusLine(c) {
  // Once the reviewer's own first reply has taken a bare Claude-chat anchor
  // over (firstReviewerReplyOnPlaceholder), that reply IS the comment, not a
  // reply to it — reviewer report: a taken-over anchor kept reading "Claude
  // gesprek · 1 reactie" even though there was really only ONE comment, no
  // reply at all. Subtract exactly the one reaction that got promoted (see
  // threadMessages' own reordering, which drops it from the tail the same
  // way), so this reads like an ordinary comment with N real replies below it.
  const taken = firstReviewerReplyOnPlaceholder(c)
  const count = taken ? Math.max(0, c.reactionCount - 1) : c.reactionCount
  return t('{n} reacties', { n: count }) + ' · ' + t(c.status) + lastReplyNote(c)
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
// `readOnly` (see "Read-only, not a rail" in .claude/docs/comments-panel.md)
// is true for exactly one case: Claude owns the keyboard, this comment is
// Claude's own anchor, and the screen is narrow enough that this half has
// shrunk to 1/3 (commentColumnReadOnly(state), passed down via commentCard).
// The thread stays fully visible and scrollable — "ik wil het wel zien wat
// er is verteld" — but every control disappears: the composer row entirely,
// the edit pencil on each bubble (reactionBubble's own readOnly param), and
// any in-body link/mention/image click (pointer-events-none on the bubble's
// own markdown body, see reactionBubble). The one remaining gesture is a
// click ANYWHERE on this card, which hands the keyboard back — the read-only
// equivalent of the click a focused card's own composer already had.
function expandedConversation(c, openCommentMenu, readOnly) {
  return html`
    <div
      class="${() =>
        'flex flex-col gap-2 rounded-xl p-3 ring-1 ring-black/5 ' +
        // No focus border any more (reviewer request, reversing the earlier
        // "indigo while cs.focus === 'comment'/'thread', border-transparent
        // otherwise" rule) — see "No per-side focus border any more" in
        // .claude/docs/comments-panel.md.
        (c.status === 'resolved' ? 'bg-emerald-50 dark:bg-emerald-500/15' : 'bg-white dark:bg-zinc-900')}"
      data-testid="comment-item"
      data-comment-id="${c.id}"
      data-expanded="true"
      data-readonly="${readOnly ? 'true' : 'false'}"
      @click="${() => {
        // The one click this read-only card DOES react to — hands the
        // keyboard back, mirroring the ←/Escape hand-off already used from
        // 'claude' (toComment()/toNewFocus(), see handleRelatedKey).
        if (readOnly) {
          cc.commentId == null ? toNewFocus() : toComment()
          return
        }
        // Not read-only, but this card can still render fully expanded
        // BEFORE the keyboard actually owns it — the "Comments op regels"
        // anchor-only forced expansion (isAnchorOnlyComment, commentCard):
        // "as if fully expanded" is purely visual, exactly like
        // openCommentAnchorDrill's own diff/Onderliggende-code column (see
        // its doc comment in home.mjs), and only an explicit → — or, per
        // mouse-navigation.md's "a click runs the same function a key runs",
        // a click — actually hands the keyboard in. Once this conversation
        // DOES own cs.focus, this is a no-op again: its own composer/reply
        // field already handles its own clicks, and this outer handler must
        // never steal focus away from an interactive field the reviewer is
        // already typing in.
        const alreadyFocused =
          (cs.focus === 'comment' || cs.focus === 'thread') && selComment() && selComment().id === c.id
        if (alreadyFocused) return
        const vi = cs.view.findIndex((x) => x.id === c.id)
        if (vi >= 0) {
          cs.sel = vi
          toComment()
        }
      }}"
      @contextmenu="${(e) => {
        // Right-click anywhere on this (already-focused) thread card = the
        // same click reaction-status already runs, native-styled at the
        // cursor — except inside the reply textarea itself, which keeps its
        // native Cut/Copy/Paste/spellcheck menu (mirrors the "an unchanged
        // diff line keeps the native menu" rule for editable surfaces in
        // general). See "The right-click context menu" in command-palette.md.
        // Suppressed entirely while read-only — there is no menu button here
        // to mirror, and "niets klikbaar" includes the right-click menu.
        if (readOnly) return
        if (e.target.closest && e.target.closest('textarea, input')) return
        if (!openCommentMenu) return
        e.preventDefault()
        openCommentMenu({ native: true, x: e.clientX, y: e.clientY })
      }}"
    >
      <div class="flex items-center justify-end gap-2" data-testid="comment-meta-line">
        ${() => sourceBadge(c)} ${() => aiWarningBadge(c)} ${() => blockWideBadge(c)} ${() => staleAnchorBadge(c)}
        ${() => sendFailedBadge('reply:' + c.id)}
        ${() => commentStatusMark(c)}
      </div>
      <div class="relative min-h-0">
        <div
          class="no-scrollbar flex max-h-[38vh] min-h-0 flex-col gap-2 overflow-y-auto p-0.5"
          data-testid="comment-thread"
          data-scroll-body
          @scroll="${(e) => {
            updateScrollHints(e.target)
            updateCommentThreadPinned(e.target)
          }}"
        >
          ${() =>
            threadMessages(c).map((r, i, arr) => reactionBubble(c, r, i, arr.length, undefined, false, readOnly).key('msg:' + r.id))}
        </div>
        ${scrollHint('up')}
        ${scrollHint('down')}
        <div class="contents">
          ${() =>
            cs.threadPos === 0 && !cs.threadPinned
              ? scrollToRecentButton(jumpToCommentThreadBottom, 'scroll-to-bottom-comments')
              : ''}
        </div>
      </div>
      ${() =>
        readOnly
          ? ''
          : html`<div class="flex items-end gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-2">
        <textarea
          rows="1"
          class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-1.5 text-xs leading-6 text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
          placeholder="${t('Reageer op deze comment…')}"
          data-testid="reaction-compose"
          @input="${(e) => {
            if (c) setReplyDraft(c.id, e.target.value)
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
          ${t('Stuur')}
        </button>
        <button
          type="button"
          class="${() =>
            'flex min-h-[2.25rem] shrink-0 items-center justify-center rounded-lg border px-2.5 py-1.5 transition ' +
            (cs.busy
              ? 'cursor-not-allowed border-slate-200 text-slate-400 dark:border-zinc-800 dark:text-zinc-600'
              : 'border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-indigo-500/40 dark:hover:text-indigo-400')}"
          data-testid="reaction-status"
          title="${t('Resolve/verwijder via het menu')}"
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
      </div>`}
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
//
// `readOnly` (from InlineComments, computed via commentColumnReadOnly(state))
// only ever applies to that SECOND branch — the comment side never goes
// read-only while it itself owns the keyboard, only while Claude does — see
// "Read-only, not a rail" in .claude/docs/comments-panel.md.
// isAnchorOnlyComment — true while this comment is the (only) one a
// "Comments op regels" index item's drilled anchor column scoped the view
// down to (cs.scope.onlyIds, set by home.mjs's commentScope while
// isCommentAnchorDrillActive(1)). Used by commentCard below to force the
// FULL thread (expandedConversation) for it even before the reviewer has
// pressed → — reviewer request: "comment en chat moet ook volledig
// opengevouwen zijn", matching the way the anchor's own diff/Onderliggende
// code already auto-opens while merely walking ↑/↓ (see
// openCommentAnchorDrill in home.mjs). Since onlyIds already narrows
// visibleComments() to just this row's own comment(s), this can never also
// match some OTHER, unrelated comment.
function isAnchorOnlyComment(c) {
  return !!(cs.scope && cs.scope.onlyIds && cs.scope.onlyIds.includes(c.id))
}

function commentCard(c, i, openCommentMenu, readOnly) {
  return html`
    <div class="contents">
      ${() =>
        selI() === i && (cs.focus === 'comment' || cs.focus === 'thread')
          ? expandedConversation(c, openCommentMenu, false)
          : cs.focus === 'claude' && chatAnchorComment() && chatAnchorComment().id === c.id
            ? expandedConversation(c, openCommentMenu, readOnly)
            : isAnchorOnlyComment(c)
              ? expandedConversation(c, openCommentMenu, false)
              : compactConversation(c, i, autoExpandLoneComment(), openCommentMenu)}
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
  // The composer used to show its own "file:line" next to the heading (a
  // local `target()` helper, since removed) — that moved to
  // composeTargetHint's own "deze regel"/"deze aanroep" card above the whole
  // merged comment-claude-row, right under the gran/label line, so it isn't
  // duplicated here any more. See "The shared composeTargetHint header" in
  // .claude/docs/comments-panel.md. The one exception is `cs.prWideCompose`:
  // "hele PR" is not a file path (there IS no composeTargetHint for a
  // PR-wide compose, see activeComposeTargetHint's own doc comment), so that
  // label stays right here.
  const heading = () => {
    if (cs.prWideCompose) return t('Nieuwe algemene comment · hele PR')
    return warningOverride ? t('Comment van AI-controle') : t('Nieuwe comment')
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
                class="flex flex-col gap-2 rounded-xl bg-white dark:bg-zinc-900 p-3 ring-1 ring-black/5"
                data-testid="comment-composer"
              >
                <p class="text-[11px] font-medium text-slate-500 dark:text-zinc-500">
                  ${() => heading()}
                </p>
                ${() =>
                  sendFailedBadge(
                    'new:' + (cs.prWideCompose ? PRWIDE_DRAFT_KEY : draftKeyFor(effectiveTarget())),
                    t('plaatsen mislukt — probeer opnieuw'),
                  )}
                <textarea
                  rows="1"
                  class="min-h-20 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-3 py-2 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="${() => (cs.prWideCompose ? t('Je algemene comment op deze PR…') : t('Je comment op deze regel…'))}"
                  title="${t('Enter plaatst · Shift+Enter nieuwe regel')}"
                  data-testid="comment-compose"
                  @input="${(e) => {
                    setComposeDraft(composeDraftKey, e.target.value)
                    autoGrowTextarea(e.target)
                  }}"
                  @keydown="${(e) => {
                    // Same local, self-contained pattern the Claude composer's
                    // own @keydown already uses (ClaudeChat.mjs) — Enter posts,
                    // Shift+Enter is left alone for the browser's own newline.
                    // Runs the SAME `openCompose` callback the "Plaats…"
                    // button's @click already runs (a key runs the same
                    // function a click runs, see mouse-navigation.md) — which
                    // already contains the one exception this composer needs:
                    // isConvertingAiWarning() opens the comment-kind menu
                    // instead of posting straight away (see
                    // isConvertingAiWarning's own doc comment). Kept alongside
                    // (not instead of) home.mjs's own isComposeOpen() Enter
                    // handling below, which still covers this same Enter via
                    // bubbling for a still-empty field (no-op either way) and
                    // stays the fallback for any other caller of this
                    // composer this local handler might miss.
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (e.target.value.trim()) {
                        // stopPropagation so this same Enter doesn't also run
                        // home.mjs's document-level isComposeOpen() branch a
                        // second time right after — mirrors reaction-compose's
                        // own guard just below.
                        e.stopPropagation()
                        if (openCompose) openCompose()
                        else placeComment(state, commentTarget)
                      }
                    }
                  }}"
                ></textarea>
                <div class="flex items-center justify-end gap-2">
                  <button
                    class="${() =>
                      'flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' +
                      (cs.busy ? 'cursor-not-allowed opacity-50' : 'hover:bg-indigo-600')}"
                    data-testid="comment-send"
                    disabled="${() => cs.busy}"
                    @click="${() => (openCompose ? openCompose() : placeComment(state, commentTarget))}"
                  >
                    ${() => sendStatusIcon(cs.busy ? 'sending' : 'draft')}
                    ${t('Plaats…')}
                  </button>
                </div>
              </div>
            `
          : ''}
    </div>
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
// `n` is the cursor's own index (hiddenAboveCount()), not a scroll
// measurement: deterministic, reactive for free, and it can't disagree with
// what ↑ would actually do.
//
// Only used for stacked comment cards (InlineComments' comment-more-above)
// now — the Onderliggende-code list dropped its own call site once its cards
// above the cursor started collapsing to just their header (relatedCard's
// `collapsed`), which already shows what's above without a separate hint.
//
// MODULE scope, deliberately: this used to sit nested INSIDE RelatedCode's
// component body, so InlineComments' own call site below threw
// "moreAboveHint is not defined" on every render — which is why the hint was
// never actually visible in the comment column (it has no test of its own).
//
// `onUp` makes it a real button: for comments the cards above are not merely
// scrolled out of view but not rendered at all (hiddenAboveCount), so without
// this the hidden conversations would have no MOUSE route back at all. The
// click runs the same step the ArrowUp key runs (see the call site), per
// .claude/docs/mouse-navigation.md.
function moreAboveHint(n, testid, onUp) {
  return html`
    <button
      type="button"
      class="sticky top-0 z-10 -mt-1 mb-1 flex shrink-0 items-center gap-1 rounded-md border border-slate-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 px-2 py-1 text-[11px] text-slate-500 dark:text-zinc-400 hover:border-indigo-300 dark:hover:border-indigo-500/40"
      title="${t('Ga naar de comment hierboven')}"
      data-testid="${testid}"
      @click="${() => onUp && onUp()}"
    >
      <span aria-hidden="true">▲</span>
      <span>${t('{n} hierboven', { n })}</span>
    </button>
  `
}

// InlineComments — the exported block home.mjs mounts directly above the
// Onderliggende-code card (see DetailPanel): the new-comment composer, once
// opened via the command palette (see newCommentComposer above), then one
// card per conversation already scoped to the selected unit
// (visibleComments()). `openPrCommentMenu` is only used for the
// isPrCommentScope() slot below (an unanchored comment-index item's own
// menu, prCommentCommandsFor) — kept as a separate callback from
// `openCommentMenu` (the ordinary block-scoped 'comment' menu) since the two
// modes build a different command list (home.mjs's openMenu('comment') vs
// openMenu('prComment')).
// InlineComments is the exported entry home.mjs mounts. It used to decide
// between a collapsed rail and the ordinary card (see "Read-only, not a
// rail" in .claude/docs/comments-panel.md — superseded that idiom for this
// pair) — now it's a thin pass-through: inlineCommentsCardHTML below always
// renders, and decides FOR ITSELF, per comment, whether it's interactive or
// read-only (commentColumnReadOnly(state), threaded down to commentCard).
export function InlineComments(state, commentTarget, openCompose, openCommentMenu, openPrCommentMenu) {
  syncComments(state ? state.pr : null)
  return inlineCommentsCardHTML(state, commentTarget, openCompose, openCommentMenu, openPrCommentMenu)
}

function inlineCommentsCardHTML(state, commentTarget, openCompose, openCommentMenu, openPrCommentMenu) {
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
      class="${() =>
        'relative flex shrink-0 flex-col justify-end gap-2 ' + commentColumnWidthCls(state)}"
      style="${() => colWidthStyle(state, widthKey())}"
      data-testid="inline-comments"
      data-col-resize-root
    >
      ${() =>
        widthKey()
          ? resizeHandle(
              (e) => startColumnResize(e, state, widthKey(), () => parseAutoWidthPx(commentColumnWidthCls(state))),
              () => resetColumnWidth(state, widthKey()),
            )
          : ''}
      <div class="contents">
        ${() =>
          // An unanchored comment-index item (isPrCommentScope) has no code
          // unit, so cs.view is empty here by design — this used to leave
          // the whole column a bare fixed-width gap next to the Claude
          // column, with the item's own thread rendered as a SEPARATE card
          // in home.mjs's block-column instead (two columns, not one merged
          // block — reviewer report: "Pr-comments wil ik graag in 1 blok
          // samen met claude chat"). commentDetailCard now renders HERE
          // instead — same shared border/bg/items-stretch row as an ordinary
          // block-scoped comment+Claude pair — with `merged: true` so it
          // takes this column's own width instead of its usual fixed one.
          // home.mjs's DetailPanel hides the block-column entirely for this
          // case (isPrCommentScope), so this is now the ONLY place this
          // card renders. See "The comment-detail card moved into the
          // merged comment-claude-row" in comments-panel.md.
          isPrCommentScope()
            ? commentDetailCard(cs.scope.prComment, {
                merged: true,
                preview: false,
                openMenu: openPrCommentMenu,
                // Same read-only shrink as an ordinary block-scoped
                // conversation (commentColumnReadOnly(state)) — this variant
                // gets the identical treatment for consistency, see "Read-only,
                // not a rail" in .claude/docs/comments-panel.md.
                readOnly: commentColumnReadOnly(state),
              }).key(
                // Forces a fresh card whenever the SELECTED comment-index
                // item changes (never reuse the previous comment's mounted
                // node/bindings), plus its own status/title, mirroring the
                // rekey-on-status/title-change reasoning the block-column's
                // own comment-detail-card key used before this moved here.
                // readOnly rides along too — a composer appearing/disappearing
                // is a real shape change (same reasoning as commentCard's own
                // key).
                'pr-comment-detail:' +
                  cs.scope.prComment.id +
                  ':' +
                  cs.scope.prComment.status +
                  ':' +
                  (commentTitleOf(cs.scope.prComment) ? 't' : '-') +
                  ':' +
                  (commentColumnReadOnly(state) ? 'ro' : 'rw'),
              )
            : ''}
      </div>
      ${() =>
        hiddenAboveCount() > 0
          ? moreAboveHint(hiddenAboveCount(), 'comment-more-above', () => {
              // Select the last comment ABOVE the expanded one — exactly the
              // card this hint points at, and the same step handleRelatedKey's
              // ArrowUp takes once it walks past a thread's oldest message.
              // Deliberately computed from hiddenAboveCount() rather than
              // `cs.sel - 1`, so it stays correct when the expanded card is
              // the Claude anchor rather than the cursor.
              cs.sel = Math.max(0, hiddenAboveCount() - 1)
              toComment()
            })
          : ''}
      ${newCommentComposer(state, commentTarget, openCompose)}
      <div class="contents">
        ${() => {
          const p = pendingCommentFor(commentTarget && commentTarget())
          return p ? pendingCommentBubble(p) : ''
        }}
      </div>
      ${() => {
        // The cards above the expanded one are left out entirely
        // (hiddenAboveCount) — they pushed the expanded card, and its reply
        // field, below the fold. `i` stays the comment's REAL index in the
        // visible list, so commentCard's own `cs.sel = i` click and its
        // `selI() === i` expand check are unaffected by the filtering, and the
        // result is a shorter KEYED array rather than a per-item template↔''
        // toggle (the "bare toggling expression" pitfall in
        // .claude/rules/arrowjs-pitfalls.md).
        //
        // hiddenAboveCount() is read UNCONDITIONALLY, before the loop, not
        // inside a .filter() callback: an empty list would never call that
        // callback, so cs.sel/cs.focus would be missing from this binding's
        // crystallized dependency set and it would never re-run on a
        // selection change (same rule as watch()'s inline deps, see
        // .claude/rules/arrowjs-pitfalls.md).
        const hidden = hiddenAboveCount()
        const list = visibleComments()
        const readOnly = commentColumnReadOnly(state)
        const cards = []
        for (let i = hidden; i < list.length; i++) {
          // titleKeyOf: a later-arriving comment title must rebuild the card,
          // see its own doc comment. readOnly rides along in the key too —
          // its own doc comment on commentCard explains why (a composer
          // appearing/disappearing is a real shape change). anchorState too:
          // a re-anchor pass landing on the SAME comment id (a poll turning a
          // pinned comment 'unpinned', or re-pinning it later) must rebuild
          // compactConversation's stale-reduced fields — a keyed-node reuse
          // would otherwise keep rendering the OLD anchorState forever, see
          // "A keyed node is reused without re-running its bindings" in
          // .claude/rules/arrowjs-pitfalls.md.
          cards.push(
            commentCard(list[i], i, openCommentMenu, readOnly).key(
              'comment:' + list[i].id + ':' + titleKeyOf(list[i]) + ':' + (readOnly ? 'ro' : 'rw') + ':' + (list[i].anchorState || '-'),
            ),
          )
        }
        return cards
      }}
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
  // A config('file.key.path') call → the value declared in config/<file>.php,
  // and its optional .env.example sibling (resolveConfigCalls, see
  // .claude/docs/workflows-analysis.md) — both pure reference material, like
  // translation/const_ref: no diff/approval, current value only.
  config_value: 'config',
  env_example: '.env.example',
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
      title="${t('Toegevoegde / verwijderde regels in de aangeroepen definitie')}"
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
      title="${t('Aangeroepen definitie is niet gewijzigd in deze PR')}"
      >${t('Ongewijzigd')}</span
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
      title="${changed ? t('Deze PR wijzigt deze declaratie') : t('Deze PR wijzigt deze declaratie niet')}"
      >${changed ? t('Gewijzigd') : t('Ongewijzigd')}</span
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
      title="${t('Goedgekeurde regels')}"
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
      <title>${t('Alleen bekijken — hier valt niets goed te keuren')}</title>
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
      title="${s.count === 1
        ? t('{count} open reactie (dit block + onderliggende code)', { count: s.count })
        : t('{count} open reacties (dit block + onderliggende code)', { count: s.count })}"
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
        // bg-white (not the old translucent bg-slate-50/60): that translucent
        // tint sits almost exactly ON the page's own bg-slate-50 in light mode
        // (see the matching note on relatedCard below), so the chip had no
        // visible background of its own there — only in dark mode (where
        // zinc-800/40 reads lighter than the zinc-950 page) did it look right.
        'w-72 shrink-0 rounded-md border bg-white dark:bg-zinc-800/40 px-1.5 py-1 text-left hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
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
        <span class="${k.approveCls}" data-testid="related-nested-approval" title="${t('Goedgekeurde regels')}">${k.approveText}</span>
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
                >${t('+{n} meer', { n: more })}</span
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
// method's card could before). Uses the CSS `ch` unit rather than a
// hand-picked px-per-char ratio — still zero live measurement, `ch` is
// resolved by the browser's layout engine from the char count we already
// computed, not from reading back a rendered node's size. NOTE (2026-08-20):
// `ch` is NOT "one monospace glyph" as this comment used to claim — it is
// one glyph of the font of the element carrying the class, here the page's
// proportional ui-sans-serif at 16px, roughly 1.5× the code panes' own
// monospace advance (see CODE_CHAR_PX in Block.mjs, where a diff card's own
// width was moved off `ch` for exactly that reason). Deliberately left as
// `ch` here: this column is clamped between a floor and a ceiling either
// way, so the only effect is that it reaches its ceiling at a lower char
// count — no line gets clipped and nothing grows past the ceiling. `clamp()` handles the "no code yet / all comment"
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

// RELATED_EMPTY_WIDTH_CLS / relatedColumnIsEmpty — an Onderliggende-code
// column with genuinely NOTHING in it gets a flat, narrow width instead of
// the 42rem/49.2rem clamp FLOOR (relatedWidthCls above, which never goes
// below it however little content there is). Reported by the reviewer as a
// diff card that looked "enormous and almost entirely empty" (live PR 13431,
// a test method's `getJson(...)` line): measured at a 2000px viewport, the
// card was 1429px and this column claimed 787px for the single sentence
// "Geen onderliggende code." — 2216px of column flow in a 1952px <main>, so
// the moment the keyboard moved into the panel (?rel.foc=code,
// scrollRelatedIntoView) <main> scrolled to its own maximum and cut 240px off
// the card's LEFT edge. Since almost every line of that method is short, the
// remaining visible slice held no text at all: the card read as a tall empty
// green field with one long line in it, and its title started mid-word. At
// 18rem the whole flow fits and <main> stays at scrollLeft 0.
//
// "Empty" is deliberately strict, and the last two terms are what keep the
// documented width invariant intact (commentColumnWidthCls() + connector +
// claudeColumnWidthCls() === relatedColumnWidthCls(), see those functions'
// own doc comment): those two siblings keep deriving from the unchanged
// clamp, so narrowing this column may only happen while the comment/Claude
// row above it has nothing to align with in the first place — which is
// exactly `!claudeChatVisible() && !hasCommentClaudeFooter() &&
// !hasAnyComments()`, the very expression home.mjs's comment-claude-row uses
// for its own `hidden` class (measured: that row is then 0px wide).
//
// Deliberately NOT gated on the "zoeken…" pill (searching() in
// RelatedPanel below): an unresolved call whose LLM search is still running is
// the normal state for a test method full of framework calls, and waiting for
// it would keep the dead 787px for as long as the search takes. If the search
// does land a child, the column simply widens then — the same content-driven
// behaviour it always had. One flat token (no narrow:/2xl: variants) since
// it's already well below every one of those floors, mirroring
// NARROW_FIXED_WIDTH_CLS in Block.mjs; `w-[18rem]` also stays parseable by
// parseAutoWidthPx's bare-rem branch, so a drag on this column still snaps
// back correctly.
//
// `!hasAnyComments()` (not hasVisibleComments()) is deliberate here too: a
// unit whose only comment is a stale one folded behind the "N hierboven"
// hint still has that hint to align with, same reasoning as home.mjs's
// comment-claude-row hidden class right below this comment's own reference.
const RELATED_EMPTY_WIDTH_CLS = 'w-[18rem]'

function relatedColumnIsEmpty() {
  return (
    rc.children.length === 0 &&
    !rc.warning &&
    !claudeChatVisible() &&
    !hasCommentClaudeFooter() &&
    !hasAnyComments()
  )
}

export function relatedColumnWidthCls() {
  if (relatedColumnIsEmpty()) return RELATED_EMPTY_WIDTH_CLS
  return relatedWidthCls(relatedGrowthChars(), 1)
}

// The dashed connector between the comment and Claude columns (home.mjs,
// data-testid=comment-claude-connector): w-3 = 0.75rem, no extra flex `gap`
// around it (mirrors nestedChipColumn's own connector, which also has none).
const COMMENT_CLAUDE_CONNECTOR_REM = 0.75

// COMMENT_CLAUDE_WIDE_SCALE — the scale BOTH halves get on a wide screen
// (see columnPairScale below). Originally 1 (the FULL clamp, same as
// relatedColumnWidthCls itself — "maak de chat blokken 2x zo breed",
// see below); lowered to 0.75 on reviewer report (screenshot, 2026-08-22):
// "voor een groot scherm heb je nu een ander formaat chat, dat mag ~25%
// kleiner" — confirmed to mean exactly this wide-screen doubling, for BOTH
// halves, nothing below COMMENT_CLAUDE_WIDE_BREAKPOINT_PX. 0.75 is 25% less
// than the previous 1, so each half is now 1.5x (rather than 2x) the
// sub-breakpoint rest-state's 0.5 share.
const COMMENT_CLAUDE_WIDE_SCALE = 0.75

// columnPairScale — the shared "how much of relatedColumnWidthCls()'s own
// clamp does THIS half get" read behind commentColumnWidthCls/
// claudeColumnWidthCls below. `thisSideFocused`/`siblingFocused` (mutually
// exclusive, but both can be false at once — the rest state) answer "does
// THIS half own the keyboard" / "does the SIBLING own the keyboard".
//
// scale is COMMENT_CLAUDE_WIDE_SCALE on a wide screen
// (`!state.commentClaudeNarrow`, at/above COMMENT_CLAUDE_WIDE_BREAKPOINT_PX
// — home.mjs) — reviewer request: "maak de chat blokken 2x zo breed (dan
// past alles heel goed)" on a screen with room to spare, so BOTH halves grow
// from the halved split below (later scaled back 25%, see the constant's own
// doc comment), and neither ever shrinks below that there. On a narrow
// screen: 2/3 for the focused half, 1/3 for the unfocused-but-still-visible
// one (reviewer request, replacing an earlier cut that collapsed the
// unfocused half to a bare rail — see "Read-only, not a rail" in
// .claude/docs/comments-panel.md), or 1/2 for both in the rest state (neither
// side focused, "zoals nu").
function columnPairScale(state, thisSideFocused, siblingFocused) {
  if (!state || !state.commentClaudeNarrow) return COMMENT_CLAUDE_WIDE_SCALE
  if (thisSideFocused) return 2 / 3
  if (siblingFocused) return 1 / 3
  return 1 / 2
}

// commentColumnWidthCls / claudeColumnWidthCls — read the SAME chars
// snapshot so both split evenly as the code grows, not just at the
// extremes — the two blocks read as one merged card (see home.mjs's
// comment-claude-row). The connector's own 0.75rem comes off the comment
// side's own subtraction, always, regardless of the split — exactly as
// before this feature existed. That single fact is also why the row's TOTAL
// width stays invariant across every state without any extra correction
// term (unlike an earlier cut of this feature, which collapsed the
// unfocused half to a fixed-width rail and needed one): both halves are
// STILL rendered via this same clamp formula, at whatever scale, and
// `relatedWidthCls(chars,a,d1) + relatedWidthCls(chars,b,d2) ===
// relatedWidthCls(chars,a+b,d1+d2)` exactly (clamp scales homogeneously and
// shifts additively — relatedWidthCls's own doc comment). This keeps the row's
// total EXACTLY equal to `relatedColumnWidthCls()` only for `a+b=1` — true for
// `2/3+1/3` (the focused/unfocused split) and `1/2+1/2` (rest); the wide-screen
// pair (`COMMENT_CLAUDE_WIDE_SCALE` for both halves, currently 0.75+0.75=1.5)
// is deliberately NOT `a+b=1` — it was already 1+1=2 before that constant was
// introduced, i.e. this row was always wider than `relatedColumnWidthCls()` on
// a wide screen, by design ("maak de chat blokken 2x zo breed", see
// columnPairScale's own doc comment). Verified numerically too, across several
// `chars` values, not just by this algebraic argument.
export function commentColumnWidthCls(state) {
  return relatedWidthCls(
    relatedGrowthChars(),
    columnPairScale(state, commentSideFocused(), isClaudeChatFocused()),
    COMMENT_CLAUDE_CONNECTOR_REM,
  )
}

export function claudeColumnWidthCls(state) {
  return relatedWidthCls(relatedGrowthChars(), columnPairScale(state, isClaudeChatFocused(), commentSideFocused()))
}

// commentClaudeRowWidthCls — the ACTUAL rendered width of comment-claude-row
// (home.mjs), for a sibling that must never exceed it (CodePreviewPanel's own
// code-preview column, below): without a real width bound of its own, an
// unbounded child (a long context line in previewCard, CodePreview.mjs
// — the same failure mode InlineComments' own doc comment above describes and
// already fixed for itself) pushes the shared `comments-and-related` ancestor
// wider than comment-claude-row, so the code-preview cards spill out past the
// comment/chat card's right edge.
//
// Deliberately NOT `relatedColumnWidthCls()` — that clamp uses scale 1, while
// comment-claude-row's own two halves can together sum to 1.5 on a wide
// screen (COMMENT_CLAUDE_WIDE_SCALE, see columnPairScale's own doc comment),
// so relatedColumnWidthCls() alone would be too NARROW and this column would
// stop lining up under the row above it. Uses the exact same
// `relatedWidthCls(chars,a,d1) + relatedWidthCls(chars,b,d2) ===
// relatedWidthCls(chars,a+b,d1+d2)` identity commentColumnWidthCls/
// claudeColumnWidthCls's own doc comment relies on, so this is the row's
// real width, not an approximation.
//
// When the Claude half isn't mounted at all (`!claudeColumnVisible()` — see
// its own gate at this module's `${() => !claudeColumnVisible() ? '' : …}`
// branch), comment-claude-row renders only the comment half, so this returns
// `commentColumnWidthCls(state)` verbatim rather than the (wrong) sum.
export function commentClaudeRowWidthCls(state) {
  if (!claudeColumnVisible()) return commentColumnWidthCls(state)
  const chars = relatedGrowthChars()
  const a = columnPairScale(state, commentSideFocused(), isClaudeChatFocused())
  const b = columnPairScale(state, isClaudeChatFocused(), commentSideFocused())
  return relatedWidthCls(chars, a + b, COMMENT_CLAUDE_CONNECTOR_REM)
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
        // bg-white, not the old translucent bg-slate-50/60: that border rule
        // was already byte-for-byte identical to Block.mjs's diffActive
        // border, so a reviewer report that this card "looks fine in dark
        // mode but not in light mode" was NOT a border-color bug — measured
        // with a live PR screenshot (light vs dark, forced-selected vs
        // default), the card was invisible against the page in light mode
        // specifically because bg-slate-50/60 over the page's own
        // bg-slate-50 (index.html's <body>) is almost exactly the page
        // colour itself, so there was no card background to show a border
        // against. dark:bg-zinc-800/40 stays untouched — over the page's
        // bg-zinc-950 it already reads visibly lighter, which is why dark
        // mode looked right. Don't "fix" this again by touching the border
        // classes — they were never the problem. Same reasoning applies to
        // nestedChip and testsBar just below/above, which share this exact
        // background.
        'min-w-0 flex-1 cursor-pointer rounded-lg border bg-white dark:bg-zinc-800/40 hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
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
          <span class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-700 dark:text-zinc-300">${
            // A translation leaf's dot-path key now sits once in a shared
            // heading above the card (see translationKeyHeading below), so
            // this title only needs the locale word — repeating the key here
            // too would just duplicate it. Every other kind keeps its usual
            // label. Plain value, not a function: r is a snapshot descriptor
            // rebuilt fresh per render (see the card's own .key(...)), not a
            // reactive object.
            r.kind === 'translation' ? r.locale || r.label : r.label
          }</span>
          ${() =>
            KIND_LABEL[r.kind]
              ? html`<span
                  class="shrink-0 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-500 dark:text-indigo-400"
                  >${t(KIND_LABEL[r.kind])}</span
                >`
              : ''}
          ${() =>
            r.source
              ? html`<span
                  class="shrink-0 rounded-full bg-amber-50 dark:bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
                  title="${t('Gevonden door een LLM')}"
                  >${t('bron: {source}', { source: r.source })}</span
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
                ? html`<p class="px-3 py-2 text-[11px] text-slate-400 dark:text-zinc-500">${t('code laden…')}</p>`
                : html`<p class="px-3 py-2 text-[11px] text-slate-400 dark:text-zinc-500" data-testid="related-empty">
                    ${t('geen code gevonden')}
                  </p>`}
    </div>
    ${() => (!collapsed() && nested.length ? nestedChipColumn([r], nested, drill, [], i) : '')}
    </div>
  `
}

// relatedCardKey builds the same reuse-safe key relatedCard's own render slot
// used to build inline — extracted so translationGroupRow (below) can key
// each half of a paired row identically to a standalone card. See the doc
// comment at the render loop for why every part of this matters (arrow.js
// keyed-node-reuse pitfalls).
function relatedCardKey(r) {
  return 'related:' + r.id + ':' + (r.code ? 'code' : r.loading ? 'load' : 'empty') + ':n' + (r.nestedSig || '')
}

// translationKeyHeading renders a translation child's Laravel dot-path
// (r.transKey, e.g. "includes.orders.billing") ONCE, above its card(s) —
// see translationGroupRow below. Plain string interpolation: transKey is
// static per descriptor, not itself reactive.
function translationKeyHeading(key) {
  return html`<p
    class="mb-1 truncate font-mono text-[10px] font-semibold text-slate-500 dark:text-zinc-400"
    data-testid="related-translation-key"
    title="${key}"
  >
    ${key}
  </p>`
}

// translationGroupRow renders every translation child that shares one
// transKey (`group`, an array of {r, i} — see the render loop below, which
// only ever calls this for 1+ items) as ONE visual row: the dot-path key
// once on top (translationKeyHeading), then the card(s) side by side, each
// taking an even share of the row's width (flex-1 on a plain min-w-0
// wrapper — relatedCard's own returned root carries no width class of its
// own) with a dotted vertical divider between them (divide-x divide-dotted —
// "dot streepjes als verticale verdeler", reviewer request). A lone,
// unpaired translation child (group.length === 1) still gets the shared
// heading, just alone at full width — see .claude/docs/underlying-code.md,
// "Translation children: en/nl paired side by side".
//
// Each card keeps its OWN, unchanged index `i` from `ks` (home.mjs already
// interleaves same-key translation siblings adjacently — see
// interleaveTranslationSiblings — precisely so this visual left-to-right
// order matches cs.codeSel's ↓/↑ walk order): selected()/collapsed()/
// data-active inside relatedCard keep working exactly as for any other card,
// nothing here renumbers them.
function translationGroupRow(group, drill) {
  return html`
    <div class="contents">
      ${() => translationKeyHeading(group[0].r.transKey)}
      <div class="flex items-start divide-x divide-dotted divide-slate-300 dark:divide-zinc-700">
        ${group.map(({ r, i }) =>
          html`<div class="min-w-0 flex-1 px-3 first:pl-0 last:pr-0">${() => relatedCard(r, i, drill)}</div>`.key(
            relatedCardKey(r),
          ),
        )}
      </div>
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
        // bg-white, not the old translucent bg-slate-50/60 — see relatedCard's
        // own doc comment above for why (it blended into the light-mode page
        // background; dark mode was already fine and stays untouched).
        'flex cursor-pointer items-center gap-2 overflow-hidden rounded-lg border bg-white dark:bg-zinc-800/40 px-3 py-2 hover:border-indigo-200 dark:hover:border-indigo-500/40 ' +
        (selected()
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700')}"
      data-testid="related-tests-bar"
      data-active="${() => (selected() ? 'true' : 'false')}"
      data-expanded="${r.expanded ? 'true' : 'false'}"
      title="${r.expanded ? t('Tests inklappen') : t('Tests uitklappen')}"
      @click="${() => drill && drill(r)}"
    >
      <span class="shrink-0 text-[10px] text-slate-400 dark:text-zinc-500">${r.expanded ? '▾' : '▸'}</span>
      <span
        class="shrink-0 rounded-full bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-500 dark:text-indigo-400"
        >${r.count === 1 ? t('1 test') : t('{n} tests', { n: r.count })}</span
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
  'comment_titles:running': 'comment-titels genereren…',
  'comment_titles:completed': 'comment-titels gegenereerd',
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
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return t('net nu')
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return t('{n} min geleden', { n: diffMin })
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return t('{n} uur geleden', { n: diffHour })
  const diffDay = Math.floor(diffHour / 24)
  return diffDay === 1 ? t('{n} dag geleden', { n: diffDay }) : t('{n} dagen geleden', { n: diffDay })
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
  // run.note — a precomputed override, read FIRST. Every run this file itself
  // produces (WorkflowRunView, straight off the Go JSON) never carries this
  // field, so this is a no-op for every existing PR-tree call site; it exists
  // for a caller building its own run-like objects client-side (plan.mjs's
  // "Taken" block, see .claude/docs/plan-page.md) to say something this
  // function has no other way to express — e.g. "plan wordt opgesteld…"
  // during the gap right after an answer, before the run itself has visibly
  // flipped to `running`.
  if (run.note) return run.note
  const c = run.comment
  if (c) {
    const parts = [c.label]
    if (c.line) parts.push(t('regel {n}', { n: c.line }))
    if (c.snippet) parts.push('"' + c.snippet + '"')
    return parts.filter(Boolean).join(' · ')
  }
  if (run.status === 'failed') return t('mislukt')
  if (run.workflow === 'build_relations' && run.status === 'waiting') {
    const summary = buildRelationsSummary(state)
    if (summary) return summary + t(' — wacht op wijzigingen')
  }
  // code_warning's own "waiting/actively working" note never suggests
  // active work while there's nothing left to say — a completed run reports
  // exactly how many findings it produced (from run.warningsFound, see
  // RunsForPR's Result read), including the "none found" case, instead of
  // falling through to a generic "completed" status word.
  if (run.workflow === 'code_warning' && run.status === 'completed') {
    const n = run.warningsFound
    if (n === 0) return t("geen risico's gevonden")
    if (n === 1) return t('1 risico gevonden')
    if (typeof n === 'number') return t("{n} risico's gevonden", { n })
  }
  return t(WORKFLOW_STATUS_NOTE[run.workflow + ':' + run.status] || run.status)
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

// ── One merged list: live runs + failures + skipped log lines ───────────────
// "Taken" and the separate "Mislukte taken" block below it (home.mjs's former
// ProblemsPanel) were two cards saying the same kind of thing about the same
// PR, so a reviewer had to read two lists to know what background work was in
// trouble. They are now ONE list inside this card (reviewer: "dit bij elkaar
// doen"), ordered purely by recency — a stale failure must not sit above a
// task that just finished. See "The Taken block" in
// .claude/docs/detail-layout.md.
//
// Every row is one plain, NON-reactive descriptor object (buildTaskRows below)
// rather than a raw run/log entry: the row template then needs no conditional
// template slot at all (every slot is an always-present string), and the row
// menu in home.mjs gets exactly the fields it needs to decide what it can
// offer — see taskCommandsFor there.

// taskUi — the card's own small, local UI state: the refresh button's in-flight
// flag and the log lines the reviewer dismissed via the row menu. Dismissal is
// deliberately CLIENT-side only: /api/problems' buffer is an in-memory log
// mirror the server rebuilds on its own terms (run_errors.go), so "verberg
// deze melding" means "stop showing it to me in this tab", not a durable write
// — which also keeps it outside the workflow write-boundary.
// `retrying` is the third piece: the Run IDs the reviewer just retried, so the
// row says so IMMEDIATELY instead of looking untouched until a poll lands (see
// markTaskRetrying).
const taskUi = reactive({ busy: false, hiddenLogs: [], retrying: [] })

// markTaskRetrying/clearTaskRetrying — "ik wil gelijk zien dat het weer aan het
// draaien is". A retry is a fresh Execution of another Workflow Type, so the
// failure row only actually disappears once /api/problems has seen that the
// failure is superseded — up to a full poll away, and the row until then looks
// exactly as it did before the click. Marking the Run ID flips that row to
// "↻ opnieuw gestart" in the same tick as the click (buildTaskRows below), and
// nothing has to clean the mark up: the row it belongs to disappears with the
// failure itself. clearTaskRetrying exists for the failure case — the POST came
// back with an error, so the row must go back to saying "mislukt".
export function markTaskRetrying(runId) {
  if (!runId || taskUi.retrying.includes(runId)) return
  taskUi.retrying = [...taskUi.retrying, runId]
}

export function clearTaskRetrying(runId) {
  if (!runId || !taskUi.retrying.includes(runId)) return
  taskUi.retrying = taskUi.retrying.filter((id) => id !== runId)
}

// isRetryingRun — a read-only peek at the same mark, for a caller that needs
// to know "is this already being retried?" before it acts (planCommands' own
// Enter-menu item, plan.mjs — see "The Taken block is the literal TasksPanel"
// in .claude/docs/plan-page.md). markTaskRetrying/clearTaskRetrying only ever
// WRITE the mark; this is the one read added alongside them.
export function isRetryingRun(runId) {
  return !!runId && taskUi.retrying.includes(runId)
}

// hideTaskLogLine drops one mirrored log line from the merged list (the row
// menu's "Verberg deze melding"). Keyed by logRowKey, so the same line coming
// back on the next /api/problems poll stays hidden.
export function hideTaskLogLine(key) {
  if (!key || taskUi.hiddenLogs.includes(key)) return
  taskUi.hiddenLogs = [...taskUi.hiddenLogs, key]
}

// setTasksRefreshBusy lets home.mjs report its refresh round trip (pollWorkflows
// + pollProblems) so the button can show it's working.
export function setTasksRefreshBusy(busy) {
  taskUi.busy = !!busy
}

// logRowKey identifies a mirrored log line across polls. The buffer has no id
// of its own, so this is content-derived — the same pair problemLogRow's own
// .key() already uses.
function logRowKey(entry) {
  return 'log:' + (entry.at || '') + '|' + (entry.message || '').slice(0, 120)
}

// TASK_WORD_CLS / the marker word. Every row leads with a WORD, never a colour
// alone (see the colorblind rule in conventions.md): a problem row says
// "⚠ mislukt"/"⚠ overgeslagen", a live run keeps its ordinary status word
// ("draait"/"klaar"). Always a plain string in one always-present slot, so the
// row template has no template↔'' toggle anywhere (see the
// statically-interpolated-template pitfall in arrowjs-pitfalls.md).
const TASK_WORD_BASE = 'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 '
const PROBLEM_WORD_CLS =
  TASK_WORD_BASE + 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-500/30'
// RETRYING_WORD_CLS — the just-retried row, in the amber of a `running` badge
// (STATUS_BADGES.running): it IS running again, and the ↻ glyph + the words
// carry that on their own.
const RETRYING_WORD_CLS = TASK_WORD_BASE + STATUS_BADGES.running.cls

// failedRunLabel/failedRunNote — what a failed run's two lines say: the
// workflow's own name, then WHICH comment it was about (a task_code_comment
// run) plus the recorded failure message. Same information the /pr-overview
// drawer's problemRunRow shows, folded into the merged row's fixed two lines.
function failedRunNote(run) {
  const parts = []
  const c = run.comment
  if (c) {
    const where = baseName(c.file) + (c.line ? ':' + c.line : '')
    parts.push(where + (c.snippet ? ' · “' + c.snippet + '”' : ''))
  }
  parts.push(run.error || t('geen foutmelding vastgelegd'))
  return parts.join(' — ')
}

// buildTaskRows is the merged, ordered list the card renders. Order is purely
// by recency (each row's own `at`, newest first) across BOTH groups — problems
// (failed runs + skipped log lines) and the live/idle runs visibleWorkflowRuns
// already selected are sorted together as one list, not problems-first. A
// reviewer reported the opposite ordering as confusing: three day-old failed
// rows sat above a run that had finished 5 minutes ago. A failed run is taken
// ONLY from state.pageProblems, never from state.workflows: /api/problems
// drops a failure that a later attempt already superseded (supersededRuns,
// run_errors.go), so reading both would resurrect exactly the failures that
// are no longer anything to act on.
export function buildTaskRows(state) {
  const problems = (state && state.pageProblems) || { failedRuns: [], logErrors: [] }
  const failed = (problems.failedRuns || []).map((run) => {
    // A retried row keeps its place (so the reviewer's eye stays where it
    // clicked) but says it's running again — word, note AND status/key, so the
    // key change forces a fresh node instead of a patched one (see the
    // block-card-key convention in conventions.md).
    const retrying = taskUi.retrying.includes(run.runId)
    return {
      kind: 'run',
      problem: true,
      key: (retrying ? 'retrying:' : 'failed:') + run.runId,
      at: new Date(run.updatedAt).getTime() || 0,
      word: retrying ? t('↻ opnieuw gestart') : t('⚠ mislukt'),
      wordCls: retrying ? RETRYING_WORD_CLS : PROBLEM_WORD_CLS,
      status: retrying ? 'retrying' : 'failed',
      retrying,
      runId: run.runId,
      label: labelForWorkflow(run.workflow),
      note: retrying ? t('opnieuw gestart — bezig…') : failedRunNote(run),
      when: retrying ? t('net nu') : relTime(run.updatedAt),
      error: run.error || '',
      comment: run.comment || null,
      retryable: !!run.retryable,
      run,
    }
  })
  const logs = (problems.logErrors || [])
    .map((entry) => ({
      kind: 'log',
      problem: true,
      key: logRowKey(entry),
      at: new Date(entry.at).getTime() || 0,
      word: t('⚠ overgeslagen'),
      wordCls: PROBLEM_WORD_CLS,
      status: 'skipped',
      runId: '',
      label: entry.scope || t('Achtergrondtaak'),
      note: entry.message || '',
      when: relTime(entry.at),
      error: entry.message || '',
      comment: null,
      retryable: false,
      entry,
    }))
    .filter((row) => !taskUi.hiddenLogs.includes(row.key))
  const trouble = [...failed, ...logs].sort((a, b) => b.at - a.at)
  const failedIds = new Set(failed.map((r) => r.runId))
  const live = foldIdenticalRuns(
    visibleWorkflowRuns(state)
      .filter((r) => r.status !== 'failed' && !failedIds.has(r.runId))
      .map((run) => {
        const badge = STATUS_BADGES[run.status] || {
          label: run.status,
          cls: 'bg-slate-50 dark:bg-zinc-800/60 text-slate-500 dark:text-zinc-500 ring-slate-200 dark:ring-zinc-800',
        }
        return {
          kind: 'run',
          problem: false,
          key: 'run:' + run.runId + ':' + run.status,
          at: new Date(run.updatedAt).getTime() || 0,
          word: t(badge.label),
          wordCls: TASK_WORD_BASE + badge.cls,
          status: run.status,
          runId: run.runId,
          label: labelForWorkflow(run.workflow),
          note: workflowNote(run, state),
          when: relTime(run.updatedAt),
          error: '',
          comment: run.comment || null,
          retryable: false,
          run,
        }
      })
  )
  return [...trouble, ...live].sort((a, b) => b.at - a.at)
}

// foldIdenticalRuns collapses several rows that are indistinguishable to the
// reviewer into one, with a "· N×" count on the label — instead of listing
// each one separately. A workflow like `explain_code`/`resolve_call` starts
// one Execution PER unit (a distinct piece of code each time), and once
// several of those are simultaneously visible (see `visibleWorkflowRuns`)
// they carry an identical, generic label+status+note: there is no comment ref
// to tell them apart (unlike a `task_code_comment` run, whose note already
// names which comment it's about — see `workflowNote`). Reviewer report: 22
// separate, pixel-identical "klaar | AI-omschrijving | … | omschrijving
// gegenereerd" rows for one PR. `resolve_call` rarely shows this in practice
// only because the Go side already groups many unresolved calls into ONE
// Execution per caller (`groupUnresolvedCalls`, workflows.go) — a
// server-side reduction of run COUNT that doesn't apply to `explain_code`
// (each unit genuinely needs its own distinct explanation, so it can't be
// merged into one Execution). This fold is therefore the general,
// display-side fix: extend the one existing "merge many rows into a
// readable list" mechanism (`buildTaskRows`) rather than build a second,
// workflow-specific grouping path — so ANY workflow type with the same
// "many generic, indistinguishable rows" shape is folded for free, not just
// `explain_code`.
//
// Only rows WITHOUT a `comment` ref are eligible: a `task_code_comment` row's
// note is per-instance information (which comment), never a duplicate-note
// signal. The group key includes the note itself (not just workflow+status)
// so two runs of the same workflow+status that legitimately say different
// things (`code_warning`'s "N risico's gevonden", `build_relations`'s
// `buildRelationsSummary`) are never folded together. The row's `.key()` is
// derived from that same content, so it stays stable across polls as long as
// the folded group's membership keeps producing the same content — no
// needless remount, per the keyed-node rules in arrowjs-pitfalls.md.
function foldIdenticalRuns(rows) {
  const folded = new Map() // groupKey -> the one row kept for that group
  const order = []
  for (const row of rows) {
    if (row.comment) {
      order.push(row)
      continue
    }
    const workflowType = (row.run && row.run.workflow) || row.label
    const groupKey = workflowType + '|' + row.status + '|' + row.note
    const existing = folded.get(groupKey)
    if (!existing) {
      const copy = { ...row, count: 1, key: 'fold:' + groupKey }
      folded.set(groupKey, copy)
      order.push(copy)
    } else {
      existing.count += 1
      if (row.at > existing.at) {
        existing.at = row.at
        existing.when = row.when
      }
    }
  }
  for (const row of order) {
    if (row.count > 1) row.label = row.label + ' · ' + row.count + '×'
  }
  return order
}

// TASK_ROW_H_REM — every row is exactly this tall, which is what makes the
// "3,5 rows visible" cut below possible at all: the reviewer asked for a HALF
// row at the bottom precisely so it's obvious more is there ("maximaal 3,5
// laten zien (half omdat je dan het idee krijgt dat er meer is)"), and that
// only reads as half a row if rows don't vary in height. Hence the fixed
// height + one truncated note line per row instead of the old free-flowing
// two/three-line row. Kept in sync BY HAND with taskRow's own literal
// `h-[3.25rem]` class — a computed `h-[${…}rem]` would be a class name Tailwind
// only ever sees after the row is already in the DOM.
const TASK_ROW_H_REM = 3.25
// TASK_FULL_ROWS — how many rows are FULLY visible; the .5 above it is the
// clipped hint. The footer counts everything past those full rows.
const TASK_FULL_ROWS = 3
const TASK_LIST_MAX_H = (TASK_FULL_ROWS + 0.5) * TASK_ROW_H_REM

// taskRow renders one descriptor. EVERY row is clickable and opens the row menu
// (reviewer: "ook ik moet het aan kunnen klikken, met een menu om het opnieuw
// te proberen") — what that menu offers per row kind lives in home.mjs's
// taskCommandsFor. `openRowMenu` is optional so a bare TasksPanel(state) mount
// (the direct-mount specs) still renders.
//
// It IS a keyboard stop as well: ↓ from the PR description walks into this list
// (`state.taskFocus` holds the focused row's KEY — see "Walking into the Taken
// block" in .claude/docs/keyboard-navigation.md). The focus class is therefore a
// FUNCTION binding reading that reactive key, not part of the statically
// interpolated class string: the row's `.key()` deliberately doesn't encode
// focus (a ↓/↑ step must not tear down and rebuild every row it passes), and
// arrow.js doesn't re-run a reused keyed node's static slots. Comparing
// `row.key` rather than a captured index is the same rule as `isActiveCard` —
// the list reorders under a poll, an index snapshot would go stale (see
// conventions.md).
function taskRow(row, actions) {
  const openRowMenu = actions && actions.openRowMenu
  const focusState = actions && actions.focusState
  const focused = () => !!focusState && focusState.taskFocus === row.key
  return html`
    <div
      class="${() =>
        'flex h-[3.25rem] shrink-0 cursor-pointer flex-col justify-center gap-0.5 border-b border-slate-100 dark:border-zinc-800/60 px-3 last:border-b-0 hover:bg-slate-50 dark:hover:bg-zinc-800/60 ' +
        (row.retrying
          ? 'bg-amber-50/70 dark:bg-amber-950/25 '
          : row.problem
            ? 'bg-rose-50/60 dark:bg-rose-950/25 '
            : row.status === 'running'
              ? ''
              : 'opacity-60 ') +
        (focused() ? 'ring-2 ring-inset ring-indigo-400 dark:ring-indigo-500 opacity-100' : '')}"
      data-testid="workflow-row"
      data-task-kind="${row.kind}"
      data-task-key="${row.key}"
      data-task-problem="${row.problem ? 'true' : 'false'}"
      data-task-focused="${() => (focused() ? 'true' : 'false')}"
      data-status="${row.status}"
      data-run-id="${row.runId}"
      @click="${(e) => (openRowMenu ? openRowMenu(row, e) : null)}"
      @contextmenu="${(e) => {
        // A right-click lands on the same menu as a left-click here (the row
        // has no other action to preserve), matching the app-wide right-click
        // convention — see "The right-click context menu" in
        // .claude/docs/command-palette.md. preventDefault suppresses the
        // native menu; openRowMenu itself stops the propagation that would
        // otherwise reach the PR-info column's own contextmenu handler.
        if (!e || !openRowMenu) return
        e.preventDefault()
        openRowMenu(row, e)
      }}"
    >
      <div class="flex items-center gap-2">
        <span class="${row.wordCls}" data-testid="workflow-status">${row.word}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-700 dark:text-zinc-300" data-testid="workflow-label"
          >${row.label}</span
        >
        <span class="shrink-0 text-[10px] text-slate-400 dark:text-zinc-600" data-testid="workflow-updated">${row.when}</span>
      </div>
      <p class="truncate text-[11px] leading-snug text-slate-500 dark:text-zinc-500" data-testid="workflow-note" title="${row.note}">
        ${row.note}
      </p>
    </div>
  `
}

// tasksRefreshButton — "verversen" on demand instead of waiting for the next
// poll tick (pollWorkflows every 2.5s, pollProblems every 15s — a retry's
// result would otherwise sit invisible for up to 15 seconds). The glyph is the
// only label, like scrollHint/stepChevron, with the wording in title/aria-label
// (see the colorblind rule): a spinning ring would be decoration, the disabled
// state is what actually reports "busy".
function tasksRefreshButton(actions) {
  const refresh = actions && actions.refresh
  return html`
    <button
      class="${() =>
        'shrink-0 rounded-md border border-slate-200 dark:border-zinc-700 px-2 py-1 text-[14px] leading-none text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800 ' +
        (taskUi.busy ? 'opacity-50' : '')}"
      data-testid="tasks-refresh"
      title="${t('Taken verversen')}"
      aria-label="${t('Taken verversen')}"
      disabled="${() => taskUi.busy || !refresh}"
      @click="${(e) => {
        if (!e) return
        e.stopPropagation()
        if (refresh) refresh()
      }}"
    >
      ${() => (taskUi.busy ? '…' : '⟳')}
    </button>
  `
}

// TasksPanel — the exported "Taken" block, mounted by home.mjs under the
// PR-description column (prInfoCard), no longer a fixed right-hand sidebar.
// It now shows the merged list (buildTaskRows): the failures and skipped log
// lines for this PR first, then the runs that are genuinely in progress or
// have been sitting idle for a while (visibleWorkflowRuns).
//
// `actions` (all optional, so the direct-mount specs can pass nothing):
//   openRowMenu(row, event) — a click on any row, opens home.mjs's row menu
//   refresh()               — the header's ⟳ button
//   focusState              — the reactive object carrying `taskFocus` (the
//                             focused row's key); home.mjs passes its own
//                             `state`, so the rows follow the keyboard cursor
//   subtitle                 — override for the small line under "Taken"
//                             (default "workflow-runs · deze PR"); plan.mjs
//                             passes its own wording since a planning ticket
//                             has no PR yet — see .claude/docs/plan-page.md.
export function TasksPanel(state, actions) {
  actions = actions || {}
  return html`
    <section
      class="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5"
      data-testid="workflows-panel"
    >
      <div class="flex items-start gap-2 border-b border-slate-100 dark:border-zinc-800/60 px-3 py-2.5">
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-semibold text-slate-800 dark:text-zinc-200">${t('Taken')}</h2>
          <p class="text-[11px] text-slate-400 dark:text-zinc-500">${actions.subtitle || t('workflow-runs · deze PR')}</p>
        </div>
        ${tasksRefreshButton(actions)}
      </div>
      <div
        class="no-scrollbar flex min-h-0 shrink-0 flex-col overflow-auto"
        style="${'max-height:' + TASK_LIST_MAX_H + 'rem'}"
        data-testid="tasks-list"
      >
        ${() => {
          // Always return an ARRAY from this slot (see the "no comments" note
          // above): a slot that alternates between a single element and an
          // array can freeze empty after the first empty render.
          const rows = buildTaskRows(state)
          return rows.length === 0
            ? [html`<p class="px-3 py-3 text-[11px] text-slate-400 dark:text-zinc-500">${t('Geen taken.')}</p>`.key('no-workflows')]
            : // The key carries the row's status (see the block-card-key
              // convention in conventions.md): arrow.js only re-runs a keyed
              // node's own bindings when its key changes, and a row whose
              // status just moved (running → klaar, or a failure that got
              // retried) must re-render, not be patched in place.
              rows.map((r) => taskRow(r, actions).key(r.key))
        }}
      </div>
      <div class="contents">
        ${() => {
          const hidden = buildTaskRows(state).length - TASK_FULL_ROWS
          return hidden > 0
            ? html`<p
                class="border-t border-slate-100 dark:border-zinc-800/60 px-3 py-1.5 text-[11px] text-slate-400 dark:text-zinc-500"
                data-testid="tasks-more"
              >
                ${t('nog {n} meer — scroll voor de rest', { n: hidden })}
              </p>`
            : ''
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
  // Calls/coverage targets the Go resolver could not pin (status unresolved) +
  // any in flight (searching). The LLM search auto-runs for them, but ONLY a
  // row that is really `searching` shows the "zoeken…" pill: `unresolved`
  // means "the Go resolver couldn't pin this", which is not by itself a
  // running action. A stuck-forever pill was a real reviewer report (PR 13431)
  // — callresolve.UpsertGo used to reset an answered `notfound` row back to
  // `unresolved` on every rebuild, while both search triggers correctly
  // refused to re-ask (the deterministic resolve_call Run ID is idempotent and
  // resolveCallAttempts remembers the attempt in the durable history), so the
  // row sat at `unresolved` with nothing running and nothing under "Taken".
  // A genuine search marks its rows `searching` before the LLM call (the
  // markCallsSearching Activity), so the pill still shows for every real run —
  // just one poll tick later than the old, over-eager `pending()` did. See
  // "Automatic LLM search for unresolved calls" in
  // .claude/docs/underlying-code.md.
  const unresolved = () => rc.unresolved
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
    unannotated: t('Dekking niet te bepalen — geen #[CoversMethod]/@covers gevonden op deze test.'),
    notfound: t('Dekking niet te bepalen — #[CoversClass] gevonden, maar geen specifieke methode kunnen vaststellen.'),
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
        <span>${COVERS_WARNING_TEXT[kind] || t('Dekking niet te bepalen.')}</span>
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
        searching()
          ? html`<span
              class="absolute right-2 top-2 z-10 shrink-0 rounded-md border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-2 py-1 text-[11px] text-slate-400 dark:text-zinc-500"
              data-testid="related-searching"
              >${t('zoeken…')}</span
            >`
          : ''}
      <div
        class="${() =>
          // pl-0 (not the p-3 default): the comment/Claude row above this
          // panel (comment-claude-row, home.mjs) has its own card border
          // sitting flush against the column's true left edge, with no
          // equivalent left inset of its own — this wrapper's ordinary p-3
          // padding therefore used to indent every card 12px further right
          // than that row, so the "Onderliggende code" cards visibly didn't
          // line up on the left with the comment/chat card above them
          // (reviewer report, confirmed with a pixel measurement of a
          // screenshot: 231px vs 219px). Only the LEFT side is trimmed —
          // top/right/bottom keep the original p-3 spacing; a plain, later
          // `pl-0` always wins over the `p-3` shorthand's own left component
          // regardless of class order (Tailwind orders side-specific
          // utilities after the shorthand in its generated stylesheet).
          'no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 pl-0 ' +
          (searching() ? 'pt-9' : '')}"
      >
        ${() => coversWarning()}
        ${() => {
          // All children render as one flat vertical list, full width, in
          // order — EXCEPT translation children of the same transKey, which
          // group into a single side-by-side row (translationGroupRow, added
          // for "de translations blokjes rechts, dat mag de helft smaller
          // zodat de engelse links kan en rechts de nederlandse van dezelfde
          // key, gooi daar dot streepjes als verticale verdeler"). home.mjs'
          // interleaveTranslationSiblings already sorted same-key translation
          // children adjacently, so grouping only ever needs to look at
          // immediate neighbours — no lookahead beyond one run.
          const ks = kids()
          if (ks.length === 0)
            return html`<p class="px-1 py-2 text-[11px] text-slate-400 dark:text-zinc-500">${t('Geen onderliggende code.')}</p>`
          const rows = []
          for (let i = 0; i < ks.length; ) {
            const r = ks[i]
            if (r.kind === 'translation') {
              let j = i + 1
              while (j < ks.length && ks[j].kind === 'translation' && ks[j].transKey === r.transKey) j++
              const group = []
              for (let k = i; k < j; k++) group.push({ r: ks[k], i: k })
              rows.push(
                translationGroupRow(group, drill).key(
                  'related-trans:' + group.map(({ r: gr }) => relatedCardKey(gr)).join('|'),
                ),
              )
              i = j
              continue
            }
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
            rows.push(
              r.kind === 'tests_group'
                ? testsBar(r, i, drill).key(
                    'tests-group:' + (r.expanded ? 'open' : 'closed') + ':' + r.tests.map((t) => t.id).join('|'),
                  )
                : relatedCard(r, i, drill).key(relatedCardKey(r)),
            )
            i++
          }
          return rows
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
  return cs.list.filter(
    (c) =>
      (c.kind || c.anchorState === 'orphan') &&
      !isKiloReview(c.body) &&
      // A bare anchor is excluded (see isChatAnchorPlaceholder's own doc
      // comment) — UNLESS the reviewer already took it over with their own
      // first reply (firstReviewerReplyOnPlaceholder), in which case it
      // reads as an ordinary comment everywhere, including here.
      !(isChatAnchorPlaceholder(c) && !firstReviewerReplyOnPlaceholder(c)),
  )
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
    // A bare Claude-chat anchor never gets a row (isChatAnchorPlaceholder) —
    // unless the reviewer already took it over with their own first reply
    // (firstReviewerReplyOnPlaceholder), in which case it IS a real comment
    // and falls through to the ordinary prWide/inBlock check below.
    if (isChatAnchorPlaceholder(c) && !firstReviewerReplyOnPlaceholder(c)) continue
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

// openChatComments — the "Openstaande chats" index section (home.mjs's
// recomputeLeftList): every comment with an EXISTING Claude conversation
// (cc.conversations — "here a Claude conversation really happened", see
// ConversationsWithMessages in modules/chat) whose own comment doesn't
// already get a row elsewhere (indexComments() — a still-open line comment,
// a PR-wide/orphan one, …), so a resolved-but-chatted-about comment (or a
// bare Claude-chat anchor with no written comment at all — reviewer request:
// "Chat over deze regel" starts exactly such a conversation) becomes
// reachable again instead of only living inside a block the reviewer happens
// to reopen on their own. A genuinely DELETED comment is excluded implicitly
// — cs.list simply no longer carries it (comments.Module.Delete removes the
// row outright, see comments-panel.md), so it can never surface here.
// home.mjs additionally requires the comment to resolve to a real block still
// in this tree (the same "must actually be in this tree" condition
// indexComments' own unresolved half needs, applied here too) before it gets
// an index row at all.
export function openChatComments() {
  const existingIds = new Set(indexComments().map((c) => c.id))
  // A general chat (isGeneralChatAnchor — the PR-wide, code-less anchor the
  // `/`-menu's "Chat met Claude over deze PR" creates) gets its row from the
  // moment it EXISTS, not only once it has turns: it is the one thing this
  // section is the sole surface for, and cc.conversations only lists
  // conversations that already have messages — so without this the row (and
  // with it the way back into the overlay) would be missing for exactly as
  // long as the reviewer has not sent anything yet.
  return cs.list.filter(
    (c) => (cc.conversations.indexOf(c.id) >= 0 || isGeneralChatAnchor(c)) && !existingIds.has(c.id),
  )
}

// chatConversationIds — a plain, unconditional read of cc.conversations for
// home.mjs's own watch to depend on (see the arrow.js `watch` pitfall in
// arrowjs-pitfalls.md: a getter must read its deps INLINE, not buried inside
// a helper with an early return like openChatComments' own `if
// (!cc.conversations.length) return []` — that guard is fine for the actual
// filtering call, but would make an unreliable watch dependency).
export function chatConversationIds() {
  return cc.conversations
}

// isOrphanComment reports whether a comment lost the code it was anchored to. Used
// for the "verouderd" pill and by the index-item label, so an orphan is
// recognisable as such rather than looking like an ordinary PR-wide comment.
export function isOrphanComment(c) {
  return !!c && c.anchorState === 'orphan'
}

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
    if (isChatAnchorPlaceholder(c)) {
      // Taken over by the reviewer's own first reply (see threadMessages'
      // own doc comment): render THAT text as the body instead of the
      // "Nog geen eigen comment" note — this is the one root-level
      // (rather than per-message) commentBody(c, …) call, compactConversation's
      // own preview line, so it's the one place that still needs this
      // substitution explicitly; every per-message call (reactionBubble's
      // commentBody(r, …)) already renders the real reply text on its own.
      const taken = firstReviewerReplyOnPlaceholder(c)
      if (taken) return renderMarkdown(taken.body, startIndex, true)
      return CHAT_ANCHOR_NOTE_HTML
    }
    const st = threadStatusSentinel(c.body)
    if (st) return statusLineHTML(st)
    return renderMarkdown(c.body, startIndex, true)
  }
}

// CHAT_ANCHOR_NOTE_HTML replaces the raw CLAUDE_ANCHOR_PLACEHOLDER sentence
// wherever a body renders (the compact card, the expanded card's own origin
// bubble via viewingBubble) — see "A bare Claude-chat anchor reads as a
// conversation, not as a comment" in comments-panel.md. Deliberately terse
// and muted/italic, the same visual register as statusLineHTML's status
// line: nobody wrote this, so it must never look like ordinary reviewer
// prose. Paired with chatAnchorAuthorLine below, which replaces the
// author/avatar row so the two together read as "an ongoing Claude
// conversation", never as a message from the reviewer.
const CHAT_ANCHOR_NOTE_HTML =
  '<span class="italic text-slate-400 dark:text-zinc-500" data-testid="chat-anchor-note">' +
  t('Nog geen eigen comment — bekijk het gesprek hiernaast.') +
  '</span>'

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
  '/resolve': { icon: '✓', text: t('Thread opgelost') },
  '/reopen': { icon: '↩', text: t('Thread heropend') },
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

// isCommentDetailEntered — the merged commentDetailCard's own "has the
// keyboard actually stepped in via →" check (see that card's border comment).
// True once the reviewer is either in comment `c`'s own thread (pct) or has
// gone one step further into its Claude conversation (cs.focus === 'claude',
// anchored via cc.commentId — set by enterClaudeChat/syncClaudeAnchorForSelection
// only once cs.focus genuinely becomes 'claude', never by mere selection).
// Both the keyboard's own → (handlePrCommentThreadKey/enterClaudeChat) and
// the mouse equivalents (startPrCommentReply's own field focus,
// startPrCommentChat's focusEl → the composer's @focus → onClaudeComposeFocus
// → enterClaudeChat) end up flipping the same pct/cs.focus state, so this
// needs no separate mouse-specific check.
function isCommentDetailEntered(c) {
  return isPrCommentThreadFocused(c) || (cs.focus === 'claude' && cc.commentId === c.id)
}

// exitPrCommentThread releases the thread cursor — called on ← out of the
// thread and whenever the sidebar selection moves off the comment it belongs
// to (mirrors the reasoning behind the selection-change watch that already
// resets picm/cancelPrCommentReply for the reply field).
export function exitPrCommentThread() {
  pct.commentId = null
  pct.pos = 0
}

// handlePrCommentThreadKey drives ↑/↓/←/→ while comment `c`'s thread owns the
// keyboard (see isPrCommentThreadFocused) — ↑ steps to an older message,
// clamped at the top (no fall-through: mirrors the block-scoped
// handleRelatedKey's 'thread' branch, where ↑ also just clamps). ↓ steps to
// a newer one; once already at the newest message (pos === 0, nothing left
// to descend into), it instead FALLS THROUGH — returns `false` and leaves
// the thread (see below) — so the caller (home.mjs's onKeydown) can advance
// the sidebar cursor to the next comment/block, mirroring the block-scoped
// panel's own `advanceFromComment` "↓ loopt door" convention (see
// detail-layout.md, "Inline comment blocks"). ← steps back out to the
// index (same row, not the next one). → steps ONE level further, into the
// Claude column that is already on screen next to this item — the exact
// mirror of the block-scoped handleRelatedKey's 'thread' + → branch
// (enterClaudeChat), so a comment-index item reaches stop 5b through the
// ordinary → chain instead of only through the "Chat met Claude" command
// (startPrCommentChat). The pct cursor is released first: the keyboard is in
// the chat from there on, and leaving pct.commentId set would keep this
// item's own thread ring lit alongside it (never two focused things at once,
// see keyboard-navigation.md's "Focus highlight per stop"). Returns `true`
// when the key was fully handled here, `false` only for the ↓-falls-through
// case above.
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
  } else if (key === 'ArrowRight') {
    // No Claude column (an "algemene" comment being composed, see
    // claudeColumnVisible) ⇒ a plain no-op, still fully handled here: falling
    // through would make → advance the sidebar cursor, which is the ↓
    // meaning, not the → one.
    if (claudeColumnVisible()) {
      exitPrCommentThread()
      enterClaudeChat(cs.pr)
    }
  }
  return true
}

// picm ("PR-index comment menu") is the ephemeral reply-composer state for
// whichever comment-index item is currently selected in home.mjs's sidebar —
// mirrors cs.focus === 'new''s role, just for this separate, simpler flow. `commentId`
// scopes `replying` to ONE specific comment: DetailPanel renders both the
// selected AND the look-ahead preview card through the very same
// commentDetailCard, so a bare boolean would reveal the reply field on BOTH
// cards at once (the preview's comment isn't even the one "Beantwoorden" was
// chosen for) — see commentDetailCard's own check below. The reply textarea
// is deliberately hidden until "Beantwoorden" (the menu's first, default
// item) is actually chosen — see keyboard-navigation.md ("Comment-index
// items"). Not bound to the URL — ephemeral UI state, like cs.focus/menu
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
  const draft = c && getPrReplyDraft(c.id)
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

// startPrCommentChat focuses the Claude conversation of an unanchored
// comment-index item — the "Chat met Claude" command (home.mjs's
// prCommentCommandsFor), the mouse/menu equivalent of the `→` chain a
// block-scoped comment has. The COLUMN itself is already on screen by then:
// isPrCommentScope() keeps claudeChatVisible() true for as long as such an
// item is selected (see its own doc comment), so this only has to make sure
// the Execution/transcript are actually loaded before focusing the composer.
//
// `cc.commentId` is already `c.id` when this runs — chatAnchorComment's
// `s.none` branch plus syncClaudeAnchorForSelection resolved it the moment the
// item was selected — so ensureAndLoadChat is the same idempotent call
// enterClaudeChat makes. Ordering mirrors it too: focus only AFTER cc.runId is
// populated, since sending before that resolves is a silent no-op
// (sendClaudeMessage's own `if (!runId) return`).
//
// There used to be a SECOND, embedded copy of the chat inside the item's own
// detail card, toggled by a `pcc` reactive ("PR-index comment chat") and only
// visible after this command ran. Removed with the column above — one chat,
// one surface. Don't reintroduce it.
export async function startPrCommentChat(c) {
  if (!c) return
  await ensureAndLoadChat(cs.pr, c.id)
  ensureChatEvents(cs.pr)
  restoreClaudeComposerDraft()
  focusEl('[data-testid=claude-chat-compose]')
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
// It used to also open the item's own action menu (prCommentMenuOpener,
// home.mjs's openMenu('prComment')) right away, mirroring postThreadReply's
// own reasoning — reversed for the same later reviewer request: "als ik een
// comment plaat, komt het direct erop (goed), maar ik zie dan ook gelijk een
// menu, dat wil ik niet". See postThreadReply's own doc comment above.
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
      deletePrReplyDraft(c.id)
      clearSendFailed('reply:' + c.id)
      await loadComments(cs.pr)
    } else {
      markSendFailed('reply:' + c.id)
      setPrReplyDraft(c.id, text)
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
      title="${t('Menu voor deze comment')}"
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

// commentDetailCard renders a general/PR-wide comment's read-only thread —
// status mark, source/AI-warning badges, then the comment's own body as
// plain text right under the author line (no separate bubble box: an
// earlier version rendered the opening message through reactionBubble too,
// which repeated the avatar+name a second time inside its own bordered/
// tinted box), any REAL replies below that via reactionBubble, and a footer
// meta line (file:line, reacties/status, relative time — reusing
// commentReactionStatusLine, the same wording compactConversation's own
// "comment-meta" line uses). Reviewer request: "ik wil algemene comments
// meer laten lijken op comments op een regel" — this card now deliberately
// mirrors compactConversation's shape (author line with inline badges, plain
// body, one muted meta line) instead of the three-stacked-pills header
// (kind/file-chip/time) plus boxed thread it had before; the kind pill
// (COMMENT_KIND_LABEL) is gone outright, since the line-comment card never
// showed one either. Plus — once picm.replying is true (see
// startPrCommentReply) — a reply textarea + send button. This is what
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
  // merged: rendered inside comments-and-related's own comment-claude-row
  // (InlineComments, in place of the ordinary inline-comment cards) instead
  // of home.mjs's block-column — see "The comment-detail card moved into the
  // merged comment-claude-row" in comments-panel.md. That row already
  // supplies this card's WIDTH (commentColumnWidthCls(), the same half-share
  // InlineComments' own cards get, so it lines up with the Claude column
  // next to it and the resize handle above it) — so this card must drop its
  // own fixed width/shrink-0 here, it would otherwise fight the parent's
  // width instead of filling it.
  const merged = !!(opts && opts.merged)
  // readOnly mirrors commentColumnReadOnly(state) from the ONE call site
  // that ever passes it (InlineComments' isPrCommentScope branch) — see
  // "Read-only, not a rail" in .claude/docs/comments-panel.md. The other
  // call site (an anchored comment-index item's own detail card,
  // home.mjs) never passes it, so this stays false — unaffected — there.
  const readOnly = !!(opts && opts.readOnly)
  return html`
    <div
      class="${() =>
        // The same on/off indigo/slate border every Block() diff card gets
        // (see Block.mjs's diffActive) — this card, after all, replaces a
        // Block() card in the same column position for a comment-index item
        // (see detail-layout.md). For the non-merged (home.mjs block-column)
        // call site there's no further "stop" (drilled column / Onderliggende
        // code) the keyboard can step into that would steal this border away,
        // so non-preview there is simply the whole of the selected/focused
        // state, unchanged.
        //
        // For the MERGED call site (isPrCommentScope, InlineComments —
        // opts.merged), there IS a further stop: → first steps into this
        // item's own thread (pct, enterPrCommentThread) and, one step
        // further, into the Claude column right next to this card
        // (cs.focus === 'claude'). Reviewer request: "ik wil dat de chat
        // alleen geselecteerd is als ik het ook echt selecteer door naar
        // rechts te gaan... de border moet een color krijgen als ik naar
        // rechts ga, niet daarvoor" — until the reviewer has actually
        // entered via →, `preview:false` used to already paint this card
        // indigo the moment the row was merely selected with ↑/↓, which read
        // as "the chat is already selected". So for `merged`, non-preview
        // splits further into "selected but not entered" (neutral slate,
        // full opacity — it IS the current selection, just not entered) and
        // "entered" (the indigo look). Mirrors the drilled anchor column's
        // own diffActive border, which already gets this exact "no color
        // until the first →" treatment — see
        // tests/comment-anchor-expanded-view.spec.mjs.
        //
        // Widened by 50px on top of the previous 42rem — reviewer request,
        // room for the footer meta line below to stay readable now that it
        // carries the file path that used to sit in its own header pill.
        // Not applied when merged (see above) — the parent already sets the
        // width there.
        'flex flex-col gap-3 rounded-2xl border p-4 shadow-sm ' +
        (merged ? 'w-full ' : 'w-[calc(42rem+50px)] shrink-0 ') +
        (preview
          ? 'border-slate-300 dark:border-zinc-700 opacity-60 '
          : merged && !isCommentDetailEntered(c)
            ? 'border-slate-300 dark:border-zinc-700 '
            : 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30 ') +
        (c.status === 'resolved' ? 'bg-emerald-50 dark:bg-emerald-500/15 ' : 'bg-white dark:bg-zinc-900 ')}"
      data-testid="comment-detail-card"
      data-readonly="${readOnly ? 'true' : 'false'}"
      @click="${() => {
        // The one gesture a read-only card reacts to — hands the keyboard
        // back, mirroring the ←/Escape hand-off already used from 'claude'.
        if (readOnly) (cc.commentId == null ? toNewFocus() : toComment())
      }}"
      @contextmenu="${(e) => {
        // Right-click anywhere on this card = the same click commentMenuButton
        // already runs, native-styled and positioned at the cursor — mirrors
        // pr-info-card's own wiring. No landing step needed: this card is
        // only ever shown for the already-selected comment-index item. See
        // "The right-click context menu" in command-palette.md. Suppressed
        // entirely while read-only, same as expandedConversation's own.
        if (readOnly) return
        const openMenu = opts && opts.openMenu
        if (!openMenu || preview) return
        e.preventDefault()
        openMenu({ native: true, x: e.clientX, y: e.clientY })
      }}"
    >
      <div
        class="flex flex-wrap items-center gap-2"
        data-testid="comment-detail-author-line"
      >
        ${() => commentStatusMark(c)}
        ${avatarHTML(detailWho.name, detailWho.avatarUrl, 'h-6 w-6')}
        <span
          class="mr-0.5 whitespace-nowrap text-sm font-semibold leading-6 text-slate-800 dark:text-zinc-200"
          data-testid="comment-detail-author"
          >${detailWho.name || t('onbekend')}</span
        >
        ${() => sourceBadge(c)} ${() => aiWarningBadge(c)} ${() => staleAnchorBadge(c)}
        ${() => sendFailedBadge('reply:' + c.id)}
        ${() => (preview || readOnly ? '' : commentMenuButton(opts && opts.openMenu))}
      </div>
      ${() => commentTitleLine(c)}
      <div class="relative min-h-0">
        <div
          class="${() =>
            'no-scrollbar flex max-h-[70vh] flex-col gap-2.5 overflow-auto rounded-lg ' +
            (!preview && pct.commentId === c.id ? 'ring-2 ring-indigo-200 dark:ring-indigo-500/30' : '')}"
          data-testid="comment-detail-thread"
          data-scroll-body
          @scroll="${(e) => updateScrollHints(e.target)}"
        >
          ${() =>
            threadMessages(c).map((r, ti, arr) =>
              // The origin message (ti===0) passes `bare` — see reactionBubble's
              // own doc comment: this card's header already shows the
              // avatar+name once, so the origin drops its own copy plus the
              // bordered/tinted bubble box, reading as plain text instead
              // (still keeps its edit pencil and its ↑/↓ ring affordance).
              reactionBubble(
                c,
                r,
                ti,
                arr.length,
                () => !preview && pct.commentId === c.id && pct.pos === arr.length - ti,
                ti === 0,
                readOnly,
              ).key('detail-msg:' + r.id + ':' + (readOnly ? 'ro' : 'rw')),
            )}
        </div>
        ${scrollHint('up')}
        ${scrollHint('down')}
      </div>
      <div
        class="truncate border-t border-slate-100 pt-2.5 text-[11px] leading-snug text-slate-500 dark:border-zinc-800/60 dark:text-zinc-500"
        data-testid="comment-detail-meta"
      >
        ${() =>
          // Same shape as compactConversation's own "comment-meta" line (the
          // block-scoped line comment this card now mirrors) — file:line, then
          // the shared reacties/status tail — plus the relative time, which
          // that line-comment card has no room for but this wider one does.
          // No file at all (a genuine PR-wide issue/review comment, never
          // anchored to code) simply drops that leading segment.
          (c.file ? truncateMiddle(c.file) + (c.line > 0 ? ':' + c.line : '') + ' · ' : '') +
          commentReactionStatusLine(c) +
          ' · ' +
          relTime(c.createdAt)}
      </div>
      <div class="contents">
        ${() =>
          !readOnly && picm.replying && picm.commentId === c.id
            ? html`<div class="flex items-end gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-3">
                <textarea
                  rows="1"
                  class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2 py-1 text-xs leading-[1.625rem] text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  placeholder="${() => (picm.mode === 'convert' ? t('Nieuwe comment op basis van deze melding…') : t('Reageer…'))}"
                  data-testid="comment-detail-reply"
                  @input="${(e) => {
                    if (picm.mode === 'reply' && c) setPrReplyDraft(c.id, e.target.value)
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
                  ${() => (picm.mode === 'convert' ? t('Plaats') : t('Stuur'))}
                </button>
              </div>`
            : ''}
      </div>
      ${() =>
        // Only this comment's own comment_batch state (batchOnly: true) — live
        // while Claude is working on it, and as a one-line outcome afterwards.
        // Deliberately NOT the "Selected: …"/live-turn/"Andere chats in deze PR"
        // sections: those describe the globally anchored conversation, and the
        // wide comment-claude-row footer (home.mjs, CommentClaudeFooter() with
        // no commentId) already shows them once, below both columns — showing
        // them here too duplicated the running "Claude denkt na…" status
        // byte-for-byte in both places. Renders nothing when there's no batch
        // activity to report, so an ordinary comment card is unchanged.
        CommentClaudeFooter(c.id, { batchOnly: true })}
    </div>
  `
}

